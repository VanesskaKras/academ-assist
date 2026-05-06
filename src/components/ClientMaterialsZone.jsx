import { useState, useRef } from "react";

const MAX_FILES = 10;
const MAX_TEXT_CHARS = 8000; // per file, to avoid enormous payloads

export function ClientMaterialsZone({ materials, onAdd, onRemove, manualText, onManualText }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);

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
        if (f.type === "text/plain") {
          const text = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.slice(0, MAX_TEXT_CHARS));
            r.onerror = rej;
            r.readAsText(f, "utf-8");
          });
          onAdd({ name: f.name, text });
        } else if (f.type === "application/pdf") {
          const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.split(",")[1]);
            r.onerror = rej;
            r.readAsDataURL(f);
          });
          const text = await extractPdfText(b64);
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
              ? `Перетягніть або клікніть — PDF або TXT (${materials.length}/${MAX_FILES})`
              : `Максимум ${MAX_FILES} файлів завантажено`}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.txt,text/plain,application/pdf"
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
