import * as vscode from "vscode";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";
import { Events, parseKimiPanelState, type KimiPanelState } from "../shared/bridge";
import { BridgeHandler } from "./bridge-handler";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * Manages webview instances (sidebar and panels).
 * Each webview gets a unique viewId for session isolation.
 */
export class KimiWebviewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer<KimiPanelState> {
  private webviews = new Map<string, vscode.Webview>();
  private panels = new Map<string, vscode.WebviewPanel>();
  private panelStates = new Map<string, KimiPanelState>();
  private bridgeHandler: BridgeHandler;

  constructor(
    private readonly extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    showLogs: () => void,
    writeLog: (message: string) => void,
  ) {
    this.bridgeHandler = new BridgeHandler(
      this.broadcastInternal.bind(this),
      context.workspaceState,
      context.globalStorageUri.fsPath,
      this.reloadWebview.bind(this),
      showLogs,
      writeLog,
      this.updatePanelState.bind(this),
    );
  }

  dispose(): void {
    void this.bridgeHandler.dispose();
  }

  shutdown(): Promise<void> {
    return this.bridgeHandler.dispose();
  }

  get harness(): KimiHarness {
    return this.bridgeHandler.runtime.harness;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewId = `sidebar_${crypto.randomUUID()}`;
    this.setupWebview(webviewId, webviewView.webview);

    webviewView.onDidDispose(() => {
      void this.bridgeHandler.disposeView(webviewId);
      this.webviews.delete(webviewId);
    });
  }

  createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel("kimiPanel", "Kimi Code", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    });
    this.registerPanel(panel, null);
    return panel;
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: KimiPanelState): Promise<void> {
    this.registerPanel(panel, parseKimiPanelState(state));
  }

  private registerPanel(panel: vscode.WebviewPanel, state: KimiPanelState | null): void {
    const webviewId = `panel_${crypto.randomUUID()}`;
    this.panels.set(webviewId, panel);
    if (state !== null) this.panelStates.set(webviewId, state);
    panel.title = panelTitle(state?.title);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "kimi-icon.svg");
    this.setupWebview(webviewId, panel.webview);

    const visibilitySubscription = panel.onDidChangeViewState(() => {
      if (panel.active) void this.bridgeHandler.emitViewState(webviewId);
    });
    panel.onDidDispose(() => {
      visibilitySubscription.dispose();
      void this.bridgeHandler.disposeView(webviewId);
      this.webviews.delete(webviewId);
      this.panels.delete(webviewId);
      this.panelStates.delete(webviewId);
    });
  }

  private updatePanelState(webviewId: string, state: KimiPanelState): void {
    const panel = this.panels.get(webviewId);
    if (panel === undefined) return;
    this.panelStates.set(webviewId, state);
    panel.title = panelTitle(state.title);
    this.broadcastInternal(Events.PanelStateChanged, state, webviewId);
  }

  broadcast(event: string, data: unknown): void {
    this.broadcastInternal(event, data);
  }

  newConversationInActivePanel(): boolean {
    const group = vscode.window.tabGroups.activeTabGroup;
    const input = group.activeTab?.input;
    if (!(input instanceof vscode.TabInputWebview) || !isKimiPanelViewType(input.viewType)) return false;
    const active = [...this.panels.entries()].find(([, panel]) => panel.active && panel.viewColumn === group.viewColumn);
    if (active === undefined) return false;
    this.broadcastInternal(Events.NewConversation, {}, active[0]);
    return true;
  }

  async insertEditorMention(documentUri: vscode.Uri, selection: vscode.Selection): Promise<boolean> {
    let inserted = false;
    await Promise.all(
      [...this.webviews.keys()].map(async (webviewId) => {
        const mention = await this.bridgeHandler.getEditorMention(webviewId, documentUri, selection);
        if (mention === null) return;
        inserted = true;
        this.broadcastInternal(Events.InsertMention, { mention }, webviewId);
      }),
    );
    return inserted;
  }

  private setupWebview(webviewId: string, webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webview.html = this.getHtml(webviewId, webview);
    this.webviews.set(webviewId, webview);

    webview.onDidReceiveMessage(async (msg: unknown) => {
      const result = await this.bridgeHandler.handle(msg, webviewId);
      webview.postMessage(result);
    });
  }

  private broadcastInternal(event: string, data: unknown, targetWebviewId?: string): void {
    const msg = { event, data };

    if (targetWebviewId) {
      void this.webviews.get(targetWebviewId)?.postMessage(msg);
      if (event === Events.NewConversation || isSessionStart(data)) {
        void this.bridgeHandler.emitViewState(targetWebviewId);
      }
    } else {
      this.webviews.forEach((webview) => {
        void webview.postMessage(msg);
      });
    }
  }

  private reloadWebview(webviewId: string): void {
    const webview = this.webviews.get(webviewId);
    if (webview) {
      webview.html = this.getHtml(webviewId, webview);
    }
  }

  reloadAllWebviews(): void {
    this.webviews.forEach((webview, webviewId) => {
      webview.html = this.getHtml(webviewId, webview);
    });
  }

  async resetAllWebviews(): Promise<void> {
    await Promise.all(
      [...this.webviews.keys()].map((webviewId) => this.bridgeHandler.disposeView(webviewId)),
    );
    this.panels.forEach((panel, webviewId) => {
      const state = { sessionId: null, workDir: null, title: null };
      this.panelStates.set(webviewId, state);
      panel.title = "Kimi Code";
      this.broadcastInternal(Events.PanelStateChanged, state, webviewId);
    });
    this.reloadAllWebviews();
  }

  getBaselineContent(sessionId: string, filePath: string): Promise<string> {
    return this.bridgeHandler.getBaselineContent(sessionId, filePath);
  }

  async setYoloModeForActiveSessions(enabled: boolean): Promise<void> {
    await this.bridgeHandler.runtime.setYoloModeForActiveSessions(enabled);
  }

  private getHtml(webviewId: string, webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const baseUri = webview.asWebviewUri(this.extensionUri).toString();
    const nonce = getNonce();
    const state = this.panelStates.get(webviewId);
    const stateAttribute = state === undefined
      ? ""
      : ` data-panel-state="${escapeAttribute(JSON.stringify(state))}"`;

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      `media-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`,
      `worker-src ${webview.cspSource} blob:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Kimi Code</title>
</head>
<body data-baseuri="${baseUri}" data-webviewid="${webviewId}"${stateAttribute}>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

function panelTitle(title: string | null | undefined): string {
  const normalized = title?.replaceAll(/\s+/g, " ").trim();
  if (!normalized) return "Kimi Code";
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}

function isKimiPanelViewType(viewType: string): boolean {
  return viewType === "kimiPanel" || viewType.endsWith("-kimiPanel");
}

function isSessionStart(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === "session_start";
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
