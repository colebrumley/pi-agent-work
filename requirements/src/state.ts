/**
 * Deterministic state store.
 *
 * Responsibilities (the deterministic half of the system):
 *   - load/save the structured state across requirements.json + decision-log.json
 *   - normalize patches proposed by the LLM (assign ids, sequences, timestamps)
 *   - apply patches by upsert/remove/set, never by freewriting prose
 *
 * The LLM proposes; this module validates the *shape* and persists.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RequirementsState,
  Decision,
  Tier,
  ReadinessAssessment,
  ReadinessOptOut,
  TestingStandards,
  TestException,
} from "./types.ts";
import { ADVERSARIAL_CATEGORIES, FIDELITY_LAYERS, READINESS_DOMAINS, SCHEMA_VERSION } from "./types.ts";
import { validateSchema } from "./validate-requirements.ts";
import { requirementsRevision } from "./revision.ts";
export { requirementsRevision } from "./revision.ts";

export const REQUIREMENTS_FILE = "requirements.json";
export const DECISION_LOG_FILE = "decision-log.json";

function nowIso(): string {
  return new Date().toISOString();
}

function emptySection() {
  return { applicable: true, notes: [] as string[] };
}

function emptyReadiness(): ReadinessAssessment {
  return {
    buildableEndToEnd: "unanswered",
    rationale: "",
    workingParameters: "",
    assumptions: [],
    stopConditions: [],
    domains: READINESS_DOMAINS.map((domain) => ({ domain, status: "open", rationale: "" })),
  };
}

function emptyTestingStandards(): TestingStandards {
  return {
    fidelity: FIDELITY_LAYERS.map((name) => ({ name, applicable: false, rationale: "" })),
    adversarial: ADVERSARIAL_CATEGORIES.map((name) => ({ name, applicable: false, rationale: "" })),
  };
}

export function newState(featureName: string, tier: Tier): RequirementsState {
  const ts = nowIso();
  const state: RequirementsState = {
    schemaVersion: SCHEMA_VERSION,
    featureName,
    problemStatement: "",
    tier,
    goals: [],
    nonGoals: [],
    actors: [],
    userJourneys: [],
    functionalRequirements: [],
    nonFunctionalRequirements: [],
    constraints: [],
    assumptions: [],
    risks: [],
    openQuestions: [],
    acceptanceCriteria: [],
    acceptanceTests: [],
    testingStandards: emptyTestingStandards(),
    testExceptions: [],
    readiness: emptyReadiness(),
    requirementsRevision: "",
    outOfScope: [],
    dependencies: [],
    rollout: { ...emptySection(), phases: [] },
    observability: emptySection(),
    security: emptySection(),
    operational: emptySection(),
    riskReviews: [],
    handoffNotes: [],
    decisions: [],
    meta: { createdAt: ts, updatedAt: ts, decisionSequence: 0 },
  };
  state.requirementsRevision = requirementsRevision(state);
  return state;
}

/** Collections that support id-keyed upsert/remove. */
const COLLECTIONS = [
  "goals",
  "nonGoals",
  "actors",
  "userJourneys",
  "functionalRequirements",
  "nonFunctionalRequirements",
  "constraints",
  "assumptions",
  "risks",
  "openQuestions",
  "acceptanceCriteria",
  "acceptanceTests",
  "outOfScope",
  "dependencies",
  "decisions",
] as const;

type CollectionKey = (typeof COLLECTIONS)[number];

const ID_PREFIX: Record<CollectionKey, string> = {
  goals: "g",
  nonGoals: "ng",
  actors: "act",
  userJourneys: "uj",
  functionalRequirements: "fr",
  nonFunctionalRequirements: "nfr",
  constraints: "con",
  assumptions: "asm",
  risks: "risk",
  openQuestions: "q",
  acceptanceCriteria: "ac",
  acceptanceTests: "at",
  outOfScope: "oos",
  dependencies: "dep",
  decisions: "dec",
};

const SCALAR_KEYS = ["featureName", "problemStatement", "tier"] as const;
const SECTION_KEYS = [
  "rollout",
  "observability",
  "security",
  "operational",
] as const;

export interface Patch {
  set?: Partial<Record<(typeof SCALAR_KEYS)[number], string>>;
  upsert?: Partial<Record<CollectionKey, any[]>>;
  remove?: Partial<Record<CollectionKey, string[]>>;
  sections?: Partial<Record<(typeof SECTION_KEYS)[number], any>>;
  riskReviews?: any[]; // appended
  handoffNotes?: string[]; // replaces the array when present
  readiness?: Partial<ReadinessAssessment>;
  readinessOptOut?: ReadinessOptOut | null;
  testingStandards?: TestingStandards;
  testExceptions?: TestException[];
}

function nextId(existing: { id?: string }[], prefix: string): string {
  let max = 0;
  for (const item of existing) {
    const m = item.id && new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

/**
 * Apply a structured patch. Returns a new state object. Pure aside from
 * generated ids/sequences/timestamps. Unknown keys are ignored so a slightly
 * malformed LLM patch degrades gracefully rather than corrupting state.
 */
export function applyPatch(
  state: RequirementsState,
  patch: Patch
): RequirementsState {
  const next: RequirementsState = structuredClone(state);

  if (patch.set) {
    for (const key of SCALAR_KEYS) {
      if (patch.set[key] !== undefined) (next as any)[key] = patch.set[key];
    }
  }

  if (patch.upsert) {
    for (const key of COLLECTIONS) {
      const incoming = patch.upsert[key];
      if (!incoming) continue;
      const list: any[] = (next as any)[key];
      for (const raw of incoming) {
        const item = { ...raw };
        if (!item.id) item.id = nextId(list, ID_PREFIX[key]);
        if (key === "decisions") normalizeDecisionInPlace(next, item);
        const idx = list.findIndex((x) => x.id === item.id);
        if (idx >= 0) list[idx] = { ...list[idx], ...item };
        else list.push(item);
      }
    }
  }

  if (patch.remove) {
    for (const key of COLLECTIONS) {
      const ids = patch.remove[key];
      if (!ids) continue;
      (next as any)[key] = (next as any)[key].filter(
        (x: any) => !ids.includes(x.id)
      );
    }
  }

  if (patch.sections) {
    for (const key of SECTION_KEYS) {
      const incoming = patch.sections[key];
      if (!incoming) continue;
      (next as any)[key] = { ...(next as any)[key], ...incoming };
      if ((next as any)[key].notes === undefined) (next as any)[key].notes = [];
    }
  }

  if (patch.riskReviews) {
    for (const r of patch.riskReviews) {
      next.riskReviews.push({ reviewedAt: nowIso(), ...r });
    }
  }

  if (patch.handoffNotes) next.handoffNotes = patch.handoffNotes.slice();
  if (patch.readiness) next.readiness = { ...next.readiness, ...structuredClone(patch.readiness) };
  if (patch.readinessOptOut === null) delete next.readinessOptOut;
  else if (patch.readinessOptOut) next.readinessOptOut = structuredClone(patch.readinessOptOut);
  if (patch.testingStandards) next.testingStandards = structuredClone(patch.testingStandards);
  if (patch.testExceptions) next.testExceptions = structuredClone(patch.testExceptions);

  next.meta.updatedAt = nowIso();
  next.requirementsRevision = requirementsRevision(next);
  return next;
}

/** Assign decision bookkeeping (sequence + timestamp) if not already set. */
function normalizeDecisionInPlace(
  state: RequirementsState,
  decision: Partial<Decision>
): void {
  const existing = state.decisions.find((d) => d.id === decision.id);
  if (decision.sequence === undefined) {
    decision.sequence = existing
      ? existing.sequence
      : ++state.meta.decisionSequence;
  } else {
    state.meta.decisionSequence = Math.max(
      state.meta.decisionSequence,
      decision.sequence
    );
  }
  if (!decision.timestamp) decision.timestamp = existing?.timestamp ?? nowIso();
  if (decision.alternatives === undefined)
    decision.alternatives = existing?.alternatives ?? [];
  if (decision.relatedRequirements === undefined)
    decision.relatedRequirements = existing?.relatedRequirements ?? [];
}

// ---------- persistence ----------

export function statePaths(dir: string) {
  return {
    requirements: join(dir, REQUIREMENTS_FILE),
    decisionLog: join(dir, DECISION_LOG_FILE),
  };
}

export function stateExists(dir: string): boolean {
  const p = statePaths(dir);
  return existsSync(p.requirements) && existsSync(p.decisionLog);
}

function parseJsonFile(path: string): any {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`could not read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is corrupt or truncated (invalid JSON): ${(e as Error).message}`);
  }
}

/**
 * Load and merge the two state files. Fails closed: a corrupt, truncated,
 * wrong-version, or structurally-invalid file throws a clean Error rather than
 * letting a malformed shape reach the validators/renderers (where a missing
 * array would otherwise crash with an opaque TypeError). Because `apply` only
 * ever persists schema-valid state, structural failure here means the file was
 * hand-edited or written by another version — the user must fix it.
 */
export function migrateState(raw: any, decisions: Decision[] = []): RequirementsState {
  if (raw?.schemaVersion === SCHEMA_VERSION) return { ...raw, decisions } as RequirementsState;
  if (raw?.schemaVersion !== 1) throw new Error(`Unsupported requirements schemaVersion ${raw?.schemaVersion}`);
  const migrated = {
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    decisions,
    acceptanceTests: [],
    testingStandards: emptyTestingStandards(),
    testExceptions: [],
    readiness: emptyReadiness(),
    requirementsRevision: "",
  } as RequirementsState;
  migrated.requirementsRevision = requirementsRevision(migrated);
  return migrated;
}

export function loadState(dir: string): RequirementsState {
  const p = statePaths(dir);
  if (!existsSync(p.requirements))
    throw new Error(`No ${REQUIREMENTS_FILE} in ${dir}. Run \`init\` first.`);
  const reqRaw = parseJsonFile(p.requirements);
  const decisionFile = existsSync(p.decisionLog) ? parseJsonFile(p.decisionLog) : {};
  const decisions = decisionFile?.decisions ?? [];
  const state = migrateState(reqRaw, decisions);

  const schemaIssues = validateSchema(state);
  if (schemaIssues.length)
    throw new Error(
      `state in ${dir} is structurally invalid:\n` +
        schemaIssues.map((i) => `  - [${i.code}] ${i.message}`).join("\n")
    );

  return state;
}

/** Write `data` to `path` atomically: temp file -> fsync -> rename. */
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path); // rename is atomic on POSIX
}

/**
 * Persist state across both files atomically. Each file is staged to a temp
 * path, fsynced, then renamed, so an interrupted write can never truncate the
 * prior good state. (Cross-file atomicity is still best-effort: a crash between
 * the two renames is detectable because `saveState` always writes the decision
 * log after requirements — but renames are fast and the window is tiny.)
 */
export function saveState(dir: string, state: RequirementsState): void {
  const p = statePaths(dir);
  state.requirementsRevision = requirementsRevision(state);
  const { decisions, ...rest } = state;
  atomicWrite(p.requirements, JSON.stringify(rest, null, 2) + "\n");
  atomicWrite(p.decisionLog, JSON.stringify({ decisions }, null, 2) + "\n");
}
