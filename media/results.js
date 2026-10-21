// Renders a backtest result inside the webview, laid out like the dashboard's backtest page.
(function () {
  const { result, logs, fileName, elapsedSeconds } = JSON.parse(document.getElementById("data").textContent);
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

  const metricRows = [
    ["Sharpe", number(metrics.sharpe)],
    ["Sortino", number(metrics.sortino)],
    ["Calmar", number(metrics.calmar)],
    ["Alpha", number(metrics.alpha)],
    ["Beta", number(metrics.beta)],
    ["PSR", number(metrics.psr)],
    ["Total Orders", count(metrics.total_orders)],
    ["Total Return", pct(metrics.total_pct_return)],
    ["CAGR", pct(metrics.annualized_return)],
    ["Ann. Volatility", pct(metrics.ann_vol)],
    ["Max Drawdown", pct(metrics.max_drawdown)],
    ["Max DD Duration", missing(metrics.max_drawdown_duration) ? "—" : `${count(metrics.max_drawdown_duration)} bars`],
    ["VaR (95%)", pct(metrics.var_95)],
    ["CVaR (95%)", pct(metrics.cvar_95)],
  ];
  const metricsRoot = document.getElementById("metrics");
  for (const [label, value] of metricRows) {
    const row = el("div", "metric");
    row.append(el("dt", "", label), el("dd", "", value));
    metricsRoot.append(row);
  }

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
  const PALETTE = [
    "#4e8ef7", "#3fb68b", "#e5a33b", "#e0628f", "#9a7cf0", "#e86f55", "#3bb7d6", "#d6884a",
    "#5fc4a8", "#c6b13c", "#7d93e8", "#d070c9", "#66a95b", "#c95f6a", "#4aa3c4", "#b4884f",
  ];
  const colorOf = new Map(
    allocation.keys.map((key, i) => [key, key === "Cash" ? "#8b929e" : PALETTE[i % PALETTE.length]])
  );

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
  // The vertical bar spans the run's lowest low to highest high. The price scale reports its
  // range without its own margins, so with every bar in view the two match and the bar hides.
  const fullLow = candles.length ? candles.reduce((m, c) => Math.min(m, c.low), Infinity) : 0;
  const priceMax = candles.length ? candles.reduce((m, c) => Math.max(m, c.high), -Infinity) : 1;
  // A run that never moved still needs a non-zero span.
  const fullHigh = priceMax > fullLow ? priceMax : fullLow + 1;

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
  function syncScrollbars() {
    const plotWidth = chartRoot.clientWidth - priceScale.width();
    const plotHeight = chartRoot.clientHeight - chart.timeScale().height();
    const logical = chart.timeScale().getVisibleLogicalRange();
    const prices = priceScale.getVisibleRange();
    const key = [plotWidth, plotHeight, logical?.from, logical?.to, prices?.from, prices?.to].join();
    if (key !== lastSync) {
      lastSync = key;
      hscroll.style.width = `${plotWidth}px`;
      hscroll.style.top = `${plotHeight - 10}px`;
      vscroll.style.left = `${plotWidth - 10}px`;
      vscroll.style.height = `${plotHeight}px`;
      // Count bars inclusively: from 0 to totalBars - 1 is every bar, a size of exactly 1.
      if (logical) setHorizontal(logical.from / totalBars, (logical.to - logical.from + 1) / totalBars);
      if (prices) {
        const span = fullHigh - fullLow;
        setVertical((fullHigh - prices.to) / span, (prices.to - prices.from) / span);
      }
      drawPriceAxis(prices, plotWidth, plotHeight);
    }
    requestAnimationFrame(syncScrollbars);
  }

  drawSeries();
  applyTheme();
  requestAnimationFrame(syncScrollbars);
  chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleAllocation);
  new ResizeObserver(scheduleAllocation).observe(chartRoot);
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
