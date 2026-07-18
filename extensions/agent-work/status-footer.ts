import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

type GitSnapshot = {
  root?: string;
  repo?: string;
  sha?: string;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
};

const emptyGit = (): GitSnapshot => ({ staged: 0, modified: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, hasUpstream: false });

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}

export function parsePorcelain(text: string): Pick<GitSnapshot, "staged" | "modified" | "untracked" | "conflicted"> {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const state = line.slice(0, 2);
    if (state === "??") untracked++;
    else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(state)) conflicted++;
    else {
      if (state[0] && state[0] !== " ") staged++;
      if (state[1] && state[1] !== " ") modified++;
    }
  }
  return { staged, modified, untracked, conflicted };
}

async function readGitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [sha, porcelain, divergence] = await Promise.all([
      git(root, ["rev-parse", "--short", "HEAD"]).catch(() => ""),
      git(root, ["status", "--porcelain"]).catch(() => ""),
      git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => ""),
    ]);
    const [behind = 0, ahead = 0] = divergence.split(/\s+/).map(Number);
    return { root, repo: basename(root), sha, ...parsePorcelain(porcelain), ahead, behind, hasUpstream: Boolean(divergence) };
  } catch {
    return emptyGit();
  }
}

async function readAgentOpenRouterCost(root?: string): Promise<number> {
  if (!root) return 0;
  try {
    const text = await readFile(join(root, ".agent-work", "routing-decisions.jsonl"), "utf8");
    let total = 0;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record.type === "outcome" && String(record.model).startsWith("openrouter/")) {
          total += Number(record.usage?.cost) || 0;
        }
      } catch {
        // Ignore a partial or malformed telemetry line.
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function usage(ctx: ExtensionContext) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let openRouterCost = 0;
  let cacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    input += message.usage.input;
    output += message.usage.output;
    cacheRead += message.usage.cacheRead;
    cacheWrite += message.usage.cacheWrite;
    const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    cacheHitRate = promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
    if (message.provider === "openrouter") openRouterCost += message.usage.cost.total;
  }
  return { input, output, cacheRead, cacheWrite, openRouterCost, cacheHitRate };
}

function joinSides(left: string, right: string, width: number): string {
  if (width < 4) return truncateToWidth(left, width, "");
  const rightBudget = Math.min(visibleWidth(right), Math.max(1, Math.min(width - 2, Math.max(12, Math.floor(width * 0.45)))));
  const fittedRight = truncateToWidth(right, rightBudget, "");
  const leftBudget = Math.max(0, width - visibleWidth(fittedRight) - 2);
  const fittedLeft = truncateToWidth(left, leftBudget, "...");
  return fittedLeft + " ".repeat(Math.max(2, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight))) + fittedRight;
}

export function registerStatusFooter(pi: ExtensionAPI): void {
  let gitState = emptyGit();
  let agentOpenRouterCost = 0;
  let requestRender: (() => void) | undefined;
  let generation = 0;

  const refresh = async (ctx: ExtensionContext) => {
    const currentGeneration = generation;
    const nextGit = await readGitSnapshot(ctx.cwd);
    const nextCost = await readAgentOpenRouterCost(nextGit.root);
    if (currentGeneration !== generation) return;
    gitState = nextGit;
    agentOpenRouterCost = nextCost;
    requestRender?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    generation++;
    await refresh(ctx);
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => {
        void refresh(ctx);
      });
      return {
        dispose() {
          unsubscribe();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const totals = usage(ctx);
          const context = ctx.getContextUsage();
          const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const percent = context?.percent;
          const separator = theme.fg("dim", " │ ");
          const contextLabel = width >= 90 ? "Context " : "";
          const contextValue = percent == null
            ? `${contextLabel}○ ? / ${formatTokens(contextWindow)}`
            : `${contextLabel}● ${percent.toFixed(1)}% · ${formatTokens(context.tokens)}/${formatTokens(contextWindow)}`;
          const coloredContext = percent == null
            ? theme.fg("dim", contextValue)
            : percent > 90
              ? theme.fg("error", contextValue)
              : percent > 70
                ? theme.fg("warning", contextValue)
                : theme.fg("success", contextValue);

          const realCost = totals.openRouterCost + agentOpenRouterCost;
          const costDetail = width >= 115 && agentOpenRouterCost > 0 ? ` · agents $${agentOpenRouterCost.toFixed(3)}` : "";
          const costPart = theme.fg("accent", `OR $${realCost.toFixed(3)}${costDetail}`);
          const tokenValues = [
            totals.input ? `↑${formatTokens(totals.input)}` : "",
            totals.output ? `↓${formatTokens(totals.output)}` : "",
            totals.cacheRead ? `R${formatTokens(totals.cacheRead)}` : "",
            totals.cacheWrite ? `W${formatTokens(totals.cacheWrite)}` : "",
            totals.cacheHitRate != null && (totals.cacheRead || totals.cacheWrite) ? `CH ${totals.cacheHitRate.toFixed(0)}%` : "",
          ].filter(Boolean).join(" ");
          const tokenPart = theme.fg("dim", `${width >= 100 ? "Tokens " : ""}${tokenValues || "no usage"}`);
          const usageLine = truncateToWidth([coloredContext, costPart, tokenPart].join(separator), width, theme.fg("dim", "..."));

          const branch = footerData.getGitBranch();
          const repoPath = gitState.root && gitState.repo
            ? `${gitState.repo}${ctx.cwd === gitState.root ? "" : `/${relative(gitState.root, ctx.cwd)}`}`
            : ctx.cwd;
          const repoIdentity = theme.fg("text", `${repoPath}${branch ? ` · ${branch}` : ""}${gitState.sha ? ` @${gitState.sha}` : ""}`);
          const changeCount = gitState.staged + gitState.modified + gitState.untracked;
          const worktreeState = gitState.conflicted
            ? theme.fg("error", `✕ ${gitState.conflicted} conflict${gitState.conflicted === 1 ? "" : "s"}`)
            : changeCount
              ? theme.fg("warning", `● ${gitState.staged ? `${gitState.staged} staged ` : ""}${gitState.modified ? `${gitState.modified} modified ` : ""}${gitState.untracked ? `${gitState.untracked} new` : ""}`.trim())
              : gitState.root
                ? theme.fg("success", "✓ clean")
                : theme.fg("dim", "○ no git");
          const syncState = !gitState.hasUpstream
            ? theme.fg("dim", "no upstream")
            : gitState.ahead && gitState.behind
              ? theme.fg("error", `diverged ↑${gitState.ahead} ↓${gitState.behind}`)
              : gitState.behind
                ? theme.fg("warning", `behind ↓${gitState.behind}`)
                : gitState.ahead
                  ? theme.fg("warning", `ahead ↑${gitState.ahead}`)
                  : theme.fg("success", "synced");
          const sessionName = ctx.sessionManager.getSessionName();
          const repoLine = [repoIdentity, worktreeState, syncState, sessionName ? theme.fg("accent", sessionName) : ""].filter(Boolean).join(separator);

          const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
          const thinking = ctx.model?.reasoning ? ctx.sessionManager.buildSessionContext().thinkingLevel : undefined;
          const modelPart = theme.fg("dim", thinking ? `${model} · ${thinking}` : model);
          const lines = [usageLine, joinSides(repoLine, modelPart, width)];

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitize(text));
          if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
          return lines;
        },
      };
    });
  });

  pi.on("agent_settled", async (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    requestRender = undefined;
    ctx.ui.setFooter(undefined);
  });
}
