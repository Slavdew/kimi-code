import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { Events, type KimiPanelState } from "../shared/bridge";

const host = vi.hoisted(() => {
  type Listener = (webviewId: string, state: KimiPanelState) => void;

  class Uri {
    constructor(readonly fsPath: string) {}

    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(join(base.fsPath, ...segments));
    }

    toString(): string {
      return `vscode-resource://${this.fsPath}`;
    }
  }

  class BridgeHandler {
    static instances: BridgeHandler[] = [];
    readonly runtime = { harness: {}, setYoloModeForActiveSessions: vi.fn() };
    readonly onViewStateChange: Listener;
    readonly emitViewState = vi.fn(async () => undefined);
    readonly dispose = vi.fn(async () => undefined);
    readonly disposeView = vi.fn(async () => undefined);
    readonly handle = vi.fn();

    constructor(...args: unknown[]) {
      this.onViewStateChange = args[6] as Listener;
      BridgeHandler.instances.push(this);
    }
  }

  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }

  return {
    Uri,
    BridgeHandler,
    TabInputWebview,
    activeTabInput: null as unknown,
    activeViewColumn: 1,
    createWebviewPanel: vi.fn(),
  };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  ViewColumn: { One: 1 },
  TabInputWebview: host.TabInputWebview,
  window: {
    createWebviewPanel: host.createWebviewPanel,
    tabGroups: {
      get activeTabGroup() {
        return {
          activeTab: host.activeTabInput === null ? undefined : { input: host.activeTabInput },
          viewColumn: host.activeViewColumn,
        };
      },
    },
  },
}));

vi.mock("../src/bridge-handler", () => ({ BridgeHandler: host.BridgeHandler }));

import { KimiWebviewProvider } from "../src/KimiWebviewProvider";

type TestUri = InstanceType<typeof host.Uri>;

interface FakePanel {
  title: string;
  active: boolean;
  viewColumn: number;
  iconPath?: unknown;
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    asWebviewUri: (uri: TestUri) => TestUri;
  };
  onDidDispose: (listener: () => void) => { dispose: ReturnType<typeof vi.fn> };
  onDidChangeViewState: (listener: () => void) => { dispose: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.BridgeHandler.instances = [];
  host.activeTabInput = new host.TabInputWebview("kimiPanel");
  host.activeViewColumn = 1;
});

describe("KimiWebviewProvider panels", () => {
  it("uses the Kimi icon for editor tabs", () => {
    const panel = makePanel();
    host.createWebviewPanel.mockReturnValue(panel);
    const provider = makeProvider();

    const created = provider.createPanel();

    expect(created).toBe(panel);
    expect(panel.iconPath).toBeInstanceOf(host.Uri);
    expect((panel.iconPath as TestUri).fsPath).toBe(join("/extension", "resources", "kimi-icon.svg"));
  });

  it("updates the title and serializes state independently for each panel", () => {
    const first = makePanel();
    const second = makePanel();
    host.createWebviewPanel.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const provider = makeProvider();
    provider.createPanel();
    provider.createPanel();
    const bridge = host.BridgeHandler.instances[0]!;
    const firstId = webviewId(first);
    const secondId = webviewId(second);
    const state = { sessionId: "session-1", workDir: "/workspace", title: 'Renamed "chat" <local>' };

    bridge.onViewStateChange(firstId, state);

    expect(first.title).toBe(state.title);
    expect(second.title).toBe("Kimi Code");
    expect(first.webview.postMessage).toHaveBeenCalledWith({ event: Events.PanelStateChanged, data: state });
    expect(second.webview.postMessage).not.toHaveBeenCalledWith({ event: Events.PanelStateChanged, data: state });

    provider.reloadAllWebviews();
    expect(first.webview.html).toContain("data-panel-state=");
    expect(first.webview.html).toContain("&quot;Renamed \\&quot;chat\\&quot; &lt;local&gt;&quot;");
    expect(second.webview.html).not.toContain("data-panel-state=");
    expect(secondId).not.toBe(firstId);
  });

  it("restores an existing panel without creating a replacement", async () => {
    const panel = makePanel();
    const provider = makeProvider();
    const state = { sessionId: "session-1", workDir: "/workspace/subdir", title: "Restored chat" };

    await provider.deserializeWebviewPanel(panel as unknown as vscode.WebviewPanel, state);

    expect(host.createWebviewPanel).not.toHaveBeenCalled();
    expect(panel.title).toBe("Restored chat");
    expect(panel.webview.html).toContain("data-panel-state=");
    expect(panel.webview.html).toContain("session-1");
    expect(panel.webview.html).toContain("/workspace/subdir");
  });

  it("falls back to an empty panel for malformed serialized state", async () => {
    const panel = makePanel();
    const provider = makeProvider();

    await provider.deserializeWebviewPanel(
      panel as unknown as vscode.WebviewPanel,
      { sessionId: 42, workDir: null, title: null } as unknown as KimiPanelState,
    );

    expect(panel.title).toBe("Kimi Code");
    expect(panel.webview.html).not.toContain("data-panel-state=");
  });

  it("starts a new conversation only in the active panel", () => {
    const active = makePanel();
    const inactive = makePanel();
    inactive.active = false;
    host.createWebviewPanel.mockReturnValueOnce(active).mockReturnValueOnce(inactive);
    const provider = makeProvider();
    provider.createPanel();
    provider.createPanel();

    expect(provider.newConversationInActivePanel()).toBe(true);
    expect(active.webview.postMessage).toHaveBeenCalledWith({ event: Events.NewConversation, data: {} });
    expect(inactive.webview.postMessage).not.toHaveBeenCalledWith({ event: Events.NewConversation, data: {} });
  });

  it("uses the active editor group instead of an active panel in a background group", () => {
    const background = makePanel();
    const active = makePanel();
    background.viewColumn = 1;
    active.viewColumn = 2;
    host.activeViewColumn = 2;
    host.createWebviewPanel.mockReturnValueOnce(background).mockReturnValueOnce(active);
    const provider = makeProvider();
    provider.createPanel();
    provider.createPanel();

    expect(provider.newConversationInActivePanel()).toBe(true);
    expect(active.webview.postMessage).toHaveBeenCalledWith({ event: Events.NewConversation, data: {} });
    expect(background.webview.postMessage).not.toHaveBeenCalledWith({ event: Events.NewConversation, data: {} });
  });

  it("normalizes long and multiline panel titles", () => {
    const panel = makePanel();
    host.createWebviewPanel.mockReturnValue(panel);
    const provider = makeProvider();
    provider.createPanel();

    host.BridgeHandler.instances[0]!.onViewStateChange(webviewId(panel), {
      sessionId: "session-1",
      workDir: "/workspace",
      title: `  First line\nSecond line ${"x".repeat(100)}  `,
    });

    expect(panel.title).toBe(`First line Second line ${"x".repeat(56)}…`);
    expect(panel.title).toHaveLength(80);
  });

  it("clears serialized panel state when resetting webviews", async () => {
    const panel = makePanel();
    host.createWebviewPanel.mockReturnValue(panel);
    const provider = makeProvider();
    provider.createPanel();
    const bridge = host.BridgeHandler.instances[0]!;
    bridge.onViewStateChange(webviewId(panel), {
      sessionId: "session-1",
      workDir: "/workspace",
      title: "Old chat",
    });

    await provider.resetAllWebviews();

    const emptyState = { sessionId: null, workDir: null, title: null };
    expect(panel.title).toBe("Kimi Code");
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ event: Events.PanelStateChanged, data: emptyState });
    expect(panel.webview.html).toContain("&quot;sessionId&quot;:null");
    expect(panel.webview.html).not.toContain("session-1");
  });
});

function makeProvider(): KimiWebviewProvider {
  return new KimiWebviewProvider(
    new host.Uri("/extension") as unknown as vscode.Uri,
    {
      workspaceState: {},
      globalStorageUri: new host.Uri("/global-storage"),
    } as unknown as vscode.ExtensionContext,
    vi.fn(),
    vi.fn(),
  );
}

function makePanel(): FakePanel {
  return {
    title: "Kimi Code",
    active: true,
    viewColumn: 1,
    webview: {
      html: "",
      options: undefined,
      cspSource: "vscode-resource:",
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: vi.fn(),
      asWebviewUri: (uri) => uri,
    },
    onDidDispose: () => ({ dispose: vi.fn() }),
    onDidChangeViewState: () => ({ dispose: vi.fn() }),
  };
}

function webviewId(panel: FakePanel): string {
  const match = /data-webviewid="([^"]+)"/.exec(panel.webview.html);
  if (match?.[1] === undefined) throw new Error("Webview ID is missing");
  return match[1];
}
