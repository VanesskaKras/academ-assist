// ─────────────────────────────────────────────
// Читання кольорових виділень і коментарів Word з .docx
// ─────────────────────────────────────────────
export const HIGHLIGHT_COLORS = {
  yellow:      { ua: "жовте",         css: "#FEF08A", text: "#854D0E" },
  red:         { ua: "червоне",       css: "#FCA5A5", text: "#991B1B" },
  green:       { ua: "зелене",        css: "#86EFAC", text: "#166534" },
  cyan:        { ua: "блакитне",      css: "#A5F3FC", text: "#155E75" },
  magenta:     { ua: "рожеве",        css: "#F9A8D4", text: "#9D174D" },
  blue:        { ua: "синє",          css: "#BFDBFE", text: "#1E3A8A" },
  darkBlue:    { ua: "темно-синє",    css: "#3B82F6", text: "#fff" },
  darkCyan:    { ua: "бірюзове",      css: "#06B6D4", text: "#fff" },
  darkGreen:   { ua: "темно-зелене",  css: "#22C55E", text: "#fff" },
  darkMagenta: { ua: "фіолетове",     css: "#A855F7", text: "#fff" },
  darkRed:     { ua: "бордове",       css: "#EF4444", text: "#fff" },
  darkYellow:  { ua: "золоте",        css: "#EAB308", text: "#fff" },
  darkGray:    { ua: "сіре",          css: "#9CA3AF", text: "#fff" },
  lightGray:   { ua: "світло-сіре",   css: "#E5E7EB", text: "#374151" },
};

// ─────────────────────────────────────────────
// JSZip loader
// ─────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return window.JSZip;
}

// ─────────────────────────────────────────────
// Витяг виділень і коментарів з .docx
// ─────────────────────────────────────────────
export async function extractAnnotations(arrayBuffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docXmlRaw = await zip.file("word/document.xml")?.async("string");
  if (!docXmlRaw) return { highlights: [], comments: [] };

  let commentsXmlRaw = "";
  try { commentsXmlRaw = (await zip.file("word/comments.xml")?.async("string")) || ""; } catch { /**/ }

  const parser = new DOMParser();
  const docXml = parser.parseFromString(docXmlRaw, "text/xml");

  // ── Коментарі ──
  const commentMap = {};
  if (commentsXmlRaw) {
    const commentsXml = parser.parseFromString(commentsXmlRaw, "text/xml");
    const commentEls = commentsXml.getElementsByTagName("w:comment");
    for (const c of commentEls) {
      const id = c.getAttribute("w:id");
      const author = c.getAttribute("w:author") || "Автор";
      const tEls = c.getElementsByTagName("w:t");
      let text = "";
      for (const t of tEls) text += t.textContent + " ";
      commentMap[id] = { author, text: text.trim() };
    }
  }

  // ── Виділення (параграф за параграфом) ──
  const highlights = [];
  const paragraphs = docXml.getElementsByTagName("w:p");

  for (const para of paragraphs) {
    // Повний текст параграфу
    const allT = para.getElementsByTagName("w:t");
    let paraText = "";
    for (const t of allT) paraText += t.textContent;
    if (!paraText.trim()) continue;

    const runs = para.getElementsByTagName("w:r");
    let curColor = null;
    let curText = "";
    // Короткий нерозфарбований розрив (звичайно — пробіл) між двома виділеннями
    // ТОГО САМОГО кольору не повинен розривати їх на окремі анотації: керівники
    // часто виділяють і сам проблемний фрагмент, і власний коментар одразу після
    // нього — розділені лише пробілом-раном без highlight. Якщо розривати тут,
    // завдання на виправлення губить половину контексту (див. "6678-6679]." +
    // "Що це за нереальні сторінки?" — без об'єднання ШІ не бачить, до чого
    // відноситься коментар).
    let pendingGap = "";

    const flush = () => {
      if (curText && curColor) {
        highlights.push({
          color: curColor,
          colorInfo: HIGHLIGHT_COLORS[curColor] || { ua: curColor, css: "#e5e7eb", text: "#374151" },
          text: curText.trim(),
          context: paraText.trim(),
        });
      }
      curColor = null;
      curText = "";
      pendingGap = "";
    };

    for (const run of runs) {
      const rPr = run.getElementsByTagName("w:rPr")[0];
      const highlightEl = rPr?.getElementsByTagName("w:highlight")[0];
      const color = highlightEl?.getAttribute("w:val");

      const tEls = run.getElementsByTagName("w:t");
      let runText = "";
      for (const t of tEls) runText += t.textContent;

      const isHighlighted = color && color !== "none" && color !== "white" && color !== "black";

      if (isHighlighted) {
        if (color === curColor) {
          curText += pendingGap + runText;
          pendingGap = "";
        } else {
          flush();
          curColor = color;
          curText = runText;
        }
      } else if (curColor && /^\s*$/.test(runText)) {
        // пробільний розрив під час активного виділення — тримаємо про запас,
        // не скидаємо накопичене одразу
        pendingGap += runText;
      } else {
        flush();
      }
    }
    flush();
  }

  // ── Коментарі з прив'язкою до тексту ──
  const comments = [];
  if (Object.keys(commentMap).length > 0) {
    const commentStarts = docXml.getElementsByTagName("w:commentRangeStart");
    for (const startEl of commentStarts) {
      const id = startEl.getAttribute("w:id");
      const comment = commentMap[id];
      if (!comment) continue;

      // Витягуємо текст між commentRangeStart і commentRangeEnd через рядковий пошук
      const startMarker = `w:id="${id}"`;
      const endTag = `<w:commentRangeEnd`;
      let searchFrom = 0;
      let commentedText = "";

      while (searchFrom < docXmlRaw.length) {
        const sPos = docXmlRaw.indexOf("<w:commentRangeStart", searchFrom);
        if (sPos === -1) break;
        const idPos = docXmlRaw.indexOf(startMarker, sPos);
        const tagEnd = docXmlRaw.indexOf(">", sPos);
        if (idPos !== -1 && idPos < tagEnd) {
          const afterStart = tagEnd + 1;
          let ePos = afterStart;
          // Знаходимо commentRangeEnd з тим самим id
          while (ePos < docXmlRaw.length) {
            const candidateEnd = docXmlRaw.indexOf(endTag, ePos);
            if (candidateEnd === -1) { ePos = docXmlRaw.length; break; }
            const endIdPos = docXmlRaw.indexOf(startMarker, candidateEnd);
            const endTagEnd = docXmlRaw.indexOf(">", candidateEnd);
            if (endIdPos !== -1 && endIdPos < endTagEnd) { ePos = candidateEnd; break; }
            ePos = candidateEnd + 1;
          }
          if (ePos < docXmlRaw.length) {
            const between = docXmlRaw.slice(afterStart, ePos);
            const tMatches = [...between.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
            commentedText = tMatches.map(m => m[1]).join("").trim();
          }
          break;
        }
        searchFrom = sPos + 1;
      }

      if (commentedText || comment.text) {
        comments.push({
          id,
          author: comment.author,
          instruction: comment.text,
          commentedText: commentedText || "(текст не визначено)",
        });
      }
    }
  }

  return { highlights, comments };
}

// ─────────────────────────────────────────────
// Форматування виділень/коментарів у текст зауважень для форми правок
// (CorrectionsStage) — той самий вигляд, який очікує buildCorrectionsAnalysisPrompt.
// ─────────────────────────────────────────────
export function formatAnnotationsAsCorrectionText(annotations, fileName) {
  const lines = [
    ...annotations.comments.map(c => `Коментар (${c.author}) до фрагмента «${c.commentedText}»: ${c.instruction}`),
    ...annotations.highlights.map(h => `Виділено ${h.colorInfo?.ua || h.color}: «${h.text}»`),
  ];
  if (!lines.length) return "";
  const header = fileName ? `Зауваження з файлу "${fileName}":` : "Зауваження з файлу:";
  return `${header}\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
}
