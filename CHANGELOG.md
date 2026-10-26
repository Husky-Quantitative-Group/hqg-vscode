# Changelog

## 0.2.2

- **Local backtests run in a sandbox.** The strategy runs in a Docker container with the
  server's limits (no network, read-only disk, 512 MB, 1 CPU), so local runs have the server's
  protection as well as its code checks. It adds about 0.3 seconds a run. Needs Docker Desktop,
  Colima, OrbStack or Rancher Desktop running.
- **No sandbox**, a second switch under Local backtest, runs the strategy without Docker, as
  before. Only for code you trust.
- After an hour without runs or strategy edits, the local engine and its waiting sandbox
  container stop to free memory; the next run starts them again.
- The local switches moved to just above **Run Backtest**.
- **Compare with S&P 500** is off on every new results tab; tick it when you want it. It was
  remembered from the last tab before.

## 0.2.1

- **Compare with S&P 500.** A box above the equity chart adds a white (or, in light themes,
  black) line for the starting equity invested in the S&P 500 index over the same dates, with
  its value in the hover, and an S&P 500 column in the metrics table, computed with the
  engine's formulas. It works for server and local runs and stays ticked for later runs.
- An expand button in the equity card's corner shows the equity and allocation charts large in
  the middle of the window; the same button or Esc puts them back.
- The allocation chart's colors are all different now. Before, strategies holding more than 16
  assets reused colors (BIL and VNQ were the same blue).

## 0.2.0

- **Local backtests.** A new **Local backtest** switch runs backtests on your own computer with the
  same engine as the HQG server: about a second for 18 years of daily data, against 4 to 6
  seconds on the server. The first time, the extension sets up a private Python environment by
  itself (Python 3.11 or newer needed).
- Local runs keep the engine loaded between runs, download a strategy's prices while you edit, and
  pass prices to the engine directly, so repeat runs are close to instant.

## 0.1.3

- Fixed the README's logo and tab icon showing as broken images on dark pages, including Open VSX
  and VS Code's extension page in a dark theme.
- The README has separate install steps for VS Code (the Marketplace) and for Cursor, Windsurf and
  VSCodium (Open VSX).

## 0.1.2

- Now installable from [Open VSX](https://open-vsx.org/extension/hqg/hqg-backtester) in Cursor,
  Windsurf and VSCodium, after Open VSX verified the `hqg` namespace.
- Releases are published by a GitHub Action: publishing a GitHub release puts it on Open VSX and
  attaches the `.vsix`.

## 0.1.1

- Also published on [Open VSX](https://open-vsx.org/extension/hqg/hqg-backtester), so Cursor,
  Windsurf and VSCodium users can install it from their editor's Extensions view.
- The README covers installing in those editors and publishing to both stores.

## 0.1.0

The first release on the VS Code Marketplace.

- Run a strategy on the HQG backtester from a side panel, with start and end dates, starting
  equity, run name, timeout and optional speed profiling.
- Sign in with your dashboard token, or reuse the token from `hqg login`.
- Mark strategy files with `# hqg-backtest: <strategy-name>` near the top.
- See the results beside your code: headline numbers, strategy metrics, the equity chart
  (candles or line, with zoom, ranges and scrollbars), the allocation over time, and the
  execution log with orders, logs and the profile.
- Errors that name a line show as red squiggles in your file.
