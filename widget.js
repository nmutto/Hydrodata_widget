// ===============================
// CONFIG
// ===============================
const CONFIG = {
  stationId: "2606",
  riverName: "Rhône",

  bgFile: "hydro_bg.png",

  hoursWindow: 24,
  trendHours: 1,
  // Below this fraction of change (over trendHours) the trend reads "stable".
  trendStablePercent: 0.05,

  referenceValue: 200,

  // Absolute discharge thresholds (m³/s)
  thresholds: {
    low: 100,
    high: 200,
    extreme: 300
  }
};

// ===============================
// STATION OVERRIDE (widget parameter)
// ===============================
// Long-press the widget on the Home Screen -> Edit Widget -> set "Parameter"
// to another hydrodaten.admin.ch station ID (e.g. "2019") to reuse this same
// script for a different river/station without touching CONFIG. Leave blank
// to use CONFIG.stationId.
const paramStationId = (args.widgetParameter || "").trim();
const isOverrideStation = paramStationId !== "" && paramStationId !== CONFIG.stationId;

if (paramStationId) {
  CONFIG.stationId = paramStationId;
}

CONFIG.url = `https://www.hydrodaten.admin.ch/plots/p_q_7days/${CONFIG.stationId}_p_q_7days_en.json`;
CONFIG.cacheFile = `hydro_${CONFIG.stationId}_cache.json`;

// Tapping the widget opens the station's official page.
const stationUrl = `https://www.hydrodaten.admin.ch/en/seen-und-fluesse/stations/${CONFIG.stationId}`;

// ===============================
// FILE MANAGER
// ===============================
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), CONFIG.cacheFile);
const bgPath = fm.joinPath(fm.documentsDirectory(), CONFIG.bgFile);

// ===============================
// FETCH + CACHE
// ===============================
let json = null;
let usedCache = false;

try {
  const req = new Request(CONFIG.url);
  json = await req.loadJSON();

  if (!json?.plot?.data) throw new Error("Invalid API structure");

  fm.writeString(cachePath, JSON.stringify(json));
} catch (e) {
  console.log("Network failed, using cache:", e);

  if (fm.fileExists(cachePath)) {
    try {
      const cached = JSON.parse(fm.readString(cachePath));
      if (cached?.plot?.data) {
        json = cached;
        usedCache = true;
      }
    } catch (err) {
      console.log("Cache corrupted:", err);
    }
  }
}

if (!json?.plot?.data) {

  // ===============================
  // NO DATA — graceful fallback widget
  // ===============================
  const errorWidget = new ListWidget();
  errorWidget.backgroundColor = new Color("#06131a");
  errorWidget.setPadding(16, 16, 16, 16);

  const errTitle = errorWidget.addText(
    `${isOverrideStation ? `Station ${CONFIG.stationId}` : CONFIG.riverName} discharge`
  );
  errTitle.font = Font.mediumSystemFont(14);
  errTitle.textColor = Color.white();
  errTitle.textOpacity = 0.9;

  errorWidget.addSpacer(8);

  const errMsg = errorWidget.addText("No data available");
  errMsg.font = Font.boldSystemFont(16);
  errMsg.textColor = new Color("#fb7185");

  errorWidget.addSpacer(4);

  const errSub = errorWidget.addText("Network failed and no cached reading was found.");
  errSub.font = Font.systemFont(11);
  errSub.textColor = new Color("#9ca3af");
  errSub.textOpacity = 0.8;

  // Retry sooner than the normal refresh interval.
  errorWidget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  errorWidget.url = stationUrl;

  Script.setWidget(errorWidget);

} else {

  // ===============================
  // DATA
  // ===============================
  // Some stations publish both "Water level" and "Discharge" series; picking
  // by name avoids silently charting the wrong one when a station (unlike
  // the default) has more than one series.
  const series = json.plot.data.find(s => s.name === "Discharge") || json.plot.data[0];

  // ===============================
  // STATION METADATA (auto-detected for override stations)
  // ===============================
  // CONFIG's riverName/thresholds/referenceValue are hand-tuned for
  // CONFIG's default station. For any other station picked via the widget
  // parameter, pull the display name and official flood-stage bands
  // straight out of the API response instead, since a fixed river's
  // thresholds are meaningless for a different river's flow.
  function deriveStationName(apiJson) {
    const title = apiJson?.plot?.layout?.title;
    if (typeof title !== "string") return null;

    const cut = title.indexOf(" PQPlot");
    const full = (cut === -1 ? title : title.slice(0, cut)).trim();
    if (!full) return null;

    return full.split(" - ")[0].trim() || full;
  }

  function deriveThresholds(apiJson, dataSeries) {
    const shapes = apiJson?.plot?.layout?.shapes || [];
    const axisKey = dataSeries.yaxis || "y";
    const yref = axisKey === "y" ? "y1" : axisKey;

    const bandStarts = [...new Set(
      shapes
        .filter(s => s.type === "rect" && s.yref === yref && typeof s.y0 === "number")
        .map(s => s.y0)
    )].sort((a, b) => a - b);

    if (bandStarts.length < 3) return null;

    return { low: bandStarts[0], high: bandStarts[1], extreme: bandStarts[2] };
  }

  let riverName = CONFIG.riverName;
  let thresholds = CONFIG.thresholds;
  let referenceValue = CONFIG.referenceValue;

  if (isOverrideStation) {
    riverName = deriveStationName(json) || riverName;

    const derivedThresholds = deriveThresholds(json, series);
    if (derivedThresholds) {
      thresholds = derivedThresholds;
      referenceValue = derivedThresholds.low;
    }
  }

  function parseTime(t) {
    const d = new Date(t);
    if (!isNaN(d)) return d;
    if (typeof t === "number") {
      return new Date(t < 1e12 ? t * 1000 : t);
    }
    return new Date(0);
  }

  // Pair x/y before filtering so a dropped invalid value can't desync the
  // two arrays and shift every later point onto the wrong timestamp.
  const points = series.x
    .map((t, i) => ({ t: parseTime(t), v: Number(series.y[i]) }))
    .filter(p => !isNaN(p.v));

  if (points.length === 0) {
    throw new Error("No valid hydrology data available");
  }

  // ===============================
  // TIME WINDOW
  // ===============================
  const now = new Date();
  const cutoff = new Date(now.getTime() - CONFIG.hoursWindow * 60 * 60 * 1000);

  let data = points.filter(p => p.t >= cutoff);

  if (data.length < 2) {
    data = points;
  }

  const seriesValues = data.map(d => d.v);

  // ===============================
  // STATS
  // ===============================
  let minV = Infinity;
  let maxV = -Infinity;

  for (const v of seriesValues) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const current = seriesValues[seriesValues.length - 1];

  // ===============================
  // TREND
  // ===============================
  const trendCutoff = new Date(now.getTime() - CONFIG.trendHours * 60 * 60 * 1000);

  const pastPoint = data.find(p => p.t >= trendCutoff);
  const pastValue = pastPoint ? pastPoint.v : seriesValues[0];

  const trendDelta = current - pastValue;

  // Scales with the river's own flow instead of a fixed m³/s cutoff, so a
  // 10 m³/s wobble doesn't read as "rising" at low flow, or get lost as
  // noise during a flood. Floored at 1 m³/s so near-zero flow doesn't make
  // the threshold vanish.
  const trendThreshold = Math.max(Math.abs(pastValue) * CONFIG.trendStablePercent, 1);

  const trendDirection =
    Math.abs(trendDelta) < trendThreshold ? "stable"
    : trendDelta > 0 ? "rising"
    : "falling";

  function trendColor(dir) {
    if (dir === "rising") return new Color("#fb7185");
    if (dir === "falling") return new Color("#34d399");
    return new Color("#9ca3af");
  }

  // ===============================
  // LAYOUT (medium widget only, for now)
  // ===============================
  const titleFont = Font.mediumSystemFont(14);
  const valueFont = Font.boldSystemFont(30);
  const padding = 12;
  // Tighter at the bottom: the chart's own tick labels already leave some
  // breathing room, so the full padding there just reads as dead space.
  const bottomPadding = 6;

  // Medium widget size (pt) keyed by portrait screen size (pt). iOS
  // aspect-fits the chart image into whatever room the text rows leave,
  // so a chart whose aspect ratio doesn't match that slot gets scaled
  // down and stops short of the right edge.
  const MEDIUM_WIDGET_SIZES = {
    "440x956": [364, 170],
    "430x932": [364, 170],
    "428x926": [364, 170],
    "414x896": [360, 169],
    "414x736": [348, 157],
    "402x874": [338, 158],
    "393x852": [338, 158],
    "390x844": [338, 158],
    "375x812": [329, 155],
    "375x667": [321, 148],
    "320x568": [292, 141]
  };

  function mediumWidgetSize() {
    const screen = Device.screenSize();
    const key =
      `${Math.min(screen.width, screen.height)}x` +
      `${Math.max(screen.width, screen.height)}`;
    return MEDIUM_WIDGET_SIZES[key] || [338, 158];
  }

  // Height of everything stacked above the chart (header, value, stats
  // rows and the spacers between them), measured from an on-device
  // screenshot. Too high leaves space under the chart; too low makes the
  // chart height-limited, so it stops short of the right edge instead.
  const contentAboveChart = 86;

  const [widgetW, widgetH] = mediumWidgetSize();
  const slotW = widgetW - padding * 2;
  const slotH = widgetH - padding - bottomPadding - contentAboveChart;

  // Drawing width stays fixed so fonts and line weights look the same on
  // every device; only the height follows the slot's aspect ratio.
  const chartW = 530;
  const chartH = Math.round(chartW * slotH / slotW);

  // ===============================
  // BACKGROUND (cached)
  // ===============================
  function createBackground() {
    const ctx = new DrawContext();
    ctx.size = new Size(400, 200);
    ctx.opaque = true;
    ctx.respectScreenScale = true;

    ctx.setFillColor(new Color("#06131a"));
    ctx.fillRect(new Rect(0, 0, 400, 200));

    ctx.setFillColor(new Color("#0b2a3a", 0.25));
    for (let i = 0; i < 20; i++) {
      ctx.fillRect(new Rect(0, i * 10, 400, 10));
    }

    return ctx.getImage();
  }

  function getBackground() {
    if (fm.fileExists(bgPath)) return fm.readImage(bgPath);
    const img = createBackground();
    fm.writeImage(bgPath, img);
    return img;
  }

  // ===============================
  // ABSOLUTE DISCHARGE COLORS
  // ===============================
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function hexToRgb(hex) {
    const c = hex.replace("#", "");
    return {
      r: parseInt(c.slice(0, 2), 16),
      g: parseInt(c.slice(2, 4), 16),
      b: parseInt(c.slice(4, 6), 16)
    };
  }

  function mixHex(c1, c2, t) {
    const r = Math.round(lerp(c1.r, c2.r, t));
    const g = Math.round(lerp(c1.g, c2.g, t));
    const b = Math.round(lerp(c1.b, c2.b, t));

    const toHex = v => v.toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  const GREEN  = hexToRgb("#34d399");
  const YELLOW = hexToRgb("#fde047");
  const ORANGE = hexToRgb("#f59e0b");
  const RED    = hexToRgb("#fb7185");

  function dischargeColor(v) {

    const low = thresholds.low;
    const high = thresholds.high;
    const extreme = thresholds.extreme;

    let hex;

    if (v <= low) {

      hex = mixHex(
        GREEN,
        YELLOW,
        0
      );

    } else if (low <= v && v <= high) {

      const t =
        (v - low) /
        (high - low);

      hex = mixHex(
        GREEN,
        YELLOW,
        t
      );

    } else if (high <= v && v <= extreme) {

      const t =
        (v - high) /
        (extreme - high);

      hex = mixHex(
        YELLOW,
        ORANGE,
        t
      );

    } else if (v >= extreme) {

      // Ramps ORANGE -> RED over the band from `extreme` to 2x `extreme`,
      // then holds solid RED. Clamped so it can never overshoot RED's
      // channel values (t must stay within [0, 1]).
      const t = Math.min(1, Math.max(0, (v - extreme) / extreme));

      hex = mixHex(
        ORANGE,
        RED,
        t
      );

    }

    return new Color(hex);
  }

  // ===============================
  // CHART
  // ===============================
  function buildChart(data) {
    const vals = data.map(p => p.v);
    const current = vals[vals.length - 1];

    const startTime = data[0].t;
    const endTime = data[data.length - 1].t;
    const w = chartW;
    const h = chartH;
    const pad = 6;

    const ctx = new DrawContext();
    ctx.size = new Size(w, h);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    let min = Infinity;
    let max = -Infinity;

    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const range = max - min || 1;
    const denom = Math.max(vals.length - 1, 1);

    const getX = i => pad + (i / denom) * (w - pad * 2);

    const totalHours =
      (endTime.getTime() - startTime.getTime()) / 3600000;

    const tickFontSize = 11;
    const labelHeight = tickFontSize + 5;

    // Reserves room for the tick labels at the bottom, so the reference
    // line, guides, area, colored line, and dots all share one scale.
    const getY = v =>
      pad +
      (1 - (v - min) / range) *
      (h - pad * 2 - labelHeight);

    // reference line
    const refY = getY(referenceValue);
    const ref = new Path();
    ref.move(new Point(pad, refY));
    ref.addLine(new Point(w - pad, refY));

    ctx.addPath(ref);
    ctx.setStrokeColor(new Color("#ffffff", 0.18));
    ctx.setLineWidth(1);
    ctx.strokePath();

    // ===============================
    // TIME GUIDES
    // ===============================

    // Guides snap to round clock times (rather than evenly splitting the
    // window at odd minutes like 15:20), with faint unlabeled minor guides
    // between labeled major ones.
    const HOUR = 3600000;
    const DAY = 24 * HOUR;
    const [majorStep, minorStep] =
      totalHours <= 6 ? [HOUR, HOUR / 4]
      : totalHours <= 12 ? [2 * HOUR, HOUR]
      : totalHours <= 24 ? [3 * HOUR, HOUR]
      : totalHours <= 48 ? [6 * HOUR, 3 * HOUR]
      : totalHours <= 24 * 14 ? [DAY, 6 * HOUR]
      : [7 * DAY, DAY];

    function formatTick(date) {
      if (majorStep < DAY) {
        return date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        });
      }

      return `${date.getDate()}/${date.getMonth() + 1}`;
    }

    const startMs = startTime.getTime();
    const spanMs = Math.max(endTime.getTime() - startMs, 1);
    const timeX = t => pad + ((t - startMs) / spanMs) * (w - pad * 2);
    const guideBottom = h - pad - labelHeight;

    function drawGuide(x, color) {
      const guide = new Path();
      guide.move(new Point(x, pad));
      guide.addLine(new Point(x, guideBottom));
      ctx.addPath(guide);
      ctx.setStrokeColor(color);
      ctx.setLineWidth(1);
      ctx.strokePath();
    }

    // Steps are aligned to local midnight so e.g. 3h ticks land on
    // 00/03/06…, not on hours offset by the timezone.
    const tzOffsetMs = startTime.getTimezoneOffset() * 60000;
    const firstTick = step =>
      Math.ceil((startMs - tzOffsetMs) / step) * step + tzOffsetMs;

    for (let t = firstTick(minorStep); t < endTime.getTime(); t += minorStep) {
      if ((t - tzOffsetMs) % majorStep === 0) continue;
      drawGuide(timeX(t), new Color("#ffffff", 0.04));
    }

    ctx.setFont(Font.systemFont(tickFontSize));
    ctx.setTextColor(new Color("#ffffff", 0.45));
    ctx.setTextAlignedCenter();

    const labelWidth = 48;

    for (let t = firstTick(majorStep); t < endTime.getTime(); t += majorStep) {
      const x = timeX(t);
      drawGuide(x, new Color("#ffffff", 0.1));

      // Skip labels that would hang off the canvas edges rather than
      // clamping them inward, which would misalign them with their guide.
      if (x - labelWidth / 2 < 0 || x + labelWidth / 2 > w) continue;

      ctx.drawTextInRect(
        formatTick(new Date(t)),
        new Rect(x - labelWidth / 2, h - labelHeight, labelWidth, labelHeight)
      );
    }

    // "now" edge
    drawGuide(w - pad, new Color("#ffffff", 0.18));

    // area fill — tinted by the current reading's severity, not a fixed blue
    const area = new Path();
    vals.forEach((v, i) => {
      const x = getX(i);
      const y = getY(v);

      if (i === 0) area.move(new Point(x, h - pad));
      area.addLine(new Point(x, y));
    });

    area.addLine(new Point(w - pad, h - pad));
    area.closeSubpath();

    ctx.addPath(area);
    ctx.setFillColor(new Color(dischargeColor(current).hex, 0.14));
    ctx.fillPath();

    // color line using absolute discharge thresholds
    const STEP = 2;

    for (let i = 0; i < vals.length - 1; i += STEP) {

      // Clamp to the last index so the final segment always reaches the
      // most recent point instead of stopping STEP points short of it.
      const j = Math.min(i + STEP, vals.length - 1);

      const v1 = vals[i];
      const v2 = vals[j];

      const representativeValue = (v1 + v2) / 2;

      const segment = new Path();
      segment.move(new Point(getX(i), getY(v1)));
      segment.addLine(new Point(getX(j), getY(v2)));

      ctx.addPath(segment);
      ctx.setStrokeColor(
        dischargeColor(representativeValue)
      );
      ctx.setLineWidth(4);
      ctx.strokePath();
    }

    // ===============================
    // MIN / MAX MARKERS
    // ===============================
    const minVal = min;
    const maxVal = max;

    const minIndex = vals.indexOf(minVal);
    const maxIndex = vals.indexOf(maxVal);

    function drawDot(x, y, color) {
      // outer glow
      const glow = new Path();
      glow.addEllipse(new Rect(x - 7, y - 7, 14, 14));
      ctx.addPath(glow);
      ctx.setFillColor(new Color(color, 0.25));
      ctx.fillPath();

      // ring
      const ring = new Path();
      ring.addEllipse(new Rect(x - 5, y - 5, 10, 10));
      ctx.addPath(ring);
      ctx.setFillColor(Color.white());
      ctx.fillPath();

      // core
      const core = new Path();
      core.addEllipse(new Rect(x - 3, y - 3, 6, 6));
      ctx.addPath(core);
      ctx.setFillColor(new Color(color));
      ctx.fillPath();
    }

    if (minIndex !== -1) {
      drawDot(
        getX(minIndex),
        getY(minVal),
        dischargeColor(minVal).hex
      );
    }

    if (maxIndex !== -1) {
      drawDot(
        getX(maxIndex),
        getY(maxVal),
        dischargeColor(maxVal).hex
      );
    }

    return ctx.getImage();
  }

  // ===============================
  // WIDGET
  // ===============================
  const widget = new ListWidget();
  widget.setPadding(padding, padding, bottomPadding, padding);
  widget.backgroundImage = getBackground();
  widget.url = stationUrl;

  // Header row
  const header = widget.addStack();
  header.layoutHorizontally();

  const title = header.addText(`${riverName} discharge`);
  title.font = titleFont;
  title.textColor = Color.white();
  title.textOpacity = 0.9;

  header.addSpacer();
  const latestTimestamp = data[data.length - 1].t;

  const updatedLabel =
    `Last measurement ${latestTimestamp.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    })}` + (usedCache ? " · cached" : "");

  const updated = header.addText(updatedLabel);

  updated.font = Font.systemFont(10);
  // Amber when we fell back to a cached reading, so a stale widget doesn't
  // look as current as a freshly fetched one.
  updated.textColor = usedCache ? new Color("#fbbf24") : new Color("#9ca3af");
  updated.textOpacity = 0.8;

  widget.addSpacer(6);

  // Value
  const valueText = widget.addText(`${current.toFixed(1)} m³ s⁻¹`);
  valueText.font = valueFont;
  valueText.textColor = dischargeColor(current);

  widget.addSpacer(4);

  // Stats
  const stats = widget.addStack();
  stats.layoutHorizontally();
  stats.spacing = 14;

  function stat(label, value, color) {
    const t = stats.addText(`${label} ${value} m³ s⁻¹`);
    t.font = Font.systemFont(11);
    t.textColor = color;
  }

  stat(
    "Min",
    minV.toFixed(0),
    dischargeColor(minV)
  );
  stat(
    "Max",
    maxV.toFixed(0),
    dischargeColor(maxV)
  );

  const arrow =
    trendDirection === "rising" ? "↑"
    : trendDirection === "falling" ? "↓"
    : "→";

  stat(
    `Trend ${CONFIG.trendHours}h`,
    `${arrow} ${Math.abs(trendDelta).toFixed(1)}`,
    trendColor(trendDirection)
  );

  widget.addSpacer(8);
  widget.refreshAfterDate =
    new Date(Date.now() + 10 * 60 * 1000);

  // Chart
  const chart = widget.addImage(buildChart(data));
  chart.cornerRadius = 10;
  chart.imageOpacity = 0.95;

  Script.setWidget(widget);
}

Script.complete();
