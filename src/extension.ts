import * as path from "path";
import * as vscode from "vscode";

import { AuthError, BacktestClient, NetworkError } from "./api";
import { AuthState, authState, markRejected, saveToken, signOut, tokenProblem } from "./auth";
import { PanelAuth, RunOptions, RunPanel, loadOptions } from "./panel";
import { showResults } from "./results";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Matches `class Foo(Strategy):` and `class Foo(hqg_algorithms.Strategy):`
const STRATEGY_CLASS = /^class\s+\w+\s*\([^)]*\bStrategy\b[^)]*\)\s*:/;
// The service appends " (line N)" to static-analysis errors and joins them with "; ".
const LINE_SUFFIX = /\s*\(line (\d+)\)$/;
// Only files with `# hqg-backtest: HAA Canary` near the top get the run buttons; the part after
// the colon names the run. A bare `# hqg-backtest` uses the file name.
const MARKER = /^\s*#\s*hqg-backtest\b\s*(?::\s*(.*?))?\s*$/;
const MARKER_SEARCH_LINES = 10;

let output: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let runButton: vscode.StatusBarItem;
let panel: RunPanel;
// The marked file the panel runs: the current tab's, if it has the marker. Kept while focus is on
// a non-editor tab such as the results, as long as the strategy is still visible beside it.
let strategyUri: vscode.Uri | undefined;
// Set while a backtest is in flight; calling it stops the run.
let cancelRun: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("HQG Backtest");
  diagnostics = vscode.languages.createDiagnosticCollection("hqg");
  panel = new RunPanel(context, {
    run: () => runBacktest(context, strategyUri),
    cancel: () => cancelRun?.(),
    signIn: (token) => signInWithToken(context, token),
  });
  refreshAuth(context);
  // Tokens last 24 hours; re-check each minute so the panel notices expiry and `hqg login`.
  const authTimer = setInterval(() => refreshAuth(context), 60_000);

  runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  runButton.text = "$(play) Run Backtest";
  runButton.tooltip = "Open the HQG backtest panel";
  runButton.color = new vscode.ThemeColor("charts.blue");
  runButton.command = "hqg.runBacktest";
  updateStrategyContext();

  context.subscriptions.push(
    output,
    diagnostics,
    runButton,
    vscode.window.registerWebviewViewProvider(RunPanel.viewId, panel),
    vscode.window.onDidChangeActiveTextEditor(updateStrategyContext),
    // Closing tabs while the results tab has focus doesn't change the active editor.
    vscode.window.onDidChangeVisibleTextEditors(updateStrategyContext),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) updateStrategyContext();
    }),
    vscode.commands.registerCommand("hqg.runBacktest", openPanel),
    vscode.commands.registerCommand("hqg.signIn", () => panel.showSignIn()),
    vscode.commands.registerCommand("hqg.signOut", () => signOutCommand(context)),
    vscode.commands.registerCommand("hqg.health", () => checkHealth(context)),
    { dispose: () => clearInterval(authTimer) },
    vscode.languages.registerCodeLensProvider({ language: "python" }, { provideCodeLenses }),
    // Stale squiggles from the last run go away once the file is edited.
    vscode.workspace.onDidChangeTextDocument((event) => diagnostics.delete(event.document.uri))
  );
}

export function deactivate(): void {}

const apiUrl = () => vscode.workspace.getConfiguration("hqg").get<string>("apiUrl")!;

/** Re-read the sign-in and show it in the panel. */
async function refreshAuth(context: vscode.ExtensionContext): Promise<AuthState> {
  const state = await authState(context);
  const shown: PanelAuth = state.signedIn
    ? { signedIn: true, netid: state.netid, source: state.source, expiresAt: state.expiresAt }
    : { signedIn: false, reason: state.reason };
  panel.setAuth(shown);
  return state;
}

function findMarker(document: vscode.TextDocument): RegExpExecArray | undefined {
  const lines = Math.min(document.lineCount, MARKER_SEARCH_LINES);
  for (let line = 0; line < lines; line++) {
    const match = MARKER.exec(document.lineAt(line).text);
    if (match) return match;
  }
  return undefined;
}

function hasMarker(document: vscode.TextDocument): boolean {
  return findMarker(document) !== undefined;
}

function strategyName(document: vscode.TextDocument): string | undefined {
  return findMarker(document)?.[1] || undefined;
}

function showStrategy(document: vscode.TextDocument | undefined): void {
  panel.setStrategy(document && path.basename(document.fileName), document && strategyName(document));
}

/** Show the run buttons only while a marked Python file is in front. */
function updateStrategyContext(): void {
  const document = vscode.window.activeTextEditor?.document;
  const isStrategy = document?.languageId === "python" && hasMarker(document);
  vscode.commands.executeCommand("setContext", "hqg.isStrategy", isStrategy);
  if (isStrategy) runButton.show();
  else runButton.hide();

  if (isStrategy) {
    strategyUri = document.uri;
    showStrategy(document);
    return;
  }
  // Another file is in front, or the strategy is no longer on screen (e.g. every tab closed):
  // back to the "open a file" prompt.
  const stillVisible = vscode.window.visibleTextEditors.some(
    (editor) => editor.document.uri.toString() === strategyUri?.toString()
  );
  if (document || !stillVisible) {
    strategyUri = undefined;
    showStrategy(undefined);
  }
}

/** The editor's run buttons open the panel; the run itself starts from the panel's Run button. */
async function openPanel(uri?: vscode.Uri): Promise<void> {
  if (uri) {
    strategyUri = uri;
    showStrategy(await vscode.workspace.openTextDocument(uri));
  }
  await vscode.commands.executeCommand(`${RunPanel.viewId}.focus`);
}

function provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
  if (!hasMarker(document)) return [];
  const lenses: vscode.CodeLens[] = [];
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (STRATEGY_CLASS.test(text)) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, text.length), {
          title: "▶ Run backtest",
          command: "hqg.runBacktest",
          arguments: [document.uri],
        })
      );
    }
  }
  return lenses;
}

/** Check a pasted token with the service and save it. Returns an error to show, or undefined. */
async function signInWithToken(context: vscode.ExtensionContext, pasted: string): Promise<string | undefined> {
  // People often copy the whole cookie ("hqg_auth_token=…"); keep just the value.
  const token = pasted.trim().replace(/^hqg_auth_token=/, "").replace(/;.*$/, "");
  const problem = tokenProblem(token);
  if (problem) return problem;

  try {
    await new BacktestClient(apiUrl(), token).verifyToken();
  } catch (err) {
    if (err instanceof AuthError) {
      return "The backtester turned that token down. Sign in to the dashboard again and copy the new one.";
    }
    if (!(err instanceof NetworkError)) return (err as Error).message;
    // Offline: the token looks valid, so keep it and let the first run confirm it.
    vscode.window.showWarningMessage("Couldn't reach the backtester to check the token; saved it anyway.");
  }

  await saveToken(context, token);
  const state = await refreshAuth(context);
  if (state.signedIn) {
    vscode.window.showInformationMessage(`Signed in to the HQG backtester as ${state.netid ?? "you"}.`);
  }
  return undefined;
}

async function signOutCommand(context: vscode.ExtensionContext): Promise<void> {
  const before = await authState(context);
  await signOut(context);
  await refreshAuth(context);
  vscode.window.showInformationMessage(
    before.signedIn && before.source === "cli"
      ? "Signed out of the HQG extension. The hqg command line tool stays signed in."
      : "Signed out of the HQG backtester."
  );
}

async function checkHealth(context: vscode.ExtensionContext): Promise<void> {
  // The platform proxy in front of the backtester wants the login cookie on every request,
  // /health included, so send the saved token.
  const auth = await authState(context);
  const token = auth.signedIn ? auth.token : undefined;
  try {
    await new BacktestClient(apiUrl(), token).health();
    vscode.window.showInformationMessage(`Backtesting service is reachable at ${apiUrl()}`);
  } catch (err) {
    if (err instanceof AuthError && token) {
      markRejected(token);
      await refreshAuth(context);
    }
    vscode.window.showErrorMessage((err as Error).message);
  }
}

function optionsProblem(options: RunOptions): string | undefined {
  if (!DATE_PATTERN.test(options.start) || !DATE_PATTERN.test(options.end)) {
    return "Pick a start and an end date in the HQG panel.";
  }
  if (options.end <= options.start) return "The end date must be after the start date.";
  if (!(options.capital > 0)) return "Starting equity must be greater than 0.";
  if (!(options.timeoutSeconds > 0)) return "Timeout must be greater than 0.";
  return undefined;
}

async function runBacktest(context: vscode.ExtensionContext, uri: vscode.Uri | undefined): Promise<void> {
  if (cancelRun) {
    vscode.window.showWarningMessage("A backtest is already running.");
    return;
  }
  if (!uri) {
    vscode.window.showErrorMessage("Open a strategy file with # hqg-backtest: <name> near the top.");
    return;
  }
  const auth = await refreshAuth(context);
  if (!auth.signedIn) {
    await panel.showSignIn();
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const options = loadOptions(context);
  const problem = optionsProblem(options);
  if (problem) {
    vscode.window.showErrorMessage(problem);
    return;
  }

  const fileName = path.basename(document.fileName);
  const name = options.name || strategyName(document) || path.parse(document.fileName).name;
  const status = (text: string, running = true) => {
    output.appendLine(`  ${text}`);
    panel.setStatus(text, running);
  };

  diagnostics.delete(document.uri);
  output.appendLine(`\n── ${fileName} · ${options.start} → ${options.end} · $${options.capital.toLocaleString()}`);

  let panelCancelled = false;
  cancelRun = () => (panelCancelled = true);
  panel.setStatus("submitting", true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Backtesting ${fileName}`, cancellable: true },
    async (progress, cancellation) => {
      try {
        const client = new BacktestClient(apiUrl(), auth.token);
        await client.health();
        const jobId = await client.submit({
          strategy_code: document.getText(),
          name,
          start_date: `${options.start}T00:00:00`,
          end_date: `${options.end}T00:00:00`,
          initial_capital: options.capital,
          profile: options.profile,
        });
        status(`job ${jobId}`);

        const started = Date.now();
        const record = await client.waitForResult(
          jobId,
          options.timeoutSeconds * 1000,
          (jobStatus) => {
            status(jobStatus.toLowerCase());
            progress.report({ message: jobStatus.toLowerCase() });
          },
          () => panelCancelled || cancellation.isCancellationRequested
        );

        if (!record) {
          const outcome = await client.cancel(jobId);
          status(`cancelled; job ${outcome}`, false);
          vscode.window.showInformationMessage(`Backtest stopped: job ${outcome}.`);
          return;
        }

        for (const line of record.logs ?? []) {
          output.appendLine(`  ${line}`);
        }

        if (record.status !== "COMPLETED" || !record.result) {
          const error = record.error || "The backtest did not complete.";
          status(`failed: ${error}`, false);
          reportErrors(document, error);
          vscode.window.showErrorMessage(`Backtest failed: ${error}`, "Show Output").then((choice) => {
            if (choice) output.show(true);
          });
          return;
        }

        const elapsed = (Date.now() - started) / 1000;
        status(`completed in ${elapsed.toFixed(1)}s; results opened beside the file`, false);
        showResults(context, record.result, record.logs ?? [], fileName, elapsed);
      } catch (err) {
        const message = (err as Error).message;
        status(message, false);
        if (err instanceof AuthError) {
          // Revoked or otherwise refused before it expired: back to the Sign In button.
          markRejected(auth.token);
          await refreshAuth(context);
        }
        vscode.window.showErrorMessage(message);
      } finally {
        cancelRun = undefined;
      }
    }
  );
}

/** Put a squiggle on each error that names a line; the rest are only in the notification. */
function reportErrors(document: vscode.TextDocument, error: string): void {
  const found: vscode.Diagnostic[] = [];
  for (const part of error.split("; ")) {
    const match = LINE_SUFFIX.exec(part);
    if (!match) continue;
    const line = Math.min(Number(match[1]) - 1, document.lineCount - 1);
    const diagnostic = new vscode.Diagnostic(
      document.lineAt(Math.max(line, 0)).range,
      part.replace(LINE_SUFFIX, ""),
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = "hqg";
    found.push(diagnostic);
  }
  diagnostics.set(document.uri, found);
}
