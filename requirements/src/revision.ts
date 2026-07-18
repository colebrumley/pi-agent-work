import { createHash } from "node:crypto";
import type { RequirementsState } from "./types.ts";

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic semantic identity; clocks and approval records are excluded. */
export function requirementsRevision(state: RequirementsState): string {
  const value: any = structuredClone(state);
  delete value.requirementsRevision;
  delete value.testExceptions;
  if (value.meta) {
    delete value.meta.createdAt;
    delete value.meta.updatedAt;
  }
  for (const decision of value.decisions ?? []) delete decision.timestamp;
  for (const review of value.riskReviews ?? []) delete review.reviewedAt;
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
