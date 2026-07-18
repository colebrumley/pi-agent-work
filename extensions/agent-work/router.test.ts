import assert from "node:assert/strict";
import { DEFAULT_ROUTER_CONFIG, routeTask } from "./router.ts";

const base = { mode: "write" as const, profile: "worker", attempt: 1 };

const tiny = routeTask(DEFAULT_ROUTER_CONFIG, { ...base, taskId: "tiny", title: "Fix typo", prompt: "Rename a label" });
assert.equal(tiny.selectedModel, "openrouter/z-ai/glm-5.2");

const medium = routeTask(DEFAULT_ROUTER_CONFIG, { ...base, taskId: "medium", title: "API integration", prompt: "Implement this across multiple files" });
assert.equal(medium.selectedModel, "openrouter/x-ai/grok-4.5");

const corrected = routeTask(DEFAULT_ROUTER_CONFIG, { ...base, taskId: "retry", title: "Security migration", prompt: "Migrate authentication", attempt: 3 });
assert.equal(corrected.selectedModel, "openai-codex/gpt-5.6-sol");
assert.equal(corrected.requiredQuality, 0.98);

const explicit = routeTask(DEFAULT_ROUTER_CONFIG, { ...base, taskId: "override", title: "Anything", prompt: "Anything" }, "provider/model", "off");
assert.equal(explicit.source, "explicit");
assert.equal(explicit.selectedModel, "provider/model");

console.log("router tests passed");
