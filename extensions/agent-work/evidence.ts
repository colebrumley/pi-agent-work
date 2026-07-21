import { createHash } from "node:crypto";
import type { AdversarialCategory, FidelityLayer } from "../../requirements/src/types.ts";

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = 1;
export type EvidenceFreshness = "same-commit" | "ancestor" | "fresh";
export type EvidenceKind = "full-suite" | "targeted" | "flow";

export interface EvidenceRecord {
  id: string;
  command: string;
  commandIdentity: string;
  kind: EvidenceKind;
  requirementsRevision: string;
  commit: string;
  environment: string;
  result: "passed" | "failed" | "not-run";
  artifactHash?: string;
  fidelity: FidelityLayer;
  scenarios: AdversarialCategory[];
  freshness: EvidenceFreshness;
  lineage?: { sourceEvidenceId: string; sourceCommit: string };
  overrideRationale?: string;
}

export interface EvidenceManifest {
  schemaVersion: 1;
  requirementsRevision: string;
  commit: string;
  records: EvidenceRecord[];
  manifestHash: string;
}

export function commandIdentity(command: string): string {
  return `sha256:${createHash("sha256").update(command.trim().replace(/\s+/g, " ")).digest("hex")}`;
}

function manifestPayload(manifest: Omit<EvidenceManifest, "manifestHash">): string {
  return JSON.stringify({ ...manifest, records: [...manifest.records].sort((a, b) => a.id.localeCompare(b.id)) });
}

export function createEvidenceManifest(input: Omit<EvidenceManifest, "schemaVersion" | "manifestHash">): EvidenceManifest {
  const records = input.records.map((record) => ({ ...record, commandIdentity: commandIdentity(record.command), scenarios: [...record.scenarios].sort() }));
  const payload = { schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION as const, ...input, records };
  return { ...payload, manifestHash: `sha256:${createHash("sha256").update(manifestPayload(payload)).digest("hex")}` };
}

export function validateEvidenceManifest(manifest: EvidenceManifest): string[] {
  const expected = createEvidenceManifest({ requirementsRevision: manifest.requirementsRevision, commit: manifest.commit, records: manifest.records }).manifestHash;
  const issues: string[] = [];
  if (manifest.schemaVersion !== EVIDENCE_MANIFEST_SCHEMA_VERSION) issues.push("unsupported evidence manifest schema version");
  if (manifest.manifestHash !== expected) issues.push("evidence manifest hash mismatch");
  for (const record of manifest.records) {
    if (record.commandIdentity !== commandIdentity(record.command)) issues.push(`${record.id} command identity mismatch`);
    if (record.freshness === "ancestor" && !record.lineage) issues.push(`${record.id} ancestor evidence requires lineage`);
  }
  return issues;
}

export function ancestorEvidence(records: EvidenceRecord[], amendedCommit: string): EvidenceRecord[] {
  return records.filter((record) => record.commit !== amendedCommit).map((record) => ({
    ...record, freshness: "ancestor" as const, lineage: { sourceEvidenceId: record.id, sourceCommit: record.commit },
  }));
}

export function duplicateCommand(records: EvidenceRecord[], command: string): EvidenceRecord | undefined {
  const identity = commandIdentity(command);
  return records.find((record) => record.commandIdentity === identity);
}

export function mayExecuteCommand(input: {
  records: EvidenceRecord[];
  command: string;
  expensive: boolean;
  finalGate: boolean;
  overrideRationale?: string;
}): { allowed: boolean; duplicate?: EvidenceRecord; reason?: string; overrideRationale?: string } {
  const duplicate = duplicateCommand(input.records, input.command);
  if (duplicate && input.expensive && !input.finalGate && !input.overrideRationale?.trim()) {
    return { allowed: false, duplicate, reason: "equivalent expensive command requires an explicit override rationale" };
  }
  return { allowed: true, duplicate, overrideRationale: duplicate ? input.overrideRationale?.trim() : undefined };
}

export function intermediateEvidencePlan(records: EvidenceRecord[], commit: string): { reused: EvidenceRecord[]; executeKinds: EvidenceKind[] } {
  const reused = records.filter((record) => record.commit === commit && record.kind === "full-suite" && record.result === "passed");
  return { reused: reused.map((record) => ({ ...record, freshness: "same-commit" })), executeKinds: ["targeted"] };
}

export function finalGateBlockers(
  records: EvidenceRecord[],
  commit: string,
  requirementsRevision: string,
  requiredFlow: boolean,
  required: { fullCommandIdentities?: string[]; flowCommandIdentities?: string[] } = {},
): string[] {
  const fresh = records.filter((record) => record.commit === commit && record.requirementsRevision === requirementsRevision && record.freshness === "fresh" && record.result === "passed");
  const blockers: string[] = [];
  if (!fresh.some((record) => record.kind === "full-suite")) blockers.push("fresh exact-current full-suite evidence is required");
  if (requiredFlow && !fresh.some((record) => record.kind === "flow")) blockers.push("fresh exact-current flow evidence is required");
  for (const identity of required.fullCommandIdentities ?? []) if (!fresh.some((record) => record.kind === "full-suite" && record.commandIdentity === identity)) blockers.push(`fresh exact-current full-suite command is missing: ${identity}`);
  for (const identity of required.flowCommandIdentities ?? []) if (!fresh.some((record) => record.kind === "flow" && record.commandIdentity === identity)) blockers.push(`fresh exact-current flow command is missing: ${identity}`);
  return blockers;
}
