import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { featureDir } from "./storage.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(MODULE_DIR, "../..");
const CLI = join(PACKAGE_ROOT, "requirements/src/cli.ts");

export function requirementsDir(root: string, featureId: string): string {
  return join(featureDir(root, featureId), "requirements");
}

export function requirementsCliPath(): string {
  return CLI;
}

export async function runRequirementsCli(
  args: string[],
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!existsSync(CLI)) throw new Error(`Requirements CLI missing at ${CLI}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function ensureRequirementsSession(
  root: string,
  featureId: string,
  featureName: string,
  tier = "medium",
): Promise<string> {
  const dir = requirementsDir(root, featureId);
  await mkdir(dir, { recursive: true });
  const hasState = existsSync(join(dir, "requirements.json")) && existsSync(join(dir, "decision-log.json"));
  if (!hasState) {
    const result = await runRequirementsCli(["init", featureName, "--tier", tier, "--dir", dir], root);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "requirements init failed");
  }
  return dir;
}

export async function requirementsStatus(root: string, featureId: string): Promise<{
  exists: boolean;
  dir: string;
  valid?: boolean;
  handoffReady?: boolean;
  reportText?: string;
  handoffPath?: string;
  forced?: boolean;
}> {
  const dir = requirementsDir(root, featureId);
  if (!existsSync(join(dir, "requirements.json"))) {
    return { exists: false, dir };
  }
  const validate = await runRequirementsCli(["validate", "--dir", dir], root);
  const text = `${validate.stdout}\n${validate.stderr}`.trim();
  const handoffReady = /handoffReady:\s*true/.test(text);
  const valid = /valid:\s*true/.test(text);
  const handoffPath = join(dir, "handoff.md");
  const forced = existsSync(handoffPath)
    ? (await readFile(handoffPath, "utf8")).includes("READINESS OPT-OUT (NON-ATTESTED)")
    : false;
  return { exists: true, dir, valid, handoffReady, reportText: text, handoffPath: existsSync(handoffPath) ? handoffPath : undefined, forced };
}

export async function renderRequirementsArtifacts(
  root: string,
  featureId: string,
  options: { force?: boolean } = {},
): Promise<{ dir: string; specPath: string; handoffPath: string; forced: boolean }> {
  const dir = requirementsDir(root, featureId);
  const specPath = join(dir, "spec.md");
  const handoffPath = join(dir, "handoff.md");
  const spec = await runRequirementsCli(["render-spec", "--dir", dir, "--out", specPath], root);
  if (spec.code !== 0) throw new Error(spec.stderr || spec.stdout || "render-spec failed");

  const handoffArgs = ["render-handoff", "--dir", dir, "--out", handoffPath];
  if (options.force) handoffArgs.push("--force");
  const handoff = await runRequirementsCli(handoffArgs, root);
  if (handoff.code !== 0) throw new Error(handoff.stderr || handoff.stdout || "render-handoff failed");
  const renderedText = await readFile(handoffPath, "utf8");
  const forced = renderedText.includes("READINESS OPT-OUT (NON-ATTESTED)");
  return { dir, specPath, handoffPath, forced };
}

export async function assertWriteGate(
  root: string,
  featureId: string,
  options: { force?: boolean } = {},
): Promise<{ handoffPath: string; forced: boolean }> {
  const status = await requirementsStatus(root, featureId);
  if (!status.exists) {
    throw new Error(`Requirements package missing for ${featureId}. Start the automatic requirements workflow or use agent_requirements first.`);
  }
  if (!status.handoffReady) {
    throw new Error(`Requirements not handoff-ready for ${featureId}. A force flag is not risk acceptance; only an explicit eligible readinessOptOut in state can bypass attestation.\n${status.reportText ?? ""}`.trim());
  }
  if (!status.handoffPath || options.force || status.forced) {
    const rendered = await renderRequirementsArtifacts(root, featureId, { force: options.force });
    return { handoffPath: rendered.handoffPath, forced: rendered.forced || Boolean(status.forced) };
  }
  return { handoffPath: status.handoffPath, forced: Boolean(status.forced) };
}
