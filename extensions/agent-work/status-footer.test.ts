import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentOpenRouterCost } from "./footer-cost.ts";

const root = await mkdtemp(join(tmpdir(), "agent-work-footer-"));
const path = join(root, ".agent-work", "routing-decisions.jsonl");
await mkdir(join(root, ".agent-work"), { recursive: true });
const lines = [
  { type: "outcome", sessionId: "source", model: "openrouter/a", usage: { cost: 0.125 } },
  { type: "outcome", sessionId: "target", model: "openrouter/b", usage: { cost: 0.25 } },
  { type: "outcome", sessionId: "target", model: "openrouter/c", usage: { cost: 0.5 } },
  { type: "outcome", sessionId: "target", model: "other/model", usage: { cost: 99 } },
  { type: "outcome", model: "openrouter/legacy", usage: { cost: 99 } },
  { type: "route", sessionId: "target", model: "openrouter/route", usage: { cost: 99 } },
  { type: "outcome", sessionId: "target", model: "openrouter/bad", usage: { cost: "0.9" } },
  { type: "outcome", sessionId: "target", model: "openrouter/negative", usage: { cost: -1 } },
  "{partial",
].map((line) => typeof line === "string" ? line : JSON.stringify(line));
await writeFile(path, `${lines.join("\n")}\n`, "utf8");
const before = await readFile(path, "utf8");

assert.equal(await readAgentOpenRouterCost(root, "fresh"), 0, "fresh/new/fork/clone identities exclude prior outcomes");
assert.equal(await readAgentOpenRouterCost(root, "target"), 0.75, "current session includes only its valid OpenRouter outcomes");
assert.equal(await readAgentOpenRouterCost(root, "source"), 0.125, "resuming a session restores its own subtotal");
assert.equal(await readAgentOpenRouterCost(root, undefined), 0, "missing identity fails closed");
assert.equal(await readFile(path, "utf8"), before, "footer reads telemetry without mutation");
console.log("status footer session attribution tests passed");
