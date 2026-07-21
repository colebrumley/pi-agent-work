import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStatusFooter } from "./status-footer.ts";

const root = await mkdtemp(join(tmpdir(), "agent-work-footer-integration-"));
execFileSync("git", ["init", "-q"], { cwd: root });
await mkdir(join(root, ".agent-work"), { recursive: true });
await writeFile(join(root, ".agent-work", "routing-decisions.jsonl"), [
  JSON.stringify({ type: "outcome", sessionId: "prior", model: "openrouter/worker", usage: { cost: 2 } }),
  JSON.stringify({ type: "outcome", sessionId: "current", model: "openrouter/worker", usage: { cost: 0.25 } }),
].join("\n"), "utf8");

const handlers = new Map<string, Function>();
let footerFactory: any;
registerStatusFooter({ on(name: string, handler: Function) { handlers.set(name, handler); } } as any);
const baseCtx = (sessionId: string, directOpenRouterCost = 0) => ({
  cwd: root,
  model: undefined,
  getContextUsage: () => undefined,
  sessionManager: {
    getSessionId: () => sessionId,
    getEntries: () => directOpenRouterCost ? [{
      type: "message",
      message: {
        role: "assistant", provider: "openrouter", usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: directOpenRouterCost },
        },
      },
    }] : [], getSessionName: () => undefined, buildSessionContext: () => ({ thinkingLevel: "off" }),
  },
  ui: { setFooter(factory: any) { footerFactory = factory; } },
});
const footerData = { onBranchChange: () => () => {}, getGitBranch: () => undefined, getExtensionStatuses: () => new Map() };
const tui = { requestRender() {} };
const theme = { fg: (_style: string, text: string) => text };

await handlers.get("session_start")!({}, baseCtx("fresh"));
let footer = footerFactory(tui, theme, footerData);
assert.match(footer.render(120)[0], /OR \$0\.000/);
assert.doesNotMatch(footer.render(120)[0], /agents \$/);
assert.match(footer.render(120)[0], /Tokens no usage/);
footer.dispose();

await handlers.get("session_start")!({}, baseCtx("current", 0.125));
footer = footerFactory(tui, theme, footerData);
assert.match(footer.render(120)[0], /OR \$0\.375 · agents \$0\.250/, "OR combines current direct and delegated spend only");
footer.dispose();
console.log("status footer integration rendering tests passed");
