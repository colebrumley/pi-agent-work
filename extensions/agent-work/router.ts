import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, exists, now, rootDir } from "./storage.ts";
import type { TaskMode } from "./types.ts";

export type RouteComplexity = "tiny" | "small" | "medium" | "large";
export type RouteRisk = "low" | "medium" | "high";

export interface RouterModel {
  model: string;
  label: string;
  roles: Array<"builder" | "scout" | "reviewer">;
  quality: number;
  speed: number;
  relativeCost: number;
  subscription?: boolean;
  enabled?: boolean;
}

export interface RouterConfig {
  schemaVersion: 1;
  enabled: boolean;
  weights: { cost: number; speed: number; quality: number };
  subscriptionScarcityPenalty: number;
  models: RouterModel[];
}

export interface RouteRequest {
  taskId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  profile: string;
  attempt: number;
  complexity?: RouteComplexity;
  risk?: RouteRisk;
  prefer?: "cost" | "speed" | "quality" | "balanced";
}

export interface RouteDecision {
  schemaVersion: 1;
  timestamp: string;
  selectedModel?: string;
  thinking?: string;
  source: "router" | "explicit" | "pi-default";
  classification: { complexity: RouteComplexity; risk: RouteRisk; role: "builder" | "scout" | "reviewer" };
  requiredQuality: number;
  reason: string;
  candidates: Array<{ model: string; eligible: boolean; score: number; quality: number; speed: number; effectiveCost: number }>;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  schemaVersion: 1,
  enabled: true,
  weights: { cost: 0.5, speed: 0.25, quality: 0.25 },
  subscriptionScarcityPenalty: 0.35,
  models: [
    { model: "openrouter/z-ai/glm-5.2", label: "cheap builder", roles: ["builder", "scout"], quality: 0.72, speed: 0.78, relativeCost: 0.12 },
    { model: "openrouter/x-ai/grok-4.5", label: "fast senior", roles: ["builder", "scout", "reviewer"], quality: 0.9, speed: 0.95, relativeCost: 0.55 },
    { model: "openai-codex/gpt-5.6-terra", label: "subscription senior", roles: ["builder", "reviewer"], quality: 0.92, speed: 0.48, relativeCost: 0, subscription: true },
    { model: "openai-codex/gpt-5.6-sol", label: "subscription expert", roles: ["builder", "reviewer"], quality: 0.99, speed: 0.38, relativeCost: 0, subscription: true },
  ],
};

export function routerConfigPath(root: string): string {
  return join(rootDir(root), "router.json");
}

export async function loadRouterConfig(root: string): Promise<RouterConfig> {
  const path = routerConfigPath(root);
  if (!(await exists(path))) await atomicJson(path, DEFAULT_ROUTER_CONFIG);
  const parsed = JSON.parse(await readFile(path, "utf8")) as RouterConfig;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.models)) throw new Error(`Invalid router config: ${path}`);
  return parsed;
}

function classify(request: RouteRequest): RouteDecision["classification"] {
  const text = `${request.title}\n${request.prompt}`.toLowerCase();
  const role = request.profile === "reviewer" || request.profile.startsWith("critique-") ? "reviewer" : request.mode === "write" ? "builder" : "scout";
  let complexity: RouteComplexity = request.complexity ?? (request.mode === "read" ? "small" : "medium");
  if (!request.complexity) {
    if (/\b(typo|rename|format|copy|locate|find|list)\b/.test(text)) complexity = "tiny";
    if (/\b(architecture|migration|concurrency|distributed|security|authentication|refactor)\b/.test(text)) complexity = "large";
    else if (text.length > 1800 || /\b(multiple files|cross-cutting|integration)\b/.test(text)) complexity = "medium";
  }
  let risk: RouteRisk = request.risk ?? "low";
  if (!request.risk) {
    if (/\b(auth|security|permission|payment|billing|production|data loss|migration)\b/.test(text)) risk = "high";
    else if (request.mode === "write" || /\b(api|schema|database)\b/.test(text)) risk = "medium";
  }
  return { complexity, risk, role };
}

function requiredQuality(c: RouteDecision["classification"], attempt: number): number {
  const complexity = { tiny: 0.6, small: 0.68, medium: 0.82, large: 0.91 }[c.complexity];
  const risk = { low: 0, medium: 0.05, high: 0.09 }[c.risk];
  return Math.min(0.98, complexity + risk + Math.min(0.12, Math.max(0, attempt - 1) * 0.06));
}

export function routeTask(config: RouterConfig, request: RouteRequest, explicitModel?: string, explicitThinking?: string): RouteDecision {
  const classification = classify(request);
  const minimum = requiredQuality(classification, request.attempt);
  if (explicitModel) return { schemaVersion: 1, timestamp: now(), selectedModel: explicitModel, thinking: explicitThinking, source: "explicit", classification, requiredQuality: minimum, reason: "Caller supplied an explicit model; router recorded but did not override it.", candidates: [] };
  if (!config.enabled) return { schemaVersion: 1, timestamp: now(), source: "pi-default", classification, requiredQuality: minimum, reason: "Router is disabled; using Pi's default model.", candidates: [] };

  const preference = request.prefer ?? "balanced";
  const multiplier = preference === "cost" ? { cost: 1.5, speed: 0.7, quality: 0.8 }
    : preference === "speed" ? { cost: 0.8, speed: 1.6, quality: 0.8 }
    : preference === "quality" ? { cost: 0.6, speed: 0.7, quality: 1.7 }
    : { cost: 1, speed: 1, quality: 1 };
  const candidates = config.models.filter((model) => model.enabled !== false && model.roles.includes(classification.role)).map((model) => {
    const effectiveCost = Math.min(1, model.relativeCost + (model.subscription ? config.subscriptionScarcityPenalty : 0));
    const eligible = model.quality >= minimum;
    const score = config.weights.quality * multiplier.quality * model.quality + config.weights.speed * multiplier.speed * model.speed + config.weights.cost * multiplier.cost * (1 - effectiveCost);
    return { model: model.model, eligible, score: Number(score.toFixed(4)), quality: model.quality, speed: model.speed, effectiveCost };
  }).sort((a, b) => b.score - a.score);
  const selected = candidates.find((candidate) => candidate.eligible) ?? candidates.sort((a, b) => b.quality - a.quality)[0];
  const thinking = minimum >= 0.95 ? "high" : minimum >= 0.87 ? "medium" : minimum >= 0.78 ? "low" : "minimal";
  return {
    schemaVersion: 1, timestamp: now(), selectedModel: selected?.model, thinking, source: selected ? "router" : "pi-default",
    classification, requiredQuality: minimum,
    reason: selected ? `Selected the highest utility eligible ${classification.role} (quality >= ${minimum.toFixed(2)}); subscription models include a scarcity penalty.` : "No enabled model supports this role; using Pi's default model.",
    candidates,
  };
}
