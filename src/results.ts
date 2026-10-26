// The results tab: a webview beside the strategy laid out like the dashboard's backtest page.

import * as crypto from "crypto";
import * as vscode from "vscode";

import { BacktestResult } from "./api";

const COMPARE_KEY = "hqg.compareSp500";

/**
 * Daily closes of a Yahoo symbol, keyed by UTC midnight. The engine measures against ^GSPC (the
 * S&P 500) and takes its risk-free rate from ^IRX (the 3-month T-bill yield, in percent).
 */
async function fetchDaily(symbol: string, from: number, to: number): Promise<{ time: number; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1d`;
  // Yahoo answers a browser user agent much faster than Node's default one.
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Yahoo Finance answered HTTP ${response.status}.`);
  const chart = ((await response.json()) as any)?.chart?.result?.[0];
  const times: number[] = chart?.timestamp ?? [];
  const closes: (number | null)[] = chart?.indicators?.quote?.[0]?.close ?? [];
  const points = times
    .map((t, i) => ({ time: Math.floor(t / 86400) * 86400, close: closes[i] as number }))
    .filter((p) => Number.isFinite(p.close));
  if (!points.length) throw new Error(`Yahoo Finance sent no ${symbol} prices for these dates.`);
  return points;
}

export function showResults(
  context: vscode.ExtensionContext,
  result: BacktestResult,
  logs: string[],
  fileName: string,
  elapsedSeconds: number
): void {
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  const charts = vscode.Uri.joinPath(context.extensionUri, "node_modules", "lightweight-charts", "dist");

  const panel = vscode.window.createWebviewPanel(
    "hqgResults",
    `Backtest: ${result.parameters?.name || fileName}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [media, charts], retainContextWhenHidden: true }
  );
  // The HQG candlestick mark in the tab, in the theme's icon color.
  panel.iconPath = {
    light: vscode.Uri.joinPath(media, "candles-light.svg"),
    dark: vscode.Uri.joinPath(media, "candles-dark.svg"),
  };

  const webview = panel.webview;
  const nonce = crypto.randomBytes(16).toString("base64");
  const asset = (base: vscode.Uri, file: string) => webview.asWebviewUri(vscode.Uri.joinPath(base, file));
  // Escape "<" so strategy-controlled strings can never close the script tag.
  const compare = context.globalState.get<boolean>(COMPARE_KEY, false);
  const data = JSON.stringify({ result, logs, fileName, elapsedSeconds, compare }).replace(/</g, "\\u003c");

  // Whether Expand maximized this tab's editor group, so Collapse only undoes what it did.
  let maximized = false;
  const setMaximized = async (on: boolean) => {
    if (on === maximized || (on && !panel.active)) return;
    maximized = on;
    // Older VS Code versions lack the command; the charts still float within the tab.
    await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup").then(undefined, () => {});
  };

  webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "expand") {
      await setMaximized(Boolean(message.on));
    } else if (message?.type === "compare") {
      await context.globalState.update(COMPARE_KEY, Boolean(message.on));
    } else if (message?.type === "sp500") {
      try {
        // Without the T-bill rate the S&P 500 metrics fall back to 3.5%, as the engine does.
        const [points, irx] = await Promise.all([
          fetchDaily("^GSPC", message.from, message.to),
          fetchDaily("^IRX", message.from, message.to).catch(() => []),
        ]);
        webview.postMessage({ type: "sp500", points, irx });
      } catch (error) {
        webview.postMessage({ type: "sp500", error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  webview.html = renderResultsHtml({
    csp: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`,
    nonce,
    data,
    css: String(asset(media, "results.css")),
    chartsJs: String(asset(charts, "lightweight-charts.standalone.production.js")),
    resultsJs: String(asset(media, "results.js")),
  });
}

/** The page itself, kept free of vscode calls so it can be previewed in a browser. */
export function renderResultsHtml(page: {
  csp: string;
  nonce: string;
  data: string;
  css: string;
  chartsJs: string;
  resultsJs: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${page.csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${page.css}">
</head>
<body>
  <header class="page-head">
    <h1 id="title"></h1>
    <p id="subtitle"></p>
  </header>

  <section id="stats" class="stats"></section>

  <div class="main">
    <aside class="card metrics">
      <h2 class="card-title">Strategy Metrics</h2>
      <dl id="metrics"></dl>
    </aside>

    <section class="card equity">
      <div class="card-head">
        <div class="group">
          <h2 class="card-title">Strategy Equity</h2>
          <div class="segmented" id="chart-type">
            <button data-type="candles" class="active">Candles</button>
            <button data-type="line">Line</button>
          </div>
          <label class="compare" title="Show what the starting equity would be worth in the S&amp;P 500 index over the same dates">
            <input type="checkbox" id="compare"><span class="stroke sp500"></span>Compare with S&amp;P 500
          </label>
          <span id="compare-note" class="compare-note" hidden></span>
        </div>
        <div class="group">
          <div class="segmented" id="zoom" title="You can also scroll to zoom and drag to pan">
            <button data-zoom="out" aria-label="Zoom out">−</button>
            <button data-zoom="in" aria-label="Zoom in">+</button>
            <button data-zoom="fit">Fit</button>
          </div>
          <div class="segmented" id="ranges">
            <button data-range="1M">1M</button>
            <button data-range="6M">6M</button>
            <button data-range="1Y">1Y</button>
            <button data-range="5Y">5Y</button>
            <button data-range="ALL" class="active">All</button>
          </div>
        </div>
        <button id="expand" class="expand" title="Expand the charts" aria-label="Expand the charts"></button>
      </div>
      <div class="chart-frame">
        <div id="price-grid" class="price-grid"></div>
        <div id="price-labels" class="price-labels"></div>
        <div id="chart"></div>
        <div id="hscroll" class="scrollbar horizontal" title="Scroll through time"><div class="thumb"></div></div>
        <div id="vscroll" class="scrollbar vertical" title="Scroll the price axis (double-click to fit prices again)"><div class="thumb"></div></div>
        <div id="tooltip" class="tooltip" hidden></div>
      </div>
      <div class="allocation">
        <div class="allocation-plot">
          <svg id="allocation" preserveAspectRatio="none"></svg>
          <div id="guide" class="guide" hidden></div>
          <div id="allocation-tooltip" class="tooltip above" hidden></div>
        </div>
        <div id="allocation-axis" class="allocation-axis"></div>
      </div>
      <div id="legend" class="legend"></div>
    </section>
  </div>

  <div id="backdrop" class="backdrop" hidden></div>

  <section class="card log">
    <div class="card-head">
      <div class="group">
        <h2 class="card-title">Execution Log</h2>
        <div class="segmented" id="log-tabs">
          <button data-tab="orders" class="active">Orders</button>
          <button data-tab="logs">Logs</button>
          <button data-tab="profile" hidden>Profile</button>
        </div>
        <span id="showing" class="badge"></span>
      </div>
      <div class="group" id="filters">
        <select id="filter-asset" aria-label="Asset"></select>
        <select id="filter-type" aria-label="Type">
          <option value="">All types</option>
          <option value="Buy">Buy</option>
          <option value="Sell">Sell</option>
        </select>
      </div>
    </div>

    <div id="tab-orders">
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Timestamp</th><th>Asset</th><th>Type</th><th class="num">Price</th><th class="num">Shares</th><th class="num">Value</th></tr>
          </thead>
          <tbody id="orders"></tbody>
        </table>
      </div>
      <div class="pager">
        <label>Show
          <select id="page-size">
            <option>10</option><option>25</option><option>50</option><option>100</option>
          </select>
          trades
        </label>
        <div class="group">
          <button id="prev" class="ghost">← Prev</button>
          <span>Page <input id="page" type="number" min="1" value="1"> of <span id="pages"></span></span>
          <button id="next" class="ghost">Next →</button>
        </div>
      </div>
    </div>
    <pre id="tab-logs" class="text-block" hidden></pre>
    <pre id="tab-profile" class="text-block" hidden></pre>
  </section>

  <script nonce="${page.nonce}" id="data" type="application/json">${page.data}</script>
  <script nonce="${page.nonce}" src="${page.chartsJs}"></script>
  <script nonce="${page.nonce}" src="${page.resultsJs}"></script>
</body>
</html>`;
}
