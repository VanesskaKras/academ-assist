// ─────────────────────────────────────────────
// Хірургічне редагування .docx: точкова заміна тексту прямо в оригінальному
// XML файлі (як Edit-тулза працює з кодом — знайти конкретне місце, змінити
// тільки його), без переходу через plain text і перебудови документа з нуля.
// Це зберігає ВСЕ оригінальне форматування (таблиці, стилі, шрифти, підписи),
// яке губилось при старому підході mammoth.extractRawText → docx-реконструкція.
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

// ── Плаский текст документа + мапа "позиція в тексті → вузол <w:t>" ──
// Абзаци (<w:p>) розділяються символом "\n" без прив'язки до жодного вузла —
// заміна, що зачіпає лише текст усередині одного чи кількох абзаців, працює
// через прив'язані вузли; сам розрив абзацу структурно лишається недоторканим.
function buildTextMap(docXml) {
  const paragraphs = [...docXml.getElementsByTagName("w:p")];
  const map = [];
  let plainText = "";
  paragraphs.forEach((p, pi) => {
    const tEls = [...p.getElementsByTagName("w:t")];
    tEls.forEach(node => {
      const text = node.textContent;
      if (!text) return;
      map.push({ node, start: plainText.length, end: plainText.length + text.length });
      plainText += text;
    });
    if (pi < paragraphs.length - 1) plainText += "\n";
  });
  return { map, plainText };
}

// ── Відкрити .docx для редагування: повертає zip, DOM document.xml і поточну
// мапу тексту. zip/docXml — живі об'єкти, які потрібно тримати в ref (не в
// React-стейті) і передавати в наступні виклики цього модуля. ──
export async function openDocxForEditing(arrayBuffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("У файлі немає word/document.xml — це не .docx");
  const docXmlRaw = await docFile.async("string");
  const docXml = new DOMParser().parseFromString(docXmlRaw, "text/xml");
  const { map, plainText } = buildTextMap(docXml);
  return { zip, docXml, map, plainText };
}

// ── Перебудувати мапу тексту після зміни DOM — виклик після КОЖНОЇ застосованої
// заміни, інакше позиції наступних правок (з locateFragment) з'їдуть відносно
// вже зміненого документа. ──
export function refreshTextMap(docXml) {
  return buildTextMap(docXml);
}

// ── Замінити фрагмент [start, end) плаского тексту на replacement, лишаючи
// решту XML (форматування, таблиці, стилі, підписи) недоторканою. Заодно
// знімає підсвітку (w:highlight) з торкнутих ранів — фрагмент виправлено,
// маркер "потребує уваги" більше не актуальний. ──
export function applyDocxReplacement(map, start, end, replacement) {
  const touched = map.filter(m => m.end > start && m.start < end);
  if (!touched.length) return false;
  touched.forEach((m, i) => {
    const text = m.node.textContent;
    const localStart = Math.max(0, start - m.start);
    const localEnd = Math.min(text.length, end - m.start);
    const before = text.slice(0, localStart);
    const after = text.slice(localEnd);
    const newText = i === 0 ? before + replacement + after : before + after;
    m.node.textContent = newText;
    if (/^\s|\s$/.test(newText)) m.node.setAttribute("xml:space", "preserve");

    const run = m.node.parentNode;
    const rPr = run && [...run.childNodes].find(n => n.tagName === "w:rPr");
    const highlight = rPr && [...rPr.childNodes].find(n => n.tagName === "w:highlight");
    if (highlight) rPr.removeChild(highlight);
  });
  return true;
}

// ── Видалити конкретний коментар Word (за id) — і сам запис у comments.xml, і
// його прив'язку в document.xml (commentRangeStart/End/Reference) — щоб
// виправлений файл не тягнув коментар, на який вже відповіли правкою. ──
export async function removeDocxComment(zip, docXml, commentId) {
  if (!commentId) return;
  const idStr = String(commentId);
  [...docXml.getElementsByTagName("w:commentRangeStart"), ...docXml.getElementsByTagName("w:commentRangeEnd")]
    .filter(el => el.getAttribute("w:id") === idStr)
    .forEach(el => el.parentNode?.removeChild(el));
  [...docXml.getElementsByTagName("w:commentReference")]
    .filter(el => el.getAttribute("w:id") === idStr)
    .forEach(el => { const run = el.parentNode; run?.parentNode?.removeChild(run); });

  const commentsFile = zip.file("word/comments.xml");
  if (!commentsFile) return;
  const commentsRaw = await commentsFile.async("string");
  const commentsXml = new DOMParser().parseFromString(commentsRaw, "text/xml");
  [...commentsXml.getElementsByTagName("w:comment")]
    .filter(el => el.getAttribute("w:id") === idStr)
    .forEach(el => el.parentNode.removeChild(el));
  zip.file("word/comments.xml", new XMLSerializer().serializeToString(commentsXml));
}

// ── Серіалізувати змінений XML назад у zip і повернути готовий .docx Blob ──
export async function serializeDocx(zip, docXml) {
  zip.file("word/document.xml", new XMLSerializer().serializeToString(docXml));
  const raw = await zip.generateAsync({ type: "blob" });
  return new Blob([raw], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
