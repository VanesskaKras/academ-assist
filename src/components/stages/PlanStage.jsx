import { parseClientPlan, buildPlanText, calcSourceDist } from "../../lib/planUtils.js";
import { exportPlanToDocx } from "../../lib/exportDocx.js";
import { SpinDot } from "../SpinDot.jsx";
import { Heading, NavBtn, PrimaryBtn, GreenBtn } from "../Buttons.jsx";
import { PlanLoadingSkeleton } from "../PlanLoadingSkeleton.jsx";

export function PlanStage({
  sections, setSections, planDisplay, setPlanDisplay, planLoading, clientPlan,
  showManualPlanInput, setShowManualPlanInput, manualPlanText, setManualPlanText,
  planDocxLoading, setPlanDocxLoading, namingLoading, totalPagesNum,
  info, methodInfo, content, doGenPlan, doNamePlaceholders, startGen, setStage,
  setSourceDist, setSourceTotal, addNewChapter, recalcPages, workflowMode,
}) {
  return (
    <div className="fade">
      <Heading>03 / План роботи</Heading>
      {planLoading ? (
        <>{clientPlan ? (
          <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>ПЛАН КЛІЄНТА (обробляється...)</div>
            <div style={{ padding: "14px 18px", background: "#faf8f3" }}><pre style={{ fontFamily: "'Spectral',serif", fontSize: 13, color: "#888", whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{clientPlan}</pre></div>
          </div>
        ) : null}
          <PlanLoadingSkeleton /></>
      ) : sections.length > 0 ? (
        <>
          <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Відредагуйте назви та к-сть сторінок. Після затвердження плану — починайте написання.</p>

          {/* Plan text block */}
          <div style={{ background: "#1a1a14", color: "#f5f2eb", borderRadius: 8, padding: 20, marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Spectral SC'", fontSize: 11, color: "#e8ff47", letterSpacing: 3 }}>ПЛАН ДЛЯ КОПІЮВАННЯ</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => navigator.clipboard.writeText(planDisplay)} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
                <button onClick={() => { setShowManualPlanInput(v => !v); setManualPlanText(""); }} style={{ background: showManualPlanInput ? "#3a2a00" : "transparent", border: "1px solid #888", color: "#e8c84a", borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>✏ Замінити</button>
                <button
                  disabled={planDocxLoading}
                  onClick={async () => { setPlanDocxLoading(true); try { await exportPlanToDocx({ sections, info, methodInfo }); } catch (e) { alert("Помилка: " + e.message); } setPlanDocxLoading(false); }}
                  style={{ background: planDocxLoading ? "#444" : "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 5, padding: "4px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {planDocxLoading ? <><SpinDot light />...</> : "⬇ .docx"}
                </button>
              </div>
            </div>
            <pre style={{ fontFamily: "'Spectral',serif", fontSize: 13, lineHeight: "2.1", whiteSpace: "pre-wrap", color: "#e0ddd4", margin: 0 }}>{planDisplay}</pre>
          </div>

          {showManualPlanInput && (
            <div style={{ background: "#1e1c0e", border: "1.5px solid #e8c84a", borderRadius: 8, padding: 16, marginBottom: 18 }}>
              <div style={{ fontFamily: "'Spectral SC'", fontSize: 11, color: "#e8c84a", letterSpacing: 3, marginBottom: 10 }}>ВСТАВИТИ НОВИЙ ПЛАН</div>
              <textarea
                value={manualPlanText}
                onChange={e => setManualPlanText(e.target.value)}
                placeholder={"РОЗДІЛ 1. Назва розділу\n    1.1 Назва підрозділу\n    1.2 Назва підрозділу\nРОЗДІЛ 2. Назва розділу\n    2.1 Назва підрозділу\n    ..."}
                style={{ width: "100%", minHeight: 180, background: "#141410", color: "#e0ddd4", border: "1px solid #555", borderRadius: 6, padding: "10px 12px", fontFamily: "'Spectral',serif", fontSize: 13, lineHeight: 1.8, resize: "vertical", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => {
                    const parsed = parseClientPlan(manualPlanText.trim(), totalPagesNum);
                    if (!parsed || !parsed.length) { alert("Не вдалося розпізнати план. Перевірте формат."); return; }
                    const withPrompts = parsed.map(s => ({ ...s, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil((s.pages || 3) / 3)) }));
                    setSections(withPrompts);
                    setPlanDisplay(buildPlanText(withPrompts));
                    const { dist, total } = calcSourceDist(withPrompts);
                    setSourceDist(dist); setSourceTotal(total);
                    setShowManualPlanInput(false);
                    setManualPlanText("");
                  }}
                  style={{ background: "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: 1 }}
                >Застосувати</button>
                <button
                  onClick={() => { setShowManualPlanInput(false); setManualPlanText(""); }}
                  style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "7px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}
                >Скасувати</button>
              </div>
            </div>
          )}

          {/* Sections table */}
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10, padding: "8px 12px", background: "#f0ece2", borderRadius: 6, lineHeight: "1.6" }}>
            ✏️ Редагуй назви та сторінки прямо в таблиці. Кнопка <strong>+</strong> — додати підрозділ, <strong>✕</strong> — видалити.
          </div>
          <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 22 }}>
            <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", background: "#1a1a14", color: "#e8ff47", padding: "9px 14px", fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase" }}>
              <div>#</div><div>Підрозділ</div><div style={{ textAlign: "center" }}>Стор.</div><div style={{ textAlign: "center" }}>Промти</div><div />
            </div>
            {(() => {
              let lastChapterTitle = null;
              let rowNum = 0;
              const rows = [];
              sections.forEach((s, i) => {
                const isSpecial = ["intro", "conclusions", "sources"].includes(s.type);
                const isChapterConclusion = s.type === "chapter_conclusion";
                const isMainSub = !isSpecial && !isChapterConclusion && s.sectionTitle;
                if (isMainSub && s.sectionTitle !== lastChapterTitle) {
                  lastChapterTitle = s.sectionTitle;
                  rows.push(
                    <div key={`chhead-${s.sectionTitle}`} style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", borderBottom: "1px solid #e4dfd4", background: "#ddd8c8", alignItems: "center" }}>
                      <div style={{ padding: "8px 10px" }} />
                      <div style={{ padding: "8px 8px", fontSize: 12, fontWeight: "bold", color: "#1a1a14", letterSpacing: "0.5px", gridColumn: "2 / 6", textTransform: "uppercase" }}>{s.sectionTitle}</div>
                    </div>
                  );
                }
                rowNum++;
                rows.push(
                  <div key={s.id} className="sec-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: isSpecial ? "#ede9e0" : rowNum % 2 === 0 ? "#f5f2eb" : "#f0ece2", alignItems: "center", transition: "background .15s" }}>
                    <div style={{ padding: "9px 10px", fontSize: 12, color: "#bbb" }}>{rowNum}</div>
                    <input value={s.label} onChange={e => { const val = e.target.value; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, label: val } : x); setPlanDisplay(buildPlanText(next)); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 8px", color: isSpecial ? "#888" : "#1a1a14", fontStyle: isSpecial ? "italic" : "normal", width: "100%", fontFamily: "'Spectral',serif" }} />
                    <input type="number" min="1" value={s.pages} onChange={e => { const v = parseInt(e.target.value) || 1; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, pages: v, prompts: x.type === "sources" ? 0 : Math.max(1, Math.ceil(v / 3)) } : x); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 4px", color: "#1a1a14", textAlign: "center", width: "100%", fontFamily: "'Spectral',serif" }} />
                    <div style={{ textAlign: "center", fontSize: 12, color: "#888", padding: "9px" }}>{s.type === "sources" ? "—" : s.prompts}</div>
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <button onClick={() => setSections(p => { const next = p.filter((_, j) => j !== i); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; })} style={{ background: "transparent", border: "none", color: "#bbb", fontSize: 15, cursor: "pointer", padding: "2px 4px", borderRadius: 4 }} onMouseEnter={e => e.currentTarget.style.color = "#c03030"} onMouseLeave={e => e.currentTarget.style.color = "#bbb"}>✕</button>
                    </div>
                  </div>
                );
              });
              return rows;
            })()}
            <div style={{ padding: "10px 14px", background: "#f5f2eb", borderTop: "1px solid #e4dfd4", display: "flex", gap: 8 }}>
              <button onClick={() => {
                const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
                const lastId = mainSecs.length ? mainSecs[mainSecs.length - 1].id : "1.0";
                const [ch, sub] = lastId.split(".").map(Number);
                const newId = `${ch}.${(sub || 0) + 1}`;
                const newSec = { id: newId, label: `${newId} Новий підрозділ`, sectionTitle: mainSecs[mainSecs.length - 1]?.sectionTitle || "", pages: Math.max(1, Math.round(totalPagesNum * 0.1)), prompts: 1, type: mainSecs[mainSecs.length - 1]?.type || "theory" };
                setSections(p => { const introIdx = p.findIndex(s => s.type === "intro"); const next = introIdx >= 0 ? [...p.slice(0, introIdx), newSec, ...p.slice(introIdx)] : [...p, newSec]; setPlanDisplay(buildPlanText(next)); return next; });
              }} style={{ background: "transparent", border: "1.5px dashed #bbb4a0", color: "#888", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#1a1a14"; e.currentTarget.style.color = "#1a1a14"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#bbb4a0"; e.currentTarget.style.color = "#888"; }}>
                + Підрозділ
              </button>
              <button onClick={addNewChapter} style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
                + Розділ
              </button>
              <button onClick={recalcPages} style={{ background: "transparent", border: "1.5px dashed #a0a0a0", color: "#888", borderRadius: 6, padding: "7px 14px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer", letterSpacing: "0.5px", whiteSpace: "nowrap" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#555"; e.currentTarget.style.color = "#555"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#a0a0a0"; e.currentTarget.style.color = "#888"; }}>
                ⟳ стор.
              </button>
            </div>
          </div>

          {sections.some(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && /\[|\bновий\b/i.test(s.label)) && (
            <div style={{ marginBottom: 14 }}>
              <GreenBtn
                onClick={doNamePlaceholders}
                loading={namingLoading}
                msg="Генерую назви..."
                label="✨ Придумати назви для заглушок"
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <NavBtn onClick={() => setStage("parsed")}>← Назад</NavBtn>
            {Object.keys(content).length > 0 && (
              <NavBtn onClick={() => setStage(workflowMode === "sources-first" ? "sources" : "writing")}>
                Вперед (продовжити) →
              </NavBtn>
            )}
          </div>

          {/* Вибір режиму */}
          <div style={{ marginTop: 16, padding: "16px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#2a4010", marginBottom: 12 }}>Оберіть порядок роботи:</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => startGen("sources-first")}
                style={{
                  flex: 1, minWidth: 200, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                  fontFamily: "'Spectral',serif", fontSize: 13, textAlign: "left", lineHeight: 1.5,
                  background: "#2a3a1a", color: "#e8ff47", border: "2px solid #5a9a1a",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Спочатку джерела →</div>
                <div style={{ fontSize: 11, color: "#a8d060", opacity: 0.9 }}>Знайдіть джерела, потім AI пише текст спираючись на них і вставляє [1][2] одразу</div>
              </button>
              <button
                onClick={() => startGen("text-first")}
                style={{
                  flex: 1, minWidth: 200, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                  fontFamily: "'Spectral',serif", fontSize: 13, textAlign: "left", lineHeight: 1.5,
                  background: "#1a1a14", color: "#f5f2eb", border: "2px solid #555",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Спочатку текст →</div>
                <div style={{ fontSize: 11, color: "#aaa", opacity: 0.9 }}>AI генерує текст без посилань, потім ви додаєте джерела і розставляєте їх окремо</div>
              </button>
            </div>
          </div>
        </>
      ) : (
        <div style={{ color: "#888", fontSize: 14 }}>
          Помилка генерації.{" "}
          <button onClick={doGenPlan} style={{ background: "none", border: "none", color: "#1a1a14", textDecoration: "underline", cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>Спробувати ще раз</button>
        </div>
      )}
    </div>
  );
}
