/**
 * Scenario: App-level view routing after init, across login state transitions.
 * Responsibilities: the sign-in screen must stay reachable from every state — in
 * particular the no-models state (a managed OAuth token exists but config.toml
 * has no models, e.g. a first login whose model provisioning failed after the
 * device flow already persisted the token), where Reload alone can never change
 * the on-disk state and the user would otherwise be stranded.
 * Wiring: resolveAppView is pure; the bridge and toast boundaries are mocked away.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/app-init.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  setWorkDir: vi.fn(),
  loadSessionHistory: vi.fn(),
  resetSession: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge,
  Events: {},
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { resolveAppView, restorePanelSession, type AppStatus } from "../webview-ui/src/hooks/useAppInit";

beforeEach(() => {
  vi.clearAllMocks();
  bridge.resetSession.mockResolvedValue({ ok: true });
});

describe("restorePanelSession", () => {
  it("restores the working directory and conversation history", async () => {
    bridge.setWorkDir.mockResolvedValue({ ok: true, workDir: "/workspace/packages/demo" });
    const events = [{ type: "TurnBegin" }];
    bridge.loadSessionHistory.mockResolvedValue(events);
    const setCurrentWorkDir = vi.fn();
    const loadSession = vi.fn(async () => undefined);

    const error = await restorePanelSession({
      state: { sessionId: "session-1", workDir: "/workspace/packages/demo", title: "Renamed chat" },
      workspaceRoot: "/workspace",
      setCurrentWorkDir,
      loadSession,
    });

    expect(error).toBeNull();
    expect(setCurrentWorkDir).toHaveBeenCalledWith("/workspace/packages/demo");
    expect(loadSession).toHaveBeenCalledWith("session-1", events);
    expect(bridge.resetSession).not.toHaveBeenCalled();
  });

  it("keeps the UI usable and clears stale state when the saved session is unavailable", async () => {
    bridge.setWorkDir.mockResolvedValue({ ok: true, workDir: "/workspace" });
    bridge.loadSessionHistory.mockRejectedValue(new Error("Session was not found"));
    const loadSession = vi.fn();

    const error = await restorePanelSession({
      state: { sessionId: "deleted-session", workDir: null, title: "Old chat" },
      workspaceRoot: "/workspace",
      setCurrentWorkDir: vi.fn(),
      loadSession,
    });

    expect(error).toBe("Session was not found");
    expect(loadSession).not.toHaveBeenCalled();
    expect(bridge.resetSession).toHaveBeenCalledOnce();
  });

  it("does nothing for a panel without serialized state", async () => {
    const error = await restorePanelSession({
      state: null,
      workspaceRoot: "/workspace",
      setCurrentWorkDir: vi.fn(),
      loadSession: vi.fn(),
    });

    expect(error).toBeNull();
    expect(bridge.setWorkDir).not.toHaveBeenCalled();
  });
});

function resolve(
  status: AppStatus,
  options: { modelsCount?: number; skippedLogin?: boolean; showLogin?: boolean } = {},
) {
  return resolveAppView({
    status,
    modelsCount: options.modelsCount ?? 0,
    skippedLogin: options.skippedLogin ?? false,
    showLogin: options.showLogin ?? false,
  });
}

describe("resolveAppView", () => {
  it("routes a brand-new user (no token, no models) to the login screen", () => {
    expect(resolve("not-logged-in")).toEqual({ view: "login" });
  });

  it("routes a skipped login without models to no-models with a sign-in path", () => {
    expect(resolve("not-logged-in", { skippedLogin: true })).toEqual({
      view: "status",
      status: "no-models",
      canGoToLogin: true,
    });
  });

  it("routes a skipped login with models to the main view", () => {
    expect(resolve("not-logged-in", { skippedLogin: true, modelsCount: 2 })).toEqual({
      view: "main",
    });
  });

  it("keeps a sign-in path in the no-models trap (token without model config)", () => {
    // Regression: this state previously rendered "Model setup required" with only
    // a Reload button, making the login screen unreachable for affected users.
    expect(resolve("no-models")).toEqual({
      view: "status",
      status: "no-models",
      canGoToLogin: true,
    });
  });

  it("routes to the login screen when the user asks for it from any state", () => {
    expect(resolve("no-models", { showLogin: true })).toEqual({ view: "login" });
    expect(resolve("ready", { showLogin: true, modelsCount: 1 })).toEqual({ view: "login" });
  });

  it("routes a no-models user who skips again back to no-models with a sign-in path", () => {
    expect(resolve("no-models", { skippedLogin: true })).toEqual({
      view: "status",
      status: "no-models",
      canGoToLogin: true,
    });
  });

  it("routes ready to the main view", () => {
    expect(resolve("ready", { modelsCount: 1 })).toEqual({ view: "main" });
  });

  it("routes non-login error statuses to status screens without a sign-in path", () => {
    for (const status of ["loading", "no-workspace", "runtime-error"] as const) {
      expect(resolve(status)).toEqual({ view: "status", status, canGoToLogin: false });
    }
  });
});
