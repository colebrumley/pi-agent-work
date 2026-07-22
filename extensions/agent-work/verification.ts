import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RequirementsState, AdversarialCategory } from "../../requirements/src/types.ts";

const execFileAsync = promisify(execFile);
export const VERIFICATION_SCHEMA_VERSION = 2;
export const MAX_EVIDENCE_SUMMARY = 4_000;
const SECRET_PATTERN = String.raw`authorization\s*[:=]\s*bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[^\s'"]+|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`;
const SECRET = new RegExp(`(${SECRET_PATTERN})`, "gi");
const SECRET_DETECT = new RegExp(`(${SECRET_PATTERN})`, "i");
const MAX_ARTIFACT_BYTES = 2_000_000;

export interface ArtifactReference { path: string; sha256: string }
export interface TestEvidence {
  testId: string;
  command: string;
  result: "passed" | "failed" | "not-run";
  environment: string;
  scenarios: AdversarialCategory[];
  summary: string;
  artifact?: ArtifactReference;
}
export interface BuilderEvidence {
  schemaVersion: 2;
  requirementsRevision: string;
  implementationCommit: string;
  tests: TestEvidence[];
}
export interface VerificationTestResult {
  testId: string;
  status: "passed" | "failed" | "approved-exception";
  command?: string;
  evidenceAssessment: string;
  artifact?: ArtifactReference;
  startingCommit?: string;
  startingSnapshotHash?: string;
  isolatedWorktree?: string;
  mutationDetected?: boolean;
}
export function evidenceResultForVerificationStatus(status: VerificationTestResult["status"]): "passed" | "failed" | "not-run" {
  return status === "passed" ? "passed" : status === "approved-exception" ? "not-run" : "failed";
}

export function evidenceResultForLayerStatus(status: FidelityLayerEvidence["status"]): "passed" | "failed" | "not-run" {
  return status === "passed" ? "passed" : status === "approved-unavailable" ? "not-run" : "failed";
}

export interface VerificationFinding {
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "resolved" | "false-positive";
  summary: string;
}
export interface VerificationReport {
  schemaVersion: 2;
  requirementsRevision: string;
  reviewedCommit: string;
  generatedAt: string;
  tests: VerificationTestResult[];
  findings: VerificationFinding[];
  evidenceComplete: boolean;
  approved: boolean;
}

export interface FidelityLayerEvidence {
  layer: string;
  applicable: boolean;
  rationale: string;
  status: "passed" | "approved-unavailable" | "missing";
  testIds: string[];
}

export function assessFidelityLayers(requirements: RequirementsState, tests: VerificationTestResult[]): { layers: FidelityLayerEvidence[]; blockers: string[] } {
  const resultById = new Map(tests.map((test) => [test.testId, test]));
  const blockers: string[] = [];
  const layers = requirements.testingStandards.fidelity.map((assessment): FidelityLayerEvidence => {
    const layerTests = requirements.acceptanceTests.filter((test) => test.fidelityLayer === assessment.name);
    if (!assessment.applicable) {
      if (!assessment.rationale.trim()) blockers.push(`${assessment.name} requires an explicit unavailability rationale`);
      return { layer: assessment.name, applicable: false, rationale: assessment.rationale, status: assessment.rationale.trim() ? "approved-unavailable" : "missing", testIds: [] };
    }
    const results = layerTests.map((test) => resultById.get(test.id));
    const passing = layerTests.length > 0 && results.every((result) => result?.status === "passed" || result?.status === "approved-exception");
    const approvedUnavailable = passing && results.some((result) => result?.status === "approved-exception");
    if (!passing) blockers.push(`${assessment.name} lacks corresponding passing acceptance evidence or an exact-current approved exception`);
    return { layer: assessment.name, applicable: true, rationale: assessment.rationale, status: approvedUnavailable ? "approved-unavailable" : passing ? "passed" : "missing", testIds: layerTests.map((test) => test.id) };
  });
  return { layers, blockers };
}

export function finalWorkspaceBlockers(expectedCommit: string, actualCommit: string, porcelainStatus: string): string[] {
  const blockers: string[] = [];
  if (actualCommit !== expectedCommit) blockers.push("coordinator HEAD does not match the exact final-gate commit");
  if (porcelainStatus.trim()) blockers.push("final-gate coordinator worktree is dirty; clean it before attributing evidence to HEAD");
  return blockers;
}

export function sanitizeSummary(value: string): string {
  return value.replace(SECRET, "[REDACTED]").slice(0, MAX_EVIDENCE_SUMMARY);
}

export async function hashFile(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

export async function validateBuilderEvidence(
  requirements: RequirementsState,
  raw: unknown,
  expectedCommit?: string,
  requiredTestIds?: readonly string[],
): Promise<{ valid: boolean; issues: string[]; evidence?: BuilderEvidence }> {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object") return { valid: false, issues: ["builder evidence is missing or not an object"] };
  const source = raw as any;
  const evidence: BuilderEvidence = {
    schemaVersion: source.schemaVersion,
    requirementsRevision: String(source.requirementsRevision ?? ""),
    implementationCommit: String(source.implementationCommit ?? ""),
    tests: Array.isArray(source.tests) ? source.tests.map((item: any) => ({
      testId: String(item?.testId ?? ""), command: String(item?.command ?? ""), result: item?.result,
      environment: String(item?.environment ?? ""), scenarios: Array.isArray(item?.scenarios) ? item.scenarios : [],
      summary: String(item?.summary ?? ""),
      ...(item?.artifact ? { artifact: { path: String(item.artifact.path ?? ""), sha256: String(item.artifact.sha256 ?? "") } } : {}),
    })) : [],
  };
  if (evidence.schemaVersion !== VERIFICATION_SCHEMA_VERSION) issues.push("builder evidence must use schemaVersion 2");
  if (evidence.requirementsRevision !== requirements.requirementsRevision) issues.push("builder evidence requirements revision is stale");
  if (expectedCommit && evidence.implementationCommit !== expectedCommit) issues.push("builder evidence implementation commit does not match current commit");
  if (!Array.isArray(source.tests)) issues.push("builder evidence tests must be an array");
  else {
    for (const item of evidence.tests) {
      item.summary = sanitizeSummary(String(item.summary ?? ""));
      item.environment = sanitizeSummary(String(item.environment ?? ""));
      item.command = String(item.command ?? "").slice(0, 2_000);
    }
    const byId = new Map(evidence.tests.map((item) => [item.testId, item]));
    const requiredIds = requiredTestIds ? new Set(requiredTestIds) : undefined;
    for (const test of requirements.acceptanceTests.filter((item) => !requiredIds || requiredIds.has(item.id))) {
      const exception = requirements.testExceptions.find((item) => item.testId === test.id && item.explicitUserApproval && item.requirementsRevision === requirements.requirementsRevision && (!item.implementationCommit || !expectedCommit || item.implementationCommit === expectedCommit));
      const item = byId.get(test.id);
      if (!item && !exception) { issues.push(`missing evidence for ${test.id}`); continue; }
      if (!item) continue;
      if (!item.command || !item.environment || !item.summary) issues.push(`${test.id} requires command, environment, and relevant output summary`);
      if (item.result !== "passed" && !exception) issues.push(`${test.id} did not pass and has no valid approved exception`);
      for (const category of test.categories) if (!item.scenarios?.includes(category)) issues.push(`${test.id} lacks scenario coverage: ${category}`);
      if (item.artifact) {
        if (!item.artifact.path || item.artifact.path.startsWith("/") || item.artifact.path.split(/[\\/]/).includes("..")) { issues.push(`${test.id} artifact must be a relative in-worktree regular file path`); continue; }
        const artifactPath = resolve(item.artifact.path);
        if (!existsSync(artifactPath)) issues.push(`${test.id} artifact does not exist: ${item.artifact.path}`);
        else {
          const link = lstatSync(artifactPath);
          if (!link.isFile() || link.isSymbolicLink()) { issues.push(`${test.id} artifact must be a regular non-symlink file`); continue; }
          const info = await stat(artifactPath);
          if (info.size > MAX_ARTIFACT_BYTES) issues.push(`${test.id} artifact exceeds bounded ${MAX_ARTIFACT_BYTES}-byte limit`);
          else if (SECRET_DETECT.test(await readFile(artifactPath, "utf8"))) issues.push(`${test.id} artifact contains a detected secret and must be sanitized`);
          if (await hashFile(artifactPath) !== item.artifact.sha256) issues.push(`${test.id} artifact hash mismatch`);
        }
      }
    }
  }
  return { valid: issues.length === 0, issues, evidence };
}

export interface VerificationRunProgress {
  testId: string;
  completed: number;
  total: number;
  status: "running" | VerificationTestResult["status"];
}

async function filesystemSnapshot(root: string): Promise<string> {
  const hash = createHash("sha256").update("recursive-worktree-v1\0");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const name = relative(root, path);
      if (name === ".git" || name.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`)) continue;
      hash.update(name).update("\0");
      const info = await lstat(path);
      if (info.isSymbolicLink()) hash.update("symlink\0").update(await readlink(path));
      else if (info.isDirectory()) { hash.update("dir\0"); await visit(path); }
      else if (info.isFile()) hash.update("file\0").update(await readFile(path));
      else hash.update(`other:${info.mode}\0`);
    }
  };
  await visit(root); return `sha256:${hash.digest("hex")}`;
}

async function isolatedExactCommand(repository: string, commit: string, command: string, signal?: AbortSignal): Promise<Omit<VerificationTestResult, "testId">> {
  const parent = await mkdtemp(join(tmpdir(), "agent-final-check-")); const worktree = join(parent, "worktree");
  let watcher: ReturnType<typeof watch> | undefined; const controller = new AbortController(); let mutation = false; let mutationPath = "";
  const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", "--quiet", worktree, commit], { cwd: repository, signal });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
    const status = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree })).stdout.trim();
    if (head !== commit || status) throw new Error("disposable final-check worktree is not the exact clean starting commit");
    const startingSnapshotHash = await filesystemSnapshot(worktree);
    watcher = watch(worktree, { recursive: true }, (_event, filename) => {
      const changed = String(filename ?? "");
      if (!changed || changed === ".git" || changed.startsWith(".git/") || changed.startsWith(".git\\")) return;
      mutation = true; mutationPath ||= changed; controller.abort();
    });
    try {
      const packageScript = command.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/);
      if (packageScript) {
        const packageJson = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"));
        if (!packageJson?.scripts || typeof packageJson.scripts[packageScript[1]] !== "string") throw new Error(`package script ${packageScript[1]} is absent in the exact verification worktree`);
      }
      const result = await execFileAsync("/bin/sh", ["-lc", command], { cwd: worktree, timeout: 120_000, maxBuffer: 2_000_000, signal: controller.signal });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      const endingSnapshotHash = await filesystemSnapshot(worktree);
      if (mutation || endingSnapshotHash !== startingSnapshotHash) throw new Error(`final acceptance command mutated disposable source state${mutationPath ? ` at ${mutationPath}` : ""}`);
      return { status: "passed", command, evidenceAssessment: sanitizeSummary(result.stdout || result.stderr || "Command exited 0."), startingCommit: commit, startingSnapshotHash, isolatedWorktree: "disposable-exact-commit", mutationDetected: false };
    } catch (error: any) {
      if (signal?.aborted && !mutation) throw new Error("Acceptance verification aborted");
      return { status: "failed", command, evidenceAssessment: sanitizeSummary(mutation ? `Filesystem mutation event detected outside .git: ${mutationPath || "unknown path"}` : [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n")), startingCommit: commit, startingSnapshotHash, isolatedWorktree: "disposable-exact-commit", mutationDetected: mutation };
    }
  } finally {
    watcher?.close(); signal?.removeEventListener("abort", abort);
    await execFileAsync("git", ["worktree", "remove", "--force", worktree], { cwd: repository }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

export async function rerunAcceptanceTests(
  requirements: RequirementsState,
  evidence: BuilderEvidence,
  cwd: string,
  commit: string,
  findings: VerificationFinding[] = [],
  options: { signal?: AbortSignal; onProgress?: (progress: VerificationRunProgress) => void | Promise<void>; testIds?: readonly string[]; canonicalCommands?: ReadonlyMap<string, string>; requireCanonicalCommands?: boolean; isolateExactCommit?: boolean } = {},
): Promise<VerificationReport> {
  const tests: VerificationTestResult[] = [];
  const selectedIds = options.testIds ? new Set(options.testIds) : undefined;
  const selectedTests = requirements.acceptanceTests.filter((test) => !selectedIds || selectedIds.has(test.id));
  const total = selectedTests.length;
  for (const test of selectedTests) {
    if (options.signal?.aborted) throw new Error("Acceptance verification aborted");
    await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: "running" });
    const exception = requirements.testExceptions.find((item) => item.testId === test.id && item.explicitUserApproval && item.requirementsRevision === requirements.requirementsRevision && (!item.implementationCommit || item.implementationCommit === commit));
    const prior = evidence.tests.find((item) => item.testId === test.id);
    const canonicalCommand = options.canonicalCommands?.get(test.id);
    if (exception && (!prior || prior.result === "not-run")) {
      tests.push({ testId: test.id, status: "approved-exception", evidenceAssessment: sanitizeSummary(`Approved by ${exception.approvedBy}; substitute: ${exception.substituteVerification}; residual risk: ${exception.residualRisk}`) });
      await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: "approved-exception" });
      continue;
    }
    if ((!canonicalCommand && options.requireCanonicalCommands) || (!canonicalCommand && !prior?.command)) {
      tests.push({ testId: test.id, status: "failed", evidenceAssessment: "No persisted coordinator-owned canonical acceptance command exists; legacy run must be resubmitted with acceptanceChecks." });
      await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: "failed" });
      continue;
    }
    try {
      const command = canonicalCommand ?? prior!.command;
      if (options.isolateExactCommit) tests.push({ testId: test.id, ...(await isolatedExactCommand(cwd, commit, command, options.signal)) });
      else {
        const packageScript = command.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/);
        if (packageScript) {
          const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8"));
          if (!packageJson?.scripts || typeof packageJson.scripts[packageScript[1]] !== "string") throw new Error(`package script ${packageScript[1]} is absent in the exact verification worktree`);
        }
        const result = await execFileAsync("/bin/sh", ["-lc", command], { cwd, timeout: 120_000, maxBuffer: 2_000_000, signal: options.signal });
        tests.push({ testId: test.id, status: "passed", command, evidenceAssessment: sanitizeSummary(result.stdout || result.stderr || "Command exited 0."), ...(canonicalCommand ? {} : { artifact: prior?.artifact }) });
      }
    } catch (error: any) {
      if (options.signal?.aborted) throw new Error("Acceptance verification aborted");
      tests.push({ testId: test.id, status: "failed", command: canonicalCommand ?? prior?.command, evidenceAssessment: sanitizeSummary([error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n")) });
    }
    await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: tests.at(-1)!.status });
  }
  const severe = findings.some((item) => (item.severity === "critical" || item.severity === "high") && item.status === "open");
  const evidenceComplete = tests.length === selectedTests.length && tests.every((item) => item.status !== "failed");
  return {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    requirementsRevision: requirements.requirementsRevision,
    reviewedCommit: commit,
    generatedAt: new Date().toISOString(),
    tests,
    findings,
    evidenceComplete,
    approved: evidenceComplete && !severe,
  };
}

export function integrationBlockers(requirements: RequirementsState, commit: string, report: unknown, requiredTestIds?: readonly string[]): string[] {
  const blockers: string[] = [];
  if (!report || typeof report !== "object") return ["current-format independent verification report is missing"];
  const value = report as VerificationReport;
  if (value.schemaVersion !== VERIFICATION_SCHEMA_VERSION) blockers.push("verification report must use schemaVersion 2 (pre-change tasks are not grandfathered)");
  if (value.requirementsRevision !== requirements.requirementsRevision) blockers.push("verification report requirements hash is stale");
  if (value.reviewedCommit !== commit) blockers.push("verification report does not match the exact current implementation commit");
  if (!value.evidenceComplete) blockers.push("required acceptance evidence is incomplete");
  if (!value.approved) blockers.push("independent verification is not approved");
  const requiredIds = requiredTestIds ? new Set(requiredTestIds) : undefined;
  const requiredTests = requirements.acceptanceTests.filter((test) => !requiredIds || requiredIds.has(test.id));
  if (!Array.isArray(value.tests) || requiredTests.some((test) => !value.tests.some((item) => item.testId === test.id && item.status !== "failed"))) blockers.push("one or more non-exempt acceptance tests lack a passing independent result");
  if (value.findings?.some((item) => (item.severity === "critical" || item.severity === "high") && item.status === "open")) blockers.push("unresolved independently verified high/critical finding exists");
  return blockers;
}

export async function writeVerificationReport(path: string, report: VerificationReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
