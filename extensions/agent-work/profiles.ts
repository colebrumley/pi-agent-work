/**
 * Coordinator + delegated profile activation for interactive/startup surfaces.
 * Kept separate from the Pi extension entry so activation atomicity is unit-testable.
 */
import {
  formatActiveProfileStatus,
  getActiveProfile,
  loadRouterConfig,
  parseModelIdentifier,
  persistActiveProfile,
  prepareProfileActivation,
  ProfileActivationError,
  type AgentProfile,
  type ModelAuthInspector,
  type RouterConfig,
} from "./router.ts";

export type CoordinatorModelRef = { provider: string; id: string };

export type ProfileUi = {
  notify(message: string, level?: string): void;
  setStatus(key: string, text: string | null): void;
};

export type ProfileModelApi = {
  setModel(model: unknown): Promise<boolean>;
};

export type ProfileActivationContext = {
  model?: CoordinatorModelRef | null;
  modelRegistry: ModelAuthInspector;
  ui: ProfileUi;
};

export type ActivationSuccess = {
  ok: true;
  profile: AgentProfile;
  config: RouterConfig;
  coordinator: CoordinatorModelRef;
};

export type ActivationFailure = {
  ok: false;
  error: string;
  /** Disk + routing snapshot that remained in effect after the failed attempt. */
  retainedConfig: RouterConfig;
  retainedCoordinator?: CoordinatorModelRef;
};

export type ActivationResult = ActivationSuccess | ActivationFailure;

/** In-session routing gate: profile routing applies only after successful activation. */
export type SessionProfileRuntime = {
  /** True when coordinator+routing were successfully activated this session (or confirmed). */
  activated: boolean;
  /** Config used for delegated routing while activated. */
  routingConfig?: RouterConfig;
  /** Last error that blocked activation. */
  lastError?: string;
  /** Display status line. */
  statusLine: string;
};

export function createSessionProfileRuntime(): SessionProfileRuntime {
  return {
    activated: false,
    statusLine: "agent-profile: pending",
  };
}

export function routingConfigForSession(runtime: SessionProfileRuntime, disk: RouterConfig): RouterConfig {
  if (runtime.activated && runtime.routingConfig) return runtime.routingConfig;
  // Fail closed: do not apply a profile's delegated policy without a successful activation.
  return { ...disk, enabled: false };
}

async function restoreCoordinator(
  api: ProfileModelApi,
  registry: ModelAuthInspector,
  previous: CoordinatorModelRef | undefined,
  ui: ProfileUi,
): Promise<void> {
  if (!previous) return;
  const model = registry.find(previous.provider, previous.id);
  if (!model) {
    ui.notify(`Failed to restore previous coordinator ${previous.provider}/${previous.id}: model not found`, "error");
    return;
  }
  const ok = await api.setModel(model);
  if (!ok) ui.notify(`Failed to restore previous coordinator ${previous.provider}/${previous.id}`, "error");
}

function coordinatorRef(model: { provider: string; id: string }): CoordinatorModelRef {
  return { provider: model.provider, id: model.id };
}

/**
 * Atomically activate a named profile: validate, set coordinator, persist.
 * On any failure restore coordinator (if changed), leave persisted profile and routing unchanged,
 * and return the retained config.
 */
export async function activateAgentProfile(input: {
  api: ProfileModelApi;
  root: string;
  profileName: string;
  ctx: ProfileActivationContext;
  /** Optional preloaded disk config used as retained baseline for status. */
  baselineConfig?: RouterConfig;
}): Promise<ActivationResult> {
  const { api, root, profileName, ctx } = input;
  const previousCoordinator = ctx.model ? { ...ctx.model } : undefined;
  let prepared: Awaited<ReturnType<typeof prepareProfileActivation>> | undefined;
  let coordinatorChanged = false;
  const retainedFallback = async (): Promise<RouterConfig> => {
    if (input.baselineConfig) return input.baselineConfig;
    if (prepared?.previous) return prepared.previous;
    try {
      return await loadRouterConfig(root);
    } catch {
      return prepared?.previous ?? {
        schemaVersion: 2,
        enabled: false,
        activeProfile: "Pro",
        profiles: [],
      } as RouterConfig;
    }
  };

  try {
    prepared = await prepareProfileActivation(root, profileName, ctx.modelRegistry);
    const parsed = parseModelIdentifier(prepared.profile.coordinatorModel);
    if (!parsed) {
      throw new ProfileActivationError("validation_failed", `Invalid coordinator model: ${prepared.profile.coordinatorModel}`);
    }
    const coordinator = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!coordinator) {
      throw new ProfileActivationError("validation_failed", `Unknown coordinator model: ${prepared.profile.coordinatorModel}`);
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(coordinator)) {
      throw new ProfileActivationError("validation_failed", `Coordinator is not authenticated: ${prepared.profile.coordinatorModel}`);
    }

    const sameCoordinator = previousCoordinator
      && previousCoordinator.provider === coordinator.provider
      && previousCoordinator.id === coordinator.id;

    if (!sameCoordinator) {
      const success = await api.setModel(coordinator);
      if (!success) {
        throw new ProfileActivationError(
          "coordinator_failed",
          `Could not activate coordinator model ${prepared.profile.coordinatorModel} (missing authentication or unavailable).`,
        );
      }
      coordinatorChanged = true;
    }

    try {
      await persistActiveProfile(root, prepared.config, prepared.previous);
    } catch (error) {
      if (coordinatorChanged) await restoreCoordinator(api, ctx.modelRegistry, previousCoordinator, ctx.ui);
      coordinatorChanged = false;
      throw error;
    }

    const status = formatActiveProfileStatus(prepared.config);
    ctx.ui.setStatus("agent-profile", status);
    ctx.ui.notify(`Activated ${status}`, "info");
    return {
      ok: true,
      profile: prepared.profile,
      config: prepared.config,
      coordinator: coordinatorRef(coordinator),
    };
  } catch (error: unknown) {
    const message = error instanceof ProfileActivationError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    if (coordinatorChanged) await restoreCoordinator(api, ctx.modelRegistry, previousCoordinator, ctx.ui);
    const retainedConfig = await retainedFallback();
    ctx.ui.setStatus("agent-profile", formatActiveProfileStatus(retainedConfig));
    ctx.ui.notify(`agent-profile activation failed: ${message}`, "error");
    return {
      ok: false,
      error: message,
      retainedConfig,
      retainedCoordinator: previousCoordinator,
    };
  }
}

/**
 * Startup activation for either `--agent-profile` or the remembered disk profile.
 * Always atomic: success ends with session routing+status on the profile; failure leaves
 * coordinator, dispatch routing (session gate), status presentation, and disk unchanged
 * relative to the pre-attempt baseline (remembered profile stays on disk but is not
 * session-activated if coordinator application fails).
 */
export async function activateStartupProfile(input: {
  api: ProfileModelApi;
  root: string;
  /** When set, flag wins and is persisted on success. When null, use remembered disk profile. */
  flagName: string | null;
  ctx: ProfileActivationContext;
  runtime: SessionProfileRuntime;
}): Promise<ActivationResult> {
  let disk: RouterConfig;
  try {
    disk = await loadRouterConfig(input.root);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    input.runtime.activated = false;
    input.runtime.routingConfig = undefined;
    input.runtime.lastError = message;
    input.runtime.statusLine = "agent-profile: error";
    input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
    input.ctx.ui.notify(`agent-profile: failed to load router config: ${message}`, "error");
    return {
      ok: false,
      error: message,
      retainedConfig: {
        schemaVersion: 2,
        enabled: false,
        activeProfile: "Pro",
        profiles: [],
      },
      retainedCoordinator: input.ctx.model ? { ...input.ctx.model } : undefined,
    };
  }

  const targetName = (input.flagName && input.flagName.trim()) || disk.activeProfile;
  const previousCoordinator = input.ctx.model ? { ...input.ctx.model } : undefined;

  // Validate target before any mutation. Remembered-profile path must not half-apply.
  let prepared: Awaited<ReturnType<typeof prepareProfileActivation>>;
  try {
    prepared = await prepareProfileActivation(input.root, targetName, input.ctx.modelRegistry);
  } catch (error: unknown) {
    const message = error instanceof ProfileActivationError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    input.runtime.activated = false;
    input.runtime.routingConfig = undefined;
    input.runtime.lastError = message;
    // Disk unchanged (prepare never writes). Status must not claim a live activated profile for routing.
    input.runtime.statusLine = `agent-profile: inactive (${message})`;
    input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
    input.ctx.ui.notify(`agent-profile activation failed: ${message}`, "error");
    return {
      ok: false,
      error: message,
      retainedConfig: disk,
      retainedCoordinator: previousCoordinator,
    };
  }

  const parsed = parseModelIdentifier(prepared.profile.coordinatorModel);
  if (!parsed) {
    const message = `Invalid coordinator model: ${prepared.profile.coordinatorModel}`;
    input.runtime.activated = false;
    input.runtime.routingConfig = undefined;
    input.runtime.lastError = message;
    input.runtime.statusLine = `agent-profile: inactive (${message})`;
    input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
    input.ctx.ui.notify(`agent-profile activation failed: ${message}`, "error");
    return { ok: false, error: message, retainedConfig: disk, retainedCoordinator: previousCoordinator };
  }

  const coordinator = input.ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!coordinator || !input.ctx.modelRegistry.hasConfiguredAuth(coordinator)) {
    const message = !coordinator
      ? `Unknown coordinator model: ${prepared.profile.coordinatorModel}`
      : `Coordinator is not authenticated: ${prepared.profile.coordinatorModel}`;
    input.runtime.activated = false;
    input.runtime.routingConfig = undefined;
    input.runtime.lastError = message;
    input.runtime.statusLine = `agent-profile: inactive (${message})`;
    input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
    input.ctx.ui.notify(`agent-profile activation failed: ${message}`, "error");
    return { ok: false, error: message, retainedConfig: disk, retainedCoordinator: previousCoordinator };
  }

  const sameCoordinator = previousCoordinator
    && previousCoordinator.provider === coordinator.provider
    && previousCoordinator.id === coordinator.id;

  let coordinatorChanged = false;
  if (!sameCoordinator) {
    const success = await input.api.setModel(coordinator);
    if (!success) {
      const message = `Could not activate coordinator model ${prepared.profile.coordinatorModel} (missing authentication or unavailable).`;
      // Coordinator unchanged (setModel false). Do not enable profile routing. Disk unchanged unless we already match persisted.
      input.runtime.activated = false;
      input.runtime.routingConfig = undefined;
      input.runtime.lastError = message;
      input.runtime.statusLine = `agent-profile: inactive (${message})`;
      input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
      input.ctx.ui.notify(`agent-profile activation failed: ${message}`, "error");
      return { ok: false, error: message, retainedConfig: disk, retainedCoordinator: previousCoordinator };
    }
    coordinatorChanged = true;
  }

  // Persist when flag requested a name, or when remembered profile already matches disk as no-op write of same active.
  // Successful coordinator confirm always marks session activated; persist flag/remembered difference:
  // --agent-profile must persist selection (fr-10). Remembered path already has the name on disk — no write needed unless flag.
  if (input.flagName && input.flagName.trim()) {
    try {
      await persistActiveProfile(input.root, prepared.config, prepared.previous);
    } catch (error: unknown) {
      if (coordinatorChanged) await restoreCoordinator(input.api, input.ctx.modelRegistry, previousCoordinator, input.ctx.ui);
      const message = error instanceof ProfileActivationError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      input.runtime.activated = false;
      input.runtime.routingConfig = undefined;
      input.runtime.lastError = message;
      input.runtime.statusLine = formatActiveProfileStatus(disk);
      input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
      input.ctx.ui.notify(`agent-profile activation failed: ${message}`, "error");
      return { ok: false, error: message, retainedConfig: disk, retainedCoordinator: previousCoordinator };
    }
  }

  input.runtime.activated = true;
  input.runtime.routingConfig = prepared.config;
  input.runtime.lastError = undefined;
  input.runtime.statusLine = formatActiveProfileStatus(prepared.config);
  input.ctx.ui.setStatus("agent-profile", input.runtime.statusLine);
  input.ctx.ui.notify(`Activated ${input.runtime.statusLine}`, "info");
  return {
    ok: true,
    profile: prepared.profile,
    config: prepared.config,
    coordinator: coordinatorRef(coordinator),
  };
}

export function profileStatusFromRuntime(runtime: SessionProfileRuntime): string {
  return runtime.statusLine;
}

export function ensureRuntimeAfterCommandSuccess(
  runtime: SessionProfileRuntime,
  result: ActivationSuccess,
): void {
  runtime.activated = true;
  runtime.routingConfig = result.config;
  runtime.lastError = undefined;
  runtime.statusLine = formatActiveProfileStatus(result.config);
}

export function ensureRuntimeAfterCommandFailure(
  runtime: SessionProfileRuntime,
  result: ActivationFailure,
): void {
  // Command failure must not scrape away a previously successful session activation.
  if (runtime.activated && runtime.routingConfig) {
    runtime.statusLine = formatActiveProfileStatus(runtime.routingConfig);
    return;
  }
  runtime.activated = false;
  runtime.routingConfig = undefined;
  runtime.lastError = result.error;
  runtime.statusLine = formatActiveProfileStatus(result.retainedConfig);
}

export { getActiveProfile, formatActiveProfileStatus };
