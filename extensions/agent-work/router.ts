import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, exists, now, rootDir, safeId } from "./storage.ts";
import type { TaskMode } from "./types.ts";

export type RouteComplexity = "tiny" | "small" | "medium" | "large";
export type RouteRisk = "low" | "medium" | "high";
export type RouteRole = "builder" | "scout" | "reviewer";
export type ProfileRoutingMode = "utility" | "pinned";

export const SOL_MODEL = "openai-codex/gpt-5.6-sol";
export const TERRA_MODEL = "openai-codex/gpt-5.6-terra";
export const LUNA_MODEL = "openai-codex/gpt-5.6-luna";
export const GLM_MODEL = "openrouter/z-ai/glm-5.2";
export const GROK_MODEL = "openrouter/x-ai/grok-4.5";

export const PRO_PROFILE_NAME = "Pro";
export const ECONOMY_PROFILE_NAME = "Economy";
export const LEGACY_PROFILE_NAME = "Legacy";

export interface RouterModel {
  model: string;
  label: string;
  roles: RouteRole[];
  quality: number;
  speed: number;
  relativeCost: number;
  subscription?: boolean;
  enabled?: boolean;
  /** When true, model is only selected if no non-escalation eligible model meets the quality floor. */
  escalationOnly?: boolean;
}

export interface UtilityRouting {
  mode: "utility";
  weights: { cost: number; speed: number; quality: number };
  subscriptionScarcityPenalty: number;
  models: RouterModel[];
}

export interface PinnedRouting {
  mode: "pinned";
  pins: Record<RouteRole, string>;
}

export type ProfileRouting = UtilityRouting | PinnedRouting;

export interface AgentProfile {
  name: string;
  coordinatorModel: string;
  routing: ProfileRouting;
}

export interface RouterConfigV1 {
  schemaVersion: 1;
  enabled: boolean;
  weights: { cost: number; speed: number; quality: number };
  subscriptionScarcityPenalty: number;
  models: RouterModel[];
}

export interface RouterConfig {
  schemaVersion: 2;
  enabled: boolean;
  activeProfile: string;
  profiles: AgentProfile[];
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
  activeProfile?: string;
  classification: { complexity: RouteComplexity; risk: RouteRisk; role: RouteRole };
  requiredQuality: number;
  reason: string;
  candidates: Array<{ model: string; eligible: boolean; score: number; quality: number; speed: number; effectiveCost: number }>;
}

/** Historical schema-version-1 default used for exact-match migration. */
export const DEFAULT_ROUTER_CONFIG_V1: RouterConfigV1 = {
  schemaVersion: 1,
  enabled: true,
  weights: { cost: 0.5, speed: 0.25, quality: 0.25 },
  subscriptionScarcityPenalty: 0.35,
  models: [
    { model: GLM_MODEL, label: "cheap builder", roles: ["builder", "scout"], quality: 0.72, speed: 0.78, relativeCost: 0.12 },
    { model: GROK_MODEL, label: "fast senior", roles: ["builder", "scout", "reviewer"], quality: 0.9, speed: 0.95, relativeCost: 0.55 },
    { model: TERRA_MODEL, label: "subscription senior", roles: ["builder", "reviewer"], quality: 0.92, speed: 0.48, relativeCost: 0, subscription: true },
    { model: SOL_MODEL, label: "subscription expert", roles: ["builder", "reviewer"], quality: 0.99, speed: 0.38, relativeCost: 0, subscription: true },
  ],
};

export function createProProfile(): AgentProfile {
  return {
    name: PRO_PROFILE_NAME,
    coordinatorModel: SOL_MODEL,
    routing: {
      mode: "utility",
      weights: { cost: 0.45, speed: 0.2, quality: 0.35 },
      subscriptionScarcityPenalty: 0.15,
      models: [
        { model: LUNA_MODEL, label: "trivial scout", roles: ["scout"], quality: 0.72, speed: 0.78, relativeCost: 0.12 },
        {
          model: TERRA_MODEL,
          label: "subscription senior",
          roles: ["builder", "scout", "reviewer"],
          quality: 0.92,
          speed: 0.48,
          relativeCost: 0,
          subscription: true,
        },
        {
          model: SOL_MODEL,
          label: "subscription expert escalation",
          roles: ["builder", "scout", "reviewer"],
          quality: 0.99,
          speed: 0.38,
          relativeCost: 0,
          subscription: true,
          escalationOnly: true,
        },
      ],
    },
  };
}

export function createEconomyProfile(): AgentProfile {
  return {
    name: ECONOMY_PROFILE_NAME,
    coordinatorModel: SOL_MODEL,
    routing: {
      mode: "pinned",
      pins: {
        builder: GLM_MODEL,
        scout: GLM_MODEL,
        reviewer: SOL_MODEL,
      },
    },
  };
}

function cloneRouterModel(model: RouterModel): RouterModel {
  const cloned: RouterModel = {
    model: model.model,
    label: model.label,
    roles: [...model.roles],
    quality: model.quality,
    speed: model.speed,
    relativeCost: model.relativeCost,
  };
  if (model.subscription === true) cloned.subscription = true;
  if (typeof model.enabled === "boolean") cloned.enabled = model.enabled;
  if (model.escalationOnly === true) cloned.escalationOnly = true;
  return cloned;
}

export function createLegacyProfile(v1: RouterConfigV1): AgentProfile {
  return {
    name: LEGACY_PROFILE_NAME,
    coordinatorModel: SOL_MODEL,
    routing: {
      mode: "utility",
      weights: { ...v1.weights },
      subscriptionScarcityPenalty: v1.subscriptionScarcityPenalty,
      models: v1.models.map(cloneRouterModel),
    },
  };
}

export function createDefaultRouterConfig(): RouterConfig {
  return {
    schemaVersion: 2,
    enabled: true,
    activeProfile: PRO_PROFILE_NAME,
    profiles: [createProProfile(), createEconomyProfile()],
  };
}

/** @deprecated Prefer createDefaultRouterConfig; retained for tests comparing v1 defaults. */
export const DEFAULT_ROUTER_CONFIG: RouterConfigV1 = DEFAULT_ROUTER_CONFIG_V1;

export function routerConfigPath(root: string): string {
  return join(rootDir(root), "router.json");
}

export function normalizeProfileName(name: string): string {
  return name.trim().toLowerCase();
}

export function parseModelIdentifier(identifier: string): { provider: string; modelId: string } | undefined {
  const trimmed = identifier.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  // Disallow path-like segments and shell metacharacters in model ids we accept as config keys.
  if (/[\\:\0\n\r\t]/.test(trimmed) || trimmed.includes("..")) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) sorted[key] = (current as Record<string, unknown>)[key];
      return sorted;
    }
    return current;
  });
}

export function isExactDefaultV1(config: RouterConfigV1): boolean {
  const { schemaVersion: _a, enabled: _e, ...rest } = config;
  const { schemaVersion: _b, enabled: _f, ...defaults } = DEFAULT_ROUTER_CONFIG_V1;
  return stableJson(rest) === stableJson(defaults);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRole(value: unknown): value is RouteRole {
  return value === "builder" || value === "scout" || value === "reviewer";
}

function validateModelIdField(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) throw new Error(`Missing or empty ${field}`);
  if (!parseModelIdentifier(value)) throw new Error(`Invalid model identifier for ${field}: ${String(value)}`);
  return value.trim();
}

export function validateUtilityRouting(routing: unknown, label: string): UtilityRouting {
  if (!routing || typeof routing !== "object") throw new Error(`${label}: routing must be an object`);
  const value = routing as Partial<UtilityRouting>;
  if (value.mode !== "utility") throw new Error(`${label}: routing.mode must be "utility"`);
  if (!value.weights || typeof value.weights !== "object") throw new Error(`${label}: routing.weights is required`);
  for (const key of ["cost", "speed", "quality"] as const) {
    if (typeof value.weights[key] !== "number" || !Number.isFinite(value.weights[key])) {
      throw new Error(`${label}: routing.weights.${key} must be a finite number`);
    }
  }
  if (typeof value.subscriptionScarcityPenalty !== "number" || !Number.isFinite(value.subscriptionScarcityPenalty)) {
    throw new Error(`${label}: routing.subscriptionScarcityPenalty must be a finite number`);
  }
  if (!Array.isArray(value.models) || value.models.length === 0) throw new Error(`${label}: routing.models must be a non-empty array`);
  const models: RouterModel[] = value.models.map((model, index) => {
    if (!model || typeof model !== "object") throw new Error(`${label}: models[${index}] must be an object`);
    const entry = model as Partial<RouterModel>;
    const id = validateModelIdField(entry.model, `${label}.models[${index}].model`);
    if (!isNonEmptyString(entry.label)) throw new Error(`${label}: models[${index}].label is required`);
    if (!Array.isArray(entry.roles) || entry.roles.length === 0 || !entry.roles.every(isRole)) {
      throw new Error(`${label}: models[${index}].roles must be a non-empty array of builder|scout|reviewer`);
    }
    for (const numeric of ["quality", "speed", "relativeCost"] as const) {
      if (typeof entry[numeric] !== "number" || !Number.isFinite(entry[numeric])) {
        throw new Error(`${label}: models[${index}].${numeric} must be a finite number`);
      }
    }
    const normalized: RouterModel = {
      model: id,
      label: entry.label.trim(),
      roles: [...entry.roles],
      quality: entry.quality as number,
      speed: entry.speed as number,
      relativeCost: entry.relativeCost as number,
    };
    if (entry.subscription === true) normalized.subscription = true;
    if (typeof entry.enabled === "boolean") normalized.enabled = entry.enabled;
    if (entry.escalationOnly === true) normalized.escalationOnly = true;
    return normalized;
  });
  return {
    mode: "utility",
    weights: {
      cost: value.weights.cost,
      speed: value.weights.speed,
      quality: value.weights.quality,
    },
    subscriptionScarcityPenalty: value.subscriptionScarcityPenalty,
    models,
  };
}

export function validatePinnedRouting(routing: unknown, label: string): PinnedRouting {
  if (!routing || typeof routing !== "object") throw new Error(`${label}: routing must be an object`);
  const value = routing as Partial<PinnedRouting>;
  if (value.mode !== "pinned") throw new Error(`${label}: routing.mode must be "pinned"`);
  if (!value.pins || typeof value.pins !== "object") throw new Error(`${label}: routing.pins is required`);
  const pins = value.pins as Record<string, unknown>;
  const normalized: Record<RouteRole, string> = {
    builder: validateModelIdField(pins.builder, `${label}.pins.builder`),
    scout: validateModelIdField(pins.scout, `${label}.pins.scout`),
    reviewer: validateModelIdField(pins.reviewer, `${label}.pins.reviewer`),
  };
  const extra = Object.keys(pins).filter((key) => !isRole(key));
  if (extra.length) throw new Error(`${label}: routing.pins has invalid role(s): ${extra.join(", ")}`);
  return { mode: "pinned", pins: normalized };
}

export function validateProfile(raw: unknown, index?: number): AgentProfile {
  const label = index === undefined ? "profile" : `profiles[${index}]`;
  if (!raw || typeof raw !== "object") throw new Error(`${label} must be an object`);
  const value = raw as Partial<AgentProfile>;
  if (!isNonEmptyString(value.name)) throw new Error(`${label}.name must be a non-empty string`);
  const name = value.name.trim();
  if (!name) throw new Error(`${label}.name must be a non-empty string`);
  // Profile names are data keys only; reject path/shell fragments.
  if (/[\\/]/.test(name) || name.includes("..") || /[\0\n\r]/.test(name)) {
    throw new Error(`${label}.name contains invalid characters`);
  }
  const coordinatorModel = validateModelIdField(value.coordinatorModel, `${label}.coordinatorModel`);
  if (!value.routing || typeof value.routing !== "object") throw new Error(`${label}.routing is required`);
  const mode = (value.routing as { mode?: unknown }).mode;
  const routing = mode === "pinned"
    ? validatePinnedRouting(value.routing, label)
    : mode === "utility"
      ? validateUtilityRouting(value.routing, label)
      : (() => { throw new Error(`${label}.routing.mode must be "utility" or "pinned"`); })();
  return { name, coordinatorModel, routing };
}

export function validateRouterConfig(raw: unknown): RouterConfig {
  if (!raw || typeof raw !== "object") throw new Error("Router config must be an object");
  const value = raw as Partial<RouterConfig>;
  if (value.schemaVersion !== 2) throw new Error(`Unsupported router schemaVersion: ${String((value as { schemaVersion?: unknown }).schemaVersion)}`);
  if (typeof value.enabled !== "boolean") throw new Error("Router config.enabled must be a boolean");
  if (!Array.isArray(value.profiles)) throw new Error("Router config.profiles must be an array");
  if (value.profiles.length === 0) throw new Error("Router config.profiles must not be empty");
  const profiles = value.profiles.map((profile, index) => validateProfile(profile, index));
  const seen = new Map<string, string>();
  for (const profile of profiles) {
    const key = normalizeProfileName(profile.name);
    if (!key) throw new Error(`Profile name normalizes to empty: ${profile.name}`);
    if (seen.has(key)) throw new Error(`Duplicate profile name after normalization: ${profile.name} conflicts with ${seen.get(key)}`);
    seen.set(key, profile.name);
  }
  if (!isNonEmptyString(value.activeProfile)) throw new Error("Router config.activeProfile is required");
  const active = findProfile(profiles, value.activeProfile);
  if (!active) throw new Error(`Unknown activeProfile: ${value.activeProfile}`);
  return {
    schemaVersion: 2,
    enabled: value.enabled,
    activeProfile: active.name,
    profiles,
  };
}

export function findProfile(profiles: AgentProfile[], name: string): AgentProfile | undefined {
  const key = normalizeProfileName(name);
  return profiles.find((profile) => normalizeProfileName(profile.name) === key);
}

export function getActiveProfile(config: RouterConfig): AgentProfile {
  const profile = findProfile(config.profiles, config.activeProfile);
  if (!profile) throw new Error(`Unknown activeProfile: ${config.activeProfile}`);
  return profile;
}

export function profileReferencedModels(profile: AgentProfile): string[] {
  const models = new Set<string>([profile.coordinatorModel]);
  if (profile.routing.mode === "pinned") {
    for (const model of Object.values(profile.routing.pins)) models.add(model);
  } else {
    for (const entry of profile.routing.models) {
      if (entry.enabled !== false) models.add(entry.model);
    }
  }
  return [...models];
}

export type ModelAuthInspector = {
  find: (provider: string, modelId: string) => { provider: string; id: string } | undefined;
  hasConfiguredAuth: (model: { provider: string; id: string }) => boolean;
};

function sanitizeErrorText(message: string): string {
  return message
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

export function validateProfileModels(profile: AgentProfile, registry: ModelAuthInspector): void {
  for (const identifier of profileReferencedModels(profile)) {
    const parsed = parseModelIdentifier(identifier);
    if (!parsed) throw new Error(sanitizeErrorText(`Invalid model identifier in profile ${profile.name}: ${identifier}`));
    let model: { provider: string; id: string } | undefined;
    try {
      model = registry.find(parsed.provider, parsed.modelId);
    } catch (error: any) {
      throw new Error(sanitizeErrorText(error?.message ?? String(error)));
    }
    if (!model) throw new Error(sanitizeErrorText(`Unknown model in profile ${profile.name}: ${identifier}`));
    let authed = false;
    try {
      authed = registry.hasConfiguredAuth(model);
    } catch (error: any) {
      throw new Error(sanitizeErrorText(error?.message ?? String(error)));
    }
    if (!authed) {
      throw new Error(sanitizeErrorText(`Model is not authenticated in profile ${profile.name}: ${identifier}`));
    }
  }
}

export class ProfileActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(sanitizeErrorText(message));
    this.code = code;
    this.name = "ProfileActivationError";
  }
}

export function migrateV1ToV2(v1: RouterConfigV1): RouterConfig {
  if (v1.schemaVersion !== 1 || !Array.isArray(v1.models)) throw new Error("Invalid schema-version-1 router config");
  const pro = createProProfile();
  const economy = createEconomyProfile();
  if (isExactDefaultV1(v1)) {
    return {
      schemaVersion: 2,
      enabled: v1.enabled,
      activeProfile: PRO_PROFILE_NAME,
      profiles: [pro, economy],
    };
  }
  // Preserve customized policy losslessly as editable Legacy and keep it active.
  const legacy = createLegacyProfile(v1);
  return {
    schemaVersion: 2,
    enabled: v1.enabled,
    activeProfile: LEGACY_PROFILE_NAME,
    profiles: [legacy, pro, economy],
  };
}

function parseV1Config(raw: unknown): RouterConfigV1 {
  if (!raw || typeof raw !== "object") throw new Error("Router config must be an object");
  const value = raw as Partial<RouterConfigV1>;
  if (value.schemaVersion !== 1) throw new Error("Not a schema-version-1 router config");
  if (typeof value.enabled !== "boolean") throw new Error("Router config.enabled must be a boolean");
  const routing = validateUtilityRouting({
    mode: "utility",
    weights: value.weights,
    subscriptionScarcityPenalty: value.subscriptionScarcityPenalty,
    models: value.models,
  }, "v1");
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    weights: routing.weights,
    subscriptionScarcityPenalty: routing.subscriptionScarcityPenalty,
    models: routing.models,
  };
}

export async function loadRouterConfig(root: string): Promise<RouterConfig> {
  const path = routerConfigPath(root);
  if (!(await exists(path))) {
    const fresh = createDefaultRouterConfig();
    await atomicJson(path, fresh);
    return fresh;
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as { schemaVersion?: number };
  if (raw.schemaVersion === 2) {
    const validated = validateRouterConfig(raw);
    // Idempotent: ensure Seeding of Pro/Economy is present never mutates custom active profile.
    return validated;
  }
  if (raw.schemaVersion === 1) {
    const v1 = parseV1Config(raw);
    const migrated = migrateV1ToV2(v1);
    await atomicJson(path, migrated);
    return migrated;
  }
  throw new Error(`Invalid router config schemaVersion at ${path}`);
}

export async function saveRouterConfig(root: string, config: RouterConfig): Promise<void> {
  const validated = validateRouterConfig(config);
  await atomicJson(routerConfigPath(root), validated);
}

export function withActiveProfile(config: RouterConfig, profileName: string): RouterConfig {
  const profile = findProfile(config.profiles, profileName);
  if (!profile) throw new ProfileActivationError("unknown_profile", `Unknown profile: ${profileName}`);
  return { ...config, activeProfile: profile.name };
}

/**
 * Atomically validate and activate a profile in repository config.
 * Coordinator model switching is applied by the caller via setModel after this returns ok.
 * Persistence of activeProfile happens here only after structural+auth validation succeeds.
 */
export async function prepareProfileActivation(
  root: string,
  profileName: string,
  registry: ModelAuthInspector,
): Promise<{ config: RouterConfig; profile: AgentProfile; previous: RouterConfig }> {
  const previous = await loadRouterConfig(root);
  const profile = findProfile(previous.profiles, profileName);
  if (!profile) throw new ProfileActivationError("unknown_profile", `Unknown profile: ${profileName}`);
  try {
    validateProfile(profile);
    validateProfileModels(profile, registry);
  } catch (error: any) {
    throw new ProfileActivationError("validation_failed", error?.message ?? String(error));
  }
  const next = withActiveProfile(previous, profile.name);
  return { config: next, profile, previous };
}

export async function persistActiveProfile(root: string, config: RouterConfig, previous: RouterConfig): Promise<void> {
  try {
    await saveRouterConfig(root, config);
  } catch (error: any) {
    // Best-effort restore of previous on-disk config.
    try { await saveRouterConfig(root, previous); } catch { /* ignore nested */ }
    throw new ProfileActivationError("persistence_failed", error?.message ?? String(error));
  }
}

function classify(request: RouteRequest): RouteDecision["classification"] {
  const text = `${request.title}\n${request.prompt}`.toLowerCase();
  const role: RouteRole = request.profile === "reviewer" || request.profile.startsWith("critique-") ? "reviewer" : request.mode === "write" ? "builder" : "scout";
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

function scoreUtility(
  routing: UtilityRouting,
  role: RouteRole,
  minimum: number,
  prefer: RouteRequest["prefer"],
): { selected?: { model: string; score: number; quality: number; speed: number; effectiveCost: number; eligible: boolean }; candidates: RouteDecision["candidates"]; reason: string } {
  const preference = prefer ?? "balanced";
  const multiplier = preference === "cost" ? { cost: 1.5, speed: 0.7, quality: 0.8 }
    : preference === "speed" ? { cost: 0.8, speed: 1.6, quality: 0.8 }
    : preference === "quality" ? { cost: 0.6, speed: 0.7, quality: 1.7 }
    : { cost: 1, speed: 1, quality: 1 };

  const candidates = routing.models
    .filter((model) => model.enabled !== false && model.roles.includes(role))
    .map((model) => {
      const effectiveCost = Math.min(1, model.relativeCost + (model.subscription ? routing.subscriptionScarcityPenalty : 0));
      const eligible = model.quality >= minimum;
      const score = routing.weights.quality * multiplier.quality * model.quality
        + routing.weights.speed * multiplier.speed * model.speed
        + routing.weights.cost * multiplier.cost * (1 - effectiveCost);
      return {
        model: model.model,
        eligible,
        score: Number(score.toFixed(4)),
        quality: model.quality,
        speed: model.speed,
        effectiveCost,
        escalationOnly: model.escalationOnly === true,
      };
    })
    .sort((a, b) => b.score - a.score);

  const primaryEligible = candidates.filter((candidate) => candidate.eligible && !candidate.escalationOnly);
  const escalationEligible = candidates.filter((candidate) => candidate.eligible && candidate.escalationOnly);
  const selectedFull = primaryEligible[0] ?? escalationEligible.sort((a, b) => b.quality - a.quality)[0]
    ?? candidates.slice().sort((a, b) => b.quality - a.quality)[0];

  const publicCandidates = candidates.map(({ model, eligible, score, quality, speed, effectiveCost }) => ({
    model, eligible, score, quality, speed, effectiveCost,
  }));

  if (!selectedFull) {
    return { candidates: publicCandidates, reason: "No enabled model supports this role; using Pi's default model." };
  }

  const viaEscalation = selectedFull.escalationOnly && primaryEligible.length === 0;
  return {
    selected: selectedFull,
    candidates: publicCandidates,
    reason: viaEscalation
      ? `Escalated ${role} to ${selectedFull.model} because no primary model met quality >= ${minimum.toFixed(2)} (active profile utility routing).`
      : `Selected the highest utility eligible ${role} (quality >= ${minimum.toFixed(2)}) under the active profile; subscription models include a scarcity penalty.`,
  };
}

export function routeTask(
  config: RouterConfig | RouterConfigV1,
  request: RouteRequest,
  explicitModel?: string,
  explicitThinking?: string,
): RouteDecision {
  const classification = classify(request);
  const minimum = requiredQuality(classification, request.attempt);
  const activeProfileName = "activeProfile" in config ? config.activeProfile : undefined;

  if (explicitModel) {
    return {
      schemaVersion: 1,
      timestamp: now(),
      selectedModel: explicitModel,
      thinking: explicitThinking,
      source: "explicit",
      activeProfile: activeProfileName,
      classification,
      requiredQuality: minimum,
      reason: "Caller supplied an explicit model; router recorded but did not override it.",
      candidates: [],
    };
  }

  if (!config.enabled) {
    return {
      schemaVersion: 1,
      timestamp: now(),
      source: "pi-default",
      activeProfile: activeProfileName,
      classification,
      requiredQuality: minimum,
      reason: "Router is disabled; using Pi's default model.",
      candidates: [],
    };
  }

  // Schema v1 path retained for pure unit tests of the legacy utility scorer shape.
  if (config.schemaVersion === 1) {
    const routing: UtilityRouting = {
      mode: "utility",
      weights: config.weights,
      subscriptionScarcityPenalty: config.subscriptionScarcityPenalty,
      models: config.models,
    };
    const result = scoreUtility(routing, classification.role, minimum, request.prefer);
    const thinking = minimum >= 0.95 ? "high" : minimum >= 0.87 ? "medium" : minimum >= 0.78 ? "low" : "minimal";
    return {
      schemaVersion: 1,
      timestamp: now(),
      selectedModel: result.selected?.model,
      thinking,
      source: result.selected ? "router" : "pi-default",
      classification,
      requiredQuality: minimum,
      reason: result.reason,
      candidates: result.candidates,
    };
  }

  let profile: AgentProfile;
  try {
    profile = getActiveProfile(config);
  } catch {
    return {
      schemaVersion: 1,
      timestamp: now(),
      source: "pi-default",
      activeProfile: activeProfileName,
      classification,
      requiredQuality: minimum,
      reason: "Active profile is missing; using Pi's default model.",
      candidates: [],
    };
  }

  if (profile.routing.mode === "pinned") {
    const selectedModel = profile.routing.pins[classification.role];
    const thinking = minimum >= 0.95 ? "high" : minimum >= 0.87 ? "medium" : minimum >= 0.78 ? "low" : "minimal";
    return {
      schemaVersion: 1,
      timestamp: now(),
      selectedModel,
      thinking,
      source: "router",
      activeProfile: profile.name,
      classification,
      requiredQuality: minimum,
      reason: `Pinned ${classification.role} to ${selectedModel} by profile ${profile.name} (complexity/risk/retry ignored unless explicitly overridden).`,
      candidates: [{ model: selectedModel, eligible: true, score: 1, quality: 1, speed: 1, effectiveCost: 0 }],
    };
  }

  const result = scoreUtility(profile.routing, classification.role, minimum, request.prefer);
  const thinking = minimum >= 0.95 ? "high" : minimum >= 0.87 ? "medium" : minimum >= 0.78 ? "low" : "minimal";
  return {
    schemaVersion: 1,
    timestamp: now(),
    selectedModel: result.selected?.model,
    thinking,
    source: result.selected ? "router" : "pi-default",
    activeProfile: profile.name,
    classification,
    requiredQuality: minimum,
    reason: `${result.reason} [profile=${profile.name}]`,
    candidates: result.candidates,
  };
}

export function formatActiveProfileStatus(config: RouterConfig): string {
  try {
    const profile = getActiveProfile(config);
    return `agent-profile: ${profile.name} (coordinator ${profile.coordinatorModel})`;
  } catch {
    return "agent-profile: unavailable";
  }
}

/** Resolve a safe display token for status surfaces (never a path). */
export function statusProfileLabel(name: string | undefined): string {
  if (!name) return "none";
  try {
    return safeId(name, "profile name");
  } catch {
    return "invalid";
  }
}
