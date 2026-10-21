# Changelog

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
