import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, type FeatureRecord, type Handoff, type TaskRecord, type TaskStatus } from "./types.ts";

export const WORK_DIR = ".agent-work";

export function now(): string {
  return new Date().toISOString();
}

export function safeId(value: string, label = "id"): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("..")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized.slice(0, 80);
}

export function rootDir(cwd: string): string {
  return join(cwd, WORK_DIR);
}

export function featureDir(cwd: string, featureId: string): string {
  return join(rootDir(cwd), "features", safeId(featureId, "feature id"));
}

export function taskDir(cwd: string, featureId: string, taskId: string): string {
  return join(featureDir(cwd, featureId), "tasks", safeId(taskId, "task id"));
}

export function attemptDir(cwd: string, featureId: string, taskId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid attempt: ${attempt}`);
  return join(taskDir(cwd, featureId, taskId), "attempts", String(attempt).padStart(3, "0"));
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function initializeRoot(cwd: string): Promise<void> {
  const root = rootDir(cwd);
  await mkdir(join(root, "features"), { recursive: true });
  const manifestPath = join(root, "manifest.json");
  if (!(await exists(manifestPath))) {
    await atomicJson(manifestPath, { schemaVersion: SCHEMA_VERSION, features: [], createdAt: now(), updatedAt: now() });
  }
}

export async function createFeature(
  cwd: string,
  input: { id: string; title: string; goal: string; acceptanceCriteria: string[]; constraints: string[] },
): Promise<FeatureRecord> {
  await initializeRoot(cwd);
  const dir = featureDir(cwd, input.id);
  if (await exists(dir)) throw new Error(`Feature already exists: ${input.id}`);
  await mkdir(join(dir, "tasks"), { recursive: true });
  const timestamp = now();
  const record: FeatureRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: safeId(input.id, "feature id"),
    title: input.title,
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints,
    state: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await atomicJson(join(dir, "feature.json"), record);
  const brief = [
    `# ${input.title}`,
    "",
    "## Goal",
    input.goal,
    "",
    "## Acceptance Criteria",
    ...(input.acceptanceCriteria.length ? input.acceptanceCriteria.map((item) => `- ${item}`) : ["- None specified"]),
    "",
    "## Constraints",
    ...(input.constraints.length ? input.constraints.map((item) => `- ${item}`) : ["- None specified"]),
    "",
  ].join("\n");
  await writeFile(join(dir, "brief.md"), brief, "utf8");

  const manifestPath = join(rootDir(cwd), "manifest.json");
  const manifest = await readJson<{ schemaVersion: number; features: string[]; createdAt: string; updatedAt: string }>(manifestPath);
  manifest.features = [...new Set([...manifest.features, record.id])];
  manifest.updatedAt = timestamp;
  await atomicJson(manifestPath, manifest);
  return record;
}

export async function assertFeature(cwd: string, featureId: string): Promise<FeatureRecord> {
  const path = join(featureDir(cwd, featureId), "feature.json");
  if (!(await exists(path))) throw new Error(`Unknown feature: ${featureId}`);
  return readJson<FeatureRecord>(path);
}

export async function createTask(cwd: string, record: TaskRecord): Promise<void> {
  const dir = taskDir(cwd, record.featureId, record.id);
  if (await exists(join(dir, "task.json"))) throw new Error(`Task already exists: ${record.id}`);
  await mkdir(join(dir, "attempts"), { recursive: true });
  await atomicJson(join(dir, "task.json"), record);
  await atomicJson(join(dir, "status.json"), {
    schemaVersion: SCHEMA_VERSION,
    featureId: record.featureId,
    taskId: record.id,
    state: "pending",
    currentAttempt: 0,
    updatedAt: now(),
  } satisfies TaskStatus);
  await atomicJson(join(dir, "current.json"), {
    schemaVersion: SCHEMA_VERSION,
    attempt: 0,
    path: null,
    updatedAt: now(),
  });
}

export async function readTask(cwd: string, featureId: string, taskId: string): Promise<TaskRecord> {
  return readJson<TaskRecord>(join(taskDir(cwd, featureId, taskId), "task.json"));
}

export async function readStatus(cwd: string, featureId: string, taskId: string): Promise<TaskStatus> {
  return readJson<TaskStatus>(join(taskDir(cwd, featureId, taskId), "status.json"));
}

export async function writeStatus(cwd: string, status: TaskStatus): Promise<void> {
  status.updatedAt = now();
  await atomicJson(join(taskDir(cwd, status.featureId, status.taskId), "status.json"), status);
}

export async function nextAttempt(cwd: string, featureId: string, taskId: string): Promise<number> {
  const status = await readStatus(cwd, featureId, taskId);
  return status.currentAttempt + 1;
}

export async function findJsonlFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await findJsonlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(resolve(path));
  }
  return result;
}

export function validateHandoff(value: unknown): value is Handoff {
  if (!value || typeof value !== "object") return false;
  const h = value as Partial<Handoff>;
  return h.schemaVersion === SCHEMA_VERSION && typeof h.summary === "string" &&
    ["done", "blocked", "failed"].includes(h.status ?? "") && Array.isArray(h.changedFiles) &&
    Array.isArray(h.checks) && Array.isArray(h.decisions) && Array.isArray(h.risks) &&
    Array.isArray(h.blockers) && Array.isArray(h.nextSteps) && Boolean(h.session);
}
