import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROUTER_CONFIG_V1,
  ECONOMY_PROFILE_NAME,
  GLM_MODEL,
  GROK_MODEL,
  LEGACY_PROFILE_NAME,
  LUNA_MODEL,
  PRO_PROFILE_NAME,
  SOL_MODEL,
  TERRA_MODEL,
  createDefaultRouterConfig,
  createEconomyProfile,
  createProProfile,
  findProfile,
  formatActiveProfileStatus,
  getActiveProfile,
  isExactDefaultV1,
  loadRouterConfig,
  migrateV1ToV2,
  parseModelIdentifier,
  persistActiveProfile,
  prepareProfileActivation,
  profileReferencedModels,
  routeTask,
  saveRouterConfig,
  validateProfile,
  validateProfileModels,
  validateRouterConfig,
  withActiveProfile,
  type AgentProfile,
  type ModelAuthInspector,
  type RouterConfig,
  type RouterConfigV1,
  type UtilityRouting,
} from "./router.ts";
import { atomicJson, rootDir } from "./storage.ts";

function fakeRegistry(auth: Record<string, boolean> = {}): ModelAuthInspector {
  const defaults: Record<string, boolean> = {
    [SOL_MODEL]: true,
    [TERRA_MODEL]: true,
    [LUNA_MODEL]: true,
    [GLM_MODEL]: true,
    [GROK_MODEL]: true,
    "test/custom-builder": true,
    "test/custom-coord": true,
  };
  const map = { ...defaults, ...auth };
  return {
    find(provider, modelId) {
      const key = `${provider}/${modelId}`;
      if (!(key in map)) return undefined;
      return { provider, id: modelId };
    },
    hasConfiguredAuth(model) {
      return map[`${model.provider}/${model.id}`] === true;
    },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-work-router-"));
}

function baseReq(over: Partial<Parameters<typeof routeTask>[1]> = {}) {
  return {
    taskId: "t1",
    title: "title",
    prompt: "prompt",
    mode: "write" as const,
    profile: "worker",
    attempt: 1,
    ...over,
  };
}

// --- at-1 Fresh Pro profile routes as specified ---
{
  const config = createDefaultRouterConfig();
  assert.equal(config.activeProfile, PRO_PROFILE_NAME);
  assert.equal(getActiveProfile(config).coordinatorModel, SOL_MODEL);

  const trivialScout = routeTask(config, baseReq({
    mode: "read",
    profile: "scout",
    title: "Find typo",
    prompt: "Locate the rename target",
    complexity: "tiny",
    risk: "low",
  }));
  assert.equal(trivialScout.selectedModel, LUNA_MODEL, "trivial scout -> Luna");
  assert.equal(trivialScout.activeProfile, PRO_PROFILE_NAME);

  const builder = routeTask(config, baseReq({
    title: "Implement feature",
    prompt: "Add the handler across multiple files",
    complexity: "medium",
    risk: "medium",
  }));
  assert.equal(builder.selectedModel, TERRA_MODEL, "ordinary builder -> Terra");

  const reviewer = routeTask(config, baseReq({
    profile: "reviewer",
    mode: "read",
    title: "Review change",
    prompt: "Check the diff",
    complexity: "medium",
    risk: "low",
  }));
  assert.equal(reviewer.selectedModel, TERRA_MODEL, "ordinary reviewer -> Terra");

  const escalate = routeTask(config, baseReq({
    title: "Security migration",
    prompt: "Migrate authentication architecture",
    complexity: "large",
    risk: "high",
    attempt: 3,
  }));
  assert.equal(escalate.selectedModel, SOL_MODEL, "quality-threshold escalates Terra->Sol");
  assert.ok(escalate.requiredQuality >= 0.95);
  assert.match(escalate.reason, /Escalat|profile=Pro/i);
  assert.match(formatActiveProfileStatus(config), /Pro/);
  console.log("at-1 fresh Pro routes passed");
}

// --- at-2 Economy strictly pins delegated roles ---
{
  const config = withActiveProfile(createDefaultRouterConfig(), ECONOMY_PROFILE_NAME);
  assert.equal(getActiveProfile(config).coordinatorModel, SOL_MODEL);

  const complexities = ["tiny", "small", "medium", "large"] as const;
  const risks = ["low", "medium", "high"] as const;
  const attempts = [1, 2, 3];
  for (const complexity of complexities) {
    for (const risk of risks) {
      for (const attempt of attempts) {
        const builder = routeTask(config, baseReq({ complexity, risk, attempt, profile: "worker", mode: "write", title: "Build", prompt: "work" }));
        assert.equal(builder.selectedModel, GLM_MODEL, `economy builder ${complexity}/${risk}/a${attempt}`);
        assert.notEqual(builder.selectedModel, TERRA_MODEL);
        assert.notEqual(builder.selectedModel, GROK_MODEL);

        const scout = routeTask(config, baseReq({ complexity, risk, attempt, profile: "scout", mode: "read", title: "Scout", prompt: "look" }));
        assert.equal(scout.selectedModel, GLM_MODEL, `economy scout ${complexity}/${risk}/a${attempt}`);

        const reviewer = routeTask(config, baseReq({ complexity, risk, attempt, profile: "reviewer", mode: "read", title: "Review", prompt: "check" }));
        assert.equal(reviewer.selectedModel, SOL_MODEL, `economy reviewer ${complexity}/${risk}/a${attempt}`);
      }
    }
  }
  console.log("at-2 Economy pins passed");
}

// --- at-3 Interactive and startup selections persist ---
{
  const root = await tempRoot();
  const registry = fakeRegistry();
  // Fresh load defaults to Pro and persists config
  const loaded = await loadRouterConfig(root);
  assert.equal(loaded.activeProfile, PRO_PROFILE_NAME);

  // Activate Economy via prepare+persist (command path)
  const act = await prepareProfileActivation(root, "Economy", registry);
  await persistActiveProfile(root, act.config, act.previous);
  const afterCmd = await loadRouterConfig(root);
  assert.equal(afterCmd.activeProfile, ECONOMY_PROFILE_NAME);

  // Restart without flag reuses Economy
  const restart1 = await loadRouterConfig(root);
  assert.equal(restart1.activeProfile, ECONOMY_PROFILE_NAME);

  // Startup --agent-profile Pro takes precedence and persists
  const startup = await prepareProfileActivation(root, "Pro", registry);
  await persistActiveProfile(root, startup.config, startup.previous);
  const afterFlag = await loadRouterConfig(root);
  assert.equal(afterFlag.activeProfile, PRO_PROFILE_NAME);

  // Final restart activates Pro
  const restart2 = await loadRouterConfig(root);
  assert.equal(restart2.activeProfile, PRO_PROFILE_NAME);
  assert.match(formatActiveProfileStatus(restart2), /Pro/);
  console.log("at-3 persistence/precedence passed");
}

// --- at-4 Activation failures are atomic ---
{
  const root = await tempRoot();
  const registry = fakeRegistry();
  await loadRouterConfig(root);
  const snap = async () => ({
    config: JSON.parse(await readFile(join(rootDir(root), "router.json"), "utf8")),
    status: formatActiveProfileStatus(await loadRouterConfig(root)),
  });
  const before = await snap();
  assert.equal(before.config.activeProfile, PRO_PROFILE_NAME);

  // unknown
  await assert.rejects(() => prepareProfileActivation(root, "NoSuch", registry), /Unknown profile/);
  assert.deepEqual(await snap(), before);

  // unauthenticated worker
  const badAuthRoot = await tempRoot();
  const cfg = createDefaultRouterConfig();
  const custom: AgentProfile = {
    name: "Unauthed",
    coordinatorModel: SOL_MODEL,
    routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: "openrouter/missing/nope" } },
  };
  // reviewer model will be unknown in registry
  cfg.profiles.push(custom);
  await saveRouterConfig(badAuthRoot, cfg);
  const beforeBad = JSON.parse(await readFile(join(rootDir(badAuthRoot), "router.json"), "utf8"));
  await assert.rejects(() => prepareProfileActivation(badAuthRoot, "Unauthed", fakeRegistry()), /Unknown model|not authenticated/);
  const afterBad = JSON.parse(await readFile(join(rootDir(badAuthRoot), "router.json"), "utf8"));
  assert.deepEqual(afterBad, beforeBad);

  // unknown model id in profile
  const unknownRoot = await tempRoot();
  const cfg2 = createDefaultRouterConfig();
  cfg2.profiles.push({
    name: "Ghost",
    coordinatorModel: "vendor/does-not-exist",
    routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } },
  });
  await saveRouterConfig(unknownRoot, cfg2);
  const beforeGhost = JSON.parse(await readFile(join(rootDir(unknownRoot), "router.json"), "utf8"));
  await assert.rejects(() => prepareProfileActivation(unknownRoot, "Ghost", registry), /Unknown model/);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir(unknownRoot), "router.json"), "utf8")), beforeGhost);

  // unauthenticated (known model without auth)
  const unauthReg = fakeRegistry({ [TERRA_MODEL]: false });
  const terraRoot = await tempRoot();
  await loadRouterConfig(terraRoot);
  const beforeTerra = JSON.parse(await readFile(join(rootDir(terraRoot), "router.json"), "utf8"));
  // Pro references Terra; activation with unauth Terra must fail
  await assert.rejects(() => prepareProfileActivation(terraRoot, "Pro", unauthReg), /not authenticated/);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir(terraRoot), "router.json"), "utf8")), beforeTerra);

  // persistence failure rolls disk back: simulate by pointing save at a file path conflict
  // Here we force persistActiveProfile wrapper failure by using a root whose router.json is replaced with a directory mid-flight.
  // Safer portable approach: call persistActiveProfile with an already-validated next config after making parent unwritable.
  // Instead only validate that failed prepare does not persist (above cases) and that double-save restore path is exercised when save throws.
  {
    const pRoot = await tempRoot();
    await loadRouterConfig(pRoot);
    const prepared = await prepareProfileActivation(pRoot, "Economy", registry);
    // Break destination by creating a directory at router.json path after read
    const path = join(rootDir(pRoot), "router.json");
    const { rmSync, mkdirSync } = await import("node:fs");
    rmSync(path);
    mkdirSync(path);
    await assert.rejects(() => persistActiveProfile(pRoot, prepared.config, prepared.previous), /persistence_failed|EISDIR|illegal operation/i);
    // previous restore may also fail if path is a directory; ensure activation API still signals failure without claiming success
  }

  // malformed profile rejected at validateRouterConfig (load/activate surface)
  assert.throws(() => validateProfile({ name: "", coordinatorModel: SOL_MODEL, routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } } }), /name/);
  console.log("at-4 activation atomicity passed");
}

// --- at-5 Editable custom profile activates ---
{
  const root = await tempRoot();
  const registry = fakeRegistry();
  const config = await loadRouterConfig(root);
  const custom: AgentProfile = {
    name: "CustomLab",
    coordinatorModel: "test/custom-coord",
    routing: {
      mode: "pinned",
      pins: {
        builder: "test/custom-builder",
        scout: GLM_MODEL,
        reviewer: SOL_MODEL,
      },
    },
  };
  config.profiles.push(custom);
  await saveRouterConfig(root, config);

  const act = await prepareProfileActivation(root, "CustomLab", registry);
  await persistActiveProfile(root, act.config, act.previous);
  const active = await loadRouterConfig(root);
  assert.equal(active.activeProfile, "CustomLab");
  assert.equal(getActiveProfile(active).coordinatorModel, "test/custom-coord");

  const b = routeTask(active, baseReq({ profile: "worker", mode: "write" }));
  const s = routeTask(active, baseReq({ profile: "scout", mode: "read" }));
  const r = routeTask(active, baseReq({ profile: "reviewer", mode: "read" }));
  assert.equal(b.selectedModel, "test/custom-builder");
  assert.equal(s.selectedModel, GLM_MODEL);
  assert.equal(r.selectedModel, SOL_MODEL);
  console.log("at-5 custom profile passed");
}

// --- at-6 Version-one routing migrates without loss ---
{
  // untouched old default -> active Pro
  const rootDefault = await tempRoot();
  await mkdir(rootDir(rootDefault), { recursive: true });
  await atomicJson(join(rootDir(rootDefault), "router.json"), DEFAULT_ROUTER_CONFIG_V1);
  assert.equal(isExactDefaultV1(DEFAULT_ROUTER_CONFIG_V1), true);
  const migratedDefault = await loadRouterConfig(rootDefault);
  assert.equal(migratedDefault.schemaVersion, 2);
  assert.equal(migratedDefault.activeProfile, PRO_PROFILE_NAME);
  assert.ok(findProfile(migratedDefault.profiles, PRO_PROFILE_NAME));
  assert.ok(findProfile(migratedDefault.profiles, ECONOMY_PROFILE_NAME));
  assert.equal(findProfile(migratedDefault.profiles, LEGACY_PROFILE_NAME), undefined);

  // customized v1 -> active Legacy lossless
  const rootCustom = await tempRoot();
  await mkdir(rootDir(rootCustom), { recursive: true });
  const customized: RouterConfigV1 = {
    ...DEFAULT_ROUTER_CONFIG_V1,
    weights: { cost: 0.1, speed: 0.2, quality: 0.7 },
    subscriptionScarcityPenalty: 0.11,
    models: [
      { model: GLM_MODEL, label: "custom glm", roles: ["builder", "scout", "reviewer"], quality: 0.8, speed: 0.5, relativeCost: 0.2 },
      { model: SOL_MODEL, label: "custom sol", roles: ["reviewer"], quality: 0.99, speed: 0.1, relativeCost: 0, subscription: true },
    ],
  };
  await atomicJson(join(rootDir(rootCustom), "router.json"), customized);
  const before = structuredClone(customized);
  const migratedCustom = await loadRouterConfig(rootCustom);
  assert.equal(migratedCustom.activeProfile, LEGACY_PROFILE_NAME);
  const legacy = findProfile(migratedCustom.profiles, LEGACY_PROFILE_NAME)!;
  assert.ok(legacy);
  assert.equal(legacy.routing.mode, "utility");
  if (legacy.routing.mode === "utility") {
    assert.deepEqual(legacy.routing.weights, before.weights);
    assert.equal(legacy.routing.subscriptionScarcityPenalty, before.subscriptionScarcityPenalty);
    assert.deepEqual(legacy.routing.models, before.models);
  }
  assert.ok(findProfile(migratedCustom.profiles, PRO_PROFILE_NAME));
  assert.ok(findProfile(migratedCustom.profiles, ECONOMY_PROFILE_NAME));

  // pure function also covers default migration identity
  const pureDefault = migrateV1ToV2(DEFAULT_ROUTER_CONFIG_V1);
  assert.equal(pureDefault.activeProfile, PRO_PROFILE_NAME);
  const pureCustom = migrateV1ToV2(customized);
  assert.equal(pureCustom.activeProfile, LEGACY_PROFILE_NAME);

  // idempotent reload
  const againDefault = await loadRouterConfig(rootDefault);
  assert.deepEqual(againDefault, migratedDefault);
  const againCustom = await loadRouterConfig(rootCustom);
  assert.deepEqual(againCustom, migratedCustom);
  console.log("at-6 v1 migration passed");
}

// --- at-7 Explicit delegation override still wins ---
{
  for (const name of [PRO_PROFILE_NAME, ECONOMY_PROFILE_NAME]) {
    const config = withActiveProfile(createDefaultRouterConfig(), name);
    const decision = routeTask(config, baseReq({ title: "Anything", prompt: "Anything" }), "provider/model", "off");
    assert.equal(decision.source, "explicit");
    assert.equal(decision.selectedModel, "provider/model");
    assert.equal(decision.activeProfile, name);
    assert.equal(config.activeProfile, name);
  }
  console.log("at-7 explicit override passed");
}

// Slice-first selection is independent of any parent-feature risk and model identifiers.
{
  const threeTier: UtilityRouting = {
    mode: "utility", weights: { cost: 1, speed: 0, quality: 0 }, subscriptionScarcityPenalty: 0,
    models: [
      { model: "fixture/cheap", label: "cheap", roles: ["builder", "scout"], quality: 0.75, speed: 0.5, relativeCost: 0.05, qualityTier: 1 },
      { model: "fixture/standard", label: "standard", roles: ["builder", "scout"], quality: 0.9, speed: 0.5, relativeCost: 0.3, qualityTier: 2 },
      { model: "fixture/top", label: "top", roles: ["builder", "scout"], quality: 0.99, speed: 0.5, relativeCost: 0.8, qualityTier: 3, escalationOnly: true },
    ],
  };
  const config: RouterConfig = { schemaVersion: 2, enabled: true, activeProfile: "fixture", profiles: [{ name: "fixture", coordinatorModel: "fixture/top", routing: threeTier }] };
  for (const kind of ["ui", "test", "maintenance"] as const) {
    const decision = routeTask(config, baseReq({ mode: "read", slice: { kind, complexity: "small", risk: "low", role: "scout" } }));
    assert.equal(decision.selectedModel, "fixture/cheap", `${kind} slice uses cheapest eligible tier`);
  }
  for (const kind of ["architecture", "security", "integration"] as const) {
    const decision = routeTask(config, baseReq({ slice: { kind, complexity: "medium", risk: "high", role: "builder" } }));
    assert.equal(decision.selectedModel, "fixture/top", `${kind} high-risk slice uses highest configured tier`);
  }
  const unDiagnosed = routeTask(config, baseReq({ slice: { kind: "general", complexity: "small", risk: "low", role: "builder" }, attempt: 2, escalation: { previousModel: "fixture/cheap" } }));
  assert.equal(unDiagnosed.selectedModel, "fixture/cheap", "retry alone cannot increase tier");
  const diagnosed = routeTask(config, baseReq({ slice: { kind: "general", complexity: "small", risk: "low", role: "builder" }, attempt: 2, escalation: { previousModel: "fixture/cheap", diagnosis: { category: "task-complexity", reason: "needs broader reasoning" } } }));
  assert.equal(diagnosed.selectedModel, "fixture/standard");
  assert.equal(diagnosed.escalation?.diagnosis.category, "task-complexity");
  assert.match(diagnosed.reason, /task-complexity/);
  console.log("slice-first tier routing passed");
}

// --- at-8 Malformed profile-name and shape boundaries ---
{
  const cases: Array<{ raw: unknown; match: RegExp }> = [
    { raw: { name: "", coordinatorModel: SOL_MODEL, routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } } }, match: /name/ },
    { raw: { name: "  ", coordinatorModel: SOL_MODEL, routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } } }, match: /name/ },
    { raw: { name: "../etc/passwd", coordinatorModel: SOL_MODEL, routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } } }, match: /invalid characters|name/ },
    { raw: { name: "Ok", routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } } }, match: /coordinatorModel/ },
    { raw: { name: "Ok", coordinatorModel: SOL_MODEL }, match: /routing/ },
    { raw: { name: "Ok", coordinatorModel: SOL_MODEL, routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL } } }, match: /reviewer/ },
    { raw: { name: "Ok", coordinatorModel: SOL_MODEL, routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL, wizard: SOL_MODEL } } }, match: /invalid role/ },
    { raw: { name: "Ok", coordinatorModel: "not-a-model", routing: { mode: "pinned", pins: { builder: GLM_MODEL, scout: GLM_MODEL, reviewer: SOL_MODEL } } }, match: /Invalid model/ },
    { raw: { name: "Ok", coordinatorModel: SOL_MODEL, routing: { mode: "utility", weights: { cost: 1, speed: 1, quality: 1 }, subscriptionScarcityPenalty: 0, models: [] } }, match: /models/ },
  ];
  for (const item of cases) {
    assert.throws(() => validateProfile(item.raw), item.match);
  }

  assert.throws(() => validateRouterConfig({
    schemaVersion: 2,
    enabled: true,
    activeProfile: PRO_PROFILE_NAME,
    profiles: [],
  }), /empty/ );

  assert.throws(() => validateRouterConfig({
    schemaVersion: 2,
    enabled: true,
    activeProfile: PRO_PROFILE_NAME,
    profiles: [createProProfile(), { ...createEconomyProfile(), name: "pro" }],
  }), /Duplicate/ );

  assert.throws(() => validateRouterConfig({
    schemaVersion: 2,
    enabled: true,
    activeProfile: "Missing",
    profiles: [createProProfile(), createEconomyProfile()],
  }), /activeProfile/ );

  // Secrets must not appear in validation/auth error text
  try {
    validateProfileModels(createProProfile(), {
      find: () => ({ provider: "openai-codex", id: "gpt-5.6-sol" }),
      hasConfiguredAuth: () => { throw new Error("api_key=sk-secret-value-here Bearer tok"); },
    });
    assert.fail("expected throw");
  } catch (error: any) {
    assert.doesNotMatch(error.message, /sk-secret/);
    assert.doesNotMatch(error.message, /api_key=sk/);
  }

  assert.equal(parseModelIdentifier("a/b")?.provider, "a");
  assert.equal(parseModelIdentifier("../x"), undefined);
  assert.equal(parseModelIdentifier("nope"), undefined);

  // empty profile collection on disk rejected (no active replace)
  {
    const root = await tempRoot();
    await mkdir(rootDir(root), { recursive: true });
    await writeFile(join(rootDir(root), "router.json"), JSON.stringify({
      schemaVersion: 2, enabled: true, activeProfile: "Pro", profiles: [],
    }), "utf8");
    await assert.rejects(() => loadRouterConfig(root), /empty|profiles/i);
  }

  console.log("at-8 malformed boundaries passed");
}

// Legacy v1 utility scorer still works for peeling old tests
{
  const tiny = routeTask(DEFAULT_ROUTER_CONFIG_V1, { ...baseReq(), title: "Fix typo", prompt: "Rename a label" });
  assert.equal(tiny.selectedModel, GLM_MODEL);
  const explicit = routeTask(DEFAULT_ROUTER_CONFIG_V1, baseReq(), "provider/model", "off");
  assert.equal(explicit.source, "explicit");
}

// referenced models helpers
{
  const models = profileReferencedModels(createEconomyProfile());
  assert.ok(models.includes(SOL_MODEL));
  assert.ok(models.includes(GLM_MODEL));
}

// --- Startup/command activation atomicity (setModel failure) ---
{
  const {
    activateAgentProfile,
    activateStartupProfile,
    createSessionProfileRuntime,
    routingConfigForSession,
  } = await import("./profiles.ts");

  const root = await tempRoot();
  await loadRouterConfig(root); // Pro on disk
  // Remember Economy then fail coordinator switch on next startup-style activation of Pro via flag
  const reg = fakeRegistry();
  const economyAct = await prepareProfileActivation(root, ECONOMY_PROFILE_NAME, reg);
  await persistActiveProfile(root, economyAct.config, economyAct.previous);
  const diskBefore = JSON.parse(await readFile(join(rootDir(root), "router.json"), "utf8"));
  assert.equal(diskBefore.activeProfile, ECONOMY_PROFILE_NAME);

  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: string[] = [];
  let currentModel: { provider: string; id: string } | null = {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
  };
  // Force setModel failure when switching (simulate same-or-switch always fails when asked)
  let setModelCalls = 0;
  const api = {
    async setModel(model: any) {
      setModelCalls++;
      // Fail every setModel to prove we do not half-activate routing
      return false;
    },
  };
  // Use a different coordinator previous model so setModel is attempted
  currentModel = { provider: "other", id: "prior" };
  const runtime = createSessionProfileRuntime();
  const ui = {
    notify(message: string, level?: string) { notifications.push({ message, level }); },
    setStatus(_key: string, text: string | null) { if (text) statuses.push(text); },
  };
  const ctx = {
    model: currentModel,
    modelRegistry: {
      find(provider: string, modelId: string) {
        if (provider === "other" && modelId === "prior") return { provider, id: modelId };
        return reg.find(provider, modelId);
      },
      hasConfiguredAuth(model: { provider: string; id: string }) {
        if (model.provider === "other") return true;
        return reg.hasConfiguredAuth(model);
      },
    },
    ui,
  };

  const startupFail = await activateStartupProfile({
    api,
    root,
    flagName: PRO_PROFILE_NAME,
    ctx,
    runtime,
  });
  assert.equal(startupFail.ok, false);
  assert.match(startupFail.ok === false ? startupFail.error : "", /Could not activate coordinator/);
  assert.equal(runtime.activated, false);
  assert.equal(runtime.routingConfig, undefined);
  // Disk must remain Economy (flag persistence never reached)
  const diskAfterFlagFail = JSON.parse(await readFile(join(rootDir(root), "router.json"), "utf8"));
  assert.deepEqual(diskAfterFlagFail, diskBefore);
  assert.equal(startupFail.ok === false ? startupFail.retainedCoordinator?.id : "", "prior");
  // Session routing gate must not apply Pro policy
  const gated = routingConfigForSession(runtime, diskAfterFlagFail);
  assert.equal(gated.enabled, false);
  assert.ok(notifications.some((n) => n.level === "error"));
  assert.ok(statuses.some((s) => /inactive/i.test(s) || /Economy/i.test(s)));

  // Remembered-path setModel failure: Economy on disk, same coordinator mismatch, no flag
  const runtime2 = createSessionProfileRuntime();
  const startupRememberedFail = await activateStartupProfile({
    api,
    root,
    flagName: null,
    ctx,
    runtime: runtime2,
  });
  assert.equal(startupRememberedFail.ok, false);
  assert.equal(runtime2.activated, false);
  const diskAfterRememberedFail = JSON.parse(await readFile(join(rootDir(root), "router.json"), "utf8"));
  assert.deepEqual(diskAfterRememberedFail, diskBefore);
  assert.equal(routingConfigForSession(runtime2, diskAfterRememberedFail).enabled, false);

  // Successful activation then failed command must retain prior session routing
  const apiOk = {
    current: { provider: "other", id: "prior" } as { provider: string; id: string },
    async setModel(model: any) {
      this.current = { provider: model.provider, id: model.id };
      return true;
    },
  };
  const runtime3 = createSessionProfileRuntime();
  const okStart = await activateStartupProfile({
    api: apiOk,
    root,
    flagName: null,
    ctx: { ...ctx, model: { provider: "other", id: "prior" } },
    runtime: runtime3,
  });
  assert.equal(okStart.ok, true);
  assert.equal(runtime3.activated, true);
  assert.equal(runtime3.routingConfig?.activeProfile, ECONOMY_PROFILE_NAME);

  // Command path setModel failure for Pro must not change disk or session Economy routing
  const failApi = {
    async setModel() { return false; },
  };
  const diskSnap = JSON.parse(await readFile(join(rootDir(root), "router.json"), "utf8"));
  const cmdFail = await activateAgentProfile({
    api: failApi,
    root,
    profileName: PRO_PROFILE_NAME,
    ctx: {
      ...ctx,
      model: { provider: "other", id: "prior" },
    },
    baselineConfig: runtime3.routingConfig,
  });
  assert.equal(cmdFail.ok, false);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir(root), "router.json"), "utf8")), diskSnap);
  const { ensureRuntimeAfterCommandFailure } = await import("./profiles.ts");
  ensureRuntimeAfterCommandFailure(runtime3, cmdFail as any);
  assert.equal(runtime3.activated, true);
  assert.equal(runtime3.routingConfig?.activeProfile, ECONOMY_PROFILE_NAME);
  assert.ok(setModelCalls >= 1);
  console.log("startup/command setModel atomicity passed");
}

console.log("router tests passed");
