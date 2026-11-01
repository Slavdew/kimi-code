import { useState, useEffect, useCallback, useRef } from "react";
import { bridge, Events } from "@/services";
import { requiresManagedProviderLogin, useChatStore, useSettingsStore } from "@/stores";
import { toast } from "@/components/ui/sonner";
import type { KimiPanelState } from "shared/bridge";
import type { ExtensionConfig, UIStreamEvent } from "shared/types";

export type AppStatus = "loading" | "no-workspace" | "runtime-error" | "not-logged-in" | "no-models" | "ready";

export type ConfigErrorStatus = "loading" | "no-workspace" | "runtime-error" | "no-models";

export type AppViewResolution =
  | { readonly view: "login" }
  | {
      readonly view: "status";
      readonly status: ConfigErrorStatus;
      /** True when the status screen must offer a path to the sign-in screen. */
      readonly canGoToLogin: boolean;
    }
  | { readonly view: "main" };

/**
 * Pure view router for App. The `no-models` status (a managed OAuth token
 * exists but config.toml has no models — e.g. a first login whose model
 * provisioning failed after the device flow already persisted the token)
 * must always keep a path back to the sign-in screen: Reload alone cannot
 * change the on-disk state, so without it the user is stranded and the
 * login UI becomes unreachable.
 */
export function resolveAppView(input: {
  readonly status: AppStatus;
  readonly modelsCount: number;
  readonly skippedLogin: boolean;
  readonly showLogin: boolean;
}): AppViewResolution {
  const { status, modelsCount, skippedLogin, showLogin } = input;
  if (showLogin || (status === "not-logged-in" && !skippedLogin)) {
    return { view: "login" };
  }
  if (skippedLogin && modelsCount === 0) {
    return { view: "status", status: "no-models", canGoToLogin: true };
  }
  if (status !== "ready" && status !== "not-logged-in") {
    return { view: "status", status, canGoToLogin: status === "no-models" };
  }
  return { view: "main" };
}

export async function restorePanelSession(input: {
  readonly state: KimiPanelState | null;
  readonly workspaceRoot: string | null;
  readonly setCurrentWorkDir: (workDir: string | null) => void;
  readonly loadSession: (sessionId: string, events: UIStreamEvent[]) => Promise<void>;
}): Promise<string | null> {
  const { state, workspaceRoot, setCurrentWorkDir, loadSession } = input;
  if (state === null) return null;
  try {
    const result = await bridge.setWorkDir(state.workDir);
    if (!result.ok) throw new Error("The saved working directory is unavailable.");
    setCurrentWorkDir(result.workDir === workspaceRoot ? null : result.workDir);
    if (state.sessionId !== null) {
      const events = await bridge.loadSessionHistory(state.sessionId);
      await loadSession(state.sessionId, events);
    }
    return null;
  } catch (error) {
    await bridge.resetSession().catch(() => undefined);
    return error instanceof Error ? error.message : String(error);
  }
}

export interface AppInitState {
  status: AppStatus;
  errorMessage: string | null;
  modelsCount: number;
  refresh: () => void;
}

export function useAppInit(): AppInitState {
  const [state, setState] = useState<Omit<AppInitState, "refresh">>({
    status: "loading",
    errorMessage: null,
    modelsCount: 0,
  });
  const [initKey, setInitKey] = useState(0);
  const catalogApplied = useRef(false);
  const {
    initModels,
    setModels,
    setExtensionConfig,
    setWireSlashCommands,
    setIsLoggedIn,
    setWorkspaceRoot,
    setCurrentWorkDir,
  } = useSettingsStore();

  const refresh = useCallback(() => {
    catalogApplied.current = false;
    setState({ status: "loading", errorMessage: null, modelsCount: 0 });
    setInitKey((k) => k + 1);
  }, []);

  useEffect(() => {
    return bridge.on<{ config: ExtensionConfig; changedKeys: string[] }>(Events.ExtensionConfigChanged, ({ config }) => {
      setExtensionConfig(config);
    });
  }, [setExtensionConfig, refresh]);

  useEffect(() => {
    let cancelled = false;
    let latestRead = 0;
    const unsubscribe = bridge.on(Events.ModelCatalogChanged, () => {
      const read = ++latestRead;
      void bridge.getModels().then(({ models }) => {
        if (!cancelled && read === latestRead) {
          catalogApplied.current = true;
          setModels(models);
        }
      }).catch((error: unknown) => {
        console.error("[AppInit] Failed to refresh models:", error);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setModels]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const workspace = await bridge.checkWorkspace();
        if (cancelled) {
          return;
        }

        if (!workspace.hasWorkspace) {
          setState({ status: "no-workspace", errorMessage: null, modelsCount: 0 });
          return;
        }

        const workspaceRoot = workspace.workspaceRoot ?? workspace.path ?? null;
        setWorkspaceRoot(workspaceRoot);

        const [extensionConfig, slashCommands] = await Promise.all([
          bridge.getExtensionConfig(),
          bridge.getSlashCommands(),
        ]);
        if (cancelled) {
          return;
        }

        setExtensionConfig(extensionConfig);
        setWireSlashCommands(slashCommands);

        const [loginStatus, kimiConfig] = await Promise.all([bridge.checkLoginStatus(), bridge.getModels()]);
        if (cancelled) {
          return;
        }

        console.log("[AppInit] Login status:", loginStatus, "kimiConfig:", kimiConfig);

        setIsLoggedIn(loginStatus.loggedIn);
        initModels(
          catalogApplied.current ? useSettingsStore.getState().models : kimiConfig.models,
          kimiConfig.defaultModel,
          kimiConfig.defaultThinking,
          kimiConfig.defaultThinkingEffort,
        );

        const modelsCount = useSettingsStore.getState().models.length;

        if (modelsCount === 0 && !loginStatus.loggedIn) {
          setState({ status: "not-logged-in", errorMessage: null, modelsCount });
          return;
        }

        if (modelsCount === 0) {
          setState({ status: "no-models", errorMessage: null, modelsCount: 0 });
          return;
        }

        if (requiresManagedProviderLogin(kimiConfig.models, kimiConfig.defaultModel, loginStatus.loggedIn)) {
          setState({ status: "not-logged-in", errorMessage: null, modelsCount });
          return;
        }

        const restoreError = await restorePanelSession({
          state: bridge.getInitialPanelState(),
          workspaceRoot,
          setCurrentWorkDir,
          loadSession: useChatStore.getState().loadSession,
        });
        if (restoreError !== null && !cancelled) {
          toast.warning(`Unable to restore the conversation: ${restoreError}`);
        }

        setState({ status: "ready", errorMessage: null, modelsCount });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "runtime-error",
            errorMessage: error instanceof Error ? error.message : "Failed to initialize",
            modelsCount: 0,
          });
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [initKey, initModels, setExtensionConfig, setWireSlashCommands, setIsLoggedIn, setCurrentWorkDir]);

  return { ...state, refresh };
}
