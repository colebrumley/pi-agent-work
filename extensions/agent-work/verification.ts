import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    for (const test of requirements.acceptanceTests) {
      const exception = requirements.testExceptions.find((item) => item.testId === test.id && item.explicitUserApproval && item.requirementsRevision === requirements.requirementsRevision && (!item.implementationCommit || !expectedCommit || item.implementationCommit === expectedCommit));
      const item = byId.get(test.id);
      if (!item && !exception) { issues.push(`missing evidence for ${test.id}`); continue; }
      if (!item) continue;
      if (!item.command || !item.environment || !item.summary) issues.push(`${test.id} requires command, environment, and relevant output summary`);
      if (item.result !== "passed" && !exception) issues.push(`${test.id} did not pass and has no valid approved exception`);
      for (const category of test.categories) if (!item.scenarios?.includes(category)) issues.push(`${test.id} lacks scenario coverage: ${category}`);
      if (item.artifact) {
        const artifactPath = resolve(item.artifact.path);
        if (!existsSync(artifactPath)) issues.push(`${test.id} artifact does not exist: ${item.artifact.path}`);
        else {
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

export async function rerunAcceptanceTests(
  requirements: RequirementsState,
  evidence: BuilderEvidence,
  cwd: string,
  commit: string,
  findings: VerificationFinding[] = [],
  options: { signal?: AbortSignal; onProgress?: (progress: VerificationRunProgress) => void | Promise<void> } = {},
): Promise<VerificationReport> {
  const tests: VerificationTestResult[] = [];
  const total = requirements.acceptanceTests.length;
  for (const test of requirements.acceptanceTests) {
    if (options.signal?.aborted) throw new Error("Acceptance verification aborted");
    await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: "running" });
    const exception = requirements.testExceptions.find((item) => item.testId === test.id && item.explicitUserApproval && item.requirementsRevision === requirements.requirementsRevision && (!item.implementationCommit || item.implementationCommit === commit));
    const prior = evidence.tests.find((item) => item.testId === test.id);
    if (exception && (!prior || prior.result === "not-run")) {
      tests.push({ testId: test.id, status: "approved-exception", evidenceAssessment: sanitizeSummary(`Approved by ${exception.approvedBy}; substitute: ${exception.substituteVerification}; residual risk: ${exception.residualRisk}`) });
      await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: "approved-exception" });
      continue;
    }
    if (!prior?.command) {
      tests.push({ testId: test.id, status: "failed", evidenceAssessment: "No feasible rerun command was recorded and no approved exception applies." });
      await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: "failed" });
      continue;
    }
    try {
      const result = await execFileAsync("/bin/sh", ["-lc", prior.command], { cwd, timeout: 120_000, maxBuffer: 2_000_000, signal: options.signal });
      tests.push({ testId: test.id, status: "passed", command: prior.command, evidenceAssessment: sanitizeSummary(result.stdout || result.stderr || "Command exited 0."), artifact: prior.artifact });
    } catch (error: any) {
      if (options.signal?.aborted) throw new Error("Acceptance verification aborted");
      tests.push({ testId: test.id, status: "failed", command: prior.command, evidenceAssessment: sanitizeSummary([error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n")) });
    }
    await options.onProgress?.({ testId: test.id, completed: tests.length, total, status: tests.at(-1)!.status });
  }
  const severe = findings.some((item) => (item.severity === "critical" || item.severity === "high") && item.status === "open");
  const evidenceComplete = tests.length === requirements.acceptanceTests.length && tests.every((item) => item.status !== "failed");
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

export function integrationBlockers(requirements: RequirementsState, commit: string, report: unknown): string[] {
  const blockers: string[] = [];
  if (!report || typeof report !== "object") return ["current-format independent verification report is missing"];
  const value = report as VerificationReport;
  if (value.schemaVersion !== VERIFICATION_SCHEMA_VERSION) blockers.push("verification report must use schemaVersion 2 (pre-change tasks are not grandfathered)");
  if (value.requirementsRevision !== requirements.requirementsRevision) blockers.push("verification report requirements hash is stale");
  if (value.reviewedCommit !== commit) blockers.push("verification report does not match the exact current implementation commit");
  if (!value.evidenceComplete) blockers.push("required acceptance evidence is incomplete");
  if (!value.approved) blockers.push("independent verification is not approved");
  if (!Array.isArray(value.tests) || requirements.acceptanceTests.some((test) => !value.tests.some((item) => item.testId === test.id && item.status !== "failed"))) blockers.push("one or more non-exempt acceptance tests lack a passing independent result");
  if (value.findings?.some((item) => (item.severity === "critical" || item.severity === "high") && item.status === "open")) blockers.push("unresolved independently verified high/critical finding exists");
  return blockers;
}

export async function writeVerificationReport(path: string, report: VerificationReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
