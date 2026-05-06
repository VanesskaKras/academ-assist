import { useState, useRef } from "react";

const MAX_FILES = 10;
const MAX_TEXT_CHARS = 8000; // per file, to avoid enormous payloads

const XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

export function ClientMaterialsZone({ materials, onAdd, onRemove, manualText, onManualText }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);

  async function loadXlsx() {
    if (window.XLSX) return window.XLSX;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = XLSX_CDN; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.XLSX;
  }

  async function extractXlsxText(arrayBuffer) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const parts = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (!csv.trim()) continue;
      // Конвертуємо CSV → markdown-таблицю
      const rows = csv.split("\n").filter(r => r.trim());
      const mdRows = rows.map((r, i) => {
        const cells = r.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
        const line = "| " + cells.join(" | ") + " |";
        if (i === 0) return line + "\n|" + cells.map(() => "---").join("|") + "|";
        return line;
      });
      parts.push(`=== Аркуш: ${sheetName} ===\n${mdRows.join("\n")}`);
    }
    return parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
  }

  async function extractPdfText(b64) {
    if (!window.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
          resolve();
        };
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      text += content.items.map(i => i.str).join(" ") + "\n";
    }
    return text.trim().slice(0, MAX_TEXT_CHARS);
  }

  async function processFiles(files) {
    const remaining = MAX_FILES - materials.length;
    const toProcess = Array.from(files).slice(0, remaining);
    if (!toProcess.length) return;
    setExtracting(true);
    for (const f of toProcess) {
      try {
        const isText = f.type === "text/plain" || f.name.endsWith(".txt") || f.name.endsWith(".csv");
        const isPdf = f.type === "application/pdf" || f.name.endsWith(".pdf");
        const isXlsx = f.name.endsWith(".xlsx") || f.name.endsWith(".xls") ||
          f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          f.type === "application/vnd.ms-excel";

        if (isText) {
          const text = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.slice(0, MAX_TEXT_CHARS));
            r.onerror = rej;
            r.readAsText(f, "utf-8");
          });
          onAdd({ name: f.name, text });
        } else if (isPdf) {
          const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.split(",")[1]);
            r.onerror = rej;
            r.readAsDataURL(f);
          });
          const text = await extractPdfText(b64);
          onAdd({ name: f.name, text });
        } else if (isXlsx) {
          const arrayBuffer = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result);
            r.onerror = rej;
            r.readAsArrayBuffer(f);
          });
          const text = await extractXlsxText(arrayBuffer);
          onAdd({ name: f.name, text });
        }
      } catch (e) {
        console.warn("ClientMaterialsZone: failed to process", f.name, e.message);
      }
    }
    setExtracting(false);
  }

  const canAdd = materials.length < MAX_FILES;

  return (
    <div>
      <div
        onClick={() => canAdd && fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDragging(false); if (canAdd) processFiles(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        style={{
          minHeight: 64,
          border: `1.5px dashed ${dragging && canAdd ? "#1a1a14" : "#c4bfb4"}`,
          borderRadius: 6,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 4, cursor: canAdd ? "pointer" : "default",
          padding: 12, background: dragging && canAdd ? "#e8e4d8" : "#ede9e0", transition: "all .2s",
        }}
      >
        <div style={{ fontSize: 20 }}>{extracting ? "⏳" : "📎"}</div>
        <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
          {extracting
            ? "Витягую текст..."
            : canAdd
              ? `Перетягніть або клікніть — PDF, TXT, CSV, XLSX (${materials.length}/${MAX_FILES})`
              : `Максимум ${MAX_FILES} файлів завантажено`}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.txt,.csv,.xlsx,.xls,text/plain,application/pdf,text/csv"
        multiple
        style={{ display: "none" }}
        onChange={e => { processFiles(e.target.files); e.target.value = ""; }}
      />

      {materials.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {materials.map((m, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, background: "#e0dbd0", borderRadius: 4, padding: "3px 8px", fontSize: 12, color: "#333" }}>
              <span>📄 {m.name}</span>
              <span style={{ color: "#999", fontSize: 10 }}>({Math.round(m.text.length / 1000)}k)</span>
              <button
                onClick={() => onRemove(i)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#8a1a1a", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
              >×</button>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={manualText}
        onChange={e => onManualText(e.target.value)}
        placeholder="Або вставте текст вручну — власні напрацювання, дані дослідження, таблиці..."
        style={{
          width: "100%", marginTop: 10, minHeight: 80,
          background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6,
          color: "#1a1a14", fontSize: 13, padding: "10px 12px",
          resize: "vertical", lineHeight: 1.7, fontFamily: "'Spectral',Georgia,serif",
        }}
      />
    </div>
  );
}
