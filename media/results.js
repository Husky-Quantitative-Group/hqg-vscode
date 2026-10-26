// Renders a backtest result inside the webview, laid out like the dashboard's backtest page.
(function () {
  const { result, logs, fileName, elapsedSeconds, compare } = JSON.parse(document.getElementById("data").textContent);
  const vscode = acquireVsCodeApi();
  const metrics = result.metrics || {};
  const params = result.parameters || {};
  const orders = result.orders || [];

  // ── formatting ──────────────────────────────────────────────
  const missing = (v) => v === null || v === undefined || !Number.isFinite(v);
  const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  // Bar times are UTC midnights; formatting them in local time would show the previous day.
  const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const stampFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
  const money = (v) => (missing(v) ? "—" : moneyFormat.format(v));
  const number = (v, places = 2) => (missing(v) ? "—" : v.toFixed(places));
  const count = (v) => (missing(v) ? "—" : numberFormat.format(v));
  const pct = (v) => (missing(v) ? "—" : `${(v * 100).toFixed(2)}%`);
  const tone = (v) => (missing(v) ? "" : v >= 0 ? "pos" : "neg");
  const date = (v) => String(v ?? "").split("T")[0];

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ── header, stat cards, metrics list ────────────────────────
  document.getElementById("title").textContent = params.name || fileName;
  document.getElementById("subtitle").textContent = [
    fileName,
    `${date(params.start_date)} → ${date(params.end_date)}`,
    `starting equity ${money(params.starting_equity)}`,
    `${elapsedSeconds.toFixed(1)}s`,
  ].join(" · ");

  const stats = [
    ["Final Equity", money(metrics.final_portfolio_value), ""],
    ["Net Profit", money(metrics.net_profit), tone(metrics.net_profit)],
    ["Return", pct(metrics.total_pct_return), tone(metrics.total_pct_return)],
    ["Fees", money(metrics.fees), ""],
    ["Volume", count(metrics.volume), ""],
  ];
  const statsRoot = document.getElementById("stats");
  for (const [label, value, cls] of stats) {
    const card = el("div", "card stat");
    card.append(el("div", "stat-label", label), el("div", `stat-value ${cls}`, value));
    statsRoot.append(card);
  }

  const metricRows = (m) => [
    ["Sharpe", number(m.sharpe)],
    ["Sortino", number(m.sortino)],
    ["Calmar", number(m.calmar)],
    ["Alpha", number(m.alpha)],
    ["Beta", number(m.beta)],
    ["PSR", number(m.psr)],
    ["Total Orders", count(m.total_orders)],
    ["Total Return", pct(m.total_pct_return)],
    ["CAGR", pct(m.annualized_return)],
    ["Ann. Volatility", pct(m.ann_vol)],
    ["Max Drawdown", pct(m.max_drawdown)],
    ["Max DD Duration", missing(m.max_drawdown_duration) ? "—" : `${count(m.max_drawdown_duration)} bars`],
    ["VaR (95%)", pct(m.var_95)],
    ["CVaR (95%)", pct(m.cvar_95)],
  ];
  const metricsRoot = document.getElementById("metrics");
  // The strategy's metrics, with the S&P 500's beside them while the comparison is on.
  function renderMetrics(benchmark) {
    metricsRoot.replaceChildren();
    document.querySelector(".main").classList.toggle("comparing", Boolean(benchmark));
    if (benchmark) {
      const head = el("div", "metric head");
      head.append(el("dt", ""), el("dd", "", "Strategy"), el("dd", "sp500", "S&P 500"));
      metricsRoot.append(head);
    }
    const others = benchmark && metricRows(benchmark);
    metricRows(metrics).forEach(([label, value], i) => {
      const row = el("div", "metric");
      row.append(el("dt", "", label), el("dd", "", value));
      if (others) row.append(el("dd", "", others[i][1]));
      metricsRoot.append(row);
    });
  }
  renderMetrics(null);

  // ── allocation over time (same method as the dashboard) ─────
  const candles = [...(result.candles || [])]
    .sort((a, b) => a.time - b.time)
    .map((c) => ({ time: Math.floor(c.time), open: c.open, high: c.high, low: c.low, close: c.close }));

  // One allocation point per candle, as percentages keyed by ticker (plus Cash).
  function buildAllocation() {
    const start = params.starting_equity;
    if (!candles.length || !(start > 0)) return { points: [], keys: [] };
    if (!orders.length) return { points: candles.map(() => ({ Cash: 100 })), keys: ["Cash"] };

    const sorted = [...orders].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const holdings = new Map();
    const prices = new Map();
    let cash = start;
    const snapshots = [{ time: candles[0].time, values: { Cash: 100 } }];

    for (let i = 0; i < sorted.length; ) {
      const stamp = sorted[i].timestamp;
      while (i < sorted.length && sorted[i].timestamp === stamp) {
        const o = sorted[i];
        const shares = (String(o.type).toLowerCase() === "buy" ? 1 : -1) * o.shares;
        const next = (holdings.get(o.ticker) || 0) + shares;
        if (Math.abs(next) < 1e-9) holdings.delete(o.ticker);
        else holdings.set(o.ticker, next);
        prices.set(o.ticker, o.price);
        cash -= shares * o.price;
        i++;
      }
      const values = {};
      let total = Math.max(cash, 0);
      for (const [ticker, quantity] of holdings) {
        const value = Math.max(quantity * (prices.get(ticker) || 0), 0);
        if (value > 0) {
          values[ticker] = value;
          total += value;
        }
      }
      if (total <= 0) continue;
      for (const ticker of Object.keys(values)) values[ticker] = (values[ticker] / total) * 100;
      values.Cash = (Math.max(cash, 0) / total) * 100;
      snapshots.push({ time: Math.floor(new Date(stamp).getTime() / 1000), values });
    }
    snapshots.sort((a, b) => a.time - b.time);

    const keySet = new Set();
    for (const s of snapshots) Object.keys(s.values).forEach((k) => keySet.add(k));
    const keys = [...keySet].sort((a, b) => (a === "Cash" ? 1 : b === "Cash" ? -1 : a.localeCompare(b)));

    const points = [];
    let active = 0;
    for (const candle of candles) {
      while (active + 1 < snapshots.length && snapshots[active + 1].time <= candle.time) active++;
      const point = {};
      for (const key of keys) point[key] = snapshots[active].values[key] || 0;
      points.push(point);
    }
    return { points, keys };
  }

  const allocation = buildAllocation();
  // 18 clearly different colors (after Sasha Trubetskoy's "20 distinct colors", with the ones
  // too dark for dark themes or too pale for light themes swapped for mid tones); grey is Cash.
  const PALETTE = [
    "#4363d8", "#3cb44b", "#ffe119", "#e6194b", "#f58231", "#911eb4", "#42d4f4", "#f032e6",
    "#bfef45", "#fabed4", "#469990", "#dcbeff", "#9a6324", "#d2b48c", "#a83232", "#7b68ee",
    "#26358c", "#fa8072",
  ];
  // Past the palette, step around the color wheel by the golden angle so no two assets match.
  const colorAt = (i) =>
    i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)}, 70%, ${i % 2 ? 45 : 65}%)`;
  let nextColor = 0;
  const colorOf = new Map(allocation.keys.map((key) => [key, key === "Cash" ? "#8b929e" : colorAt(nextColor++)]));

  const legend = document.getElementById("legend");
  if (allocation.keys.length) legend.append(el("span", "legend-title", "Legend"));
  for (const key of allocation.keys) {
    const item = el("span", "legend-item");
    const dot = el("span", "dot");
    dot.style.background = colorOf.get(key);
    item.append(dot, document.createTextNode(key));
    legend.append(item);
  }

  // ── equity chart ────────────────────────────────────────────
  const themeColor = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  const colors = () => ({
    text: themeColor("--vscode-descriptionForeground", "#9aa0a6"),
    up: themeColor("--vscode-charts-green", "#34d399"),
    down: themeColor("--vscode-charts-red", "#fb7185"),
    line: themeColor("--vscode-charts-blue", "#4e8ef7"),
    cash: themeColor("--vscode-descriptionForeground", "#8b929e"),
    // The theme's text color (white or black): no asset or candle uses it.
    sp500: themeColor("--vscode-foreground", "#cccccc"),
  });

  const LC = window.LightweightCharts;
  const chartRoot = document.getElementById("chart");
  const chart = LC.createChart(chartRoot, {
    autoSize: true,
    layout: { background: { type: LC.ColorType.Solid, color: "transparent" }, attributionLogo: false },
    // Price labels and their grid lines are drawn by drawPriceAxis below, so the library's own
    // are hidden; its last-price and crosshair tags still show on the axis.
    grid: {
      vertLines: { color: "rgba(128,128,128,0.10)" },
      horzLines: { visible: false },
    },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderVisible: false, textColor: "transparent" },
    // A small minimum bar spacing lets "All" fit decades of daily bars on screen, locking the
    // range keeps the same dates in view when the tab is resized, and the fixed edges stop
    // scrolling at the padding days below.
    timeScale: {
      borderVisible: false,
      minBarSpacing: 0.01,
      lockVisibleTimeRangeOnResize: true,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    localization: { priceFormatter: (v) => `$${numberFormat.format(Math.round(v))}` },
  });

  // Blank days before the first bar and after the last give the chart a margin, so the first
  // and last dates aren't clipped. The library's own edge locks stop scrolling there smoothly;
  // snapping the view back by hand made the chart shake at the edges.
  const PAD = candles.length ? Math.max(Math.round(candles.length * 0.02), 2) : 0;
  const blankDays = (time, direction) =>
    Array.from({ length: PAD }, (_, k) => ({ time: time + direction * 86400 * (k + 1) }));
  const lead = candles.length ? blankDays(candles[0].time, -1).reverse() : [];
  const trail = candles.length ? blankDays(candles[candles.length - 1].time, 1) : [];
  // Chart positions count the lead padding; candle and allocation arrays don't.
  const toLogical = (index) => index + PAD;
  const toIndex = (logical) => Math.round(logical) - PAD;
  // Prices follow the visible bars again unless the user has scrolled the price axis.
  const fitPrices = () => chart.priceScale("right").setAutoScale(true);
  const fitAll = () => {
    fitPrices();
    chart.timeScale().fitContent();
  };

  let chartType = "candles";
  let series;
  // The S&P 500 comparison line: its points once loaded, and its series while it's shown.
  let sp500Data = null;
  let sp500Series = null;
  const sp500Options = () => ({ color: colors().sp500, lineWidth: 2, priceLineVisible: false });
  const seriesOptions = () => {
    const c = colors();
    return chartType === "candles"
      ? { upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false }
      : { color: c.line, lineWidth: 2 };
  };
  // Bars where the portfolio holds nothing but cash (e.g. while a strategy warms up) are drawn
  // grey, so the flat stretch reads as "not invested" rather than as the strategy's result.
  const cashOnly = candles.map((_, i) => {
    const point = allocation.points[i];
    return Boolean(point) && allocation.keys.every((key) => key === "Cash" || point[key] < 0.01);
  });
  const seriesData = () => {
    const cash = colors().cash;
    const bars = candles.map((c, i) => {
      if (chartType === "candles") {
        return cashOnly[i] ? { ...c, color: cash, wickColor: cash, borderColor: cash } : c;
      }
      const point = { time: c.time, value: c.close };
      return cashOnly[i] ? { ...point, color: cash } : point;
    });
    return [...lead, ...bars, ...trail];
  };

  const drawSeries = () => {
    const visible = chart.timeScale().getVisibleLogicalRange();
    if (series) chart.removeSeries(series);
    series = chart.addSeries(chartType === "candles" ? LC.CandlestickSeries : LC.LineSeries, seriesOptions());
    series.setData(seriesData());
    // Keep the zoom when switching between candles and line.
    if (visible) chart.timeScale().setVisibleLogicalRange(visible);
    else fitAll();
  };
  const applyTheme = () => {
    chart.applyOptions({ layout: { textColor: colors().text } });
    series.applyOptions(seriesOptions());
    if (sp500Series) sp500Series.applyOptions(sp500Options());
    scheduleAllocation();
  };
  // The cash-only grey is baked into each bar, so a theme change re-sends the bars too.
  const recolorBars = () => {
    const visible = chart.timeScale().getVisibleLogicalRange();
    series.setData(seriesData());
    if (visible) chart.timeScale().setVisibleLogicalRange(visible);
  };

  const setActive = (group, button) =>
    group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === button));

  const chartTypes = document.getElementById("chart-type");
  chartTypes.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    chartType = button.dataset.type;
    setActive(chartTypes, button);
    drawSeries();
    applyTheme();
  });

  const RANGE_SECONDS = { "1M": 30, "6M": 182, "1Y": 365, "5Y": 365 * 5 };
  const ranges = document.getElementById("ranges");
  ranges.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !candles.length) return;
    setActive(ranges, button);
    const days = RANGE_SECONDS[button.dataset.range];
    if (!days) {
      fitAll();
      return;
    }
    const last = candles[candles.length - 1].time;
    fitPrices();
    chart.timeScale().setVisibleRange({ from: Math.max(candles[0].time, last - days * 86400), to: last });
  });

  document.getElementById("zoom").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setActive(ranges, null);
    if (button.dataset.zoom === "fit") {
      setActive(ranges, ranges.querySelector('[data-range="ALL"]'));
      fitAll();
      return;
    }
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const factor = button.dataset.zoom === "in" ? 0.6 : 1 / 0.6;
    const center = (range.from + range.to) / 2;
    const half = Math.max(((range.to - range.from) / 2) * factor, 5);
    chart.timeScale().setVisibleLogicalRange({ from: center - half, to: center + half });
  });

  // ── hover tooltip ───────────────────────────────────────────
  const frame = document.querySelector(".chart-frame");
  const tooltip = document.getElementById("tooltip");
  const guide = document.getElementById("guide");
  let hoveringAllocation = false;
  chart.subscribeCrosshairMove((param) => {
    // The allocation hover moves the crosshair itself and shows its own tooltip.
    if (hoveringAllocation) return;
    const bar = param.point && param.seriesData.get(series);
    if (!bar || param.point.x < 0 || param.point.y < 0) {
      tooltip.hidden = true;
      guide.hidden = true;
      return;
    }
    guide.hidden = false;
    guide.style.transform = `translateX(${param.point.x}px)`;
    tooltip.replaceChildren(el("div", "tooltip-date", dayFormat.format(new Date(bar.time * 1000))));
    const rows =
      chartType === "candles"
        ? [["Open", bar.open], ["High", bar.high], ["Low", bar.low], ["Close", bar.close]]
        : [["Equity", bar.value]];
    const sp500 = sp500Series && param.seriesData.get(sp500Series);
    if (sp500 && sp500.value !== undefined) rows.push(["S&P 500", sp500.value]);
    for (const [label, value] of rows) {
      const row = el("div", "tooltip-row");
      row.append(el("span", "", label), el("span", "", money(value)));
      tooltip.append(row);
    }

    const point = allocation.points[toIndex(param.logical)];
    if (point) {
      const top = allocation.keys
        .filter((k) => point[k] >= 0.5)
        .sort((a, b) => point[b] - point[a])
        .slice(0, 5);
      if (top.length) tooltip.append(el("div", "tooltip-split"));
      for (const key of top) {
        const row = el("div", "tooltip-row");
        const name = el("span", "tooltip-key");
        const dot = el("span", "dot");
        dot.style.background = colorOf.get(key);
        name.append(dot, document.createTextNode(key));
        row.append(name, el("span", "", `${point[key].toFixed(1)}%`));
        tooltip.append(row);
      }
    }

    tooltip.hidden = false;
    const gap = 16;
    const width = tooltip.offsetWidth;
    const x = param.point.x + gap + width > frame.clientWidth ? param.point.x - gap - width : param.point.x + gap;
    tooltip.style.transform = `translate(${Math.max(x, 0)}px, 12px)`;
  });

  // ── allocation chart, lined up with the equity chart's bars ─
  const svg = document.getElementById("allocation");
  const axis = document.getElementById("allocation-axis");
  const SVG_NS = "http://www.w3.org/2000/svg";
  let pending = false;

  function scheduleAllocation() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      drawAllocation();
    });
  }

  // The bars where the allocation differs from the bar before: the rebalance days.
  const allocationChanges = allocation.points.reduce((list, point, i, all) => {
    if (i === 0 || allocation.keys.some((key) => Math.abs(point[key] - all[i - 1][key]) > 1e-9)) list.push(i);
    return list;
  }, []);

  function drawAllocation() {
    const points = allocation.points;
    const range = chart.timeScale().getVisibleLogicalRange();
    const scaleWidth = chart.priceScale("right").width();
    const width = chartRoot.clientWidth - scaleWidth;
    const height = svg.clientHeight;
    svg.replaceChildren();
    axis.style.width = `${scaleWidth}px`;
    if (!points.length || !range || width <= 0 || height <= 0) return;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.width = `${width}px`;

    // One flat step per stretch between rebalances, edges halfway between bars like the candles.
    const first = Math.max(0, toIndex(Math.floor(range.from)) - 1);
    const last = Math.min(points.length - 1, toIndex(Math.ceil(range.to)) + 1);
    if (first > last) return;
    // The library only places whole bars (half positions come back as 0), so put each edge
    // midway between bar i - 1 and bar i.
    const at = (i) => chart.timeScale().logicalToCoordinate(toLogical(i));
    const edge = (i) => (at(i - 1) + at(i)) / 2;
    const starts = [first, ...allocationChanges.filter((i) => i > first && i <= last)];
    const steps = starts.map((start, n) => ({
      x0: edge(start),
      x1: edge(n + 1 < starts.length ? starts[n + 1] : last + 1),
      point: points[start],
    }));

    const y = (v) => (height - (Math.min(v, 100) / 100) * height).toFixed(1);
    const lower = steps.map(() => 0);
    for (const key of allocation.keys) {
      const upper = steps.map((s, n) => lower[n] + s.point[key]);
      if (upper.some((v, n) => v - lower[n] > 0.01)) {
        // Along the top edge left to right, then back along the bottom edge.
        let d = `M${steps[0].x0},${y(upper[0])}`;
        steps.forEach((s, n) => {
          d += `H${s.x1}`;
          if (n + 1 < steps.length) d += `V${y(upper[n + 1])}`;
        });
        d += `V${y(lower[steps.length - 1])}`;
        for (let n = steps.length - 1; n >= 0; n--) {
          d += `H${steps[n].x0}`;
          if (n > 0) d += `V${y(lower[n - 1])}`;
        }
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", `${d}Z`);
        path.setAttribute("fill", colorOf.get(key));
        svg.append(path);
      }
      upper.forEach((v, n) => (lower[n] = v));
    }
  }

  for (const label of ["100%", "75%", "50%", "25%"]) axis.append(el("span", "", label));

  // Hovering the allocation lists that day's holdings and moves the equity crosshair to match.
  const allocationTooltip = document.getElementById("allocation-tooltip");
  svg.addEventListener("mousemove", (event) => {
    const x = event.clientX - svg.getBoundingClientRect().left;
    const logical = chart.timeScale().coordinateToLogical(x);
    const index = logical === null ? -1 : toIndex(logical);
    const point = allocation.points[index];
    if (!point) {
      hideAllocationHover();
      return;
    }
    hoveringAllocation = true;
    tooltip.hidden = true;
    const barX = chart.timeScale().logicalToCoordinate(toLogical(index));
    guide.hidden = false;
    guide.style.transform = `translateX(${barX}px)`;
    chart.setCrosshairPosition(candles[index].close, candles[index].time, series);

    allocationTooltip.replaceChildren(el("div", "tooltip-date", dayFormat.format(new Date(candles[index].time * 1000))));
    const held = allocation.keys.filter((k) => point[k] >= 0.05).sort((a, b) => point[b] - point[a]);
    for (const key of held) {
      const row = el("div", "tooltip-row");
      const name = el("span", "tooltip-key");
      const dot = el("span", "dot");
      dot.style.background = colorOf.get(key);
      name.append(dot, document.createTextNode(key));
      row.append(name, el("span", "", `${point[key].toFixed(1)}%`));
      allocationTooltip.append(row);
    }
    allocationTooltip.hidden = false;
    const gap = 12;
    const width = allocationTooltip.offsetWidth;
    const left = barX + gap + width > svg.clientWidth ? barX - gap - width : barX + gap;
    allocationTooltip.style.transform = `translateX(${Math.max(left, 0)}px)`;
  });
  svg.addEventListener("mouseleave", hideAllocationHover);

  function hideAllocationHover() {
    if (!hoveringAllocation) return;
    hoveringAllocation = false;
    allocationTooltip.hidden = true;
    guide.hidden = true;
    chart.clearCrosshairPosition();
  }

  // ── inner scrollbars ────────────────────────────────────────
  // Overlay bars inside the plot: the horizontal one shows which part of the run is on screen,
  // the vertical one which part of the price range. Drag a thumb, or click the track to page.
  function scrollbar(track, vertical, onScroll) {
    const thumb = track.firstElementChild;
    let start = 0;
    let size = 1;
    const length = () => (vertical ? track.clientHeight : track.clientWidth);

    thumb.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      track.classList.add("dragging");
      const origin = vertical ? event.clientY : event.clientX;
      const from = start;
      const move = (e) => onScroll(from + ((vertical ? e.clientY : e.clientX) - origin) / length());
      const up = () => {
        track.classList.remove("dragging");
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", up);
      };
      thumb.addEventListener("pointermove", move);
      thumb.addEventListener("pointerup", up);
    });
    track.addEventListener("pointerdown", (event) => {
      if (event.target !== track) return;
      const rect = track.getBoundingClientRect();
      const at = vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
      onScroll(at < start ? start - size : start + size);
    });

    return (nextStart, nextSize) => {
      size = Math.min(Math.max(nextSize, 0), 1);
      start = Math.min(Math.max(nextStart, 0), 1 - size);
      track.classList.toggle("full", size >= 0.999);
      const minThumb = 24 / Math.max(length(), 1);
      const shown = Math.max(size, minThumb);
      const offset = start * (1 - shown) / Math.max(1 - size, 1e-9);
      thumb.style[vertical ? "top" : "left"] = `${(size >= 0.999 ? 0 : offset) * 100}%`;
      thumb.style[vertical ? "height" : "width"] = `${shown * 100}%`;
    };
  }

  const priceScale = chart.priceScale("right");
  const totalBars = candles.length + 2 * PAD;
  // The vertical bar spans the run's lowest low to highest high (and the S&P 500 line's, when
  // shown). The price scale reports its range without its own margins, so with every bar in
  // view the two match and the bar hides.
  let fullLow = 0;
  let fullHigh = 1;
  function setPriceBounds() {
    let low = candles.length ? candles.reduce((m, c) => Math.min(m, c.low), Infinity) : 0;
    let high = candles.length ? candles.reduce((m, c) => Math.max(m, c.high), -Infinity) : 1;
    if (sp500Series) {
      for (const p of sp500Data) {
        if (p.value === undefined) continue;
        low = Math.min(low, p.value);
        high = Math.max(high, p.value);
      }
    }
    fullLow = low;
    // A run that never moved still needs a non-zero span.
    fullHigh = high > low ? high : low + 1;
  }
  setPriceBounds();

  const hscroll = document.getElementById("hscroll");
  const vscroll = document.getElementById("vscroll");
  const setHorizontal = scrollbar(hscroll, false, (fraction) => {
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const width = range.to - range.from;
    const from = fraction * totalBars;
    setActive(ranges, null);
    chart.timeScale().setVisibleLogicalRange({ from, to: from + width });
  });
  const setVertical = scrollbar(vscroll, true, (fraction) => {
    const range = priceScale.getVisibleRange();
    if (!range) return;
    const span = range.to - range.from;
    const to = Math.min(fullHigh, Math.max(fullLow + span, fullHigh - fraction * (fullHigh - fullLow)));
    priceScale.setAutoScale(false);
    priceScale.setVisibleRange({ from: to - span, to });
  });
  vscroll.addEventListener("dblclick", fitPrices);

  // ── price axis ──────────────────────────────────────────────
  // The library spaces price labels by 1, 2, 2.5, 4 or 5 × 10ⁿ; a 4 × 10ⁿ step (e.g. $40k)
  // skips round numbers like $100,000. Leaving out 4 makes every power of 10 at least as
  // big as the step a multiple of it, so those always get a label when they're in view.
  const STEP_MULTIPLES = [1, 2, 2.5, 5];
  const MIN_LABEL_GAP = 30; // px, about what the library keeps between its own labels
  const priceGrid = document.getElementById("price-grid");
  const priceLabels = document.getElementById("price-labels");

  function priceStep(span, plotHeight) {
    const smallest = (span * MIN_LABEL_GAP) / Math.max(plotHeight, 1);
    let power = Math.pow(10, Math.floor(Math.log10(smallest)));
    for (;;) {
      for (const m of STEP_MULTIPLES) if (m * power >= smallest) return m * power;
      power *= 10;
    }
  }

  function drawPriceAxis(prices, plotWidth, plotHeight) {
    priceGrid.replaceChildren();
    priceLabels.replaceChildren();
    if (!prices || !series || plotHeight <= 0 || prices.to <= prices.from) return;
    priceGrid.style.width = `${plotWidth}px`;
    priceGrid.style.height = `${plotHeight}px`;
    priceLabels.style.left = `${plotWidth}px`;
    priceLabels.style.height = `${plotHeight}px`;

    const step = priceStep(prices.to - prices.from, plotHeight);
    const places = step >= 1 ? 0 : Math.min(Math.ceil(-Math.log10(step)), 4);
    const format = new Intl.NumberFormat("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
    for (let k = Math.ceil(prices.from / step); k * step <= prices.to; k++) {
      const value = k * step;
      const y = series.priceToCoordinate(value);
      if (y === null || y < 8 || y > plotHeight - 8) continue;
      const line = el("div", "grid-line");
      line.style.top = `${Math.round(y)}px`;
      priceGrid.append(line);
      const label = el("div", "price-label", `$${format.format(value)}`);
      label.style.top = `${y}px`;
      priceLabels.append(label);
    }
  }

  // Keep the bars over the plot area (not the axes) and in step with the chart each frame;
  // the price axis has no change event, and this only touches the DOM when something moved.
  let lastSync = "";
  // Whether the whole run is on screen; a resize then fits it again (see the ResizeObserver).
  let showingWholeRun = true;
  function syncScrollbars() {
    const plotWidth = chartRoot.clientWidth - priceScale.width();
    const plotHeight = chartRoot.clientHeight - chart.timeScale().height();
    const logical = chart.timeScale().getVisibleLogicalRange();
    const prices = priceScale.getVisibleRange();
    const key = [plotWidth, plotHeight, logical?.from, logical?.to, prices?.from, prices?.to, fullLow, fullHigh].join();
    if (key !== lastSync) {
      lastSync = key;
      hscroll.style.width = `${plotWidth}px`;
      hscroll.style.top = `${plotHeight - 10}px`;
      vscroll.style.left = `${plotWidth - 10}px`;
      vscroll.style.height = `${plotHeight}px`;
      // Count bars inclusively: from 0 to totalBars - 1 is every bar, a size of exactly 1.
      if (logical) {
        const size = (logical.to - logical.from + 1) / totalBars;
        showingWholeRun = size >= 0.99;
        setHorizontal(logical.from / totalBars, size);
      }
      if (prices) {
        const span = fullHigh - fullLow;
        setVertical((fullHigh - prices.to) / span, (prices.to - prices.from) / span);
      }
      drawPriceAxis(prices, plotWidth, plotHeight);
    }
    requestAnimationFrame(syncScrollbars);
  }

  // ── S&P 500 comparison ──────────────────────────────────────
  // The extension fetches the index (the webview can't reach the network) and the line shows the
  // starting equity invested in it on the first day, one point per candle so the chart's bars
  // and the allocation stay lined up.
  const compareBox = document.getElementById("compare");
  const compareNote = document.getElementById("compare-note");
  let loadingSp500 = false;

  function sp500Line(points) {
    const closes = [];
    let close;
    for (let i = 0, j = 0; i < candles.length; i++) {
      // The last close on or before each candle's day; a market holiday repeats the day before.
      while (j < points.length && points[j].time <= candles[i].time) close = points[j++].close;
      closes.push(close);
    }
    const base = closes.find((c) => c !== undefined);
    return candles.map((c, i) =>
      closes[i] === undefined ? { time: c.time } : { time: c.time, value: (params.starting_equity * closes[i]) / base }
    );
  }

  // ── engine metrics for the S&P 500 (same formulas as src/utils/metrics.py) ──
  const BARS_PER_YEAR = 252;
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const sampleStd = (xs) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  };
  // pandas' bias-corrected skew and excess kurtosis.
  function skewKurt(xs) {
    const n = xs.length;
    const m = mean(xs);
    let s2 = 0, s3 = 0, s4 = 0;
    for (const x of xs) {
      const d = x - m;
      s2 += d * d;
      s3 += d * d * d;
      s4 += d * d * d * d;
    }
    const skew = ((n * Math.sqrt(n - 1)) / (n - 2)) * (s3 / s2 ** 1.5);
    const kurt = (n * (n + 1) * (n - 1) * s4) / ((n - 2) * (n - 3) * s2 * s2) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
    return { skew, kurt };
  }
  // Abramowitz and Stegun 7.1.26, accurate to about 1e-7.
  function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }
  // numpy's default percentile: linear between the two nearest ranks.
  function percentile(xs, p) {
    const sorted = [...xs].sort((a, b) => a - b);
    const at = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(at);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
  }

  function seriesMetrics(values, rfAnnual) {
    const returns = values.slice(1).map((v, i) => v / values[i] - 1);
    const n = returns.length;
    if (n < 2) return {};
    const rf = rfAnnual / BARS_PER_YEAR;
    const avg = mean(returns);
    const sd = sampleStd(returns);
    const excess = returns.map((r) => r - rf);
    const downside = Math.sqrt(mean(excess.map((e) => Math.min(e, 0) ** 2)));

    let peak = -Infinity, maxDrawdown = 0, run = 0, longest = 0;
    for (const v of values) {
      peak = Math.max(peak, v);
      const drawdown = (v - peak) / peak;
      maxDrawdown = Math.min(maxDrawdown, drawdown);
      run = drawdown < 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    maxDrawdown = Math.abs(maxDrawdown);

    const cagr = n < 4 ? null : returns.reduce((g, r) => g * (1 + r), 1) ** (BARS_PER_YEAR / n) - 1;
    const sharpe = sd > 0 ? (Math.sqrt(BARS_PER_YEAR) * (avg - rf)) / sd : 0;

    let psr = 0;
    if (sd > 0) {
      const { skew, kurt } = skewKurt(returns);
      const srHat = ((avg - rf) / sd) * Math.sqrt(BARS_PER_YEAR);
      const srStd = Math.sqrt((1 - skew * srHat + ((kurt - 1) / 4) * srHat ** 2) / (n - 1));
      if (srStd > 0) psr = 0.5 * (1 + erf((srHat - 1) / srStd / Math.SQRT2));
    }
    const var95 = percentile(returns, 5);
    const tail = returns.filter((r) => r <= var95);

    return {
      sharpe,
      sortino: downside > 0 ? (Math.sqrt(BARS_PER_YEAR) * mean(excess)) / downside : 0,
      calmar: cagr !== null && maxDrawdown > 0 ? cagr / maxDrawdown : null,
      // The index measured against itself.
      alpha: 0,
      beta: 1,
      psr,
      total_pct_return: values[values.length - 1] / values[0] - 1,
      annualized_return: cagr,
      ann_vol: sd * Math.sqrt(BARS_PER_YEAR),
      max_drawdown: maxDrawdown,
      max_drawdown_duration: longest,
      var_95: var95,
      cvar_95: tail.length ? mean(tail) : var95,
    };
  }

  let sp500Metrics = null;

  function showSp500(on) {
    if (!on) {
      if (sp500Series) chart.removeSeries(sp500Series);
      sp500Series = null;
      setPriceBounds();
      renderMetrics(null);
      return;
    }
    if (!sp500Data) {
      if (loadingSp500) return;
      loadingSp500 = true;
      compareNote.textContent = "Loading the S&P 500…";
      compareNote.hidden = false;
      // A week early so the first day has a close to start from even after a long weekend.
      vscode.postMessage({ type: "sp500", from: candles[0].time - 7 * 86400, to: candles[candles.length - 1].time + 86400 });
      return;
    }
    if (sp500Series) return;
    sp500Series = chart.addSeries(LC.LineSeries, sp500Options());
    sp500Series.setData(sp500Data);
    setPriceBounds();
    renderMetrics(sp500Metrics);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type !== "sp500") return;
    loadingSp500 = false;
    if (message.error) {
      compareNote.textContent = `Couldn't load the S&P 500: ${message.error}`;
      compareBox.checked = false;
      return;
    }
    compareNote.hidden = true;
    sp500Data = sp500Line(message.points);
    // The engine's risk-free rate: the average T-bill yield over the run, else 3.5%.
    const first = Math.floor(candles[0].time / 86400) * 86400;
    const last = candles[candles.length - 1].time;
    const yields = (message.irx || []).filter((p) => p.time >= first && p.time <= last).map((p) => p.close);
    const rfAnnual = yields.length ? mean(yields) / 100 : 0.035;
    sp500Metrics = seriesMetrics(sp500Data.filter((p) => p.value !== undefined).map((p) => p.value), rfAnnual);
    showSp500(compareBox.checked);
  });

  compareBox.disabled = !candles.length || !(params.starting_equity > 0);
  compareBox.checked = Boolean(compare) && !compareBox.disabled;
  compareBox.addEventListener("change", () => {
    vscode.postMessage({ type: "compare", on: compareBox.checked });
    compareNote.hidden = true;
    showSp500(compareBox.checked);
  });

  // ── expand ──────────────────────────────────────────────────
  // Floats the equity card in the middle of the tab; the extension also maximizes the tab's
  // editor group, so the charts get most of the window. The same button puts it back.
  const equityCard = document.querySelector(".card.equity");
  const expandButton = document.getElementById("expand");
  const backdrop = document.getElementById("backdrop");
  // Arrows on the top-right to bottom-left diagonal: pointing out to expand, in to collapse.
  const icon = (d) =>
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const EXPAND_ICON = icon("M13.5 6.5v-4h-4M13.5 2.5L9 7M2.5 9.5v4h4M2.5 13.5L7 9");
  const COLLAPSE_ICON = icon("M9 3v4h4M9 7l4.5-4.5M7 13V9H3M7 9l-4.5 4.5");
  expandButton.innerHTML = EXPAND_ICON;
  function setExpanded(on) {
    if (on === equityCard.classList.contains("expanded")) return;
    equityCard.classList.toggle("expanded", on);
    document.body.classList.toggle("expanded", on);
    backdrop.hidden = !on;
    expandButton.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON;
    expandButton.title = on ? "Collapse the charts (Esc)" : "Expand the charts";
    expandButton.setAttribute("aria-label", expandButton.title);
    vscode.postMessage({ type: "expand", on });
  }
  expandButton.addEventListener("click", () => setExpanded(!equityCard.classList.contains("expanded")));
  backdrop.addEventListener("click", () => setExpanded(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setExpanded(false);
  });

  drawSeries();
  applyTheme();
  if (compareBox.checked) showSp500(true);
  requestAnimationFrame(syncScrollbars);
  chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleAllocation);
  // Resizing keeps the visible dates, which can leave the bars a hair short of the edges; if the
  // whole run was on screen, fit it again so it still is (and the scrollbars stay hidden).
  new ResizeObserver(() => {
    if (showingWholeRun) requestAnimationFrame(fitAll);
    scheduleAllocation();
  }).observe(chartRoot);
  // VS Code swaps the body class when the color theme changes.
  new MutationObserver(() => {
    applyTheme();
    recolorBars();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // ── execution log ───────────────────────────────────────────
  const assetFilter = document.getElementById("filter-asset");
  const typeFilter = document.getElementById("filter-type");
  const pageSize = document.getElementById("page-size");
  const pageInput = document.getElementById("page");
  const showing = document.getElementById("showing");
  let page = 1;

  assetFilter.append(new Option("All assets", ""));
  for (const ticker of [...new Set(orders.map((o) => o.ticker))].sort()) assetFilter.append(new Option(ticker, ticker));

  function renderOrders() {
    const filtered = orders.filter(
      (o) => (!assetFilter.value || o.ticker === assetFilter.value) && (!typeFilter.value || o.type === typeFilter.value)
    );
    const size = Number(pageSize.value);
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    page = Math.min(Math.max(page, 1), pages);
    const start = (page - 1) * size;
    const rows = filtered.slice(start, start + size);

    const body = document.getElementById("orders");
    body.replaceChildren();
    for (const o of rows) {
      const row = el("tr");
      const type = el("td");
      type.append(el("span", `pill ${o.type === "Buy" ? "pos" : "neg"}`, o.type));
      row.append(
        el("td", "", stampFormat.format(new Date(o.timestamp))),
        el("td", "ticker", o.ticker),
        type,
        el("td", "num", money(o.price)),
        el("td", "num", numberFormat.format(o.shares)),
        el("td", "num", money(o.shares * o.price))
      );
      body.append(row);
    }
    if (!rows.length) {
      const row = el("tr");
      const cell = el("td", "empty", orders.length ? "No orders match the filters." : "This run placed no orders.");
      cell.colSpan = 6;
      row.append(cell);
      body.append(row);
    }

    pageInput.value = page;
    pageInput.max = pages;
    document.getElementById("pages").textContent = pages;
    document.getElementById("prev").disabled = page <= 1;
    document.getElementById("next").disabled = page >= pages;
    showing.textContent = filtered.length
      ? `Showing ${start + 1}–${start + rows.length} of ${filtered.length}`
      : "Showing 0 of 0";
  }

  for (const control of [assetFilter, typeFilter, pageSize]) {
    control.addEventListener("change", () => {
      page = 1;
      renderOrders();
    });
  }
  pageInput.addEventListener("change", () => {
    page = Number(pageInput.value) || 1;
    renderOrders();
  });
  document.getElementById("prev").addEventListener("click", () => {
    page--;
    renderOrders();
  });
  document.getElementById("next").addEventListener("click", () => {
    page++;
    renderOrders();
  });
  renderOrders();

  document.getElementById("tab-logs").textContent = logs.length ? logs.join("\n") : "No log output from this run.";
  if (result.profile) {
    document.getElementById("tab-profile").textContent = result.profile;
    document.querySelector('[data-tab="profile"]').hidden = false;
  }

  const tabs = document.getElementById("log-tabs");
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setActive(tabs, button);
    for (const name of ["orders", "logs", "profile"]) {
      document.getElementById(`tab-${name}`).hidden = button.dataset.tab !== name;
    }
    const onOrders = button.dataset.tab === "orders";
    document.getElementById("filters").hidden = !onOrders;
    showing.hidden = !onOrders;
  });
})();
