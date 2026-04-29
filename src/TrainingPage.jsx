import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { collection, getDocs, doc, setDoc, addDoc, deleteDoc, query, orderBy } from "firebase/firestore";
import { useAuth } from "./AuthContext";
import TrainingTests from "./TrainingTests";

function genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function toYoutubeEmbed(url) {
    if (!url) return "";
    const m = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&]+)/);
    return m ? `https://www.youtube.com/embed/${m[1]}` : url;
}

function toDriveEmbed(url) {
    if (!url) return "";
    const file = url.match(/\/file\/d\/([^\/\?]+)/);
    if (file) return `https://drive.google.com/file/d/${file[1]}/preview`;
    const docs = url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([^\/\?]+)/);
    if (docs) return `https://docs.google.com/${docs[1]}/d/${docs[2]}/preview`;
    const open = url.match(/[?&]id=([^&]+)/);
    if (open) return `https://drive.google.com/file/d/${open[1]}/preview`;
    return url;
}

const isHtml = (s) => /<[a-z][\s\S]*>/i.test(s || "");

// ── Rich text editor ────────────────────────────────────────────────────────

function RichTextEditor({ value, onChange }) {
    const ref = useRef(null);

    useEffect(() => {
        if (ref.current) ref.current.innerHTML = value || "";
    }, []);

    const exec = (cmd, val = null) => {
        ref.current.focus();
        document.execCommand(cmd, false, val);
        onChange(ref.current.innerHTML);
    };

    const tbBtn = {
        background: "transparent", border: "1px solid #ddd", borderRadius: 4,
        padding: "3px 10px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#444",
    };

    return (
        <div>
            <div style={{ display: "flex", gap: 4, padding: "6px 8px", background: "#f5f2eb", borderRadius: "6px 6px 0 0", border: "1.5px solid #e0ddd4", borderBottom: "1px solid #e0ddd4", flexWrap: "wrap", alignItems: "center" }}>
                <button onMouseDown={e => { e.preventDefault(); exec("bold"); }} style={tbBtn} title="Жирний"><b>Ж</b></button>
                <button onMouseDown={e => { e.preventDefault(); exec("underline"); }} style={tbBtn} title="Підкреслений"><u>П</u></button>
                <button onMouseDown={e => { e.preventDefault(); exec("italic"); }} style={tbBtn} title="Курсив"><i>К</i></button>
                <div style={{ width: 1, height: 18, background: "#ddd", margin: "0 2px" }} />
                <select
                    defaultValue=""
                    onChange={e => {
                        if (!e.target.value) return;
                        ref.current.focus();
                        document.execCommand("fontSize", false, e.target.value);
                        e.target.value = "";
                        onChange(ref.current.innerHTML);
                    }}
                    style={{ ...tbBtn, padding: "3px 6px", fontSize: 12 }}
                >
                    <option value="" disabled>Розмір</option>
                    <option value="1">Малий</option>
                    <option value="3">Нормальний</option>
                    <option value="5">Великий</option>
                </select>
                <button onMouseDown={e => { e.preventDefault(); document.execCommand("formatBlock", false, "h3"); onChange(ref.current.innerHTML); }} style={{ ...tbBtn, fontWeight: 700 }} title="Заголовок">H</button>
                <button onMouseDown={e => { e.preventDefault(); document.execCommand("formatBlock", false, "div"); onChange(ref.current.innerHTML); }} style={{ ...tbBtn, fontSize: 11, color: "#999" }} title="Звичайний текст">¶</button>
                <div style={{ width: 1, height: 18, background: "#ddd", margin: "0 2px" }} />
                <button onMouseDown={e => { e.preventDefault(); exec("insertUnorderedList"); }} style={tbBtn} title="Маркований список">• список</button>
                <button onMouseDown={e => { e.preventDefault(); exec("insertOrderedList"); }} style={tbBtn} title="Нумерований список">1. список</button>
                <div style={{ width: 1, height: 18, background: "#ddd", margin: "0 2px" }} />
                <button onMouseDown={e => { e.preventDefault(); exec("removeFormat"); }} style={{ ...tbBtn, fontSize: 11, color: "#999" }}>✕ формат</button>
            </div>
            <div
                ref={ref}
                contentEditable
                suppressContentEditableWarning
                onInput={() => onChange(ref.current.innerHTML)}
                style={{
                    minHeight: 120, padding: "10px 12px",
                    border: "1.5px solid #e0ddd4", borderTop: "none",
                    borderRadius: "0 0 6px 6px",
                    fontSize: 14, fontFamily: "Georgia, serif",
                    lineHeight: 1.7, outline: "none", background: "#fff",
                }}
            />
        </div>
    );
}

// ── Content viewer ───────────────────────────────────────────────────────────

function ContentView({ blocks }) {
    if (!blocks?.length) return (
        <div style={{ color: "#aaa", fontSize: 14, fontStyle: "italic", padding: "20px 0" }}>Контент ще не додано</div>
    );
    return (
        <>
            {blocks.map((block, bi) => {
                const prevIsText = bi > 0 && blocks[bi - 1]?.type === "text";
                if (block.type === "text") {
                    const html = block.value || "";
                    return (
                        <div key={block.id}>
                            {prevIsText && (
                                <div style={{ borderTop: "1.5px solid #f0ece2", margin: "4px 0 20px 0" }} />
                            )}
                            {isHtml(html) ? (
                                <div className="tr-html" style={{ fontSize: 15, lineHeight: 1.85, color: "#2a2a1e", marginBottom: 20 }}
                                    dangerouslySetInnerHTML={{ __html: html }} />
                            ) : (
                                <p style={{ fontSize: 15, lineHeight: 1.85, color: "#2a2a1e", marginBottom: 20, whiteSpace: "pre-wrap" }}>
                                    {html}
                                </p>
                            )}
                        </div>
                    );
                }

                if (block.type === "image" && block.url) return (
                    <div key={block.id} style={{ marginBottom: 28, textAlign: "center" }}>
                        <img src={block.url} alt={block.caption || ""} style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }} />
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "video" && block.url) return (
                    <div key={block.id} style={{ marginBottom: 28 }}>
                        <div style={{ position: "relative", paddingBottom: "56.25%", borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }}>
                            <iframe src={toYoutubeEmbed(block.url)} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }} allowFullScreen title={block.caption || "video"} />
                        </div>
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "drive" && block.url) return (
                    <div key={block.id} style={{ marginBottom: 28 }}>
                        <div style={{ width: "100%", height: 520, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.12)" }}>
                            <iframe src={toDriveEmbed(block.url)} style={{ width: "100%", height: "100%", border: "none" }} allowFullScreen title={block.caption || "Google Drive"} />
                        </div>
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic", textAlign: "center" }}>{block.caption}</div>}
                    </div>
                );

                if (block.type === "table" && block.headers?.length) return (
                    <div key={block.id} style={{ marginBottom: 28, overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                            <thead>
                                <tr>
                                    {block.headers.map((h, i) => (
                                        <th key={i} style={{ padding: "10px 14px", background: "#1a1a14", color: "#e8ff47", fontSize: 12, fontWeight: 700, textAlign: "left", borderRight: "1px solid #333" }}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {(block.rows || []).map((row, ri) => (
                                    <tr key={ri} style={{ background: ri % 2 === 0 ? "#fff" : "#faf8f3" }}>
                                        {row.map((cell, ci) => (
                                            <td key={ci} style={{ padding: "9px 14px", borderBottom: "1px solid #f0ece2", borderRight: "1px solid #f0ece2", color: "#2a2a1e", lineHeight: 1.5 }}>
                                                {cell}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {block.caption && <div style={{ fontSize: 12, color: "#888", marginTop: 8, fontStyle: "italic", textAlign: "center" }}>{block.caption}</div>}
                    </div>
                );

                return null;
            })}
        </>
    );
}

// ── Block editor ─────────────────────────────────────────────────────────────

const miniBtn = {
    background: "transparent", border: "1px solid #ddd", borderRadius: 4,
    padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#666", fontFamily: "inherit",
};

const BLOCK_LABELS = { text: "Текст", image: "Фото", video: "Відео", drive: "Google Drive", table: "Таблиця" };

function BlockEditor({ block, onUpdate, onRemove, onMoveUp, onMoveDown, isFirst, isLast }) {
    return (
        <div style={{ border: "1.5px solid #e0ddd4", borderRadius: 8, padding: 12, marginBottom: 10, background: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 10, color: "#888", background: "#f0ece2", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, fontFamily: "inherit" }}>
                    {BLOCK_LABELS[block.type] || block.type}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    {!isFirst && <button onClick={onMoveUp} style={miniBtn}>↑</button>}
                    {!isLast && <button onClick={onMoveDown} style={miniBtn}>↓</button>}
                    <button onClick={onRemove} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                </div>
            </div>

            {/* Text — rich editor */}
            {block.type === "text" && (
                <RichTextEditor
                    key={block.id}
                    value={block.value || ""}
                    onChange={val => onUpdate({ ...block, value: val })}
                />
            )}

            {/* Image / Video */}
            {(block.type === "image" || block.type === "video") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <input
                        value={block.url || ""}
                        onChange={e => onUpdate({ ...block, url: e.target.value })}
                        placeholder={block.type === "image" ? "URL зображення (https://...)" : "YouTube URL"}
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }}
                    />
                    <input
                        value={block.caption || ""}
                        onChange={e => onUpdate({ ...block, caption: e.target.value })}
                        placeholder="Підпис (необов'язково)"
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", color: "#888", outline: "none" }}
                    />
                </div>
            )}

            {/* Google Drive */}
            {block.type === "drive" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <input
                        value={block.url || ""}
                        onChange={e => onUpdate({ ...block, url: e.target.value })}
                        placeholder="Посилання з Google Drive (файл має бути відкритий для перегляду)"
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }}
                    />
                    <input
                        value={block.caption || ""}
                        onChange={e => onUpdate({ ...block, caption: e.target.value })}
                        placeholder="Підпис (необов'язково)"
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", color: "#888", outline: "none" }}
                    />
                    {block.url && (
                        <div style={{ fontSize: 11, color: "#888", fontStyle: "italic" }}>
                            Embed: {toDriveEmbed(block.url)}
                        </div>
                    )}
                </div>
            )}

            {/* Table */}
            {block.type === "table" && (
                <div>
                    <div style={{ overflowX: "auto", marginBottom: 8 }}>
                        <table style={{ borderCollapse: "collapse", minWidth: 280 }}>
                            <thead>
                                <tr>
                                    {(block.headers || []).map((h, ci) => (
                                        <th key={ci} style={{ padding: 0, verticalAlign: "top" }}>
                                            <div style={{ display: "flex" }}>
                                                <input
                                                    value={h}
                                                    onChange={e => onUpdate({ ...block, headers: block.headers.map((x, i) => i === ci ? e.target.value : x) })}
                                                    style={{ width: "100%", minWidth: 80, padding: "6px 8px", border: "1px solid #e0ddd4", background: "#f5f2eb", fontWeight: 700, fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                                                />
                                                {block.headers.length > 1 && (
                                                    <button onClick={() => onUpdate({
                                                        ...block,
                                                        headers: block.headers.filter((_, i) => i !== ci),
                                                        rows: (block.rows || []).map(r => r.filter((_, i) => i !== ci)),
                                                    })} style={{ background: "#f0ece2", border: "none", color: "#aaa", cursor: "pointer", padding: "0 6px", fontSize: 11 }}>✕</button>
                                                )}
                                            </div>
                                        </th>
                                    ))}
                                    <th style={{ verticalAlign: "middle", paddingLeft: 4 }}>
                                        <button onClick={() => onUpdate({
                                            ...block,
                                            headers: [...(block.headers || []), `Колонка ${(block.headers || []).length + 1}`],
                                            rows: (block.rows || []).map(r => [...r, ""]),
                                        })} style={{ background: "transparent", border: "1px solid #ddd", borderRadius: 4, color: "#888", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" }}>+</button>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {(block.rows || []).map((row, ri) => (
                                    <tr key={ri}>
                                        {row.map((cell, ci) => (
                                            <td key={ci} style={{ padding: 0 }}>
                                                <input
                                                    value={cell}
                                                    onChange={e => onUpdate({
                                                        ...block,
                                                        rows: block.rows.map((r, i) => i === ri ? r.map((c, j) => j === ci ? e.target.value : c) : r),
                                                    })}
                                                    style={{ width: "100%", minWidth: 80, padding: "6px 8px", border: "1px solid #f0ece2", background: "#fff", fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                                                />
                                            </td>
                                        ))}
                                        <td style={{ verticalAlign: "middle", paddingLeft: 4 }}>
                                            <button onClick={() => onUpdate({ ...block, rows: block.rows.filter((_, i) => i !== ri) })}
                                                style={{ background: "transparent", border: "none", color: "#bbb", cursor: "pointer", fontSize: 12, padding: "4px 6px" }}>✕</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <button onClick={() => onUpdate({ ...block, rows: [...(block.rows || []), new Array((block.headers || []).length).fill("")] })}
                            style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888" }}>
                            + Рядок
                        </button>
                    </div>
                    <input
                        value={block.caption || ""}
                        onChange={e => onUpdate({ ...block, caption: e.target.value })}
                        placeholder="Підпис таблиці (необов'язково)"
                        style={{ width: "100%", padding: "6px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: "#888", outline: "none", boxSizing: "border-box" }}
                    />
                </div>
            )}
        </div>
    );
}

// ── Main component ───────────────────────────────────────────────────────────

const BLOCK_TYPES = [
    { type: "text",  label: "+ Текст" },
    { type: "image", label: "+ Фото" },
    { type: "video", label: "+ Відео" },
    { type: "drive", label: "+ Google Drive" },
    { type: "table", label: "+ Таблиця" },
];

const NEW_BLOCK = {
    text:  () => ({ id: genId(), type: "text",  value: "", }),
    image: () => ({ id: genId(), type: "image", url: "", caption: "" }),
    video: () => ({ id: genId(), type: "video", url: "", caption: "" }),
    drive: () => ({ id: genId(), type: "drive", url: "", caption: "" }),
    table: () => ({ id: genId(), type: "table", caption: "", headers: ["Колонка 1", "Колонка 2"], rows: [["", ""], ["", ""]] }),
};

export default function TrainingPage({ onBack }) {
    const { profile } = useAuth();
    const isAdmin = profile?.role === "admin";

    const [sections, setSections] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeId, setActiveId] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [editMode, setEditMode] = useState(false);
    const [editSections, setEditSections] = useState([]);
    const [saving, setSaving] = useState(false);
    const [showTests, setShowTests] = useState(false);

    useEffect(() => {
        const id = "training-content-css";
        if (!document.getElementById(id)) {
            const el = document.createElement("style");
            el.id = id;
            el.textContent = `
                .tr-html ul,.tr-html ol{margin:8px 0 10px 22px;padding:0}
                .tr-html ul{list-style:disc}
                .tr-html ol{list-style:decimal}
                .tr-html li{margin:3px 0;line-height:1.8}
                .tr-html h2{font-size:1.2em;font-weight:700;margin:14px 0 6px;color:#1a1a14}
                .tr-html h3{font-size:1.08em;font-weight:700;margin:12px 0 5px;color:#1a1a14}
                .tr-html h4{font-size:1em;font-weight:700;margin:10px 0 4px;color:#3a3a2e}
                .tr-html p{margin:5px 0}
                .tr-html div{min-height:1em}
            `;
            document.head.appendChild(el);
        }
    }, []);

    useEffect(() => { loadSections(); }, []);

    const deserializeSection = (raw) => ({
        ...raw,
        subsections: (raw.subsections || []).map(sub => ({
            ...sub,
            content: (sub.content || []).map(block => {
                if (block.type !== "table") return block;
                return {
                    ...block,
                    rows: (block.rows || []).map(row =>
                        Array.isArray(row) ? row : (row.cells || [])
                    ),
                };
            }),
        })),
    });

    const serializeSection = (sec) => ({
        ...sec,
        subsections: (sec.subsections || []).map(sub => ({
            ...sub,
            content: (sub.content || []).map(block => {
                if (block.type !== "table") return block;
                return {
                    ...block,
                    rows: (block.rows || []).map(row => ({ cells: row })),
                };
            }),
        })),
    });

    const loadSections = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(query(collection(db, "training_sections"), orderBy("order")));
            const data = snap.docs.map(d => deserializeSection({ id: d.id, ...d.data() }));
            setSections(data);
            if (data.length > 0) {
                const first = data[0];
                setExpanded({ [first.id]: true });
                setActiveId({ sectionId: first.id, subsectionId: first.subsections?.[0]?.id ?? null });
            }
        } finally {
            setLoading(false);
        }
    };

    const saveEdit = async () => {
        setSaving(true);
        try {
            const existingIds = new Set(sections.map(s => s.id));
            const keepIds = new Set(editSections.filter(s => !s._new).map(s => s.id));
            for (const id of existingIds) {
                if (!keepIds.has(id)) await deleteDoc(doc(db, "training_sections", id));
            }
            for (let i = 0; i < editSections.length; i++) {
                const { _new, id, ...raw } = editSections[i];
                raw.order = i + 1;
                const data = serializeSection(raw);
                if (_new) await addDoc(collection(db, "training_sections"), data);
                else await setDoc(doc(db, "training_sections", id), data);
            }
            await loadSections();
            setEditMode(false);
        } catch (e) { console.error(e); }
        setSaving(false);
    };

    const startEdit = () => {
        setEditSections(JSON.parse(JSON.stringify(sections)));
        setEditMode(true);
    };

    // ── Edit helpers ──────────────────────────────────────────────────────────

    const updSec = (i, patch) =>
        setEditSections(p => p.map((s, j) => j === i ? { ...s, ...patch } : s));

    const updSub = (si, subi, patch) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : { ...sub, ...patch })
        }));

    const updBlock = (si, subi, bi, blk) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : {
                ...sub, content: sub.content.map((b, k) => k !== bi ? b : blk)
            })
        }));

    const moveBlock = (si, subi, bi, dir) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => {
                if (j !== subi) return sub;
                const c = [...sub.content];
                const t = bi + dir;
                if (t < 0 || t >= c.length) return sub;
                [c[bi], c[t]] = [c[t], c[bi]];
                return { ...sub, content: c };
            })
        }));

    const addBlock = (si, subi, type) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : {
                ...sub, content: [...(sub.content || []), NEW_BLOCK[type]()]
            })
        }));

    const rmBlock = (si, subi, bi) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.map((sub, j) => j !== subi ? sub : {
                ...sub, content: sub.content.filter((_, k) => k !== bi)
            })
        }));

    const addSub = (si) => {
        const sub = { id: genId(), title: "Новий підрозділ", content: [] };
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: [...(s.subsections || []), sub]
        }));
    };

    const rmSub = (si, subi) =>
        setEditSections(p => p.map((s, i) => i !== si ? s : {
            ...s, subsections: s.subsections.filter((_, j) => j !== subi)
        }));

    const moveSub = (si, subi, dir) =>
        setEditSections(p => p.map((s, i) => {
            if (i !== si) return s;
            const subs = [...s.subsections];
            const t = subi + dir;
            if (t < 0 || t >= subs.length) return s;
            [subs[subi], subs[t]] = [subs[t], subs[subi]];
            return { ...s, subsections: subs };
        }));

    const addSec = () =>
        setEditSections(p => [...p, { _new: true, id: genId(), title: "Новий розділ", order: p.length + 1, subsections: [] }]);

    const rmSec = (si) =>
        setEditSections(p => p.filter((_, i) => i !== si));

    const moveSec = (si, dir) =>
        setEditSections(p => {
            const arr = [...p];
            const t = si + dir;
            if (t < 0 || t >= arr.length) return p;
            [arr[si], arr[t]] = [arr[t], arr[si]];
            return arr;
        });

    const getActive = () => {
        if (!activeId) return null;
        const sec = sections.find(s => s.id === activeId.sectionId);
        if (!sec) return null;
        const sub = sec.subsections?.find(s => s.id === activeId.subsectionId) ?? null;
        return { sec, sub };
    };

    const toggleExpand = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));

    if (showTests) return <TrainingTests onBack={() => setShowTests(false)} />;

    const headerBtn = { background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 };
    const primBtn = { background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "7px 20px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 };

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "Georgia, serif" }}>
            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    {onBack && <button onClick={onBack} style={headerBtn}>← Назад</button>}
                    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 3 }}>ACADEM — НАВЧАННЯ</span>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    {isAdmin && !editMode && (
                        <button onClick={startEdit} style={{ ...headerBtn, color: "#e8ff47", borderColor: "#888" }}>Редагувати</button>
                    )}
                    {isAdmin && editMode && (
                        <>
                            <button onClick={() => setEditMode(false)} style={headerBtn}>Скасувати</button>
                            <button onClick={saveEdit} disabled={saving} style={{ ...primBtn, opacity: saving ? 0.6 : 1 }}>
                                {saving ? "Збереження..." : "Зберегти"}
                            </button>
                        </>
                    )}
                    {!editMode && (
                        <button onClick={() => setShowTests(true)} style={primBtn}>Тести →</button>
                    )}
                </div>
            </div>

            {loading ? (
                <div style={{ padding: 60, textAlign: "center", color: "#888", fontSize: 14 }}>Завантаження...</div>
            ) : editMode ? (
                /* ── EDITOR ── */
                <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>
                    {editSections.length === 0 && (
                        <div style={{ textAlign: "center", padding: "48px 0", color: "#aaa", fontSize: 14 }}>
                            Розділів ще немає. Додайте перший розділ.
                        </div>
                    )}

                    {editSections.map((sec, si) => (
                        <div key={sec.id} style={{ background: "#fff", borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                            {/* Section title */}
                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, paddingBottom: 16, borderBottom: "1.5px solid #f0ece2" }}>
                                <span style={{ fontSize: 10, color: "#888", background: "#f0ece2", padding: "2px 10px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0, fontFamily: "inherit" }}>
                                    Розділ {si + 1}
                                </span>
                                <input
                                    value={sec.title}
                                    onChange={e => updSec(si, { title: e.target.value })}
                                    style={{ flex: 1, fontSize: 16, fontWeight: 700, fontFamily: "Georgia, serif", border: "none", borderBottom: "2px solid #e0ddd4", background: "transparent", padding: "4px 0", outline: "none", color: "#1a1a14" }}
                                />
                                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                    {si > 0 && <button onClick={() => moveSec(si, -1)} style={miniBtn}>↑</button>}
                                    {si < editSections.length - 1 && <button onClick={() => moveSec(si, 1)} style={miniBtn}>↓</button>}
                                    <button onClick={() => { if (window.confirm("Видалити розділ?")) rmSec(si); }} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                                </div>
                            </div>

                            {/* Subsections */}
                            {(sec.subsections || []).map((sub, subi) => (
                                <div key={sub.id} style={{ marginBottom: 20, paddingLeft: 16, borderLeft: "3px solid #e8ff47" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                                        <span style={{ fontSize: 10, color: "#888", background: "#fdf9e8", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0, fontFamily: "inherit" }}>Підрозділ</span>
                                        <input
                                            value={sub.title}
                                            onChange={e => updSub(si, subi, { title: e.target.value })}
                                            style={{ flex: 1, fontSize: 14, fontWeight: 600, fontFamily: "Georgia, serif", border: "none", borderBottom: "1.5px solid #e0ddd4", background: "transparent", padding: "3px 0", outline: "none", color: "#1a1a14" }}
                                        />
                                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                            {subi > 0 && <button onClick={() => moveSub(si, subi, -1)} style={miniBtn}>↑</button>}
                                            {subi < sec.subsections.length - 1 && <button onClick={() => moveSub(si, subi, 1)} style={miniBtn}>↓</button>}
                                            <button onClick={() => { if (window.confirm("Видалити підрозділ?")) rmSub(si, subi); }} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                                        </div>
                                    </div>

                                    {/* Content blocks */}
                                    {(sub.content || []).map((blk, bi) => (
                                        <BlockEditor
                                            key={blk.id}
                                            block={blk}
                                            isFirst={bi === 0}
                                            isLast={bi === sub.content.length - 1}
                                            onUpdate={b => updBlock(si, subi, bi, b)}
                                            onRemove={() => rmBlock(si, subi, bi)}
                                            onMoveUp={() => moveBlock(si, subi, bi, -1)}
                                            onMoveDown={() => moveBlock(si, subi, bi, 1)}
                                        />
                                    ))}

                                    {/* Add block buttons */}
                                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                                        {BLOCK_TYPES.map(({ type, label }) => (
                                            <button key={type} onClick={() => addBlock(si, subi, type)}
                                                style={{ background: "#f5f2eb", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#666" }}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}

                            <button onClick={() => addSub(si)}
                                style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 7, padding: "7px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 8 }}>
                                + Додати підрозділ
                            </button>
                        </div>
                    ))}

                    <button onClick={addSec}
                        style={{ width: "100%", background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 10, padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                        + Додати розділ
                    </button>
                </div>
            ) : (
                /* ── READING VIEW ── */
                <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 20px", display: "flex", gap: 28, alignItems: "flex-start" }}>
                    {/* Sidebar */}
                    <div style={{ width: 240, flexShrink: 0, position: "sticky", top: 24 }}>
                        <div style={{ background: "#fff", borderRadius: 12, paddingTop: 8, paddingBottom: 8, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                            {sections.length === 0 ? (
                                <div style={{ padding: "20px", color: "#aaa", fontSize: 13 }}>
                                    {isAdmin ? "Натисніть «Редагувати» щоб додати контент." : "Контент ще не додано."}
                                </div>
                            ) : sections.map(sec => (
                                <div key={sec.id}>
                                    <div
                                        onClick={() => {
                                            toggleExpand(sec.id);
                                            const firstSub = sec.subsections?.[0];
                                            setActiveId({ sectionId: sec.id, subsectionId: firstSub?.id ?? null });
                                        }}
                                        style={{
                                            padding: "10px 18px", cursor: "pointer", fontWeight: 600, fontSize: 13,
                                            color: activeId?.sectionId === sec.id ? "#1a1a14" : "#555",
                                            background: activeId?.sectionId === sec.id && !activeId?.subsectionId ? "#f0ece2" : "transparent",
                                            borderLeft: activeId?.sectionId === sec.id && !activeId?.subsectionId ? "3px solid #1a1a14" : "3px solid transparent",
                                            display: "flex", alignItems: "center", gap: 8, transition: "all .15s",
                                        }}
                                    >
                                        <span style={{ fontSize: 10, color: "#bbb", minWidth: 10 }}>{expanded[sec.id] ? "▾" : "▸"}</span>
                                        {sec.title}
                                    </div>
                                    {expanded[sec.id] && (sec.subsections || []).map(sub => (
                                        <div
                                            key={sub.id}
                                            onClick={() => setActiveId({ sectionId: sec.id, subsectionId: sub.id })}
                                            style={{
                                                padding: "8px 18px 8px 38px", cursor: "pointer", fontSize: 12,
                                                color: activeId?.subsectionId === sub.id ? "#1a1a14" : "#888",
                                                background: activeId?.subsectionId === sub.id ? "#eef5d8" : "transparent",
                                                borderLeft: activeId?.subsectionId === sub.id ? "3px solid #8ac040" : "3px solid transparent",
                                                fontWeight: activeId?.subsectionId === sub.id ? 600 : 400,
                                                transition: "all .15s",
                                            }}
                                        >
                                            {sub.title}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        {!activeId ? (
                            <div style={{ padding: "40px 0", color: "#aaa", fontSize: 14 }}>Оберіть розділ</div>
                        ) : (() => {
                            const active = getActive();
                            if (!active) return null;
                            const { sec, sub } = active;
                            return (
                                <div style={{ background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                    <div style={{ fontSize: 11, color: "#aaa", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6, fontFamily: "inherit" }}>{sec.title}</div>
                                    <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1a1a14", margin: "0 0 28px 0", borderBottom: "2px solid #f0ece2", paddingBottom: 16 }}>
                                        {sub?.title || sec.title}
                                    </h2>
                                    <ContentView blocks={sub?.content || []} />
                                </div>
                            );
                        })()}
                    </div>
                </div>
            )}
        </div>
    );
}
