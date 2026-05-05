import { isPsychoPed } from "../../lib/planUtils.js";
import { exportToDocx, exportAppendixToDocx, exportSpeechToDocx } from "../../lib/exportDocx.js";
import { SpinDot } from "../SpinDot.jsx";
import { Heading, NavBtn } from "../Buttons.jsx";

export function DoneStage({
  content, displayOrder, titlePage, setTitlePage, titlePageLines,
  regenId, setRegenId, regenPrompt, setRegenPrompt, regenLoading, regenAllLoading,
  loadMsg, appendicesText, setAppendicesText, appendicesLoading, setAppendicesLoading,
  appendicesCustomPrompt, setAppendicesCustomPrompt, speechText, setSpeechText,
  speechLoading, setSpeechLoading, presentationLoading, presentationMsg, presentationReady,
  docxLoading, setDocxLoading, figureRefs, figureKeywords, figKwLoading,
  figPanelOpen, setFigPanelOpen, sections, info, methodInfo,
  doRegenSection, doRegenAll, regenAllAbortRef, doGenAppendices, saveToFirestore,
  copyAll, resetAll, generatePresentation, generateSpeech, doScanAndGenFigures, setStage,
  orderId,
}) {
  return (
    <div className="fade">
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 4 }}>
        <Heading style={{ margin: 0 }}>✓ Роботу завершено!</Heading>
        {!regenAllLoading && <button onClick={doRegenAll} style={{ background: "transparent", border: "1px solid #555", color: "#ccc", borderRadius: 6, padding: "6px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>↺ Переписати всю роботу</button>}
        {regenAllLoading && <><span style={{ fontSize: 12, color: "#888", display: "inline-flex", alignItems: "center", gap: 6 }}><SpinDot />{loadMsg}</span><button onClick={() => regenAllAbortRef.current?.abort()} style={{ background: "#7a1010", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>⏹ Зупинити</button></>}
      </div>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>Текст згенеровано. Скопіюйте або завантажте Word-файл.</p>

      {/* ── ТИТУЛЬНА СТОРІНКА ── */}
      <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47", flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>ТИТУЛЬНА СТОРІНКА</div>
          {titlePage && <button onClick={() => navigator.clipboard.writeText(titlePage)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>}
        </div>
        <div style={{ padding: "14px 18px", background: "#faf8f3" }}>
          {titlePage ? (
            <textarea
              value={titlePage}
              onChange={e => { setTitlePage(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
              onBlur={e => saveToFirestore({ titlePage: e.target.value })}
              onFocus={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
              style={{ width: "100%", minHeight: 200, fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", overflow: "hidden" }}
            />
          ) : (
            <div style={{ fontSize: 12, color: "#888", lineHeight: 1.6 }}>
              Шаблон титульної сторінки не знайдено в методичці. Введіть текст вручну:
              <textarea
                value={titlePage}
                onChange={e => setTitlePage(e.target.value)}
                onBlur={e => saveToFirestore({ titlePage: e.target.value })}
                placeholder={"МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ\nНазва університету\n\nКУРСОВА РОБОТА\nна тему:\n" + (info?.topic || "[ТЕМА]")}
                style={{ width: "100%", minHeight: 160, fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", marginTop: 8 }}
              />
            </div>
          )}
        </div>
      </div>

      {displayOrder.map(sec => {
        const txt = content[sec.id];
        if (!txt) return null;
        const isRegen = regenId === sec.id;
        return (
          <div key={sec.id} style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47", flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</div>
              <button onClick={() => navigator.clipboard.writeText(txt)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
              {!["sources"].includes(sec.type) && (
                <button onClick={() => setRegenId(isRegen ? null : sec.id)} style={{ background: isRegen ? "#e8ff47" : "transparent", color: isRegen ? "#111" : "#aaa", border: "1px solid " + (isRegen ? "#e8ff47" : "#555"), borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}>✏️ Переписати</button>
              )}
            </div>
            {isRegen && (
              <div style={{ padding: "12px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
                <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>ДОДАТКОВІ ВИМОГИ:</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={regenPrompt} onChange={e => setRegenPrompt(e.target.value)} placeholder="Наприклад: більше прикладів, змінити акцент..." style={{ flex: 1, background: "#2a2a20", border: "1px solid #444", borderRadius: 5, color: "#f5f2eb", fontSize: 12, padding: "7px 10px", fontFamily: "'Spectral',serif" }} />
                  <button onClick={() => doRegenSection(sec)} disabled={regenLoading} style={{ background: regenLoading ? "#444" : "#e8ff47", color: "#111", border: "none", borderRadius: 5, padding: "7px 18px", fontSize: 12, cursor: regenLoading ? "default" : "pointer", fontFamily: "'Spectral',serif", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {regenLoading ? <><SpinDot />Генерую...</> : "Переписати →"}
                  </button>
                </div>
              </div>
            )}
            <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto", background: "#faf8f3" }}>{txt}</div>
          </div>
        );
      })}

      {/* ══ ДОДАТКИ ══ */}
      <div style={{ marginTop: 24, border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "11px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>ДОДАТКИ</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {isPsychoPed(info) && <span style={{ fontSize: 10, color: "#888", letterSpacing: 1, marginRight: 8 }}>Додаток А: Анкета дослідження</span>}
            <button onClick={() => navigator.clipboard.writeText(appendicesText)}
              style={{ background: "transparent", color: "#d4d0c8", border: "1px solid #666", borderRadius: 5, padding: "5px 12px", fontFamily: "'Spectral',serif", fontSize: 11, letterSpacing: "0.5px", cursor: "pointer" }}>
              COPY
            </button>
            <button onClick={async () => { setAppendicesLoading(true); try { await exportAppendixToDocx(appendicesText, info, methodInfo, orderId); } catch (e) { alert("Помилка: " + e.message); } setAppendicesLoading(false); }} disabled={appendicesLoading}
              style={{ background: appendicesLoading ? "#555" : "#1a4a1a", color: appendicesLoading ? "#aaa" : "#a8e060", border: "none", borderRadius: 5, padding: "5px 12px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: appendicesLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {appendicesLoading ? <><SpinDot light />...</> : <><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: 5 }}><path d="M6.5 1v7M6.5 8l-2.5-2.5M6.5 8l2.5-2.5" stroke="#a8e060" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 11h9" stroke="#a8e060" strokeWidth="1.5" strokeLinecap="round" /></svg>.docx</>}
            </button>
            <button onClick={() => { setAppendicesText(""); saveToFirestore({ appendicesText: "" }); }}
              style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 5, padding: "5px 10px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer" }}>
              Очистити
            </button>
            <button onClick={doGenAppendices} disabled={appendicesLoading}
              style={{ background: "transparent", border: "1px solid #555", color: "#ccc", borderRadius: 5, padding: "5px 10px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: appendicesLoading ? "default" : "pointer" }}>
              Переробити
            </button>
          </div>
        </div>
        <div style={{ padding: "16px 18px", background: "#faf8f3" }}>
          {!appendicesText ? (
            <div style={{ fontSize: 12, color: "#888", lineHeight: 1.6, display: "inline-flex", alignItems: "center", gap: 8 }}>
              {appendicesLoading ? <><SpinDot />Генерую додатки...</> : "Додатки генеруються автоматично перед початком тексту."}
            </div>
          ) : (
            <div>
              <textarea
                value={appendicesText}
                onChange={e => setAppendicesText(e.target.value)}
                style={{ width: "100%", minHeight: 220, fontSize: 12, lineHeight: "1.85", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box" }}
              />
              <textarea
                value={appendicesCustomPrompt}
                onChange={e => setAppendicesCustomPrompt(e.target.value)}
                placeholder="Інструкції для переробки (необов'язково)..."
                style={{ width: "100%", minHeight: 56, fontSize: 12, lineHeight: "1.7", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "10px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", marginTop: 8 }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Рисунки ── */}
      <div style={{ marginTop: 20, border: "1.5px solid #e8c84a", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "#fff8e8", cursor: "pointer" }} onClick={() => setFigPanelOpen(p => !p)}>
          <span style={{ fontWeight: 600, fontSize: 13, color: "#7a5000", fontFamily: "'Spectral',serif" }}>Рисунки у роботі</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }} onClick={e => e.stopPropagation()}>
            <button onClick={doScanAndGenFigures} disabled={figKwLoading} style={{ fontSize: 11, background: "transparent", border: "1px solid #c8a030", borderRadius: 5, padding: "3px 10px", cursor: figKwLoading ? "default" : "pointer", color: "#7a5000", fontFamily: "'Spectral',serif" }}>
              {figKwLoading ? "Оновлюю..." : "↻ Оновити"}
            </button>
            <span style={{ fontSize: 11, color: "#b08020", fontFamily: "'Spectral',serif" }} onClick={e => { e.stopPropagation(); setFigPanelOpen(p => !p); }}>{figPanelOpen ? "▲ згорнути" : "▼ розгорнути"}</span>
          </div>
        </div>
        {figPanelOpen && (
          <div style={{ padding: "12px 16px", background: "#fffdf5" }}>
            {figKwLoading ? (
              <div style={{ fontSize: 13, color: "#888" }}>Оновлюю рисунки...</div>
            ) : Object.values(figureRefs).every(a => a.length === 0) ? (
              <div style={{ fontSize: 13, color: "#888", fontStyle: "italic" }}>Рисунків у роботі не виявлено</div>
            ) : (
              <>
                {sections.flatMap(sec => (figureRefs[sec.id] || []).map(f => ({ ...f, secLabel: sec.label }))).map((f, i) => {
                  const kw = figureKeywords.find(k => k.label?.toLowerCase() === f.label?.toLowerCase());
                  return (
                    <div key={i} style={{ fontSize: 12, color: "#5a3a00", marginBottom: 10, lineHeight: "1.6", paddingLeft: 10, borderLeft: "3px solid #e8c84a" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600 }}>{f.label}</span>
                        <span style={{ color: "#888", fontSize: 11 }}>{f.secLabel}</span>
                      </div>
                      {kw ? (
                        <>
                          <div style={{ color: "#3a6010", fontSize: 11, marginTop: 2 }}>{kw.name}</div>
                          <div style={{ color: "#1a5a8a", fontSize: 11, marginTop: 2 }}>Пошук: <span style={{ fontStyle: "italic" }}>{kw.keywords}</span></div>
                        </>
                      ) : (
                        <div style={{ color: "#7a5a20", marginTop: 2 }}>...{f.context}...</div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
        <NavBtn onClick={() => setStage("sources")}>← Джерела</NavBtn>
        <button onClick={copyAll} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 30px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: "pointer" }}>Скопіювати текст</button>
        <button disabled={docxLoading} onClick={async () => { setDocxLoading(true); try { await exportToDocx({ sections, content, info, displayOrder, appendicesText, titlePage, titlePageLines, methodInfo, orderId }); } catch (e) { alert("Помилка: " + e.message); } setDocxLoading(false); }}
          style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 30px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {docxLoading ? <><SpinDot light />Генерую Word...</> : "⬇ Завантажити .docx"}
        </button>

        <button onClick={resetAll} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>Нове замовлення</button>
        <button onClick={() => setStage("checklist")} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>Чек-лист →</button>
        <button onClick={() => setStage("corrections")} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>Правки →</button>
      </div>

      {/* ── Додаткові матеріали ── */}
      <div style={{ marginTop: 32, borderTop: "1.5px solid #d4cfc4", paddingTop: 24 }}>
        <div style={{ fontSize: 11, color: "#888", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 16 }}>Додаткові матеріали</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>

          {/* Презентація */}
          <div style={{ flex: 1, minWidth: 220, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Презентація (.pptx)</div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>13 слайдів для захисту з дизайном</div>
            <button
              onClick={generatePresentation}
              disabled={presentationLoading}
              style={{ background: presentationLoading ? "#aaa" : "#1a1a14", color: presentationLoading ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: presentationLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
              {presentationLoading
                ? <><SpinDot light />{presentationMsg || "Генерую..."}</>
                : presentationReady ? "Генерувати знову" : "Генерувати"}
            </button>
            {presentationReady && !presentationLoading && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#2a6a2a", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>✓</span> Файл завантажено
              </div>
            )}
            {!presentationReady && !presentationLoading && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#aaa", lineHeight: 1.5 }}>
                Gemini аналізує текст, Claude генерує слайди
              </div>
            )}
          </div>

          {/* Доповідь */}
          <div style={{ flex: 1, minWidth: 220, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Доповідь (.docx)</div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>Текст виступу на захист (5-7 хвилин)</div>
            {!speechText ? (
              <button onClick={generateSpeech} disabled={speechLoading}
                style={{ background: speechLoading ? "#aaa" : "#1a1a14", color: speechLoading ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: speechLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {speechLoading ? <><SpinDot light />Генерую...</> : "Генерувати"}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: 12, lineHeight: "1.8", color: "#444", maxHeight: 150, overflowY: "auto", background: "#f5f2ea", borderRadius: 6, padding: "10px 12px", marginBottom: 10, whiteSpace: "pre-wrap" }}>
                  {speechText.substring(0, 450)}...
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={async () => { setSpeechLoading(true); try { await exportSpeechToDocx(speechText, info, methodInfo, orderId); } catch (e) { alert("Помилка: " + e.message); } setSpeechLoading(false); }} disabled={speechLoading}
                    style={{ background: speechLoading ? "#aaa" : "#1a4a1a", color: speechLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: speechLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {speechLoading ? <><SpinDot light />...</> : "⬇ Завантажити .docx"}
                  </button>
                  <button onClick={() => setSpeechText("")}
                    style={{ background: "transparent", border: "1.5px solid #d4cfc4", color: "#888", borderRadius: 6, padding: "9px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>
                    Переробити
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
