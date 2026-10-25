// The side panel: a Sign In button until signed in (pressing it shows the token box and steps
// in place), then the run form (dates, equity, name, timeout, profiling), Run/Cancel, live
// status and the account.

import * as crypto from "crypto";
import * as vscode from "vscode";

export type RunOptions = {
  start: string;
  end: string;
  capital: number;
  name: string;
  timeoutSeconds: number;
  profile: boolean;
  /** Run on this computer instead of the HQG server. */
  local: boolean;
};

/** What the panel shows about the sign-in; never the token itself. */
export type PanelAuth = {
  signedIn: boolean;
  netid?: string;
  source?: "vscode" | "cli";
  expiresAt?: number;
  reason?: string;
};

const DEFAULTS: RunOptions = {
  start: "2023-01-01",
  end: "2024-01-01",
  capital: 10000,
  name: "",
  timeoutSeconds: 600,
  profile: false,
  local: false,
};
const OPTIONS_KEY = "hqg.runOptions";

export function loadOptions(context: vscode.ExtensionContext): RunOptions {
  return { ...DEFAULTS, ...context.globalState.get<Partial<RunOptions>>(OPTIONS_KEY, {}) };
}

type Handlers = {
  run: () => void;
  cancel: () => void;
  /** Checks and saves a pasted token; resolves to an error to show, or undefined on success. */
  signIn: (token: string) => Promise<string | undefined>;
  /** Called whenever the form changes and is saved. */
  optionsChanged: (options: RunOptions) => void;
};

const DASHBOARD_URL = "https://dashboard.uconnquant.com";
// Wide enough for the "No strategy open" sentence to fit on one line.
const MIN_PANEL_WIDTH = 440;
const WIDENED_KEY = "hqg.sidebarWidened";

export class RunPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "hqg.runPanel";

  private view?: vscode.WebviewView;
  private auth: PanelAuth = { signedIn: false };
  private strategy?: string;
  private strategyName?: string;
  private status = "";
  private running = false;
  private pendingSignIn = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly handlers: Handlers) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [media] };

    const nonce = crypto.randomBytes(16).toString("base64");
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset("panel.css")}">
</head>
<body>
  <section id="signed-out" class="signin-form" hidden>
    <img class="logo logo-white" src="${asset("logo-white.png")}" alt="HQG">
    <img class="logo logo-black" src="${asset("logo-black.png")}" alt="HQG">
    <h1>Sign in to the HQG backtester</h1>
    <p class="lead">Paste your dashboard token below. You only need to do this about once a day.</p>
    <p id="auth-reason" class="reason" hidden></p>
    <form id="token-form" class="token-form">
      <label>Dashboard token
        <input type="password" name="token" placeholder="paste hqg_auth_token here" autocomplete="off" spellcheck="false">
      </label>
      <p id="token-error" class="error" hidden></p>
      <div class="actions">
        <button id="token-submit" type="submit" class="primary">Sign In</button>
      </div>
    </form>
    <div class="steps">
      <p class="steps-title">Where to copy it from</p>
      <ol>
        <li>Sign in at <a href="#" id="open-dashboard">dashboard.uconnquant.com</a>.</li>
        <li>Open DevTools: <kbd>⌥⌘I</kbd> on Mac, <kbd>F12</kbd> on Windows.</li>
        <li>Go to <b>Application</b> → <b>Cookies</b> → <b>https://dashboard.uconnquant.com</b>. In Firefox it's the <b>Storage</b> tab.</li>
        <li>Find <code>hqg_auth_token</code>, copy its <b>Value</b>, and paste it above.</li>
      </ol>
      <p class="steps-note">The token lasts 24 hours, then you'll need to sign in again.</p>
    </div>
  </section>

  <section id="signed-in" hidden>
    <div id="no-strategy" class="callout" hidden title="The line has to be within the file's first 10 lines.">
      <p class="callout-title">No strategy open</p>
      <p>Open a Python file with <code># hqg-backtest: &lt;name&gt;</code> at the top.</p>
    </div>
    <div id="strategy-block" class="strategy" hidden>
      <span class="label">Strategy</span>
      <span id="strategy" class="value"></span>
      <span id="strategy-file" class="label" hidden></span>
    </div>
    <form id="form">
      <div class="row">
        <label>Start date<input type="date" name="start" required></label>
        <label>End date<input type="date" name="end" required></label>
      </div>
      <label class="switch" title="Run the backtest on this computer instead of the HQG server. The first time, the extension sets up a private Python environment, which takes about a minute.">
        <input type="checkbox" name="local" role="switch">
        <span class="track" aria-hidden="true"></span>
        Local backtest
      </label>
      <label>Starting equity ($)<input type="number" name="capital" min="1" step="any" required></label>
      <label>Run name<input type="text" name="runName" placeholder="defaults to the strategy name"></label>
      <label>Timeout (seconds)<input type="number" name="timeoutSeconds" min="1" step="1" required></label>
      <label class="check" title="Times every function while the backtest runs; the slowest show in the results' Profile tab. The run takes a little longer.">
        <input type="checkbox" name="profile">Profile speed (slowest functions)
      </label>
      <p id="error" class="error" hidden></p>
      <button id="run" type="submit" class="primary">▶ Run Backtest</button>
      <button id="cancel" type="button" class="secondary" hidden>Cancel</button>
    </form>
    <p id="status" class="status"></p>
    <footer>
      <span id="account" class="account"></span>
      <div class="footer-buttons">
        <button type="button" id="sign-out" class="secondary">Sign Out</button>
        <button type="button" id="health" class="secondary">Check Service</button>
      </div>
    </footer>
  </section>
  <script nonce="${nonce}" src="${asset("panel.js")}"></script>
</body>
</html>`;

    webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready":
          webview.postMessage({ type: "init", options: loadOptions(this.context) });
          this.sync();
          this.deliverSignIn();
          await this.widenIfNarrow(message.width);
          break;
        case "update":
          await this.context.globalState.update(OPTIONS_KEY, message.options);
          this.handlers.optionsChanged(loadOptions(this.context));
          break;
        case "run":
          await this.context.globalState.update(OPTIONS_KEY, message.options);
          this.handlers.run();
          break;
        case "cancel":
          this.handlers.cancel();
          break;
        case "signIn":
          webview.postMessage({ type: "signInResult", error: await this.handlers.signIn(message.token) });
          break;
        case "openDashboard":
          vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
          break;
        case "signOut":
          vscode.commands.executeCommand("hqg.signOut");
          break;
        case "health":
          vscode.commands.executeCommand("hqg.health");
          break;
      }
    });
  }

  /**
   * Widen the sidebar once if it's narrower than the panel's content needs. VS Code has no way to
   * set a sidebar's width, but "increase view width" widens the focused view in 60px steps. It
   * only happens the first time, so a sidebar the user narrows later is left alone.
   */
  private async widenIfNarrow(width: number): Promise<void> {
    if (!(width > 0) || width >= MIN_PANEL_WIDTH || this.context.globalState.get(WIDENED_KEY)) return;
    await this.context.globalState.update(WIDENED_KEY, true);
    if (!this.view?.visible) return;
    await vscode.commands.executeCommand(`${RunPanel.viewId}.focus`);
    for (let step = 0; step < Math.ceil((MIN_PANEL_WIDTH - width) / 60); step++) {
      await vscode.commands.executeCommand("workbench.action.increaseViewWidth");
    }
  }

  setAuth(auth: PanelAuth): void {
    this.auth = auth;
    this.sync();
  }

  /** Open the panel on the token box (the "HQG: Sign In" command, or Run while signed out). */
  async showSignIn(): Promise<void> {
    // A panel opened for the first time isn't listening yet; "ready" delivers this then.
    this.pendingSignIn = true;
    await vscode.commands.executeCommand(`${RunPanel.viewId}.focus`);
    if (this.view?.visible) this.deliverSignIn();
  }

  private deliverSignIn(): void {
    if (!this.pendingSignIn) return;
    this.pendingSignIn = false;
    this.view?.webview.postMessage({ type: "showSignIn" });
  }

  setStrategy(fileName: string | undefined, strategyName: string | undefined): void {
    this.strategy = fileName;
    this.strategyName = strategyName;
    this.sync();
  }

  setStatus(status: string, running: boolean): void {
    this.status = status;
    this.running = running;
    this.sync();
  }

  private sync(): void {
    this.view?.webview.postMessage({
      type: "state",
      auth: this.auth,
      strategy: this.strategy,
      strategyName: this.strategyName,
      status: this.status,
      running: this.running,
    });
  }
}
