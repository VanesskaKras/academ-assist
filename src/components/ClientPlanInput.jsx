import { useState, useRef } from "react";
import { callClaude, MODEL_FAST } from "../lib/api.js";

export function ClientPlanInput({ onExtracted, extracted }) {
  const fileRef = useRef();
  const [extracting, setExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewSrc, setPreviewSrc] = useState(null);

  async function handlePhoto(file) {
    if (!file || !file.type.startsWith("image/")) return;
    setExtracting(true);
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => { setPreviewSrc(e.target.result); res(e.target.result.split(",")[1]); };
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const raw = await callClaude([{
        role: "user", content: [
          { type: "image", source: { type: "base64", media_type: file.type, data: b64 } },
          { type: "text", text: "Extract the table of contents / plan from this image. Copy all lines exactly as they appear (chapter numbers, subsection numbers, titles). Return only the plain text of the plan, no explanations." }
        ]
      }], null, "Return only plain text, no markdown.", 800, null, MODEL_FAST);
      onExtracted(raw.trim());
    } catch (e) {
      console.warn("plan photo extract failed:", e.message);
    } finally {
      setExtracting(false);
      setDragging(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handlePhoto(file);
  }

  return <>
    <div
      onClick={() => !extracting && fileRef.current.click()}
      onDrop={onDrop}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      style={{ minHeight: 90, border: `1.5px dashed ${dragging ? "#5a8a30" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: extracting ? "wait" : "pointer", padding: 14, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}
    >
      {extracting
        ? <><div style={{ fontSize: 22 }}>⏳</div><div style={{ fontSize: 12, color: "#888" }}>Розпізнаю план...</div></>
        : previewSrc && extracted
          ? <><img src={previewSrc} alt="" style={{ maxHeight: 56, maxWidth: "100%", borderRadius: 4, objectFit: "contain" }} /><div style={{ fontSize: 11, color: "#5a8a30" }}>✓ План розпізнано</div><div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div></>
          : <><div style={{ fontSize: 22 }}>📷</div><div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>Перетягніть або клікніть для вибору фото плану</div></>
      }
    </div>
    <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
      onChange={e => { const f = e.target.files[0]; if (f) handlePhoto(f); e.target.value = ""; }} />
  </>;
}
