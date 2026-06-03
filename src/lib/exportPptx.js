import PptxGenJS from "pptxgenjs";

export async function exportToPptxFile(slideData, info) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";

  const THEMES = {
    midnight: { bg: "1E2761", accent: "CADCFC", light: "EEF3FF", text: "1E2761" },
    forest: { bg: "2C5F2D", accent: "97BC62", light: "F0F7F0", text: "1A3A1B" },
    coral: { bg: "B85042", accent: "F5C6C0", light: "FDF8F5", text: "5A1A0F" },
    slate: { bg: "36454F", accent: "C8D8E4", light: "F5F5F5", text: "2A3540" },
    warm: { bg: "0D1B3E", accent: "4A7CBF", light: "EEF3FF", text: "0D1B3E" },
  };

  const detectTheme = (info) => {
    const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
    if (/it|інформ|програм|комп|tech|техн|систем|цифр/.test(dir)) return "midnight";
    if (/медицин|біол|фарм|здоров|лікар/.test(dir)) return "forest";
    if (/право|психол|соціол|педагог|гуманіт|мов|освіт/.test(dir)) return "coral";
    if (/економ|менедж|фінанс|облік|маркет|бізнес/.test(dir)) return "slate";
    return "warm";
  };

  const themeName = (slideData.theme && THEMES[slideData.theme]) ? slideData.theme : detectTheme(info);
  const T = THEMES[themeName];

  // Font support — Claude може вказати шрифт у slideData.font
  const FONT_TITLE = slideData.font?.title || slideData.font || "Georgia";
  const FONT_BODY = slideData.font?.body || slideData.font || "Calibri";

  const STRIP_W = 0.18;
  const CONTENT_X = STRIP_W + 0.17;
  const CONTENT_W = 10 - CONTENT_X - 0.15;
  const TITLE_H = 0.9;

  // ── Helper: light slide frame + title ──
  const addTitle = (s, title) => {
    s.background = { color: T.light };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: STRIP_W, h: 5.625, fill: { color: T.bg }, line: { type: "none" } });
    s.addText(title || "", {
      x: CONTENT_X - 0.05, y: 0.06, w: 10 - CONTENT_X, h: TITLE_H,
      fontSize: 22, bold: true, color: T.text,
      fontFace: FONT_TITLE, align: "center", valign: "middle",
    });
  };

  // ── renderHero: темний повноекранний слайд (title / thanks) ──
  const renderHero = (s, data) => {
    s.background = { color: T.bg };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.13, fill: { color: T.accent }, line: { type: "none" } });
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 5.5, w: 10, h: 0.125, fill: { color: T.accent }, line: { type: "none" } });
    s.addShape(pptx.ShapeType.rect, { x: 0.45, y: 1.3, w: 0.07, h: 2.7, fill: { color: T.accent }, line: { type: "none" } });
    s.addText(data.title || info?.topic || "", {
      x: 0.7, y: 1.2, w: 8.8, h: 2.1,
      fontSize: 34, bold: true, color: "FFFFFF",
      fontFace: FONT_TITLE, align: "left", valign: "middle", wrap: true,
    });
    if (data.subtitle) {
      s.addText(data.subtitle, {
        x: 0.7, y: 3.4, w: 8.8, h: 1.2,
        fontSize: 16, color: T.accent, fontFace: FONT_BODY,
        align: "left", valign: "top", wrap: true,
      });
    }
  };

  // ── renderTitleSlide: титульний слайд з ПІБ, керівником, закладом ──
  const renderTitleSlide = (s, data) => {
    s.background = { color: T.bg };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.13, fill: { color: T.accent }, line: { type: "none" } });
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 5.5, w: 10, h: 0.125, fill: { color: T.accent }, line: { type: "none" } });
    s.addShape(pptx.ShapeType.rect, { x: 0.45, y: 0.75, w: 0.07, h: 4.5, fill: { color: T.accent }, line: { type: "none" } });
    if (data.institution) {
      s.addText(data.institution, {
        x: 0.7, y: 0.18, w: 8.8, h: 0.48,
        fontSize: 12, color: T.accent, fontFace: FONT_BODY, align: "left", valign: "middle", wrap: true,
      });
    }
    s.addText(data.title || info?.topic || "", {
      x: 0.7, y: 0.82, w: 8.8, h: 2.4,
      fontSize: 26, bold: true, color: "FFFFFF",
      fontFace: FONT_TITLE, align: "left", valign: "middle", wrap: true,
    });
    if (data.work_type) {
      s.addText(data.work_type, {
        x: 0.7, y: 3.32, w: 8.8, h: 0.38,
        fontSize: 14, color: T.accent, fontFace: FONT_BODY, align: "left", valign: "middle",
      });
    }
    if (data.student) {
      s.addText(`Виконав(ла): ${data.student}`, {
        x: 0.7, y: 3.8, w: 8.8, h: 0.36,
        fontSize: 13, color: "CCCCCC", fontFace: FONT_BODY, align: "left",
      });
    }
    if (data.supervisor) {
      s.addText(`Науковий керівник: ${data.supervisor}`, {
        x: 0.7, y: 4.18, w: 8.8, h: 0.36,
        fontSize: 13, color: "CCCCCC", fontFace: FONT_BODY, align: "left",
      });
    }
    s.addText(String(data.year || new Date().getFullYear()), {
      x: 0.7, y: 5.12, w: 8.8, h: 0.3,
      fontSize: 13, color: T.accent, fontFace: FONT_BODY, align: "left",
    });
  };

  // ── renderTwoColumn: текст ліво + кольоровий блок право ──
  const renderTwoColumn = (s, data) => {
    addTitle(s, data.title);
    const COL_Y = TITLE_H + 0.25;
    const COL_H = 5.625 - COL_Y - 0.25;
    s.addText(data.left || data.content || "", {
      x: CONTENT_X, y: COL_Y, w: 4.3, h: COL_H,
      fontSize: 14, color: "333333", fontFace: FONT_BODY,
      valign: "top", wrap: true, paraSpaceAfter: 8,
    });
    const RIGHT_X = CONTENT_X + 4.5;
    const RIGHT_W = 10 - RIGHT_X - 0.15;
    s.addShape(pptx.ShapeType.roundRect, {
      x: RIGHT_X, y: COL_Y, w: RIGHT_W, h: COL_H,
      fill: { color: T.bg }, line: { type: "none" }, rectRadius: 0.1,
    });
    if (data.right_type === "image") {
      addImagePlaceholder(s, RIGHT_X, COL_Y, RIGHT_W, COL_H, data.right || data.image || "Додайте зображення");
    } else if (data.right_type === "stat") {
      s.addText(data.right_value || "", {
        x: RIGHT_X, y: COL_Y + 0.35, w: RIGHT_W, h: 1.5,
        fontSize: 54, bold: true, color: T.accent,
        fontFace: FONT_BODY, align: "center", valign: "middle",
      });
      s.addText(data.right_label || "", {
        x: RIGHT_X + 0.1, y: COL_Y + 1.95, w: RIGHT_W - 0.2, h: 0.65,
        fontSize: 14, color: "FFFFFF", fontFace: FONT_BODY, align: "center", wrap: true,
      });
    } else {
      s.addText(data.right || data.key_point || "", {
        x: RIGHT_X + 0.2, y: COL_Y + 0.25, w: RIGHT_W - 0.35, h: COL_H - 0.4,
        fontSize: 14, color: "FFFFFF", fontFace: FONT_BODY,
        valign: "top", wrap: true, paraSpaceAfter: 8,
      });
    }
  };

  // ── renderStatCallout: 1-3 великих числа на картках ──
  const renderStatCallout = (s, data) => {
    addTitle(s, data.title);
    const v = data.visual || {};
    const stats = v.stats || (v.stat
      ? [{ value: v.stat, label: v.stat_label || "" }, ...(v.stat2 ? [{ value: v.stat2, label: v.stat2_label || "" }] : [])]
      : []);
    const n = Math.min(stats.length, 3);
    const CARD_Y = TITLE_H + 0.2;
    const CARD_H = 2.15;
    if (n > 0) {
      const cardW = 2.7;
      const totalW = n * cardW + (n - 1) * 0.2;
      const startX = (10 - totalW) / 2;
      stats.slice(0, 3).forEach((st, i) => {
        const cx = startX + i * (cardW + 0.2);
        s.addShape(pptx.ShapeType.roundRect, {
          x: cx, y: CARD_Y, w: cardW, h: CARD_H,
          fill: { color: T.bg }, line: { type: "none" }, rectRadius: 0.12,
        });
        s.addText(st.value || "", {
          x: cx, y: CARD_Y + 0.1, w: cardW, h: 1.35,
          fontSize: 54, bold: true, color: T.accent,
          fontFace: FONT_BODY, align: "center", valign: "middle",
        });
        s.addText(st.label || "", {
          x: cx + 0.1, y: CARD_Y + 1.5, w: cardW - 0.2, h: 0.55,
          fontSize: 13, color: "FFFFFF", fontFace: FONT_BODY, align: "center", wrap: true,
        });
      });
    }
    if (data.content) {
      s.addText(data.content, {
        x: CONTENT_X, y: CARD_Y + CARD_H + 0.2, w: CONTENT_W, h: 5.625 - (CARD_Y + CARD_H + 0.2) - 0.2,
        fontSize: 14, color: "444444", fontFace: FONT_BODY, wrap: true, valign: "top",
      });
    }
  };

  // ── renderIconList: список з іконками (goals / conclusions) ──
  const renderIconList = (s, data) => {
    addTitle(s, data.title);
    const ICONS_DEFAULT = ["🎯", "📊", "🔬", "💡", "✅", "→"];
    const rawItems = data.visual?.items || data.points || (data.content ? data.content.split("\n").filter(Boolean) : []);
    const n = Math.min(rawItems.length, 5);
    if (!n) return;
    const COL_Y = TITLE_H + 0.2;
    const availH = 5.625 - COL_Y - 0.25;
    const itemH = availH / n;
    const circSize = Math.min(0.52, itemH * 0.55);
    rawItems.slice(0, 5).forEach((item, i) => {
      const ty = COL_Y + i * itemH;
      const icon = typeof item === "object" ? (item.icon || ICONS_DEFAULT[i % ICONS_DEFAULT.length]) : ICONS_DEFAULT[i % ICONS_DEFAULT.length];
      const header = typeof item === "object" ? item.header : null;
      const text = typeof item === "object" ? (item.text || item.header) : item;
      s.addShape(pptx.ShapeType.ellipse, {
        x: CONTENT_X, y: ty + (itemH - circSize) / 2, w: circSize, h: circSize,
        fill: { color: T.bg }, line: { type: "none" },
      });
      s.addText(String(icon), {
        x: CONTENT_X, y: ty + (itemH - circSize) / 2, w: circSize, h: circSize,
        fontSize: 14, align: "center", valign: "middle", color: "FFFFFF",
      });
      const textX = CONTENT_X + circSize + 0.14;
      const textW = CONTENT_W - circSize - 0.14;
      if (header) {
        s.addText(header, {
          x: textX, y: ty + (itemH - circSize) / 2, w: textW, h: circSize * 0.42,
          fontSize: 14, bold: true, color: T.text, fontFace: FONT_BODY, valign: "bottom",
        });
        s.addText(String(text), {
          x: textX, y: ty + (itemH - circSize) / 2 + circSize * 0.42, w: textW, h: circSize * 0.58,
          fontSize: 12, color: "555555", fontFace: FONT_BODY, valign: "top", wrap: true,
        });
      } else {
        s.addText(String(text), {
          x: textX, y: ty, w: textW, h: itemH,
          fontSize: 14, color: T.text, fontFace: FONT_BODY, valign: "middle", wrap: true,
        });
      }
    });
  };

  // ── renderHighlightBox: смугасті рядки + опціональний акцент-футер ──
  const COLOR_NAMES = new Set(["blue","green","orange","red","yellow","purple","pink","white","black","gray","cyan","magenta","violet","brown","beige"]);
  const renderHighlightBox = (s, data) => {
    addTitle(s, data.title);
    const items = data.visual?.items || data.points || (data.content ? data.content.split("\n").filter(Boolean) : []);
    const rawAccent = data.accent || data.gap;
    const isColorPlaceholder = typeof rawAccent === "string" && rawAccent.trim().split(/\s+/).length === 1 && COLOR_NAMES.has(rawAccent.trim().toLowerCase());
    const hasFooter = !!rawAccent && !isColorPlaceholder;
    const footerH = 0.88;
    const COL_Y = TITLE_H + 0.15;
    const availH = 5.625 - COL_Y - (hasFooter ? footerH + 0.22 : 0.25);
    const n = Math.min(items.length, 4);
    if (n) {
      const itemH = availH / n;
      items.slice(0, 4).forEach((pt, i) => {
        const ty = COL_Y + i * itemH;
        s.addShape(pptx.ShapeType.rect, {
          x: CONTENT_X, y: ty + 0.05, w: CONTENT_W, h: itemH - 0.1,
          fill: { color: i % 2 === 0 ? T.light : "FFFFFF" }, line: { color: T.accent, w: 0.5 },
        });
        s.addShape(pptx.ShapeType.rect, {
          x: CONTENT_X, y: ty + 0.05, w: 0.1, h: itemH - 0.1,
          fill: { color: T.bg }, line: { type: "none" },
        });
        const text = typeof pt === "object" ? (pt.text || pt.header) : pt;
        s.addText(String(text), {
          x: CONTENT_X + 0.18, y: ty + 0.05, w: CONTENT_W - 0.22, h: itemH - 0.1,
          fontSize: 13, color: T.text, fontFace: FONT_BODY, valign: "middle", wrap: true,
        });
      });
    }
    if (hasFooter) {
      const gy = 5.625 - footerH - 0.1;
      s.addShape(pptx.ShapeType.rect, { x: CONTENT_X, y: gy, w: CONTENT_W, h: footerH, fill: { color: T.accent }, line: { type: "none" } });
      s.addText(String(rawAccent), {
        x: CONTENT_X + 0.15, y: gy, w: CONTENT_W - 0.3, h: footerH,
        fontSize: 13, bold: true, color: T.text, fontFace: FONT_BODY, align: "left", valign: "middle", wrap: true,
      });
    }
  };

  // ── renderNumberedSteps: картки-кроки 1→2→3→4 (методи / процеси) ──
  const renderNumberedSteps = (s, data) => {
    addTitle(s, data.title);
    const steps = data.visual?.items || data.steps
      || (data.points ? data.points.map((p, i) => ({ num: String(i + 1), title: "", text: p })) : []);
    const n = Math.min(steps.length, 4);
    if (!n) return;
    const COL_Y = TITLE_H + 0.2;
    const cardW = (CONTENT_W - (n - 1) * 0.15) / n;
    const cardH = 5.625 - COL_Y - 0.25;
    steps.slice(0, 4).forEach((st, i) => {
      const cx = CONTENT_X + i * (cardW + 0.15);
      if (i < n - 1) {
        s.addShape(pptx.ShapeType.rect, {
          x: cx + cardW + 0.01, y: COL_Y + cardH / 2 - 0.04, w: 0.13, h: 0.07,
          fill: { color: T.accent }, line: { type: "none" },
        });
      }
      s.addShape(pptx.ShapeType.rect, {
        x: cx, y: COL_Y, w: cardW, h: cardH,
        fill: { color: T.light }, line: { color: T.accent, w: 0.75 },
      });
      const cSize = 0.52;
      s.addShape(pptx.ShapeType.ellipse, {
        x: cx + (cardW - cSize) / 2, y: COL_Y + 0.12, w: cSize, h: cSize,
        fill: { color: T.bg }, line: { type: "none" },
      });
      s.addText(st.num || String(i + 1), {
        x: cx + (cardW - cSize) / 2, y: COL_Y + 0.12, w: cSize, h: cSize,
        fontSize: 16, bold: true, color: "FFFFFF", fontFace: FONT_BODY, align: "center", valign: "middle",
      });
      if (st.title) {
        s.addText(st.title, {
          x: cx + 0.1, y: COL_Y + 0.78, w: cardW - 0.2, h: 0.55,
          fontSize: 13, bold: true, color: T.text, fontFace: FONT_TITLE, align: "center", valign: "middle", wrap: true,
        });
      }
      const textY = COL_Y + (st.title ? 1.42 : 0.82);
      s.addText(st.text || (typeof st === "string" ? st : ""), {
        x: cx + 0.1, y: textY, w: cardW - 0.2, h: COL_Y + cardH - textY - 0.1,
        fontSize: 12, color: "444444", fontFace: FONT_BODY, align: "left", valign: "top", wrap: true,
      });
    });
  };

  // ── addImagePlaceholder: виділений блок-заглушка для зображення ──
  const addImagePlaceholder = (s, x, y, w, h, label) => {
    s.addShape(pptx.ShapeType.rect, {
      x, y, w, h,
      fill: { color: "FFF8E1" },
      line: { color: "FFB300", w: 1.5 },
    });
    // діагональні смуги — два трикутники по кутах для візуального акценту
    s.addShape(pptx.ShapeType.rect, {
      x, y, w, h: 0.06,
      fill: { color: "FFB300" }, line: { type: "none" },
    });
    s.addShape(pptx.ShapeType.rect, {
      x, y: y + h - 0.06, w, h: 0.06,
      fill: { color: "FFB300" }, line: { type: "none" },
    });
    s.addText("📷", {
      x, y: y + h * 0.18, w, h: h * 0.38,
      fontSize: Math.min(48, h * 30), align: "center", valign: "bottom",
    });
    s.addText(label || "Додайте зображення", {
      x: x + 0.1, y: y + h * 0.56, w: w - 0.2, h: h * 0.35,
      fontSize: 13, bold: true, color: "795548",
      fontFace: FONT_BODY, align: "center", valign: "top", wrap: true,
    });
  };

  // ── renderTable: таблиця з заголовком і рядками ──
  const renderTable = (s, data) => {
    addTitle(s, data.title);
    const v = data.visual || {};
    const headers = v.headers || [];
    const rows = v.rows || [];
    if (!headers.length && !rows.length) return;

    const TABLE_Y = TITLE_H + 0.2;
    const TABLE_H = 5.625 - TABLE_Y - 0.2;
    const colCount = headers.length || (rows[0]?.length ?? 1);

    const tableRows = [];
    if (headers.length) {
      tableRows.push(headers.map(h => ({
        text: String(h),
        options: { bold: true, color: "FFFFFF", fill: T.bg, fontSize: 13, fontFace: FONT_BODY, align: "center", valign: "middle" },
      })));
    }
    rows.forEach((row, ri) => {
      tableRows.push(row.map(cell => ({
        text: String(cell ?? ""),
        options: {
          color: T.text,
          fill: ri % 2 === 0 ? T.light : "FFFFFF",
          fontSize: 12,
          fontFace: FONT_BODY,
          valign: "middle",
        },
      })));
    });

    s.addTable(tableRows, {
      x: CONTENT_X, y: TABLE_Y, w: CONTENT_W, h: TABLE_H,
      colW: Array(colCount).fill(CONTENT_W / colCount),
      border: { type: "solid", color: T.accent, pt: 0.5 },
      autoPage: false,
    });
  };

  // ── renderImagePlaceholder: слайд із великим placeholder для зображення ──
  const renderImagePlaceholder = (s, data) => {
    addTitle(s, data.title);
    const PH_Y = TITLE_H + 0.2;
    const PH_H = 5.625 - PH_Y - 0.2;
    addImagePlaceholder(s, CONTENT_X, PH_Y, CONTENT_W, PH_H, data.image || data.content || "Додайте зображення");
  };

  // ── renderChart: графік bar / line / pie / doughnut ──
  const CHART_TYPE_MAP = {
    bar: "bar", column: "bar", line: "line",
    pie: "pie", doughnut: "doughnut", area: "area",
  };
  const renderChart = (s, data) => {
    addTitle(s, data.title);
    const v = data.visual || {};
    const chartType = CHART_TYPE_MAP[v.type] || "bar";
    const series = (v.series || []).map(sr => ({
      name: sr.name || "",
      labels: sr.labels || [],
      values: (sr.values || []).map(Number),
    }));
    if (!series.length || !series[0].values.length) return;

    const CHART_COLORS = [T.bg, T.accent, "888888", "AAAAAA", "CCCCCC"];

    s.addChart(chartType, series, {
      x: CONTENT_X, y: TITLE_H + 0.15, w: CONTENT_W, h: 5.625 - TITLE_H - 0.35,
      showLegend: series.length > 1,
      legendPos: "b",
      legendFontSize: 11,
      showTitle: false,
      chartColors: CHART_COLORS,
      dataLabelFontSize: 11,
      dataLabelColor: "333333",
      valAxisLabelFontSize: 11,
      catAxisLabelFontSize: 11,
      showValue: v.showValues !== false,
    });
  };

  // ── Dispatch ──
  for (const slide of (slideData.slides || [])) {
    const s = pptx.addSlide();
    switch (slide.layout) {
      case "title_slide": renderTitleSlide(s, slide); break;
      case "hero":
      case "dark_title": renderHero(s, slide); break;
      case "two_column": renderTwoColumn(s, slide); break;
      case "stat_callout": renderStatCallout(s, slide); break;
      case "icon_list":
      case "icon_grid": renderIconList(s, slide); break;
      case "numbered_steps":
      case "timeline": renderNumberedSteps(s, slide); break;
      case "table": renderTable(s, slide); break;
      case "chart": renderChart(s, slide); break;
      case "image_placeholder": renderImagePlaceholder(s, slide); break;
      default: renderHighlightBox(s, slide); break;
    }
  }

  const prefix = info?.orderNumber ? info.orderNumber + "_" : "";
  const safeName = prefix + (info?.topic || "презентація").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  await pptx.writeFile({ fileName: safeName + " - презентація.pptx" });
}
