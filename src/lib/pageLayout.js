// ── Реальний підрахунок сторінок через Canvas 2D ──
// wordCount.js рахує обсяг за грубою оцінкою "270 слів = сторінка" — вона не бачить,
// що таблиці, PlantUML-схеми/графіки та посторінкові виноски (APA/MLA-цитування,
// %%FN<n>%%) займають реального місця на сторінці набагато більше, ніж кількість
// "слів" у їхньому вихідному markdown. Тут рахуємо фактичне перенесення рядків через
// canvas.measureText — тим самим підходом, що вже перевірений у проєкті для розміру
// графіків (renderChartFromParsed, exportDocx.js) — з урахуванням реальної ширини
// сторінки й шрифту з методички.
//
// Свідомі спрощення (не помилки, а компроміс продуктивність/точність — див. план):
// - таблиці вважаються неподільними, висота рядка не враховує перенос у клітинці;
// - рисунки/схеми оцінюються фіксованою орієнтовною висотою, а не реальним рендером
//   (щоб не робити мережевий виклик до /api/render-diagram лише заради підрахунку);
// - виноски резервують орієнтовну (не виміряну по факту) висоту на маркер;
// - кожна секція рахується так, ніби починається з верху чистої сторінки — узгоджено
//   з тим, що весь інший бюджет підрозділів (sec.pages) у системі теж рахується
//   незалежно один від одного, а не як суцільний потік по всьому документу.

import { getLangLabels } from "./planUtils.js";

const MM_TO_PX = 96 / 25.4; // 96dpi "CSS px"
const PT_TO_PX = 96 / 72;
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const LINE_HEIGHT_FACTOR = 1.15; // емпіричний коефіцієнт "leading" для Times New Roman
const FIGURE_HEIGHT_PX_DEFAULT = 260; // орієнтовна висота рисунка/схеми/графіка
const TABLE_ROW_HEIGHT_FACTOR = 1.3; // рядок таблиці трохи вищий за рядок тексту (паддінги клітинок)
const FOOTNOTE_HEIGHT_FACTOR = 1.5; // множник lineHeight на кожен маркер виноски
const PLANTUML_FENCE_RE = /^```\s*plantuml\s*$/i;
const TABLE_SEP_RE = /^\|[\s:|-]+\|?\s*$/;
const FOOTNOTE_MARKER_RE = /%%FN\d+%%/g;

let _measureCanvas = null;
function createMeasurer(fontPx, fontFamily) {
  if (typeof document === "undefined") {
    // SSR/тестове середовище без DOM — грубий фолбек, не використовується в браузері.
    const avgCharWidth = fontPx * 0.5;
    return { width: (text) => text.length * avgCharWidth };
  }
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  ctx.font = `${fontPx}px "${fontFamily}", serif`;
  return { width: (text) => ctx.measureText(text).width };
}

function pageGeometryPx(formatting) {
  const marg = formatting?.margins || {};
  const left = (marg.left ?? 30) * MM_TO_PX;
  const right = (marg.right ?? 15) * MM_TO_PX;
  const top = (marg.top ?? 20) * MM_TO_PX;
  const bottom = (marg.bottom ?? 20) * MM_TO_PX;
  return {
    contentWidth: PAGE_WIDTH_MM * MM_TO_PX - left - right,
    contentHeight: PAGE_HEIGHT_MM * MM_TO_PX - top - bottom,
  };
}

function lineMetricsPx(formatting) {
  const fontSizePt = formatting?.fontSize || 14;
  const lineSpacing = formatting?.lineSpacing || 1.5;
  const fontFamily = formatting?.font || "Times New Roman";
  const fontSizePx = fontSizePt * PT_TO_PX;
  return { fontSizePx, lineHeightPx: fontSizePx * LINE_HEIGHT_FACTOR * lineSpacing, fontFamily };
}

// К-сть рядків, у які реально перенесеться абзац тексту заданої ширини шрифтом
// (жадібне перенесення по словах — той самий принцип, що й у реальному текстовому
// рушії; не відтворює перенос по складах чи кернінг, але для довжини абзацу це
// не має значення).
function wrapLineCount(text, measurer, contentWidthPx) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const spaceWidth = measurer.width(" ");
  let lines = 1;
  let lineWidth = 0;
  for (const w of words) {
    const wWidth = measurer.width(w);
    const nextWidth = lineWidth === 0 ? wWidth : lineWidth + spaceWidth + wWidth;
    if (nextWidth > contentWidthPx && lineWidth > 0) {
      lines++;
      lineWidth = wWidth;
    } else {
      lineWidth = nextWidth;
    }
  }
  return lines;
}

// Чи є цей блок markdown-таблиці насправді джерелом даних для графіка (а не
// звичайною таблицею) — та сама умова, що й resolveDiagrams у exportDocx.js:
// таблиця, одразу за якою (через порожні рядки) йде підпис рисунка.
function isChartSourceTable(lines, afterIdx, figWord) {
  let k = afterIdx;
  while (k < lines.length && !lines[k].trim()) k++;
  if (k >= lines.length) return false;
  const escaped = figWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped + "\\s+\\d").test(lines[k].trim());
}

// Реальна к-сть сторінок для тексту ОДНІЄЇ секції звіту/курсової.
export function estimateRealPages(text, formatting, lang = "Українська") {
  if (!text?.trim()) return 0;
  const { contentWidth, contentHeight } = pageGeometryPx(formatting);
  const { lineHeightPx, fontSizePx, fontFamily } = lineMetricsPx(formatting);
  const measurer = createMeasurer(fontSizePx, fontFamily);
  const figWord = getLangLabels(lang).figWord;

  const lines = text.split("\n");
  let usedHeight = 0;
  let reservedFootnoteHeight = 0;
  let pages = 1;
  let i = 0;

  const addHeight = (h) => {
    const available = Math.max(1, contentHeight - reservedFootnoteHeight);
    if (usedHeight + h > available) {
      pages++;
      usedHeight = 0;
      reservedFootnoteHeight = 0;
    }
    usedHeight += h;
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }

    // Блок markdown-таблиці (звичайна таблиця АБО дані графіка — розрізняємо так само,
    // як реальний експорт: якщо одразу за таблицею йде підпис рисунка, це графік).
    if (trimmed.startsWith("|")) {
      let rowCount = 0;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (!TABLE_SEP_RE.test(lines[i].trim())) rowCount++;
        i++;
      }
      if (isChartSourceTable(lines, i, figWord)) {
        addHeight(FIGURE_HEIGHT_PX_DEFAULT);
      } else {
        addHeight(rowCount * lineHeightPx * TABLE_ROW_HEIGHT_FACTOR);
      }
      continue;
    }

    // PlantUML-схема — фіксований блок аж до закриваючого ```
    if (PLANTUML_FENCE_RE.test(trimmed)) {
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) i++;
      i++;
      addHeight(FIGURE_HEIGHT_PX_DEFAULT);
      continue;
    }

    // Звичайний абзац — реальне перенесення рядків
    const wrapped = wrapLineCount(trimmed, measurer, contentWidth);
    addHeight(wrapped * lineHeightPx);

    // Виноски в цьому абзаці резервують орієнтовне місце знизу ПОТОЧНОЇ сторінки —
    // реального тексту виноски тут немає (він у окремому реєстрі поза цим текстом),
    // тож беремо усереднену "типову" висоту на кожен маркер.
    const fnCount = (trimmed.match(FOOTNOTE_MARKER_RE) || []).length;
    if (fnCount) reservedFootnoteHeight += fnCount * lineHeightPx * FOOTNOTE_HEIGHT_FACTOR;

    i++;
  }

  return pages;
}
