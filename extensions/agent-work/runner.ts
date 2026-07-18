import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BUILDER_CONTRACT, CRITICAL_FEEDBACK_PROTOCOL } from "./policy.ts";
import type { RunResult, UsageRecord } from "./types.ts";

export function piInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !bunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

export async function runPi(options: {
  cwd: string;
  args: string[];
  eventsFile: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<RunResult> {
  await mkdir(join(options.eventsFile, ".."), { recursive: true });
  const invocation = piInvocation(options.args);
  let stderr = "";
  let buffer = "";
  let finalText = "";
  let sessionId: string | undefined;
  let aborted = false;
  const usage: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const consume = (line: string) => {
      if (!line.trim()) return;
      appendFileSync(options.eventsFile, `${line}\n`, "utf8");
      try {
        const event = JSON.parse(line);
        if (event.type === "session" && typeof event.id === "string") sessionId = event.id;
        if (event.type === "message_end") {
          const text = assistantText(event.message);
          if (event.message?.role === "assistant") {
            usage.turns++;
            usage.input += event.message.usage?.input ?? 0;
            usage.output += event.message.usage?.output ?? 0;
            usage.cacheRead += event.message.usage?.cacheRead ?? 0;
            usage.cacheWrite += event.message.usage?.cacheWrite ?? 0;
            usage.cost += event.message.usage?.cost?.total ?? 0;
          }
          if (text) {
            finalText = text;
            options.onProgress?.(text.slice(-1000));
          }
        }
      } catch {
        // Preserve malformed lines in the event log; stderr will carry process errors.
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) consume(buffer);
      resolve(code ?? 1);
    });

    const kill = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000).unref();
    };
    if (options.signal?.aborted) kill();
    else options.signal?.addEventListener("abort", kill, { once: true });
  });

  if (aborted) throw new Error("Subagent aborted");
  return { exitCode, stderr, finalText, sessionId, usage };
}

export async function writeSystemPrompt(
  path: string,
  profile: string,
  handoffPath: string,
  mode: "read" | "write",
  extra = "",
): Promise<void> {
  const role = profile === "reviewer" || profile.startsWith("critique-")
    ? "You are an adversarial reviewer. Inspect the target and report concrete evidence-backed findings. Do not modify project files."
    : profile === "scout"
      ? "You are a codebase scout. Locate relevant code and return compressed, evidence-backed context. Do not modify project files."
      : "You are an implementation worker. Complete the delegated task autonomously, keep scope tight, and run relevant checks.";
  const mutationRule = mode === "read"
    ? "This is a read-only task. Do not modify files, install packages, or run mutating shell commands."
    : "Do not commit changes; the coordinator owns commits and integration.";
  const handoffRule = mode === "write"
    ? `Before finishing, write valid JSON to ${handoffPath} using the handoff contract below.`
    : "Your entire final response must be the handoff JSON below (without a Markdown fence); changedFiles must be empty. The coordinator will persist it.";
  const extras = [CRITICAL_FEEDBACK_PROTOCOL, mode === "write" ? BUILDER_CONTRACT : "", extra].filter(Boolean).join("\n\n");

  const content = `${role}

${mutationRule}
${handoffRule}
Do not expose hidden chain-of-thought. Record concise decisions, rationale, evidence, checks, risks, and blockers instead.

${extras}

Handoff contract:
\`\`\`json
{
  "schemaVersion": 1,
  "featureId": "provided in task",
  "taskId": "provided in task",
  "attempt": 1,
  "status": "done | blocked | failed",
  "summary": "concise result",
  "changedFiles": [{"path": "relative/path", "summary": "change"}],
  "checks": [{"command": "command", "status": "passed | failed | not-run", "exitCode": 0, "evidence": "short evidence"}],
  "decisions": [{"decision": "choice", "rationale": "why"}],
  "risks": [],
  "blockers": [],
  "nextSteps": [],
  "session": {"eventsFile": "filled by coordinator"},
  "createdAt": "ISO-8601"
}
\`\`\`
`;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}
