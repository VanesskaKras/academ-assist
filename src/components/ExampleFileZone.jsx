import { useState, useRef } from "react";
import mammoth from "mammoth";

const MAX_TEXT_CHARS = 50000;

// Односайлова зона: приймає .docx (mammoth) або .pdf (pdf.js), одразу витягує
// текст і повертає його через onExtracted — сирі байти файлу нікуди не зберігаються.
export function ExampleFileZone({ hint, fileName, onExtracted }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");

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
    return text.trim();
  }

  async function processFile(f) {
    const name = f.name.toLowerCase();
    const isDocx = name.endsWith(".docx") ||
      f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const isPdf = name.endsWith(".pdf") || f.type === "application/pdf";
    if (!isDocx && !isPdf) {
      setError("Підтримуються лише .docx та .pdf. Якщо файл .doc — спершу збережіть його як .pdf.");
      return;
    }
    setError("");
    setExtracting(true);
    try {
      let text;
      if (isDocx) {
        const arrayBuffer = await f.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value.trim();
      } else {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = ev => res(ev.target.result.split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        text = await extractPdfText(b64);
      }
      onExtracted(f.name, text.slice(0, MAX_TEXT_CHARS));
    } catch (e) {
      setError("Не вдалось прочитати файл: " + e.message);
    }
    setExtracting(false);
  }

  return (
    <div>
      <div
        onClick={() => fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        style={{
          minHeight: 64, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`,
          borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 4, cursor: "pointer", padding: 12, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s",
        }}
      >
        <div style={{ fontSize: 20 }}>{extracting ? "⏳" : fileName ? "📄" : "⬆️"}</div>
        <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
          {extracting
            ? "Витягую текст..."
            : fileName
              ? `${fileName} (клікніть щоб замінити)`
              : (hint || "Перетягніть або клікніть — .docx, .pdf")}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        style={{ display: "none" }}
        onChange={e => { const f = e.target.files[0]; if (f) processFile(f); e.target.value = ""; }}
      />
      {error && <div style={{ color: "#c55", fontSize: 11, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
