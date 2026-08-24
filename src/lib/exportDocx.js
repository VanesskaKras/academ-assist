import { getLangLabels } from "./planUtils.js";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel,
  TableOfContents, Table, TableRow, TableCell, WidthType, BorderStyle,
  ExternalHyperlink, InternalHyperlink, Bookmark, FootnoteReferenceRun, ImageRun,
} from "docx";

// ─────────────────────────────────────────────
// Лістинги коду: розпізнавання ```-блоків і моношрифтовий рендер
// ─────────────────────────────────────────────
function isFenceLine(line) { return /^\s*```/.test(line || ""); }

// Підпис таблиці ("Таблиця 2.3 – Назва") відрізняється від речення аналізу, що
// теж починається з "Таблиця 2.3 ..." (напр. "Таблиця 2.3 наочно підтверджує...")
// тим, що одразу за ним (без порожніх рядків між ними) іде markdown-таблиця.
function isFollowedByTable(lines, index) {
  let j = index + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  return j < lines.length && /^\s*\|/.test(lines[j]);
}

function codeListingParagraphs(lines, methodInfo) {
  const fmt = methodInfo?.formatting || {};
  const font = fmt.codeFont || "Courier New";
  const fontSize = Math.round((fmt.codeFontSize || 10) * 2); // docx: half-points
  const spacingLine = Math.round((fmt.codeLineSpacing || 1.0) * 240);
  return lines.map(line => new Paragraph({
    alignment: AlignmentType.LEFT,
    indent: { firstLine: 0 },
    spacing: { line: spacingLine, lineRule: "auto", before: 0, after: 0 },
    children: [new TextRun({ text: line.replace(/\t/g, "    "), font, size: fontSize, color: "000000" })],
  }));
}

// Читає рядки з fence-блоком, починаючи з indexу, що вказує на відкриваючу ```.
// Повертає {codeLines, nextIndex} — nextIndex вказує на рядок ПІСЛЯ закриваючої ```.
function readFencedBlock(lines, startIndex) {
  let i = startIndex + 1;
  const codeLines = [];
  while (i < lines.length && !isFenceLine(lines[i])) { codeLines.push(lines[i]); i++; }
  if (i < lines.length) i++; // пропускаємо закриваючу ```
  return { codeLines, nextIndex: i };
}

const LISTING_CAPTION_RE = /^Лістинг\s+[А-ЯA-Z0-9]/i;

// ─────────────────────────────────────────────
// UML-діаграми: ```plantuml``` → PNG через api/render-diagram (Kroki)
// ─────────────────────────────────────────────
const PLANTUML_FENCE_RE = /^\s*```\s*plantuml\s*$/i;

function pngDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const CLIENT_IMAGE_MARKER_RE = /^\[КЛІЄНТ-ІЛЮСТРАЦІЯ:(\d+)\]$/;

function scaleToFit(width, height, maxW, maxH) {
  let w = width, h = height;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
  return { width: w, height: h };
}

// 7 см і 14 см у px при 96 dpi; альбомні (ширші за висоту) картинки обмежуємо 14×7 см,
// портретні — 7×14 см, щоб зображення не займали пів сторінки в "короткому" вимірі.
const CLIENT_IMG_SHORT_SIDE_PX = Math.round(7 * 96 / 2.54);
const CLIENT_IMG_LONG_SIDE_PX = Math.round(14 * 96 / 2.54);

function scaleClientImage(width, height) {
  const [maxW, maxH] = width >= height
    ? [CLIENT_IMG_LONG_SIDE_PX, CLIENT_IMG_SHORT_SIDE_PX]
    : [CLIENT_IMG_SHORT_SIDE_PX, CLIENT_IMG_LONG_SIDE_PX];
  return scaleToFit(width, height, maxW, maxH);
}

// docx завжди пакує вставлені зображення як .png (незалежно від реального формату), тож
// перекодовуємо клієнтське фото (jpeg/webp/gif) через canvas у PNG прямо перед вставкою в
// документ — і лише тоді, а не при завантаженні, щоб не зберігати подвійну копію у Firestore.
function clientImageToPng(ill, maxDim = 1200) {
  return new Promise(resolve => {
    if (!ill?.b64) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const pngB64 = canvas.toDataURL("image/png").split(",")[1];
        resolve({ data: b64ToBytes(pngB64), width: w, height: h });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `data:${ill.type || "image/png"};base64,${ill.b64}`;
  });
}

function resolveClientIllustrations(illustrations, maxDim) {
  return Promise.all((illustrations || []).map(ill => clientImageToPng(ill, maxDim)));
}

// Повносторінкові зображення (креслення в Додатках) масштабуємо під майже всю ширину сторінки,
// на відміну від невеликих inline-ілюстрацій (scaleClientImage) — 16×22 см максимум.
const DRAWING_MAX_W_PX = Math.round(16 * 96 / 2.54);
const DRAWING_MAX_H_PX = Math.round(22 * 96 / 2.54);

function scaleDrawingImage(width, height) {
  return scaleToFit(width, height, DRAWING_MAX_W_PX, DRAWING_MAX_H_PX);
}

export async function renderPlantUmlToPng(source) {
  try {
    const res = await fetch("/api/render-diagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await res.json();
    if (!data?.image) return null;
    const bin = atob(data.image);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const { width, height } = pngDimensions(bytes);
    const MAX_W = 450, MAX_H = 550;
    let w = width, h = height;
    if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
    if (h > MAX_H) { w = Math.round(w * MAX_H / h); h = MAX_H; }
    return { data: bytes, width: w, height: h };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Числові діаграми: markdown-таблиця з даними, за якою одразу йде підпис
// рисунка, → PNG-стовпчикова діаграма (Canvas 2D, без сторонніх бібліотек).
// ─────────────────────────────────────────────
const CHART_SERIES_COLORS = ["#3B6EA5", "#8FB3D6", "#1F3F5C", "#B8CFE3"];
const CHART_FONT = '"Times New Roman", Times, serif';

function parseChartNumber(raw) {
  const cleaned = String(raw ?? "").trim().replace(/\s+/g, "").replace(/%$/, "").replace(",", ".");
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

// Перший стовпець таблиці — підписи категорій, решта — числові ряди (за назвою
// стовпця в шапці). Повертає null, якщо в таблиці взагалі немає жодного числа —
// тоді таблиця лишається просто текстовою, без діаграми.
function parseChartTable(tableLines) {
  const dataLines = tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
  if (dataLines.length < 2) return null;
  const rows = dataLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
  const header = rows[0];
  if (header.length < 2) return null;
  const seriesNames = header.slice(1);
  const labels = [];
  const series = seriesNames.map(() => []);
  let hasValue = false;
  for (const row of rows.slice(1)) {
    labels.push(row[0] || "");
    for (let s = 0; s < seriesNames.length; s++) {
      const v = parseChartNumber(row[s + 1]);
      if (v !== null) hasValue = true;
      series[s].push(v ?? 0);
    }
  }
  return hasValue ? { labels, seriesNames, series } : null;
}

function niceChartMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function formatChartNum(v) {
  const r = Math.round(v * 100) / 100;
  const s = Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(".", ",");
}

// Малює просту стовпчикову діаграму на offscreen canvas, повертає PNG у тому ж
// форматі, що й renderPlantUmlToPng ({ data, width, height }). Розмір шрифту
// підписів категорій автоматично зменшується, а за потреби підписи повертаються
// під кутом — щоб вони не накладались одне на одне; вісь значень отримує запас
// зверху під підпис над стовпцем, а її ліве поле підганяється під ширину чисел.
// Підписи значень над стовпцями показуються лише для одного ряду даних — при
// кількох рядах замість них унизу малюється легенда (інакше цифри зіллються).
function renderChartFromParsed({ labels, seriesNames, series }) {
  const DPR = 2;
  const W = 620;
  // Виміри шрифтів не залежать від розміру canvas, тож спершу рахуємо їх на
  // тимчасовому canvas, щоб визначити фактичну висоту зображення (H) — і лише
  // потім створюємо canvas потрібного розміру. Це потрібно, бо повернуті під
  // кутом підписи категорій можуть займати різну висоту залежно від довжини
  // тексту, а фіксована висота призводила до накладання підписів на легенду.
  const measureCtx = document.createElement("canvas").getContext("2d");

  const INK = "#111111", GRID = "#e3e7ec", MUTED = "#6b7280";
  const n = labels.length;
  const seriesCount = seriesNames.length;
  const showValueLabels = seriesCount === 1;
  const showLegend = seriesCount > 1;
  const legendH = showLegend ? 26 : 0;

  const maxVal = Math.max(1e-9, ...series.flat());
  const niceMax = niceChartMax(maxVal * (showValueLabels ? 1.15 : 1.08));

  measureCtx.font = `11px ${CHART_FONT}`;
  const steps = 4;
  let maxTickW = 0;
  for (let i = 0; i <= steps; i++) {
    const w = measureCtx.measureText(formatChartNum((niceMax / steps) * i)).width;
    if (w > maxTickW) maxTickW = w;
  }
  const padL = Math.max(40, Math.round(maxTickW) + 16);
  const padR = 16;
  const padT = showValueLabels ? 32 : 18;
  const plotWidth = W - padL - padR;
  const slot = plotWidth / n;

  let labelFont = 13;
  const fitsHorizontal = (font) => {
    measureCtx.font = `${font}px ${CHART_FONT}`;
    return labels.every(l => measureCtx.measureText(l).width <= slot - 6);
  };
  while (labelFont > 9 && !fitsHorizontal(labelFont)) labelFont -= 1;
  const rotate = !fitsHorizontal(labelFont);
  if (rotate) labelFont = 12;

  // Кут повороту підписів — 36°; довгі підписи обрізаються з "…", щоб верти-
  // кальний відступ під них не ріс необмежено (інакше зображення виходило б
  // занадто витягнутим по висоті).
  const ROTATE_ANGLE = Math.PI / 5;
  let plotLabels = labels;
  let rotatedDrop = 0;
  if (rotate) {
    measureCtx.font = `${labelFont}px ${CHART_FONT}`;
    const maxDrop = 130;
    const maxLabelW = maxDrop / Math.sin(ROTATE_ANGLE);
    plotLabels = labels.map(l => {
      if (measureCtx.measureText(l).width <= maxLabelW) return l;
      let s = l;
      while (s.length > 1 && measureCtx.measureText(s + "…").width > maxLabelW) {
        s = s.slice(0, -1);
      }
      return s + "…";
    });
    rotatedDrop = Math.max(...plotLabels.map(l => measureCtx.measureText(l).width)) * Math.sin(ROTATE_ANGLE);
  }

  const padB = (rotate ? Math.ceil(rotatedDrop) + 20 : 28) + legendH;
  const plotT = padT;
  const minPlotH = 270;
  const H = plotT + minPlotH + padB;
  const plotB = H - padB;
  const plotH = plotB - plotT;

  const canvas = document.createElement("canvas");
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext("2d");
  ctx.scale(DPR, DPR);

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= steps; i++) {
    const val = (niceMax / steps) * i;
    const y = plotB - (val / niceMax) * plotH;
    ctx.font = `11px ${CHART_FONT}`;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotWidth, y);
    ctx.stroke();
    ctx.fillText(formatChartNum(val), padL - 8, y);
  }

  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(padL, plotB);
  ctx.lineTo(padL + plotWidth, plotB);
  ctx.stroke();

  const groupPad = 0.28;
  const groupW = slot * (1 - groupPad);
  const barGap = seriesCount > 1 ? 2 : 0;
  const barW = Math.max(2, (groupW - barGap * (seriesCount - 1)) / seriesCount);

  labels.forEach((label, i) => {
    const groupX = padL + slot * i + (slot - groupW) / 2;
    for (let s = 0; s < seriesCount; s++) {
      const v = series[s][i];
      const barH = (v / niceMax) * plotH;
      const x = groupX + s * (barW + barGap);
      const y = plotB - barH;
      ctx.fillStyle = CHART_SERIES_COLORS[s % CHART_SERIES_COLORS.length];
      ctx.fillRect(x, y, barW, barH);
      if (showValueLabels && barH > 1) {
        ctx.fillStyle = INK;
        ctx.font = `12px ${CHART_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(formatChartNum(v), x + barW / 2, Math.max(12, y - 6));
      }
    }
    ctx.fillStyle = INK;
    ctx.font = `${labelFont}px ${CHART_FONT}`;
    const cx = padL + slot * i + slot / 2;
    if (rotate) {
      ctx.save();
      ctx.translate(cx, plotB + 12);
      ctx.rotate(-ROTATE_ANGLE);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(plotLabels[i], 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, cx, plotB + 8);
    }
  });

  if (showLegend) {
    ctx.font = `12px ${CHART_FONT}`;
    ctx.textBaseline = "middle";
    const swatch = 10, gap = 18;
    const widths = seriesNames.map(nm => swatch + 6 + ctx.measureText(nm).width);
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (seriesNames.length - 1);
    let lx = padL + Math.max(0, (plotWidth - totalW) / 2);
    const ly = H - legendH / 2 - 6;
    seriesNames.forEach((nm, s) => {
      ctx.fillStyle = CHART_SERIES_COLORS[s % CHART_SERIES_COLORS.length];
      ctx.fillRect(lx, ly - swatch / 2, swatch, swatch);
      ctx.fillStyle = INK;
      ctx.textAlign = "left";
      ctx.fillText(nm, lx + swatch + 6, ly);
      lx += widths[s] + gap;
    });
  }

  const pngB64 = canvas.toDataURL("image/png").split(",")[1];
  const { width, height } = scaleToFit(W, H, 450, 320);
  return { data: b64ToBytes(pngB64), width, height };
}

// tableLines → PNG діаграми, або null якщо в таблиці немає жодного числа (тоді
// таблиця лишається як є, без діаграми — так само, як невдалий рендер PlantUML).
export function renderDataChartToPng(tableLines) {
  try {
    const parsed = parseChartTable(tableLines);
    if (!parsed) return null;
    return renderChartFromParsed(parsed);
  } catch {
    return null;
  }
}

// Заміняє кожен ```plantuml``` fence-блок на маркер \x00DIAGRAM<i>\x00 і рендерить
// відповідні PNG паралельно; таблицю з даними, за якою одразу йде підпис рисунка
// (${figWord} N – ...), замінює на автоматично намальовану діаграму (сама таблиця
// прибирається з тексту, щоб не дублювати ті самі дані таблицею й графіком одразу;
// якщо рендер графіка не вдався — таблиця лишається як фолбек). Викликається один
// раз для всього numberedContent.
async function resolveDiagrams(content, figWord) {
  const diagramImages = [];
  const jobs = [];
  const updated = { ...content };
  const fwRe = new RegExp("^" + figWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+\\d");
  for (const key of Object.keys(updated)) {
    const txt = updated[key];
    if (!txt) continue;
    const lines = txt.split("\n");
    const outLines = [];
    let changed = false;
    let i = 0;
    while (i < lines.length) {
      if (PLANTUML_FENCE_RE.test(lines[i])) {
        const { codeLines, nextIndex } = readFencedBlock(lines, i);
        const idx = diagramImages.length;
        diagramImages.push(null);
        jobs.push(renderPlantUmlToPng(codeLines.join("\n")).then(img => { diagramImages[idx] = img; }));
        outLines.push(`\x00DIAGRAM${idx}\x00`);
        i = nextIndex;
        changed = true;
        continue;
      }
      if (/^\s*\|/.test(lines[i])) {
        const tableLines = [];
        let j = i;
        while (j < lines.length && /^\s*\|/.test(lines[j])) { tableLines.push(lines[j]); j++; }
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        const img = (k < lines.length && fwRe.test(lines[k].trim())) ? renderDataChartToPng(tableLines) : undefined;
        if (img) {
          // Графік вдалося намалювати — таблицю-джерело не дублюємо текстом, лишаємо тільки картинку.
          const idx = diagramImages.length;
          diagramImages.push(img);
          outLines.push(`\x00DIAGRAM${idx}\x00`);
          changed = true;
        } else {
          outLines.push(...tableLines);
        }
        i = j;
        continue;
      }
      // Застарілий рядок-підказку (з уже згенерованого раніше вмісту) більше не показуємо —
      // тепер діаграма вставляється сама.
      if (/^⚠/.test(lines[i].trim())) { i++; changed = true; continue; }
      outLines.push(lines[i]);
      i++;
    }
    if (changed) updated[key] = outLines.join("\n");
  }
  await Promise.all(jobs);
  return { content: updated, diagramImages };
}

// ─────────────────────────────────────────────
// Перенумерація таблиць і рисунків
// ─────────────────────────────────────────────
export function renumberTablesAndFigures(content, displayOrder, lang) {
  const lc = getLangLabels(lang);
  const tw = lc.tableWord;
  const fw = lc.figWord;

  function getChapter(sec) {
    if (!sec?.id) return null;
    const m = sec.id.match(/^(\d+)/);
    return m ? m[1] : null;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  const chTableCount = {}, chFigCount = {};
  const secRenamings = {};

  for (const sec of displayOrder) {
    const txt = content[sec.id];
    if (!txt) continue;
    const ch = getChapter(sec);
    if (!ch) continue;
    chTableCount[ch] = chTableCount[ch] || 0;
    chFigCount[ch]   = chFigCount[ch]   || 0;
    secRenamings[sec.id] = [];

    let m;
    // Рахуємо лише справжні підписи таблиць (одразу за рядком іде markdown-таблиця),
    // а не речення аналізу, що теж починаються з "Таблиця X.Y" (напр. "Таблиця 2.3 наочно
    // підтверджує...") — інакше такі речення з'їдають номер і справжні підписи проскакують.
    const tableCapRe = new RegExp(`^${escRe(tw)}\\s+(\\d+\\.\\d+)`);
    const txtLines = txt.split("\n");
    for (let li = 0; li < txtLines.length; li++) {
      const cap = txtLines[li].match(tableCapRe);
      if (cap && isFollowedByTable(txtLines, li)) {
        chTableCount[ch]++;
        secRenamings[sec.id].push({ oldRef: cap[1], newRef: `${ch}.${chTableCount[ch]}`, type: "table" });
      }
    }
    const figRe = new RegExp(`^${escRe(fw)}\\s+(\\d+\\.\\d+)`, "gm");
    while ((m = figRe.exec(txt)) !== null) {
      chFigCount[ch]++;
      secRenamings[sec.id].push({ oldRef: m[1], newRef: `${ch}.${chFigCount[ch]}`, type: "fig" });
    }
  }

  const updated = { ...content };
  for (const sec of displayOrder) {
    let txt = content[sec.id];
    if (!txt) continue;
    const renamings = (secRenamings[sec.id] || []).filter(r => r.oldRef !== r.newRef);
    if (!renamings.length) continue;

    let tokI = 0;
    const tokMap = new Map();

    for (const { oldRef, newRef, type } of renamings) {
      const tok = `\x00T${tokI++}\x00`;
      tokMap.set(tok, newRef);
      if (type === "table") {
        txt = txt.replace(new RegExp(`(^${escRe(tw)}\\s+)${escRe(oldRef)}`, "m"), `$1${tok}`);
        if (tw === "Таблиця") {
          txt = txt.replace(new RegExp(`(Таблиц[яіюю]\\s+)${escRe(oldRef)}(?!\\d)`, "g"), `$1${tok}`);
        } else {
          txt = txt.replace(new RegExp(`(${escRe(tw)}\\s+)${escRe(oldRef)}(?!\\d)`, "gi"), `$1${tok}`);
        }
      } else {
        txt = txt.replace(new RegExp(`(^${escRe(fw)}\\s+)${escRe(oldRef)}`, "m"), `$1${tok}`);
        txt = txt.replace(new RegExp(`(${escRe(fw)}\\s+)${escRe(oldRef)}(?!\\d)`, "gi"), `$1${tok}`);
      }
    }

    for (const [tok, newRef] of tokMap) {
      txt = txt.replaceAll(tok, newRef);
    }
    updated[sec.id] = txt;
  }
  return updated;
}

// ─────────────────────────────────────────────
// Визначає код мови Word для перевірки правопису
// ─────────────────────────────────────────────
function getLangWordCode(lang) {
  const l = (lang || "").toLowerCase();
  if (/англ|english/.test(l)) return "en-US";
  if (/польськ|polish/.test(l)) return "pl-PL";
  if (/іспан|spanish|español/.test(l)) return "es-ES";
  if (/нім|german|deutsch/.test(l)) return "de-DE";
  if (/чеськ|czech/.test(l)) return "cs-CZ";
  if (/словацьк|slovak/.test(l)) return "sk-SK";
  if (/китайськ|chinese/.test(l)) return "zh-CN";
  return "uk-UA";
}

// ─────────────────────────────────────────────
// Визначає мову перевірки правопису за фактичним текстом документа
// (info.language — це заявлена мова роботи, вона не завжди збігається з
// реальною мовою згенерованого тексту, тому мову правопису беремо з тексту)
// ─────────────────────────────────────────────
export function detectTextLanguage(text, fallbackLang) {
  const sample = (text || "").slice(0, 8000);
  const letters = sample.match(/\p{L}/gu) || [];
  if (letters.length < 30) return getLangWordCode(fallbackLang);
  const cyrillic = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length;
  const cjk = letters.filter(c => /[一-鿿]/.test(c)).length;
  const latin = letters.filter(c => /[A-Za-z]/.test(c)).length;
  if (cjk / letters.length > 0.3) return "zh-CN";
  if (cyrillic >= latin) return "uk-UA";
  if (/[ąćęłńśźż]/i.test(sample)) return "pl-PL";
  if (/[ñáéíóúü¡¿]/i.test(sample)) return "es-ES";
  if (/[äöüß]/i.test(sample)) return "de-DE";
  if (/[řě]/i.test(sample)) return "cs-CZ";
  if (/[ľĺŕôňäť]/i.test(sample)) return "sk-SK";
  const fb = getLangWordCode(fallbackLang);
  return fb !== "uk-UA" ? fb : "en-US";
}

// ─────────────────────────────────────────────
// Word export (основний документ)
// ─────────────────────────────────────────────
export async function exportToDocx({ content, info, displayOrder, appendicesText, titlePage, titlePageLines, methodInfo, commentAnalysis, orderId, annotationUk, annotationEn, illustrations = [], clientDrawings = [], skipToc = false, keepHeadingCase = false, diaryArrivalDeparture = false, diaryBlankNotesPages = false, diaryStudentName = "" }) {
  const lc = getLangLabels(info?.language);
  const numberedContent = renumberTablesAndFigures(content, displayOrder, info?.language);
  Object.keys(numberedContent).forEach(k => { if (numberedContent[k]) numberedContent[k] = numberedContent[k].replace(/'/g, '\u2019'); });
  const langCode = detectTextLanguage(Object.values(numberedContent).join("\n\n"), info?.language);
  const normAppendices = appendicesText ? appendicesText.replace(/'/g, '\u2019') : appendicesText;
  const { content: diagramResolvedContent, diagramImages } = await resolveDiagrams(numberedContent, lc.figWord);
  Object.assign(numberedContent, diagramResolvedContent);
  const clientImages = await resolveClientIllustrations(illustrations);
  const drawingImages = await resolveClientIllustrations(clientDrawings, 1600);

  // \u2500\u2500 \u0412\u0438\u043d\u043e\u0441\u043a\u0438 (\u0414\u0421\u0422\u0423-\u0440\u0435\u0436\u0438\u043c): %%FN<n>%% \u0443 \u0442\u0435\u043a\u0441\u0442\u0456 \u2192 \u0440\u0435\u0430\u043b\u044c\u043d\u0430 Word-\u0432\u0438\u043d\u043e\u0441\u043a\u0430 \u2500\u2500
  // n \u2192 \u043f\u043e\u0432\u043d\u0438\u0439 \u0442\u0435\u043a\u0441\u0442 \u0434\u0436\u0435\u0440\u0435\u043b\u0430, \u0440\u043e\u0437\u043f\u0430\u0440\u0441\u0435\u043d\u0438\u0439 \u0437\u0456 \u0441\u043f\u0438\u0441\u043a\u0443 \u0434\u0436\u0435\u0440\u0435\u043b ("\u0421\u041f\u0418\u0421\u041e\u041a \u0412\u0418\u041a\u041e\u0420\u0418\u0421\u0422\u0410\u041d\u0418\u0425 \u0414\u0416\u0415\u0420\u0415\u041b").
  const footnoteTextByNum = {};
  const sourcesSec = displayOrder.find(s => s.type === "sources");
  if (sourcesSec && numberedContent[sourcesSec.id]) {
    numberedContent[sourcesSec.id].split("\n").forEach(line => {
      const cleaned = line.trim().replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      const m = cleaned.match(/^(\d+)[.)]\s*(.*)/);
      if (m) footnoteTextByNum[parseInt(m[1])] = m[2];
    });
  }
  const footnotesRegistry = {};
  let footnoteCounter = 0;

  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round((methodInfo?.formatting?.fontSize || 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  const twRe = new RegExp("^" + _escRe(lc.tableWord) + "\\s+\\d");
  const fwRe = new RegExp("^" + _escRe(lc.figWord) + "\\s+\\d");
  const figNumRe = new RegExp("^" + _escRe(lc.figWord) + "\\s+([\\d.]+)");
  // Номери рисунків, для яких у поточному підрозділі реально вставлено зображення (не текстова
  // заглушка) — щоб посилання на них у тексті малювалось чорним, а не помаранчевим "TODO".
  let resolvedFigNums = new Set();
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || commentAnalysis?.formattingHints?.margins || {};
  const toMm = v => (v != null && Number(v) > 0 ? Number(v) : null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;
  const LINE_SINGLE = 240;

  function cleanMarkdown(line) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  }
  function isDuplicateTitle(firstLine, secLabel) {
    if (!firstLine || !secLabel) return false;
    const a = cleanMarkdown(firstLine).toLowerCase().replace(/\s+/g, " ").trim();
    const b = secLabel.toLowerCase().replace(/\s+/g, " ").trim();
    if (a === b) return true;
    const numMatch = secLabel.match(/^(\d+\.\d+)/);
    if (numMatch && a.startsWith(numMatch[1])) return true;
    return false;
  }
  const FIG_INLINE_RE = /(?:рис(?:унок)?\.?\s*\d+(?:\.\d+)*|fig(?:ure)?\.?\s*\d+(?:\.\d+)*)/i;
  const FIG_INLINE_NUM_RE = /(?:рис(?:унок)?\.?|fig(?:ure)?\.?)\s*(\d+(?:\.\d+)*)/gi;
  function hasUnresolvedFigRef(text) {
    if (!FIG_INLINE_RE.test(text || "")) return false;
    FIG_INLINE_NUM_RE.lastIndex = 0;
    let m, any = false, allResolved = true;
    while ((m = FIG_INLINE_NUM_RE.exec(text)) !== null) {
      any = true;
      if (!resolvedFigNums.has(m[1])) allResolved = false;
    }
    return !(any && allResolved);
  }
  function parseTextWithCitations(text, color) {
    const CITE_RE = /\[(\d+)\]|%%FN(\d+)%%/g;
    const result = [];
    let lastIndex = 0;
    let match;
    while ((match = CITE_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE, color }));
      }
      if (match[2]) {
        footnoteCounter++;
        const fnText = footnoteTextByNum[Number(match[2])] || "";
        footnotesRegistry[footnoteCounter] = { children: [new Paragraph({ children: [new TextRun({ text: fnText, font: FONT, size: SIZE_NUM, color: "000000" })] })] };
        result.push(new TextRun({ children: [new FootnoteReferenceRun(footnoteCounter)], font: FONT, size: SIZE, color }));
      } else {
        result.push(new InternalHyperlink({
          anchor: `ref_${match[1]}`,
          children: [new TextRun({ text: match[0], font: FONT, size: SIZE, color: "000000" })],
        }));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE, color }));
    }
    return result.length ? result : [new TextRun({ text, font: FONT, size: SIZE, color })];
  }
  function bodyPara(text) {
    const color = hasUnresolvedFigRef(text) ? "B85C00" : "000000";
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text || "", color),
    });
  }
  function introBoldPara(text) {
    const STARTS = /^(Актуальн|Мет(?:ою|а\s)|Завдання|Для досягн|Для вирішен|Об.єкт|Предмет|Метод(?:и|ологічн)|Наукова новизна|Практична знач|Апробац|Структур|Теоретико|Матеріал|Хронологічн)/i;
    if (!STARTS.test(text)) return bodyPara(text);
    let boldEnd = -1;
    const colon = text.indexOf(':');
    if (colon > 0 && colon < 120) {
      boldEnd = colon + 1;
    } else {
      const dashIdx = text.indexOf(' – ') !== -1 ? text.indexOf(' – ') : text.indexOf(' — ');
      if (dashIdx > 0 && dashIdx < 80) {
        boldEnd = dashIdx + 2;
      } else {
        const dot = text.indexOf('.');
        if (dot > 0 && dot < 50) {
          boldEnd = dot + 1;
        } else {
          const єIdx = text.indexOf(' є ');
          if (єIdx > 0 && єIdx < 60) {
            boldEnd = єIdx + 2;
          } else {
            const полягIdx = text.indexOf(' полягає');
            if (полягIdx > 0 && полягIdx < 60) boldEnd = полягIdx;
            else {
              const становIdx = text.indexOf(' становлять');
              if (становIdx > 0 && становIdx < 70) boldEnd = становIdx;
            }
          }
        }
      }
    }
    if (boldEnd <= 0) return bodyPara(text);
    const boldPart = text.slice(0, boldEnd);
    const restPart = text.slice(boldEnd);
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [
        new TextRun({ text: boldPart, font: FONT, size: SIZE, bold: true, color: "000000" }),
        ...(restPart ? parseTextWithCitations(restPart, "000000") : []),
      ],
    });
  }
  function listPara(text) {
    return new Paragraph({
      indent: { left: INDENT, hanging: 360 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text, "000000"),
    });
  }
  function numberedListPara(text) {
    return new Paragraph({
      indent: { left: INDENT, hanging: 360 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text, "000000"),
    });
  }
  function heading1(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      children: [new TextRun({ text: keepHeadingCase ? text : text.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function headingSubsection(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH, indent: { firstLine: INDENT },
      children: [new TextRun({ text, font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function makeTableDocx(lines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const filteredLines = lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rawRows = filteredLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    const headerCount = rawRows[0]?.length || 0;
    // Якщо джерело розбило один рядок таблиці на кілька фізичних "|"-рядків
    // (клітинок менше, ніж у шапці), доклеюємо продовження до попереднього
    // рядка замість того, щоб рендерити його як окремий кривий рядок.
    const mergedRows = [];
    for (const cells of rawRows) {
      const prev = mergedRows[mergedRows.length - 1];
      if (prev && headerCount > 0 && cells.length < headerCount && prev.length < headerCount) {
        prev.push(...cells);
      } else {
        mergedRows.push(cells);
      }
    }
    const rows = mergedRows.map((cells, rowIndex) => {
      const isHeader = rowIndex === 0;
      return new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            borders: cellBorders,
            margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({
              alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
              children: [new TextRun({ text: cellText, font: FONT, size: SIZE_NUM, color: "000000", bold: isHeader && !!methodInfo?.formatting?.tableHeaderBold })],
            })],
          })
        ),
      });
    });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    });
  }

  function makeBlocks(text, secLabel, isIntro = false) {
    if (!text) return [];
    const result = [];
    const lines = text.split("\n");
    resolvedFigNums = new Set();
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].trim();
      const dm = t.startsWith("\x00DIAGRAM") && t.endsWith("\x00") ? t.slice(8, -1) : null;
      const cm = t.match(CLIENT_IMAGE_MARKER_RE);
      const hasImg = dm !== null ? !!diagramImages[Number(dm)] : (cm ? !!clientImages[Number(cm[1])] : false);
      if (!hasImg) continue;
      let j = k + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const capLine = j < lines.length ? lines[j].trim() : "";
      const numMatch = capLine.match(figNumRe);
      if (numMatch) resolvedFigNums.add(numMatch[1]);
    }
    let firstContentLine = true;
    let i = 0;
    let taskMode = false;
    let taskNum = 0;
    let lastWasDiagramTable = false;
    const TASK_HEADER_RE = /^(Завдання дослідження|Для досягнення мети|Для вирішення поставлених)/i;
    const INTRO_KEYWORD_RE = /^(Актуальн|Мета[\s.–—]|Метою|Завдання|Для досягн|Для вирішен|Об.єкт|Предмет|Метод(?:и|ологічн)|Наукова|Практична|Апробац|Структур|Теоретико|Матеріал|Хронологічн)/i;
    while (i < lines.length) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const diagMatch = trimmedLine.startsWith("\x00DIAGRAM") && trimmedLine.endsWith("\x00")
        ? trimmedLine.slice(8, -1)
        : null;
      if (diagMatch !== null) {
        const img = diagramImages[Number(diagMatch)];
        if (img) {
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } })],
          }));
          lastWasDiagramTable = true;
        } else {
          lastWasDiagramTable = false;
        }
        i++;
        continue;
      }
      const clientImgMatch = trimmedLine.match(CLIENT_IMAGE_MARKER_RE);
      if (clientImgMatch) {
        const img = clientImages[Number(clientImgMatch[1])];
        if (img) {
          const { width, height } = scaleClientImage(img.width, img.height);
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width, height } })],
          }));
          lastWasDiagramTable = true;
        } else {
          lastWasDiagramTable = false;
        }
        i++;
        continue;
      }
      if (isFenceLine(line)) {
        const { codeLines, nextIndex } = readFencedBlock(lines, i);
        result.push(...codeListingParagraphs(codeLines, methodInfo));
        result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        i = nextIndex;
        continue;
      }
      if (/^\s*\|/.test(line)) {
        const tableLines = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        lastWasDiagramTable = false;
        if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
          result.push(makeTableDocx(tableLines));
          result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        }
        continue;
      }
      if (twRe.test(line.trim()) && isFollowedByTable(lines, i)) {
        const fmt = methodInfo?.formatting || {};
        const tf = fmt.tableFormat || "";
        const tAlignRight = fmt.tableNumberRight ?? /правий|right|справа|верхн.*кут/i.test(tf);
        const tCenter    = fmt.tableTitleCenter ?? /по\s*центру.*назв|назв.*по\s*центру|центр/i.test(tf);
        const tBold      = fmt.tableTitleBold   ?? /жирн|bold/i.test(tf);
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const tAlign = tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH;
        const dashIdx = line.search(/ [–\-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = line.trim().substring(0, dashIdx).trim();
          const namePart = line.trim().substring(dashIdx + 3).trim();
          result.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, color: "000000" })],
          }));
        } else {
          result.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        i++;
        continue;
      }
      if (fwRe.test(line.trim())) {
        const ff = methodInfo?.formatting?.figureFormat || "";
        const fBold = /жирн|bold/i.test(ff);
        const fItalic = /курсив|italic/i.test(ff);
        const isResolved = lastWasDiagramTable;
        lastWasDiagramTable = false;
        result.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: fBold, italics: fItalic, color: isResolved ? "000000" : "B85C00" })],
        }));
        i++;
        continue;
      }
      const isHyphenList = /^[-*]\s+/.test(line.trim());
      const isNumberedList = /^\s*\d+[.)]\s+/.test(line);
      const numMatchRaw = isNumberedList ? line.trim().match(/^(\d+[.)]\s*)(.*)/) : null;
      const raw = cleanMarkdown(line);
      if (!raw) { i++; continue; }
      if (isIntro) {
        if (TASK_HEADER_RE.test(raw)) {
          taskMode = true;
          taskNum = 0;
        } else if (taskMode && INTRO_KEYWORD_RE.test(raw)) {
          taskMode = false;
        }
      }
      if (firstContentLine && isDuplicateTitle(line, secLabel)) { firstContentLine = false; i++; continue; }
      firstContentLine = false;
      if (/^[–—]\s/.test(raw) || isHyphenList) {
        const listText = /^[–—]\s/.test(raw) ? raw : `– ${raw}`;
        result.push(listPara(listText));
        i++; continue;
      }
      if (isNumberedList && numMatchRaw) {
        if (taskMode) taskNum++;
        const numPrefix = numMatchRaw[1].trimEnd();
        const numBody = cleanMarkdown(numMatchRaw[2] || "");
        result.push(numberedListPara(`${numPrefix} ${numBody}`));
        i++; continue;
      }
      if (isIntro && taskMode && !TASK_HEADER_RE.test(raw)) {
        taskNum++;
        result.push(numberedListPara(`${taskNum}. ${raw}`));
        i++; continue;
      }
      lastWasDiagramTable = false;
      result.push(isIntro ? introBoldPara(raw) : bodyPara(raw));
      i++;
    }
    return result;
  }

  function sourceParaChildren(text) {
    const URL_RE = /(https?:\/\/[^\s]+)/;
    const parts = text.split(URL_RE);
    return parts.flatMap(part => {
      if (URL_RE.test(part)) {
        const cleanUrl = part.replace(/[.,;:!?)]+$/, '');
        const tail = part.slice(cleanUrl.length);
        const link = new ExternalHyperlink({
          link: cleanUrl,
          children: [new TextRun({ text: cleanUrl, font: FONT, size: SIZE, color: "0563C1", underline: {} })],
        });
        return tail ? [link, new TextRun({ text: tail, font: FONT, size: SIZE, color: "000000" })] : [link];
      }
      // Парсимо *курсив* всередині звичайного тексту
      const runs = [];
      const italicRe = /\*([^*]+)\*/g;
      let last = 0, m;
      while ((m = italicRe.exec(part)) !== null) {
        if (m.index > last) runs.push(new TextRun({ text: part.slice(last, m.index), font: FONT, size: SIZE, color: "000000" }));
        runs.push(new TextRun({ text: m[1], font: FONT, size: SIZE, color: "000000", italics: true }));
        last = m.index + m[0].length;
      }
      if (last < part.length) runs.push(new TextRun({ text: part.slice(last), font: FONT, size: SIZE, color: "000000" }));
      return runs;
    });
  }
  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children: sourceParaChildren(cleaned),
    });
  }
  function sourceParaWithBookmark(text, refNum) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    const numMatch = cleaned.match(/^(\d+[\.\)]\s*)/);
    let children;
    if (numMatch) {
      const prefix = numMatch[1];
      const rest = cleaned.slice(prefix.length);
      children = [
        new Bookmark({
          id: `ref_${refNum}`,
          children: [new TextRun({ text: prefix, font: FONT, size: SIZE, color: "000000" })],
        }),
        ...sourceParaChildren(rest),
      ];
    } else {
      children = sourceParaChildren(cleaned);
    }
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children,
    });
  }

  const children = [];

  const alignMap = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
  const topicStr = info?.topic || "";
  const currentYear = new Date().getFullYear().toString();
  const practiceFieldMap = {
    "[ПІБ]": info?.studentName,
    "[ГРУПА]": info?.studentGroup,
    "[КУРС]": info?.course,
    "[БАЗА_ПРАКТИКИ]": info?.companyName,
    "[КЕРІВНИК_ПІДПРИЄМСТВА]": info?.supervisorCompany,
    "[КЕРІВНИК_КАФЕДРИ]": info?.supervisorUniversity,
    "[ДАТА_ПОЧАТКУ]": info?.dateStart,
    "[ДАТА_КІНЦЯ]": info?.dateEnd,
    // Узагальнені токени титулки (не лише практика) — методичка іноді наводить у Додатках
    // уже ЗАПОВНЕНИЙ приклад титулки (чуже ім'я/кафедра), і крок читання методички заміняє
    // такі конкретні значення на ці токени, щоб вони не потрапили в роботу клієнта як є.
    // Дані беруться з аналізу тексту замовлення (buildTemplateAnalysisPrompt) — якщо клієнт
    // їх явно не вказав, лишається видимий плейсхолдер "___________", який треба вручну
    // заповнити на кроці "Готово".
    "[ФАКУЛЬТЕТ]": info?.faculty,
    "[КАФЕДРА]": info?.department,
    "[КЕРІВНИК]": info?.supervisorUniversity,
  };
  const applyTopic = (t) => {
    let s = topicStr ? t.replace(/\[ТЕМА\]/g, topicStr) : t;
    if (topicStr) {
      s = s.replace(/(Тема\s*[:：]\s*«\s*)([_\s]*)(\s*»)/g, `$1${topicStr}$3`);
      s = s.replace(/\(найменування\s+теми\)/gi, topicStr);
      s = s.replace(/\(назва\s+теми\)/gi, topicStr);
    }
    s = s.replace(/\[РІК\]/g, currentYear).replace(/\[ДАТА\]/g, currentYear);
    s = s.replace(/(?<![/\d])20\d{2}(?![/\d])/g, currentYear);
    for (const [token, value] of Object.entries(practiceFieldMap)) {
      if (s.includes(token)) s = s.split(token).join(value || "___________________");
    }
    return s;
  };
  const RIGHT_LINE_RE = /^(Група|Курс|ПІБ\s+студента|ПІБ\s+керівника)\s*:/i;
  const buildDefaultTitlePageLines = () => [
    { text: "МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ", align: "center", bold: true },
    { text: info?.university || "[Назва університету]", align: "center" },
    ...(info?.faculty ? [{ text: info.faculty, align: "center" }] : []),
    ...(info?.department ? [{ text: `Кафедра ${info.department}`, align: "center" }] : []),
    { text: "", align: "center", spaceBefore: 960 },
    { text: (info?.type || "КУРСОВА РОБОТА").toUpperCase(), align: "center", bold: true },
    ...(info?.subject ? [{ text: `з дисципліни: ${info.subject}`, align: "center" }] : []),
    { text: `на тему: «${topicStr || "[тема]"}»`, align: "center" },
    { text: "", align: "center", spaceBefore: 2880 },
    { text: `Група: ${info?.studentGroup || "___________"}`, align: "right" },
    { text: `Курс: ${info?.course || "___________"}`, align: "right" },
    { text: `ПІБ студента: ${info?.studentName || "___________"}`, align: "right" },
    { text: `ПІБ керівника: ${info?.supervisorUniversity || "___________"}`, align: "right" },
    { text: "", align: "center", spaceBefore: 3840 },
    { text: info?.city ? `${info.city} – ${currentYear}` : currentYear, align: "center" },
  ];
  // Компенсує найбільший (типово останній, перед "Місто – Рік") spaceBefore титулки так, щоб
  // сума висот усіх рядків точно дорівнювала висоті сторінки — незалежно від того, скільки
  // фізичних рядків реально займуть довга тема роботи чи довге ПІБ. Без цього нижній блок
  // зсувається на фіксовану "оцінку на око" ШІ/дефолту й титулка або не дотягує до низу
  // сторінки, або переливається на другу.
  function autoFitTitlePageLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return lines;

    const contentWidth = 11906 - L - R;
    const pageContentHeight = 16838 - T - B;
    const lineHeightTwips = fontSizeHalfPt => Math.round((fontSizeHalfPt / 2) * 1.15 * 20);
    const estimateLineCount = (text, fontSizeHalfPt) => {
      if (!text) return 1;
      const avgCharWidth = (fontSizeHalfPt / 2) * 20 * 0.5; // приблизна середня ширина символу ~0.5em
      const charsPerLine = Math.max(1, Math.floor(contentWidth / avgCharWidth));
      return Math.max(1, Math.ceil(text.length / charsPerLine));
    };

    // Порожні рядки-заповнювачі (без тексту) — це так само вертикальний проміжок, як і
    // spaceBefore, просто закодований AI по-іншому (кілька порожніх абзаців підряд замість
    // одного числа-відступу). Якщо їх не звести до spaceBefore тут, масштабування нижче їх
    // не бачить — вони лишаються "незгортними" рядками фіксованої висоти і можуть самі по
    // собі виштовхнути титулку на другу сторінку. Тому зливаємо кожен прогін порожніх рядків
    // у spaceBefore наступного змістовного рядка — весь "повітряний" простір потрапляє під
    // однакове подальше масштабування, незалежно від того, як саме AI його закодував.
    const normalized = [];
    let pendingGap = 0;
    for (const item of lines) {
      if (!item.text || !item.text.trim()) {
        pendingGap += (item.spaceBefore || 0) + lineHeightTwips(item.fontSize ? item.fontSize * 2 : SIZE);
        continue;
      }
      normalized.push({ ...item, spaceBefore: (item.spaceBefore || 0) + pendingGap });
      pendingGap = 0;
    }
    if (pendingGap && normalized.length) {
      normalized.push({ text: "", align: "center", spaceBefore: pendingGap });
    }
    if (!normalized.length) return lines;

    // Замість підганяння ОДНОГО "гнучкого" рядка (AI все одно вгадує абсолютні twips
    // на око, дивлячись на зразок, і легко помиляється) масштабуємо ВСІ задані відступи
    // одним спільним коефіцієнтом. Це зберігає їхні відносні пропорції зі зразка методички
    // (який проміжок був більшим/меншим за інший — той самий ритм лишається), і водночас
    // гарантує, що сума точно влізе на сторінку — незалежно від того, наскільки AI
    // помилився з абсолютними числами чи наскільки тема/ПІБ студента довші/коротші за
    // приклад у методичці.
    const gapSum = normalized.reduce((sum, item) => sum + (item.spaceBefore || 0), 0);
    if (gapSum <= 0) return normalized;

    const textHeight = normalized.reduce((sum, item) => {
      const fs = item.fontSize ? item.fontSize * 2 : SIZE;
      return sum + estimateLineCount(item.text, fs) * lineHeightTwips(fs);
    }, 0);

    // estimateLineCount — груба оцінка (середня ширина символу ~0.5em), тому може трохи
    // недооцінити реальний обгорнутий рядок (напр. довгу тему в лапках) — SAFETY_BUFFER
    // залишає запас ~одного рядка висоти, щоб неточність оцінки не зіштовхувала останній
    // рядок (місто — рік) на другу сторінку.
    const SAFETY_BUFFER = 300;
    const availableGapBudget = Math.max(0, pageContentHeight - textHeight - SAFETY_BUFFER);
    const scale = availableGapBudget / gapSum;
    return normalized.map(item =>
      item.spaceBefore ? { ...item, spaceBefore: Math.round(item.spaceBefore * scale) } : item);
  }

  const resolvedLines = autoFitTitlePageLines(titlePageLines?.length
    ? titlePageLines.map(item => ({ ...item, text: applyTopic(item.text) }))
    : (titlePage?.trim()
      ? titlePage.split("\n").map(text => ({ text: applyTopic(text), align: RIGHT_LINE_RE.test(text.trim()) ? "right" : "center" }))
      : buildDefaultTitlePageLines()));
  if (resolvedLines) {
    resolvedLines.forEach((item, idx) => {
      const itemSize = item.fontSize ? item.fontSize * 2 : SIZE;
      const spaceBefore = item.spaceBefore != null ? item.spaceBefore : 0;
      children.push(new Paragraph({
        alignment: alignMap[item.align] || AlignmentType.CENTER,
        spacing: { line: LINE_SINGLE, lineRule: "auto", before: spaceBefore, after: 0 },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: item.text, font: FONT, size: itemSize, bold: !!item.bold, color: "000000" })],
      }));
    });
  } else {
    children.push(new Paragraph({ spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
  }

  // ── Завдання на курсову/кваліфікаційну роботу (якщо знайдено у зразку/методичці), окрема сторінка ──
  const hasTaskSheet = Array.isArray(methodInfo?.taskSheetTemplate) && methodInfo.taskSheetTemplate.length > 0;
  if (hasTaskSheet) {
    methodInfo.taskSheetTemplate.forEach((item, idx) => {
      const itemSize = item.fontSize ? item.fontSize * 2 : SIZE;
      children.push(new Paragraph({
        pageBreakBefore: idx === 0,
        alignment: alignMap[item.align] || AlignmentType.CENTER,
        spacing: { line: LINE_SINGLE, lineRule: "auto", before: item.spaceBefore || 0, after: 0 },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: applyTopic(item.text), font: FONT, size: itemSize, bold: !!item.bold, color: "000000" })],
      }));
    });
  }

  // ── Календарний план виконання роботи (якщо знайдено) — продовжує сторінку завдання, або власна сторінка ──
  const calendarPlanLines = methodInfo?.calendarPlanTable?.trim()
    ? methodInfo.calendarPlanTable.split("\n").map(applyTopic).filter(l => /^\s*\|/.test(l))
    : [];
  if (calendarPlanLines.length) {
    children.push(new Paragraph({
      pageBreakBefore: !hasTaskSheet,
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE_SINGLE, lineRule: "auto", before: 240, after: 120 },
      children: [new TextRun({ text: "КАЛЕНДАРНИЙ ПЛАН", font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    children.push(makeTableDocx(calendarPlanLines));
    children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
  }

  // ── Анотація (укр + англ), кожна мова — окрема сторінка, перед змістом ──
  [annotationUk, annotationEn].filter(a => a?.trim()).forEach(annotationText => {
    let isFirstLine = true;
    annotationText.replace(/'/g, '’').split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const isHeading = isFirstLine && /^(АНОТАЦІЯ|РЕФЕРАТ|ABSTRACT)$/i.test(trimmed);
      children.push(new Paragraph({
        pageBreakBefore: isFirstLine,
        alignment: isHeading ? AlignmentType.CENTER : AlignmentType.BOTH,
        indent: isHeading ? { firstLine: 0 } : { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        children: [new TextRun({ text: trimmed, font: FONT, size: SIZE, bold: isHeading, color: "000000" })],
      }));
      if (isHeading) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
      isFirstLine = false;
    });
  });

  if (!skipToc) {
    children.push(new Paragraph({
      pageBreakBefore: true,
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE_SINGLE, lineRule: "auto", before: 0, after: LINE_SINGLE * 2 },
      children: [new TextRun({ text: lc.toc, font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    children.push(new TableOfContents(lc.toc, {
      hyperlink: true,
      headingStyleRange: "1-2",
    }));
    children.push(new Paragraph({
      spacing: { line: LINE_SINGLE, lineRule: "auto", before: 0, after: 0 },
      children: [],
    }));
  }

  let lastChapter = null;
  let firstMainSec = true;

  for (let i = 0; i < displayOrder.length; i++) {
    const sec = displayOrder[i]; const txt = numberedContent[sec.id];
    if (!txt) continue;
    const isMain = !["intro", "conclusions", "sources"].includes(sec.type);
    const isChapterConc = sec.type === "chapter_conclusion";
    const isSubsection = isMain && (/^\d+\.\d+/.test(sec.id) || isChapterConc);
    const thisChapter = isSubsection ? sec.id.split(".")[0] : null;

    let needsPageBreak = true;
    if (firstMainSec) { needsPageBreak = true; firstMainSec = false; }
    else if (isSubsection) {
      const prevSec = displayOrder.slice(0, i).reverse().find(s => numberedContent[s.id]);
      const prevIsSubsection = prevSec && !["intro", "conclusions", "sources"].includes(prevSec.type) && (/^\d+\.\d+/.test(prevSec.id || "") || prevSec.type === "chapter_conclusion");
      needsPageBreak = !prevIsSubsection || thisChapter !== prevSec?.id?.split(".")?.[0];
    }
    if (needsPageBreak) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));

    if (sec.type === "sources") {
      children.push(heading1(sec.label));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      txt.split("\n").forEach(line => {
        const cleaned = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
        const numMatch = cleaned.match(/^(\d+)[\.\)]/);
        if (numMatch) {
          const p = sourceParaWithBookmark(line, parseInt(numMatch[1]));
          if (p) children.push(p);
        } else {
          const p = sourcePara(line);
          if (p) children.push(p);
        }
      });
      continue;
    }

    if (!isSubsection) {
      children.push(heading1(sec.label));
      if (sec.type === "intro" || sec.type === "conclusions" || (isMain && !isSubsection)) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
    } else {
      if (thisChapter !== lastChapter) {
        lastChapter = thisChapter;
        const rawTitle = sec.sectionTitle || `${lc.chapterWord} ${thisChapter}`;
        const CHAPTER_PREFIX_RE = /^(РОЗДІЛ|CHAPTER|ROZDZIAŁ|CAP[IÍ]TULO|CAPITULO|KAPITEL|KAPITOLA|第)/i;
        const alreadyHasPrefix = CHAPTER_PREFIX_RE.test(rawTitle.trim());
        const chapterLabel = alreadyHasPrefix ? rawTitle.trim() : `${lc.chapterWord} ${thisChapter}. ${rawTitle}`;
        children.push(heading1(chapterLabel));
      }
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      children.push(headingSubsection(sec.label));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
    }
    let processedTxt = txt;
    if (isChapterConc) {
      // Стрипаємо перший рядок якщо AI дублює назву "Висновки до розділу N" (з markdown-заголовком або без)
      processedTxt = txt
        .replace(/^\s*#{1,6}\s+[^\n]*\n?/, "")
        .replace(/^\s*(?:висновк[^\s]*\s+до\s+|wnioski\s+do\s+|conclusiones\s+(?:del|al)\s+|závěry\s+ke\s+|závery\s+ku\s+|schlussfolgerungen\s+zu\s+)[^\n]*\n?/i, "")
        .trimStart();
    } else if (isMain && !isSubsection) {
      // Стрипаємо перший рядок якщо AI дублює заголовок розділу (РОЗДІЛ N. або # Назва)
      processedTxt = txt
        .replace(/^\s*(?:#{1,6}\s*)?розділ\s+\d+[^\n]*\n?/i, "")
        .replace(/^\s*#{1,6}\s+[^\n]*\n?/, "")
        .trimStart();
    }
    children.push(...makeBlocks(processedTxt, sec.label, sec.type === "intro"));
  }

  if (normAppendices && normAppendices.trim()) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(heading1(lc.appendixWord));
    const appLines = normAppendices.split("\n");
    let ai = 0;
    const fmt = methodInfo?.formatting || {};
    const tf = fmt.tableFormat || "";
    const tAlignRight = fmt.tableNumberRight ?? /правий|right|справа|верхн.*кут/i.test(tf);
    const tCenter    = fmt.tableTitleCenter ?? /по\s*центру.*назв|назв.*по\s*центру|центр/i.test(tf);
    const tBold      = fmt.tableTitleBold   ?? /жирн|bold/i.test(tf);
    while (ai < appLines.length) {
      const line = appLines[ai];
      if (isFenceLine(line)) {
        const { codeLines, nextIndex } = readFencedBlock(appLines, ai);
        children.push(...codeListingParagraphs(codeLines, methodInfo));
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        ai = nextIndex;
        continue;
      }
      if (/^\s*\|/.test(line)) {
        const tableLines = [];
        while (ai < appLines.length && /^\s*\|/.test(appLines[ai])) { tableLines.push(appLines[ai]); ai++; }
        if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
          children.push(makeTableDocx(tableLines));
          children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        }
        continue;
      }
      const raw = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
      if (!raw) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        ai++; continue;
      }
      if (LISTING_CAPTION_RE.test(raw)) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
        ai++; continue;
      }
      if (/^ДОДАТОК\s+[А-ЯA-Z]/i.test(raw)) {
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
          children: [new TextRun({ text: raw.toUpperCase(), font: FONT, size: SIZE, bold: false, color: "000000" })],
        }));
        ai++; continue;
      }
      if (/^Таблиця\s+\w/.test(raw) || /^Tabelle\s+\w/i.test(raw) || /^Table\s+\w/i.test(raw)) {
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const dashIdx = raw.search(/ [–\-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = raw.substring(0, dashIdx).trim();
          const namePart = raw.substring(dashIdx + 3).trim();
          children.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: true, color: "000000" })],
          }));
        } else {
          children.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        ai++; continue;
      }
      children.push(new Paragraph({
        indent: { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
      }));
      ai++;
    }
  }

  // Реальні креслення клієнта — вставляються програмно як окремі додатки в кінці, без згадки в тілі тексту.
  if (drawingImages.some(Boolean)) {
    if (!(normAppendices && normAppendices.trim())) {
      children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
      children.push(heading1(lc.appendixWord));
    }
    const abc = lc.appendixLetters || [];
    const usedLetters = new Set();
    const letterRe = /ДОДАТОК\s+([А-ЯA-Z])/gi;
    let lm;
    while ((lm = letterRe.exec(normAppendices || "")) !== null) usedLetters.add(lm[1].toUpperCase());
    let letterIdx = abc.findIndex(l => !usedLetters.has(l));
    if (letterIdx === -1) letterIdx = Math.max(abc.length - 1, 0);
    clientDrawings.forEach((drawing, idx) => {
      const img = drawingImages[idx];
      if (!img) return;
      const letter = abc[letterIdx] || String(letterIdx + 1);
      letterIdx++;
      const { width, height } = scaleDrawingImage(img.width, img.height);
      children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
      children.push(new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE / 2) },
        children: [new TextRun({ text: `ДОДАТОК ${letter}`, font: FONT, size: SIZE, color: "000000" })],
      }));
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE / 2) },
        children: [new TextRun({ text: `Креслення — ${drawing.name}`, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        children: [new ImageRun({ data: img.data, transformation: { width, height } })],
      }));
    });
  }

  // ── Щоденник практики: статичні канцелярські додатки (з методички, без участі ШІ) ──
  if (diaryArrivalDeparture) {
    const plainLine = (text, opts = {}) => new Paragraph({
      alignment: AlignmentType.LEFT,
      indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0, ...opts.spacing },
      children: [new TextRun({ text, font: FONT, size: opts.size || SIZE, bold: !!opts.bold, color: "000000" })],
    });
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(plainLine(`Здобувач вищої освіти ${diaryStudentName || "___________________________"}`));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      children: [new TextRun({ text: "(прізвище, ім’я, по батькові)", font: FONT, size: SIZE_NUM, color: "000000" })],
    }));
    children.push(plainLine("прибув на підприємство ___________________________ практику закінчено з оцінкою ___________"));
    children.push(plainLine("МП                                                                              «___» _____________ 20__ року"));
    children.push(plainLine("_________________     (посада, прізвище та ініціали відповідальної особи)", { spacing: { after: LINE } }));
    children.push(plainLine("Вибув з підприємства", { bold: true }));
    children.push(plainLine("МП                                                                              «___» _____________ 20__ року"));
    children.push(plainLine("_________________     (посада, прізвище та ініціали відповідальної особи)"));
  }

  if (diaryBlankNotesPages) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      children: [new TextRun({ text: "Робочі записи під час практики", font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    for (let i = 0; i < 28; i++) {
      children.push(new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 260 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000", space: 1 } },
        children: [new TextRun({ text: "", font: FONT, size: SIZE })],
      }));
    }
  }

  const doc = new Document({
    features: { updateFields: true },
    styles: {
      default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, alignment: AlignmentType.CENTER, indent: { firstLine: 0 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, alignment: AlignmentType.BOTH, indent: { firstLine: INDENT } } },
        { id: "TOC1", name: "TOC 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, indent: { firstLine: 0 } } },
        { id: "TOC2", name: "TOC 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, indent: { firstLine: 0 } } },
      ],
    },
    footnotes: footnoteCounter > 0 ? footnotesRegistry : undefined,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1, titlePage: true },
      headers: {
        first: new Header({ children: [] }),
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }),
      },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const prefix = info?.orderNumber ? info.orderNumber + "_" : (orderId ? orderId + "_" : "");
    const safeName = prefix + (info?.topic || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + ".docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Export plan to docx
// ─────────────────────────────────────────────
export async function exportPlanToDocx({ sections, info, methodInfo }) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round((methodInfo?.formatting?.fontSize || 14) * 2);
  const LINE = 360, INDENT = 709;
  const langCode = detectTextLanguage(sections.map(s => `${s.label || ""} ${s.sectionTitle || ""}`).join(" "), info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => (v != null && Number(v) > 0 ? Number(v) : null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);

  const intro = sections.find(s => s.type === "intro");
  const concs = sections.find(s => s.type === "conclusions");
  const srcs = sections.find(s => s.type === "sources");
  const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));

  const children = [];
  if (info?.topic) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE * 2 },
      children: [new TextRun({ text: info.topic, font: FONT, size: SIZE, color: "000000" })],
    }));
  }

  const groups = {};
  for (const s of main) { const top = s.id.split(".")[0]; if (!groups[top]) groups[top] = []; groups[top].push(s); }

  if (intro) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "ВСТУП", font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  for (const [num, items] of Object.entries(groups)) {
    const rawTitle = items[0].sectionTitle || `РОЗДІЛ ${num}`;
    const alreadyHasPrefix = rawTitle.trim().toUpperCase().startsWith(`РОЗДІЛ ${num}`);
    const secLabel = alreadyHasPrefix ? rawTitle.trim() : `РОЗДІЛ ${num}. ${rawTitle}`;
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: secLabel, font: FONT, size: SIZE, bold: true, color: "000000" })] }));
    for (const s of items) {
      if (/^\d+\.\d+/.test(s.id)) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE / 2), after: 0 }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT }, children: [new TextRun({ text: s.label, font: FONT, size: SIZE, color: "000000" })] }));
      }
    }
    const chapConc = sections.find(s => s.type === "chapter_conclusion" && s.id === `${num}.conclusions`);
    if (chapConc) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE / 2), after: 0 }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT }, children: [new TextRun({ text: chapConc.label, font: FONT, size: SIZE, color: "000000" })] }));
    }
  }
  if (concs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "ВИСНОВКИ", font: FONT, size: SIZE, bold: true, color: "000000" })] }));
  if (srcs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } } }, children }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const prefix = info?.orderNumber ? info.orderNumber + "_" : "";
    const safeName = prefix + ("план_" + (info?.topic || "робота")).replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + ".docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Export practice report plan to docx (flat id/label shape, no `type` field)
// ─────────────────────────────────────────────
export async function exportPracticePlanToDocx({ sections, info, methodInfo }) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round((methodInfo?.formatting?.fontSize || 14) * 2);
  const LINE = 360, INDENT = 709;
  const langCode = detectTextLanguage(sections.map(s => `${s.label || ""} ${s.sectionTitle || ""}`).join(" "), info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => (v != null && Number(v) > 0 ? Number(v) : null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);

  const FIXED = ["intro", "conclusions", "sources"];
  const children = [];
  if (info?.topic) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE * 2 },
      children: [new TextRun({ text: info.topic, font: FONT, size: SIZE, color: "000000" })],
    }));
  }
  let lastChapterTitle = null;
  for (const s of sections) {
    const isSub = !FIXED.includes(s.id) && /^\d+\.\d+/.test(String(s.id));
    if (isSub && s.sectionTitle && s.sectionTitle !== lastChapterTitle) {
      lastChapterTitle = s.sectionTitle;
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.LEFT,
        indent: { firstLine: 0 },
        children: [new TextRun({ text: s.sectionTitle, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
    } else if (!isSub) {
      lastChapterTitle = null;
    }
    children.push(new Paragraph({
      heading: isSub ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
      spacing: { line: LINE, lineRule: "auto", before: isSub ? Math.round(LINE / 2) : LINE, after: isSub ? 0 : Math.round(LINE / 2) },
      alignment: AlignmentType.LEFT,
      indent: { firstLine: isSub ? INDENT : 0 },
      children: [new TextRun({ text: s.label, font: FONT, size: SIZE, bold: !isSub, color: "000000" })],
    }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } } }, children }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const prefix = info?.orderNumber ? info.orderNumber + "_" : "";
    const safeName = prefix + ("план_" + (info?.topic || "звіт")).replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + ".docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Додатки (.docx)
// ─────────────────────────────────────────────
export async function exportAppendixToDocx(text, info, methodInfo, orderId) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round((methodInfo?.formatting?.fontSize || 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  const langCode = detectTextLanguage(text, info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => (v != null && Number(v) > 0 ? Number(v) : null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;

  function cleanMarkdown(line) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  }
  function makeTableDocx(lines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const filteredLines = lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rawRows = filteredLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    const headerCount = rawRows[0]?.length || 0;
    // Якщо джерело розбило один рядок таблиці на кілька фізичних "|"-рядків
    // (клітинок менше, ніж у шапці), доклеюємо продовження до попереднього
    // рядка замість того, щоб рендерити його як окремий кривий рядок.
    const mergedRows = [];
    for (const cells of rawRows) {
      const prev = mergedRows[mergedRows.length - 1];
      if (prev && headerCount > 0 && cells.length < headerCount && prev.length < headerCount) {
        prev.push(...cells);
      } else {
        mergedRows.push(cells);
      }
    }
    const rows = mergedRows.map((cells, rowIndex) => {
      const isHeader = rowIndex === 0;
      return new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            borders: cellBorders,
            margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({
              alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
              children: [new TextRun({ text: cellText, font: FONT, size: SIZE_NUM, color: "000000", bold: isHeader && !!methodInfo?.formatting?.tableHeaderBold })],
            })],
          })
        ),
      });
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  }

  if (text) text = text.replace(/'/g, '\u2019');
  const children = [];
  const lines = text.split("\n");
  let i = 0;
  let isQuestionnaire = false;
  while (i < lines.length) {
    const line = lines[i];
    if (isFenceLine(line)) {
      const { codeLines, nextIndex } = readFencedBlock(lines, i);
      children.push(...codeListingParagraphs(codeLines, methodInfo));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      i = nextIndex;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
        children.push(makeTableDocx(tableLines));
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
      continue;
    }
    if (LISTING_CAPTION_RE.test(line.trim())) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    if (/^Таблиця\s+\d/.test(line.trim()) && isFollowedByTable(lines, i)) {
      const fmt = methodInfo?.formatting || {};
      const tf = fmt.tableFormat || "";
      const tAlignRight = fmt.tableNumberRight ?? /правий|right|справа|верхн.*кут/i.test(tf);
      const tCenter    = fmt.tableTitleCenter ?? /по\s*центру.*назв|назв.*по\s*центру|центр/i.test(tf);
      const tBold      = fmt.tableTitleBold   ?? /жирн|bold/i.test(tf);
      const tTwoLine = tAlignRight && (tCenter || tBold);
      const dashIdx = line.search(/ [–\-] /);
      if (tTwoLine && dashIdx !== -1) {
        const numPart = line.trim().substring(0, dashIdx).trim();
        const namePart = line.trim().substring(dashIdx + 3).trim();
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          indent: { firstLine: 0 },
          children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
        }));
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          indent: { firstLine: 0 },
          children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
      } else {
        children.push(new Paragraph({
          alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          indent: { firstLine: tAlignRight ? 0 : INDENT },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: tBold, color: "000000" })],
        }));
      }
      i++; continue;
    }
    if (/^Рис\.\s+\d/.test(line.trim())) {
      const ff = methodInfo?.formatting?.figureFormat || "";
      const fBold = /жирн|bold/i.test(ff);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: fBold, color: "000000" })],
      }));
      i++; continue;
    }
    const raw = cleanMarkdown(line);
    if (!raw) { i++; continue; }
    if (/^ДОДАТОК\s+[А-ЯA-Z]/i.test(raw)) {
      // Peek at upcoming lines to detect questionnaire
      let peekIdx = i + 1;
      while (peekIdx < lines.length && !lines[peekIdx].trim()) peekIdx++;
      const nextNonEmpty = (lines[peekIdx] || "").replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
      isQuestionnaire = /анкет|опитувальник/i.test(nextNonEmpty);
      children.push(new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: raw.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    if (/^#{1,6}\s/.test(line.trim())) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.LEFT,
        indent: { firstLine: INDENT },
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    children.push(new Paragraph({
      indent: { firstLine: isQuestionnaire ? 0 : INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: isQuestionnaire ? AlignmentType.LEFT : AlignmentType.BOTH,
      children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
    }));
    i++;
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1 },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }) },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const prefix = info?.orderNumber ? info.orderNumber + "_" : (orderId ? orderId + "_" : "");
    const safeName = prefix + (info?.topic || "додатки").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + " - додатки.docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Доповідь (.docx)
// ─────────────────────────────────────────────
export async function exportSpeechToDocx(text, info, methodInfo, orderId, speechLabel) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round((methodInfo?.formatting?.fontSize || 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  const langCode = detectTextLanguage(text, info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => (v != null && Number(v) > 0 ? Number(v) : null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;
  if (text) text = text.replace(/'/g, '\u2019');

  const topic = info?.topic || "";
  const workType = info?.type || "";
  const typeMap = { "дипломн": "дипломної роботи", "кваліфікаційн": "кваліфікаційної роботи", "курсов": "курсової роботи", "магістерськ": "магістерської роботи", "бакалавр": "бакалаврської роботи", "реферат": "реферату", "стаття": "статті", "есе": "есе", "доповід": "роботи" };
  const typeLabel = Object.entries(typeMap).find(([k]) => workType.toLowerCase().includes(k))?.[1] || "роботи";

  const header = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [new TextRun({ text: "ДОПОВІДЬ", font: FONT, size: SIZE, bold: true, color: "000000" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [new TextRun({ text: `до ${typeLabel} на тему:`, font: FONT, size: SIZE, color: "000000" })] }),
    ...(topic ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [new TextRun({ text: `«${topic}»`, font: FONT, size: SIZE, bold: true, color: "000000" })] })] : []),
    new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }),
  ];

  const children = [...header, ...text.split("\n").map(line => {
    const raw = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!raw) return new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] });
    if (/^Слайд\s+\d+/i.test(raw)) {
      return new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: 120, after: 0 },
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
      });
    }
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
    });
  })];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1 },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }) },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const num = info?.orderNumber || (orderId ? orderId.slice(0, 10) : "");
    const label = speechLabel || "доповідь";
    const fileName = num ? `${num}_${label}.docx` : `${label}.docx`;
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
