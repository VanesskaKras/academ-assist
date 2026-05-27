import { useState, useRef, useEffect } from "react";
import mammoth from "mammoth";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { callClaude, MODEL, MODEL_FAST } from "./lib/api.js";
import { SYS_JSON_ARRAY, buildFileCorrectionsAnalysisPrompt, buildFileApplyCorrectionPrompt } from "./lib/prompts.js";
import { SpinDot } from "./components/SpinDot.jsx";

// ── Простий експорт тексту як .docx ──
async function exportCorrectedDocx(text, originalName) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = window.docx;
  const FONT = "Times New Roman";
  const SIZE = 28; // 14pt

  const paragraphs = text.split("\n").map(line => {
    const trimmed = line.trim();
    const isHeading = /^(РОЗДІЛ|ВСТУП|ВИСНОВКИ|СПИСОК|ДОДАТКИ|\d+\.\s)/i.test(trimmed);
    return new Paragraph({
      alignment: isHeading ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
      spacing: { line: 360 },
      indent: isHeading ? {} : { firstLine: 709 },
      children: [new TextRun({
        text: trimmed,
        font: FONT,
        size: SIZE,
        bold: isHeading,
      })],
    });
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1134, bottom: 1134, left: 1701, right: 851 },
        },
      },
      children: paragraphs,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const base = originalName?.replace(/\.docx$/i, "") || "документ";
  a.href = url;
  a.download = `${base}_виправлено.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Стилі ──
const cardStyle = {
  border: "1.5px solid #d4cfc4",
  borderRadius: 8,
  overflow: "hidden",
  marginBottom: 14,
};
const cardHead = (bg = "#1a1a14") => ({
  padding: "11px 16px",
  background: bg,
  display: "flex",
  alignItems: "center",
  gap: 10,
});
const cardBody = { padding: "14px 16px", background: "#faf8f3" };
const dot = (color) => ({
  width: 8, height: 8, borderRadius: "50%",
  background: color, flexShrink: 0,
});
const labelStyle = { fontSize: 13, fontWeight: 600, color: "#f5f2eb" };
const btnPrimary = (disabled) => ({
  background: disabled ? "#444" : "#1a1a14",
  color: disabled ? "#888" : "#e8ff47",
  border: "none", borderRadius: 6,
  padding: "9px 24px", fontFamily: "'Spectral',serif",
  fontSize: 13, cursor: disabled ? "default" : "pointer",
  display: "inline-flex", alignItems: "center", gap: 8,
});
const btnGreen = (disabled) => ({
  background: disabled ? "#444" : "#1a4a1a",
  color: disabled ? "#aaa" : "#a8e060",
  border: "none", borderRadius: 6,
  padding: "9px 24px", fontFamily: "'Spectral',serif",
  fontSize: 13, cursor: disabled ? "default" : "pointer",
  display: "inline-flex", alignItems: "center", gap: 8,
});

// ── КРОКИ ──
const STEPS = ["Файл", "Правки", "Аналіз", "Готово"];

function StepBar({ current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 24, gap: 0 }}>
      {STEPS.map((s, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : "initial" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                background: done ? "#6a9000" : active ? "#1a1a14" : "#ddd",
                color: done ? "#fff" : active ? "#e8ff47" : "#aaa",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
              }}>
                {done ? "✓" : i + 1}
              </div>
              <div style={{ fontSize: 10, color: active ? "#1a1a14" : "#aaa", fontWeight: active ? 700 : 400, letterSpacing: 0.5 }}>
                {s}
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ flex: 1, height: 2, background: done ? "#6a9000" : "#ddd", margin: "0 4px", marginBottom: 16 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function FileCorrectionsPage({ onBack }) {
  const { user } = useAuth();
  const [step, setStep] = useState(0); // 0=file, 1=corrections, 2=analysis/apply, 3=done

  // Крок 1
  const [fileName, setFileName] = useState("");
  const [docText, setDocText] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const fileRef = useRef();

  // Крок 2
  const [correctionsText, setCorrectionsText] = useState("");

  // Крок 3
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [tasks, setTasks] = useState([]); // [{id, location, issue, suggestion}]
  const [checked, setChecked] = useState({});
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [currentDocText, setCurrentDocText] = useState("");
  const [error, setError] = useState("");

  // Крок 4
  const [correctedText, setCorrectedText] = useState("");

  // Відстеження витрат
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0 });
  const [sessionCost, setSessionCost] = useState(0);

  useEffect(() => {
    const handler = (e) => {
      const isGemini = e.detail.model?.startsWith("gemini");
      const isSerper = e.detail.model === "serper";
      if (isGemini || isSerper) return;
      const inTok = e.detail.inTok || 0;
      const outTok = e.detail.outTok || 0;
      const cost = e.detail.cost || 0;
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + inTok,
        outTok: tokenAccRef.current.outTok + outTok,
        costUsd: tokenAccRef.current.costUsd + cost,
        claudeInTok: tokenAccRef.current.claudeInTok + inTok,
        claudeOutTok: tokenAccRef.current.claudeOutTok + outTok,
        claudeCostUsd: tokenAccRef.current.claudeCostUsd + cost,
      };
      setSessionCost(c => c + cost);
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  async function handleFile(file) {
    if (!file) return;
    setFileLoading(true);
    setError("");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = result.value.trim();
      if (!text) throw new Error("Не вдалося витягти текст з документа");
      setFileName(file.name);
      setDocText(text);
      setCurrentDocText(text);
      setStep(1);
    } catch (e) {
      setError("Помилка читання файлу: " + e.message);
    }
    setFileLoading(false);
  }

  async function doAnalyze() {
    if (!correctionsText.trim()) return;
    setAnalysisLoading(true);
    setError("");
    setTasks([]);
    setChecked({});
    try {
      const prompt = buildFileCorrectionsAnalysisPrompt({
        documentText: docText,
        correctionsText,
      });
      const raw = await callClaude(
        [{ role: "user", content: prompt }],
        null,
        SYS_JSON_ARRAY,
        2000,
        null,
        MODEL_FAST,
      );
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error("Некоректна відповідь");
      const defaultChecked = {};
      parsed.forEach(t => { defaultChecked[t.id] = true; });
      setTasks(parsed);
      setChecked(defaultChecked);
      setStep(2);
    } catch (e) {
      setError("Помилка аналізу: " + e.message);
    }
    setAnalysisLoading(false);
  }

  async function doApply() {
    const toFix = tasks.filter(t => checked[t.id]);
    if (!toFix.length) return;
    setApplyLoading(true);
    setApplyProgress(0);
    setError("");
    let text = currentDocText;
    try {
      for (let i = 0; i < toFix.length; i++) {
        const task = toFix[i];
        const prompt = buildFileApplyCorrectionPrompt({
          documentText: text,
          location: task.location,
          issue: task.issue,
          suggestion: task.suggestion,
        });
        const result = await callClaude(
          [{ role: "user", content: prompt }],
          null,
          null,
          10000,
          null,
          MODEL,
        );
        try {
          const jsonStr = result.replace(/```json|```/g, "").trim();
          const { original, replacement } = JSON.parse(jsonStr);
          if (original && replacement && text.includes(original)) {
            text = text.replace(original, replacement);
          }
          // якщо оригінал не знайдено — пропускаємо це виправлення
        } catch {
          // якщо JSON не розпарсився — пропускаємо
        }
        setApplyProgress(i + 1);
      }
      setCorrectedText(text);
      setCurrentDocText(text);
      setStep(3);
      // Зберігаємо сесію в Firestore щоб витрати відображались в адмінці
      try {
        const acc = tokenAccRef.current;
        await addDoc(collection(db, "orders"), {
          mode: "file_corrections",
          uid: user?.uid || null,
          createdAt: new Date().toISOString(),
          timestamp: serverTimestamp(),
          fileName,
          correctionsApplied: toFix.length,
          totalInTok: acc.inTok,
          totalOutTok: acc.outTok,
          totalCostUsd: acc.costUsd,
          claudeInTok: acc.claudeInTok,
          claudeOutTok: acc.claudeOutTok,
          claudeCostUsd: acc.claudeCostUsd,
          geminiInTok: 0,
          geminiOutTok: 0,
          geminiCostUsd: 0,
          serperCredits: 0,
          serperCostUsd: 0,
          info: { topic: `Правки: ${fileName}`, orderNumber: null },
          type: "file_corrections",
        });
      } catch { /* не блокуємо UI якщо Firestore недоступний */ }
    } catch (e) {
      setError("Помилка виправлення: " + e.message);
    }
    setApplyLoading(false);
  }

  function toggleAll(val) {
    const next = {};
    tasks.forEach(t => { next[t.id] = val; });
    setChecked(next);
  }

  const checkedCount = Object.values(checked).filter(Boolean).length;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#f5f2eb",
      fontFamily: "'Spectral', Georgia, serif",
      padding: "0 0 60px",
    }}>
      {/* Хедер */}
      <div style={{
        background: "#1a1a14",
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        position: "sticky", top: 0, zIndex: 10,
      }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", color: "#888", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >
          ←
        </button>
        <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3 }}>
          ПРАВКИ ДО ФАЙЛУ
        </div>
        {sessionCost > 0 && (
          <div style={{ marginLeft: "auto", fontSize: 11, color: "#888", fontFamily: "monospace" }}>
            сесія: ${sessionCost.toFixed(4)}
          </div>
        )}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 0" }}>
        <StepBar current={step} />

        {error && (
          <div style={{ background: "#fff0f0", border: "1.5px solid #f00a", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 13, color: "#c00" }}>
            {error}
          </div>
        )}

        {/* ── КРОК 0: Завантаження файлу ── */}
        {step === 0 && (
          <div style={cardStyle}>
            <div style={cardHead()}>
              <div style={dot("#e8ff47")} />
              <div style={labelStyle}>Завантажте вашу роботу (.docx)</div>
            </div>
            <div style={cardBody}>
              <div
                onClick={() => fileRef.current.click()}
                onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                onDragOver={e => e.preventDefault()}
                style={{
                  minHeight: 120,
                  border: "1.5px dashed #c4bfb4",
                  borderRadius: 6,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  cursor: "pointer",
                  background: "#ede9e0",
                }}
              >
                {fileLoading
                  ? <><SpinDot /><div style={{ fontSize: 12, color: "#888" }}>Читаю файл...</div></>
                  : <>
                    <div style={{ fontSize: 32 }}>📄</div>
                    <div style={{ fontSize: 13, color: "#555" }}>Перетягніть або клікніть щоб вибрати .docx</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>Тільки Word документи (.docx)</div>
                  </>
                }
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".docx"
                style={{ display: "none" }}
                onChange={e => handleFile(e.target.files[0])}
              />
            </div>
          </div>
        )}

        {/* ── КРОК 1: Введення правок ── */}
        {step === 1 && (
          <>
            {/* Файл завантажено */}
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Файл завантажено</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "#a8e060" }}>{fileName}</div>
              </div>
              <div style={{ ...cardBody, maxHeight: 160, overflowY: "auto" }}>
                <pre style={{ fontSize: 11, color: "#555", whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>
                  {docText.slice(0, 600)}{docText.length > 600 ? "\n..." : ""}
                </pre>
              </div>
            </div>

            {/* Введення правок */}
            <div style={cardStyle}>
              <div style={cardHead()}>
                <div style={dot("#e8ff47")} />
                <div style={labelStyle}>Зауваження викладача</div>
              </div>
              <div style={cardBody}>
                <textarea
                  value={correctionsText}
                  onChange={e => setCorrectionsText(e.target.value)}
                  placeholder={"Вставте зауваження від викладача...\nНаприклад: «Висновки надто короткі. Вступ не розкриває актуальність. Список літератури оформлено неправильно.»"}
                  style={{
                    width: "100%", minHeight: 140, fontSize: 13,
                    lineHeight: "1.8", color: "#2a2a1e", background: "#f5f2ea",
                    borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4",
                    fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box",
                  }}
                />
                <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
                  <button
                    onClick={doAnalyze}
                    disabled={analysisLoading || !correctionsText.trim()}
                    style={btnPrimary(analysisLoading || !correctionsText.trim())}
                  >
                    {analysisLoading ? <><SpinDot />Аналізую...</> : "Проаналізувати →"}
                  </button>
                  {analysisLoading && (
                    <span style={{ fontSize: 12, color: "#888" }}>Claude визначає що потрібно виправити</span>
                  )}
                </div>
              </div>
            </div>

            <button
              onClick={() => setStep(0)}
              style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}
            >
              ← Завантажити інший файл
            </button>
          </>
        )}

        {/* ── КРОК 2: Підтвердження та виконання ── */}
        {step === 2 && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={{ ...cardHead("#1a2a00"), justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot("#a8e060")} />
                  <div style={labelStyle}>Що потрібно виправити ({tasks.length})</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => toggleAll(true)} style={{ fontSize: 10, color: "#a8e060", background: "transparent", border: "1px solid #4a6a00", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "'Spectral',serif" }}>Всі</button>
                  <button onClick={() => toggleAll(false)} style={{ fontSize: 10, color: "#888", background: "transparent", border: "1px solid #444", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "'Spectral',serif" }}>Жоден</button>
                </div>
              </div>
              <div style={{ background: "#faf8f3" }}>
                {tasks.map((task, i) => {
                  const isChecked = checked[task.id] !== false;
                  return (
                    <div key={i} style={{
                      padding: "12px 16px",
                      borderBottom: i < tasks.length - 1 ? "1px solid #e8e4dc" : "none",
                      display: "flex", gap: 12, alignItems: "flex-start",
                      opacity: isChecked ? 1 : 0.45,
                    }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={e => setChecked(prev => ({ ...prev, [task.id]: e.target.checked }))}
                        style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          {task.location}
                        </div>
                        <div style={{ fontSize: 13, color: "#c04020", marginBottom: 3 }}>
                          <span style={{ fontWeight: 600 }}>Проблема:</span> {task.issue}
                        </div>
                        <div style={{ fontSize: 13, color: "#3a6010" }}>
                          <span style={{ fontWeight: 600 }}>Що зробити:</span> {task.suggestion}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ padding: "12px 16px", background: "#1a2a00", display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  onClick={doApply}
                  disabled={applyLoading || checkedCount === 0}
                  style={btnGreen(applyLoading || checkedCount === 0)}
                >
                  {applyLoading
                    ? <><SpinDot light />Виправляю ({applyProgress}/{tasks.filter(t => checked[t.id]).length})...</>
                    : `Виконати обрані (${checkedCount}) →`}
                </button>
                {applyLoading && (
                  <span style={{ fontSize: 12, color: "#6a9000" }}>Claude застосовує виправлення</span>
                )}
              </div>
            </div>

            <button
              onClick={() => setStep(1)}
              style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}
            >
              ← Змінити зауваження
            </button>
          </>
        )}

        {/* ── КРОК 3: Готово ── */}
        {step === 3 && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Виправлення внесено</div>
              </div>
              <div style={{ ...cardBody, maxHeight: 300, overflowY: "auto" }}>
                <pre style={{ fontSize: 12, color: "#333", whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>
                  {correctedText.slice(0, 1200)}{correctedText.length > 1200 ? "\n\n...[решта документа]" : ""}
                </pre>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                onClick={() => exportCorrectedDocx(correctedText, fileName)}
                style={btnGreen(false)}
              >
                Завантажити виправлений .docx
              </button>
              <button
                onClick={() => { setStep(1); setTasks([]); setChecked({}); setCorrectedText(""); setApplyProgress(0); }}
                style={{ ...btnPrimary(false), background: "transparent", color: "#555", border: "1px solid #ccc" }}
              >
                Внести ще правки
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
