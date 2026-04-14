import { useState, useRef, useCallback } from "react";

export function DropZone({ fileLabel, onFile, accept = ".pdf" }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const handleDrop = useCallback(e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }, []);
  function processFile(f) { const r = new FileReader(); r.onload = ev => onFile(f.name, ev.target.result.split(",")[1], f.type); r.readAsDataURL(f); }
  return <>
    <div onClick={() => fileRef.current.click()} onDrop={handleDrop} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      style={{ minHeight: 90, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", padding: 14, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}>
      <div style={{ fontSize: 24 }}>{fileLabel ? "📄" : "⬆️"}</div>
      <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>{fileLabel || "Перетягніть або клікніть для вибору PDF"}</div>
      {fileLabel && <div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div>}
    </div>
    <input ref={fileRef} type="file" accept={accept} style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (f) processFile(f); }} />
  </>;
}
