// ===============================
// CONFIG
// ===============================
const CONFIG = {
  stationId: "2606",
  riverName: "Rhône",
  hoursWindow: 24,
  trendHours: 1,
  // Below this fraction of change (over trendHours) the trend reads "stable".
  trendStablePercent: 0.05,
  referenceValue: 200,
  // Absolute discharge thresholds (m³/s)
  thresholds: { low: 100, high: 200, extreme: 300 }
};

// Widget parameter = another hydrodaten.admin.ch station ID (e.g. "2019")
// to reuse this script for a different river. Blank = CONFIG.stationId.
const param = (args.widgetParameter || "").trim();
const isOverride = param !== "" && param !== CONFIG.stationId;
const stationId = param || CONFIG.stationId;
const stationUrl = `https://www.hydrodaten.admin.ch/en/seen-und-fluesse/stations/${stationId}`;

const HOUR = 3600000;
const BG = new Color("#071922");

// ===============================
// FETCH + CACHE
// ===============================
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), `hydro_${stationId}_cache.json`);

let json = null;
let usedCache = false;

try {
  json = await new Request(
    `https://www.hydrodaten.admin.ch/plots/p_q_7days/${stationId}_p_q_7days_en.json`
  ).loadJSON();
  if (!json?.plot?.data) throw new Error("Invalid API structure");
  fm.writeString(cachePath, JSON.stringify(json));
} catch (e) {
  console.log("Network failed, using cache:", e);
  try {
    json = JSON.parse(fm.readString(cachePath));
    usedCache = true;
  } catch {
    json = null;
  }
}

if (!json?.plot?.data) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(16, 16, 16, 16);
  w.url = stationUrl;
  // Retry sooner than the normal refresh interval.
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  const line = (str, font, color, spaceBefore) => {
    if (spaceBefore) w.addSpacer(spaceBefore);
    const t = w.addText(str);
    t.font = font;
    t.textColor = color;
  };
  line(`${isOverride ? `Station ${stationId}` : CONFIG.riverName} discharge`, Font.mediumSystemFont(14), Color.white());
  line("No data available", Font.boldSystemFont(16), new Color("#fb7185"), 8);
  line("Network failed and no cached reading was found.", Font.systemFont(11), new Color("#9ca3af"), 4);

  Script.setWidget(w);
  Script.complete();
  return;
}

// ===============================
// DATA
// ===============================
// Some stations publish both "Water level" and "Discharge" series.
const series = json.plot.data.find(s => s.name === "Discharge") || json.plot.data[0];

// CONFIG's name/thresholds are hand-tuned for the default station; for an
// override station, use the API's title and official flood-stage bands.
let riverName = CONFIG.riverName;
let thresholds = CONFIG.thresholds;
let referenceValue = CONFIG.referenceValue;

if (isOverride) {
  const title = json.plot.layout?.title;
  if (typeof title === "string") {
    riverName = title.split(" PQPlot")[0].split(" - ")[0].trim() || riverName;
  }

  const yref = (series.yaxis || "y") === "y" ? "y1" : series.yaxis;
  const bands = [...new Set(
    (json.plot.layout?.shapes || [])
      .filter(s => s.type === "rect" && s.yref === yref && typeof s.y0 === "number")
      .map(s => s.y0)
  )].sort((a, b) => a - b);

  if (bands.length >= 3) {
    thresholds = { low: bands[0], high: bands[1], extreme: bands[2] };
    referenceValue = bands[0];
  }
}

// Pair x/y before filtering so a dropped value can't shift later timestamps.
const points = series.x
  .map((t, i) => ({ t: new Date(t), v: Number(series.y[i]) }))
  .filter(p => !isNaN(p.v) && !isNaN(p.t));

if (points.length === 0) throw new Error("No valid hydrology data available");

const now = Date.now();
let data = points.filter(p => p.t >= now - CONFIG.hoursWindow * HOUR);
if (data.length < 2) data = points;

const vals = data.map(p => p.v);
const minV = Math.min(...vals);
const maxV = Math.max(...vals);
const current = vals[vals.length - 1];

// Trend: the "stable" band scales with the river's own flow (floored at
// 1 m³/s), so a small wobble doesn't read as rising at low flow.
const pastValue = (data.find(p => p.t >= now - CONFIG.trendHours * HOUR) || data[0]).v;
const trendDelta = current - pastValue;
const trend =
  Math.abs(trendDelta) < Math.max(Math.abs(pastValue) * CONFIG.trendStablePercent, 1) ? "stable"
  : trendDelta > 0 ? "rising"
  : "falling";

// ===============================
// COLORS
// ===============================
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const [GREEN, YELLOW, ORANGE, RED] = ["#34d399", "#fde047", "#f59e0b", "#fb7185"].map(rgb);

// Blends two RGB triples; t clamped so a color never overshoots its target.
function ramp(from, to, t) {
  const k = Math.min(1, Math.max(0, t));
  return "#" + from
    .map((c, i) => Math.round(c + (to[i] - c) * k).toString(16).padStart(2, "0"))
    .join("");
}

// ORANGE -> RED spans `extreme` to 2x `extreme`, then holds RED.
function dischargeColor(v, alpha = 1) {
  const { low, high, extreme } = thresholds;
  const hex =
    v <= low ? ramp(GREEN, YELLOW, 0)
    : v <= high ? ramp(GREEN, YELLOW, (v - low) / (high - low))
    : v <= extreme ? ramp(YELLOW, ORANGE, (v - high) / (extreme - high))
    : ramp(ORANGE, RED, (v - extreme) / extreme);
  return new Color(hex, alpha);
}

// ===============================
// LAYOUT (medium widget only)
// ===============================
const padding = 12;
// The chart's tick labels already leave room, so less padding at the bottom.
const bottomPadding = 6;

// Medium widget size (pt) keyed by portrait screen size (pt). iOS
// aspect-fits the chart into the room the text rows leave, so a chart whose
// ratio doesn't match stops short of the right edge or leaves space below.
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
const screen = Device.screenSize();
const screenKey = `${Math.min(screen.width, screen.height)}x${Math.max(screen.width, screen.height)}`;
const [widgetW, widgetH] = MEDIUM_WIDGET_SIZES[screenKey] || [338, 158];

// Height of the rows above the chart, measured from an on-device
// screenshot. Too high leaves space under the chart; too low shrinks it
// horizontally instead.
const contentAboveChart = 86;

// Fixed drawing width keeps fonts and line weights consistent; only the
// height follows the slot's aspect ratio.
const chartW = 530;
const chartH = Math.round(
  chartW * (widgetH - padding - bottomPadding - contentAboveChart) / (widgetW - padding * 2)
);

// ===============================
// CHART
// ===============================
function buildChart() {
  const w = chartW;
  const h = chartH;
  const pad = 6;
  const tickFontSize = 11;
  const labelHeight = tickFontSize + 5;
  const guideBottom = h - pad - labelHeight;

  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const getX = i => pad + (i / Math.max(vals.length - 1, 1)) * (w - pad * 2);
  // Leaves room at the bottom for the tick labels.
  const getY = v => pad + (1 - (v - minV) / (maxV - minV || 1)) * (guideBottom - pad);

  function line(x1, y1, x2, y2, color, width = 1) {
    const p = new Path();
    p.move(new Point(x1, y1));
    p.addLine(new Point(x2, y2));
    ctx.addPath(p);
    ctx.setStrokeColor(color);
    ctx.setLineWidth(width);
    ctx.strokePath();
  }

  // reference line
  const refY = getY(referenceValue);
  line(pad, refY, w - pad, refY, new Color("#ffffff", 0.18));

  // Time guides snap to round clock times (aligned to local midnight):
  // labeled majors, faint unlabeled minors.
  const DAY = 24 * HOUR;
  const startMs = data[0].t.getTime();
  const endMs = data[data.length - 1].t.getTime();
  const spanMs = Math.max(endMs - startMs, 1);
  const totalHours = spanMs / HOUR;
  const [majorStep, minorStep] =
    totalHours <= 6 ? [HOUR, HOUR / 4]
    : totalHours <= 12 ? [2 * HOUR, HOUR]
    : totalHours <= 24 ? [3 * HOUR, HOUR]
    : totalHours <= 48 ? [6 * HOUR, 3 * HOUR]
    : totalHours <= 24 * 14 ? [DAY, 6 * HOUR]
    : [7 * DAY, DAY];

  const timeX = t => pad + ((t - startMs) / spanMs) * (w - pad * 2);
  const tz = data[0].t.getTimezoneOffset() * 60000;
  const firstTick = step => Math.ceil((startMs - tz) / step) * step + tz;
  const guide = (x, alpha) => line(x, pad, x, guideBottom, new Color("#ffffff", alpha));

  for (let t = firstTick(minorStep); t < endMs; t += minorStep) {
    if ((t - tz) % majorStep !== 0) guide(timeX(t), 0.04);
  }

  ctx.setFont(Font.systemFont(tickFontSize));
  ctx.setTextColor(new Color("#ffffff", 0.45));
  ctx.setTextAlignedCenter();
  const labelWidth = 48;

  for (let t = firstTick(majorStep); t < endMs; t += majorStep) {
    const x = timeX(t);
    guide(x, 0.1);
    // Skip labels that would hang off the edges.
    if (x - labelWidth / 2 < 0 || x + labelWidth / 2 > w) continue;
    const date = new Date(t);
    const label = majorStep < DAY
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : `${date.getDate()}/${date.getMonth() + 1}`;
    ctx.drawTextInRect(label, new Rect(x - labelWidth / 2, h - labelHeight, labelWidth, labelHeight));
  }

  // "now" edge
  guide(w - pad, 0.18);

  // area fill, tinted by the current reading's severity
  const area = new Path();
  vals.forEach((v, i) => {
    if (i === 0) area.move(new Point(getX(i), h - pad));
    area.addLine(new Point(getX(i), getY(v)));
  });
  area.addLine(new Point(w - pad, h - pad));
  area.closeSubpath();
  ctx.addPath(area);
  ctx.setFillColor(dischargeColor(current, 0.14));
  ctx.fillPath();

  // line colored per segment; last segment clamped to reach the newest point
  const STEP = 2;
  for (let i = 0; i < vals.length - 1; i += STEP) {
    const j = Math.min(i + STEP, vals.length - 1);
    line(getX(i), getY(vals[i]), getX(j), getY(vals[j]), dischargeColor((vals[i] + vals[j]) / 2), 4);
  }

  // min / max markers: glow, white ring, colored core
  for (const v of [minV, maxV]) {
    const x = getX(vals.indexOf(v));
    const y = getY(v);
    for (const [r, color] of [[7, dischargeColor(v, 0.25)], [5, Color.white()], [3, dischargeColor(v)]]) {
      const p = new Path();
      p.addEllipse(new Rect(x - r, y - r, r * 2, r * 2));
      ctx.addPath(p);
      ctx.setFillColor(color);
      ctx.fillPath();
    }
  }

  return ctx.getImage();
}

// ===============================
// WIDGET
// ===============================
const widget = new ListWidget();
widget.setPadding(padding, padding, bottomPadding, padding);
widget.backgroundColor = BG;
widget.url = stationUrl;

function text(stack, str, font, color, opacity = 1) {
  const t = stack.addText(str);
  t.font = font;
  t.textColor = color;
  t.textOpacity = opacity;
}

const header = widget.addStack();
header.layoutHorizontally();
text(header, `${riverName} discharge`, Font.mediumSystemFont(14), Color.white(), 0.9);
header.addSpacer();
const lastTime = data[data.length - 1].t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// Amber when showing a cached reading, so a stale widget doesn't look fresh.
text(
  header,
  `Last measurement ${lastTime}` + (usedCache ? " · cached" : ""),
  Font.systemFont(10),
  new Color(usedCache ? "#fbbf24" : "#9ca3af"),
  0.8
);

widget.addSpacer(6);
text(widget, `${current.toFixed(1)} m³ s⁻¹`, Font.boldSystemFont(30), dischargeColor(current));
widget.addSpacer(4);

const stats = widget.addStack();
stats.layoutHorizontally();
stats.spacing = 14;
const arrow = { rising: "↑", falling: "↓", stable: "→" }[trend];
const trendColor = { rising: "#fb7185", falling: "#34d399", stable: "#9ca3af" }[trend];
text(stats, `Min ${minV.toFixed(0)} m³ s⁻¹`, Font.systemFont(11), dischargeColor(minV));
text(stats, `Max ${maxV.toFixed(0)} m³ s⁻¹`, Font.systemFont(11), dischargeColor(maxV));
text(stats, `Trend ${CONFIG.trendHours}h ${arrow} ${Math.abs(trendDelta).toFixed(1)} m³ s⁻¹`, Font.systemFont(11), new Color(trendColor));

widget.addSpacer(8);
widget.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);

const chart = widget.addImage(buildChart());
chart.cornerRadius = 10;
chart.imageOpacity = 0.95;

Script.setWidget(widget);
Script.complete();
