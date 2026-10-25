<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/Husky-Quantitative-Group/hqg-vscode/raw/HEAD/media/logo-white.png">
    <img src="media/logo-black.png" alt="HQG" width="96">
  </picture>
</p>

<h1 align="center">HQG Backtester</h1>

<p align="center">
  Run a strategy on the HQG backtester without leaving your editor, and see the results in a tab beside your code.<br>
  For VS Code and VS Code-based editors: Cursor, Windsurf and VSCodium.
</p>

This extension does what the HQG command line tool (`hqg`, from [hqg-backtester](https://github.com/Husky-Quantitative-Group/hqg-backtester)) does: it sends your
strategy to the HQG backtester and waits for the result. You pick the dates and starting equity in
a side panel, press **Run Backtest**, and get the dashboard's results view inside your editor.

Install it in under a minute, without reading or building any code. If you want to work on the
extension itself, see [Develop the extension](#develop-the-extension).

- [Install](#install)
- [Sign in](#sign-in)
- [Mark your strategy file](#mark-your-strategy-file)
- [Run a backtest](#run-a-backtest)
- [Local backtests](#local-backtests)
- [Read the results](#read-the-results)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)
- [Develop the extension](#develop-the-extension)

## Install

### What you need

- **VS Code 1.90 or newer**, or a recent **Cursor**, **Windsurf** or **VSCodium**.
- **An HQG dashboard account** with backtester access. You can sign in at
  [dashboard.uconnquant.com](https://dashboard.uconnquant.com); if you can't, ask an HQG admin.

### Step 1: Install the extension

The extension is the same everywhere, but VS Code and the other editors get extensions from
different stores. Follow the steps for your editor.

#### VS Code, from the VS Code Marketplace

1. Open the Extensions view: `⇧⌘X` on Mac, `Ctrl+Shift+X` on Windows.
2. Search for **HQG Backtester**, and check that the publisher is **Husky Quantitative Group**.
3. Click **Install**.

Or click **Install** on its [Marketplace page](https://marketplace.visualstudio.com/items?itemName=hqg.hqg-backtester), or run this in a terminal:

```bash
code --install-extension hqg.hqg-backtester
```

#### Cursor, Windsurf or VSCodium, from Open VSX

These editors can't use the VS Code Marketplace. They install from [Open VSX](https://open-vsx.org/extension/hqg/hqg-backtester) instead.

1. Open the editor's Extensions view: `⇧⌘X` on Mac, `Ctrl+Shift+X` on Windows.
2. Search for **HQG Backtester**, and check that it's by **hqg**.
3. Click **Install**.

In VSCodium you can also run this in a terminal:

```bash
codium --install-extension hqg.hqg-backtester
```

The rest of this guide works the same in every editor. The screenshots show VS Code.

### Step 2: Find the extension's icons

Open any Python file that has the `# hqg-backtest` line (see
[Mark your strategy file](#mark-your-strategy-file)). The extension adds two chart icons:

![VS Code with a strategy file open. Circled: 1, the line-chart icon in the Activity Bar; 2, the chart icon above the file](docs/images/vscode-icons.png)

1. **The line-chart icon in the Activity Bar**, on the far left. It opens the **HQG Backtester**
   panel, and it's always there, even with no strategy open.
2. **The chart icon above the file**, at the top-right of the editor. It shows only while a
   strategy file is the current tab, and opens the same panel.

You run backtests from inside the panel, with its **Run Backtest** button.

The extension is installed. Next, sign in.

## Sign in

Click the line-chart icon in the Activity Bar. The first time, the panel asks for your dashboard token:

![VS Code with the HQG Backtester panel open on the left, showing the token box and the steps for finding the token, beside the strategy file](docs/images/vscode-sign-in.png)

1. Sign in at [dashboard.uconnquant.com](https://dashboard.uconnquant.com).
2. Open your browser's DevTools: `⌥⌘I` on Mac, `F12` on Windows.
3. Go to **Application** → **Cookies** → **https://dashboard.uconnquant.com**. In Firefox it's the
   **Storage** tab.
4. Copy the **Value** of `hqg_auth_token`, paste it into the panel, and press **Sign In**.

The extension checks the token with the backtester before saving it, and tells you if it's wrong
or expired.

- **Tokens last 24 hours.** The bottom of the panel shows how long you have left. When the token
  expires, the panel asks you to sign in again.
- **Already use the [HQG command line tool](https://github.com/Husky-Quantitative-Group/hqg-backtester#hqg-cli)?** If you've run `hqg login`, you're already signed in.
  The extension reads the same token from `~/.hqg/credentials`.
- **Sign Out** at the bottom of the panel signs you out of the extension only. Your
  `~/.hqg/credentials` file is left alone, so the HQG command line tool stays signed in.

## Mark your strategy file

Add this line near the top of your strategy file, with your strategy's name after the colon:

```python
# hqg-backtest: <strategy-name>
```

- **It's a comment, so Python ignores it.** It can go on line 1, even above the module docstring.
- **It has to be within the first 10 lines**, on a line of its own.
- **The name is used for the run.** It shows in the panel and at the top of the results. With a
  bare `# hqg-backtest`, the file name is used instead.
- **Spaces are optional:** `#hqg-backtest:<strategy-name>` works too.

Only files with this line can be backtested. That keeps the run buttons away from your other
Python files.

## Run a backtest

1. Open your strategy file, so it's the current tab.
2. Open the panel: click the line-chart icon in the Activity Bar, or the chart icon above the
   file (see [step 2](#step-2-find-the-extensions-icons)). The panel shows your strategy's name
   and the run settings:

   ![Ready to run: the panel shows the strategy name, dates, starting equity and an enabled Run Backtest button](docs/images/vscode-ready.png)

3. Fill in the run. The panel remembers your values for next time.

   | Field | What it does |
   | --- | --- |
   | **Start date / End date** | The period to backtest. |
   | **Local backtest** | Run on your own computer instead of the HQG server. Much faster; see [Local backtests](#local-backtests). |
   | **Starting equity ($)** | The cash the strategy starts with. |
   | **Run name** | Leave empty to use the name from `# hqg-backtest`. Anything you type here is used for every strategy until you clear it. |
   | **Timeout (seconds)** | How long to wait for the result before giving up. The run may still finish on the server. |
   | **Profile speed (slowest functions)** | Times every function while your strategy runs and lists the 40 slowest in the results' **Profile** tab. Use it to find out why a backtest is slow. The run takes a little longer, so leave it off normally. |

4. Press **▶ Run Backtest**. While it runs, the panel shows the job's progress and a **Cancel**
   button, and VS Code shows a progress notification at the bottom-right:

   ![Running: the panel shows "submitting" and a Cancel button, with a Backtesting main.py notification](docs/images/vscode-running.png)

5. When it finishes, the results open in a tab on the right, beside your code:

   ![The results tab open on the right of the strategy file, with final equity, net profit, return, the equity chart and the allocation chart](docs/images/vscode-results.png)

   See [Read the results](#read-the-results) for what everything in it means.

**The panel follows the current tab.** Switch to another strategy file and the panel switches with
it. Switch to a file without the `# hqg-backtest` line, or close your strategy, and the panel asks
you to open one, with **Run Backtest** greyed out. You can click into the results tab while your
strategy is still visible beside it, and the panel keeps the strategy, so you can run again straight
away.

**Want the panel on the right**, next to Claude Code or Copilot? Drag the line-chart icon from the
Activity Bar into the Secondary Side Bar. VS Code remembers where you put it.

## Local backtests

Turn on **Local backtest** under the dates to run backtests on your own computer instead of the
HQG server. It uses the same backtest engine and gives the same results, much faster: about a
second for 18 years of daily data, against 4 to 6 seconds on the server. You still need to be
signed in.

- **The first time** you turn it on, the extension sets up a private Python environment and
  installs pandas, yfinance and a few other libraries into it. That takes about a minute, and runs
  in the background while you keep working. Your own Python and packages aren't touched.
- **You need Python 3.11 or newer** installed. The extension finds it by itself; to choose a
  specific one, set **hqg.localPython** in Settings to its command or path.
- **Prices download once per ticker** from Yahoo Finance, the same source the server uses, and are
  kept on your computer. The first run with new tickers waits a second or two for that; after
  that, runs read them from disk. With local mode on, the extension also downloads them while you
  edit, as soon as you open a strategy or change its `universe`.
- **Strategies run as ordinary Python on your computer.** The server runs each one in a locked-down
  container; locally there's no such sandbox, so only run code you trust.
- **Alt data from FRED** needs a free [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html)
  in a `FRED_API_KEY` environment variable when you start VS Code. Price data needs nothing.

Everything is stored in VS Code's storage for the extension, so uninstalling the extension removes
it.

## Read the results

When the backtest finishes, the results open in a tab beside your code. The tab has the HQG
candlestick icon <picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/Husky-Quantitative-Group/hqg-vscode/raw/HEAD/docs/images/candles-dark.png"><img src="docs/images/candles-light.png" alt="" height="14"></picture>.
Each run opens its own tab, so you can compare runs side by side.

![The results tab: headline numbers, strategy metrics, the equity chart, the allocation chart and the execution log](docs/images/results.png)

- **Along the top:** final equity, net profit, return, fees and volume.
- **Strategy metrics**, on the left: Sharpe, Sortino, Calmar, alpha, beta, drawdown, VaR and more.
- **Strategy equity:** your portfolio's value over time.
  - Switch between **Candles** and **Line**.
  - Jump to the last **1M / 6M / 1Y / 5Y**, or show **All**.
  - Zoom with **− / +**, by scrolling over the chart, or by dragging the price axis. **Fit** shows
    the whole run again. Drag the chart to pan.
  - When zoomed in, thin scrollbars appear along the bottom (time) and right side (price) of the
    chart. Double-click the price scrollbar to fit prices again.
  - **Grey bars mean the portfolio was 100% cash.** You'll often see this at the start, while a
    strategy collects enough price history to make its first decision.
- **Allocation:** what share of the portfolio each asset held over time. Each step is a
  rebalance.
- **Execution log:** every order, with filters by asset and buy/sell, and 10–100 orders per page.
  The **Logs** tab has your strategy's `self.log()` output. The **Profile** tab appears when you
  ran with **Profile speed** on.

Hover over either chart to see that day's prices and holdings:

![Hovering the equity chart shows the day's open, high, low and close, and the largest holdings](docs/images/results-hover.png)

**If a run fails**, the error shows in a notification and in the panel. If the error names a line
in your file, that line gets a red squiggle, which goes away once you edit the file. Everything
from each run, including `self.log()` output, is also written to the **HQG Backtest** channel in
VS Code's Output panel (**View → Output**).

## Updates

VS Code updates the extension by itself when a new version comes out. To check which version you
have, open the Extensions view and click **HQG Backtester**. Its changes are listed in the
[changelog](CHANGELOG.md).

After an update, results tabs that were already open keep the old version until you run the
backtest again.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No line-chart icon in the Activity Bar | In the Extensions view, check that **HQG Backtester** is installed and enabled, then run **Developer: Reload Window** (`⇧⌘P`). |
| **Run Backtest** is greyed out | Make your strategy file the current tab, and check that `# hqg-backtest: <strategy-name>` is within its first 10 lines. |
| The chart icon above the file doesn't show | Same as above. The `# hqg-backtest` line must be on its own, not after code. |
| "The backtester turned down your sign-in" | Your token was rejected. Sign in to the dashboard again and paste the new token. |
| "Your sign-in expired" | Tokens last 24 hours. Copy a fresh one from the dashboard. |
| The equity line is flat and grey at the start | That's warm-up: your strategy was all cash while it gathered price history. The backtester sends no data from before your start date, so start the backtest earlier if you need results from a specific date. |
| Not sure the backtester is up | Press **Check Service** at the bottom of the panel. |
| "Local backtests need Python 3.11 or newer" | Install Python from [python.org](https://www.python.org/downloads/), then turn **Local backtest** off and on again. Or set **hqg.localPython** to a Python you already have. |
| The first local run is slow | It's downloading the strategy's prices once. Later runs with the same tickers read them from disk. |
| A local run fails on FRED alt data | Set a `FRED_API_KEY` environment variable and restart VS Code. See [Local backtests](#local-backtests). |

**Setting:** `hqg.apiUrl` points the extension at a different backtester, for example one you run
locally. The default is `https://platform.uconnquant.com/backtester`.

## Develop the extension

This section is for working on the extension itself. To just use it, install it from the
Marketplace as described in [Install](#install).

### What you need

| | How to check | Where to get it |
| --- | --- | --- |
| **VS Code 1.90 or newer** | **Code → About Visual Studio Code** | [code.visualstudio.com](https://code.visualstudio.com) |
| **Git** | `git --version` in a terminal | [git-scm.com](https://git-scm.com/downloads) |
| **Node.js 18 or newer**, which includes `npm` | `node --version` | [nodejs.org](https://nodejs.org), the LTS version |

### Step 1: Get the code

```bash
git clone https://github.com/Husky-Quantitative-Group/hqg-vscode.git
cd hqg-vscode
```

### Step 2: Install the build tools

```bash
npm install
```

This downloads what the extension needs into a `node_modules` folder. It only has to be done once,
and again after `package.json` changes.

### Step 3: Run your copy

Open the `hqg-vscode` folder in VS Code and press **F5**. A second VS Code window opens with your
development copy of the extension loaded. After changing code, run **Developer: Reload Window** in
that second window to see the change.

If you also have the Marketplace version installed, disable it in the Extensions view while you
work, so the two copies don't both show up.

### Step 4: Build and install your own copy

To try your build in your normal editor before it's published:

```bash
npm run package                                  # builds hqg-backtester-0.1.0.vsix
code --install-extension hqg-backtester-0.1.0.vsix
```

Then run **Developer: Reload Window**.

<details>
<summary><b>If it says <code>code: command not found</code></b></summary>

1. Open VS Code.
2. Press `⇧⌘P` (`Ctrl+Shift+P` on Windows) to open the Command Palette.
3. Type **Shell Command: Install 'code' command in PATH** and press Enter.
4. Open a new terminal, `cd` back into `hqg-vscode`, and run the command again.

On Mac, VS Code must be in your **Applications** folder for this to work. If you'd rather not use
the terminal: open the Extensions view, click the **⋯** menu at the top, choose
**Install from VSIX…**, and pick the `.vsix` file.
</details>

To pick up other people's changes later: `git pull`, `npm install`, then run step 4 again with
`--force` added to the install command.

### Publish a new version

For HQG maintainers. Each release goes to both stores: the VS Code Marketplace, and Open VSX for
Cursor, Windsurf and VSCodium. Publishing a GitHub release does the Open VSX part for you. The
Marketplace takes one command.

You need membership in the **hqg** publisher on the
[Marketplace management page](https://marketplace.visualstudio.com/manage), and the
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`brew install azure-cli`).

1. Raise `version` in `package.json`, for example `0.1.1` → `0.1.2`, describe the change at the top
   of [CHANGELOG.md](CHANGELOG.md), then commit and push.
2. Create a GitHub release tagged with that version, for example `v0.1.2`, on
   [Releases](https://github.com/Husky-Quantitative-Group/hqg-vscode/releases) → **Draft a new
   release**, or with `gh release create v0.1.2 --generate-notes`. The **Publish release** GitHub
   Action then builds the extension, publishes it to Open VSX, and attaches the `.vsix` to the
   release. It stops with an error if the tag doesn't match `package.json`.
3. Publish the same version to the VS Code Marketplace, from the `hqg-vscode` folder:
   ```bash
   az login --allow-no-subscriptions --scope "499b84ac-1321-427f-aa17-267ca6975798/.default"
   npm run publish
   ```
   With a work or school account, add `--tenant <your-organization's-tenant-id>` to `az login`.
   For UConn that's `17f1a87e-2a25-4eaa-b9df-9d439034b080`.

The Marketplace step signs in through the Azure CLI, because Microsoft retires token-based
Marketplace publishing on December 1, 2026. It isn't automated because UConn accounts can't create
the Azure identity a GitHub Action would need. The Action's Open VSX token is the `OVSX_PAT`
repository secret; to replace it, run `gh secret set OVSX_PAT` and paste a new token from your
[Open VSX settings](https://open-vsx.org/user-settings/tokens).

### Update the local engine

Local backtests run a copy of the HQG backtest engine bundled in `python/vendor/`, so their results
match the server. When `hqg-backtester`, `hqg-datafeed` or `hqg-algorithms` change, refresh the copy
before releasing:

```bash
./scripts/sync-engine.sh
```

It copies the current `main` branch of each repo from GitHub, without touching your own clones,
and records the commits in `python/vendor/VERSIONS.txt`. It expects the three repos cloned next to
`hqg-vscode`; set `HQG_REPOS` to their folder otherwise. Commit the result. If you change
`python/requirements.txt`, members' private environments update themselves on their next local run.

### Where things are

| Path | What's there |
| --- | --- |
| `src/extension.ts` | Commands, the run flow, sign-in, and which file counts as the strategy |
| `src/panel.ts`, `media/panel.*` | The side panel |
| `src/results.ts`, `media/results.*` | The results tab |
| `src/api.ts` | The backtester API client, the same calls as [`cli/api.py`](https://github.com/Husky-Quantitative-Group/hqg-backtester/blob/main/cli/api.py) in hqg-backtester |
| `src/auth.ts` | Token storage, and reading `~/.hqg/credentials` |
| `src/local.ts` | Local backtests: the private Python environment and the background worker |
| `python/hqg_local/worker.py` | The worker that runs local backtests with the bundled engine |
| `python/vendor/` | The bundled engine, from hqg-backtester, hqg-datafeed and hqg-algorithms |
| `scripts/sync-engine.sh` | Refreshes `python/vendor/` from GitHub |
| `media/icon.png` | The extension's icon on the Marketplace |
| `docs/images/` | The screenshots in this README |
