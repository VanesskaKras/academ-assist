import { TA_WHITE } from "../../shared.jsx";
import { Heading, NavBtn, PrimaryBtn, GreenBtn } from "../Buttons.jsx";

export function SourcesStage({
  mainSections, citInputs, setCitInputs, sourceDist, sourceTotal,
  keywords, kwLoading, kwError, setKwError, methodInfo, commentAnalysis,
  allRefs, refList, showMissingSources, citInputsSnapshot, allCitLoading, info,
  doGenKeywords, doAddAllCitations, onFinish, setStage,
}) {
  let runningIdx = 0;
  const missingSections = mainSections.filter(s => !(citInputs[s.id] || "").trim());
  const visibleSections = showMissingSources ? missingSections : mainSections;

  return (
    <div className="fade">
      <Heading>05 / Джерела</Heading>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#888" }}>Загальна к-сть джерел: <strong style={{ color: "#1a1a14" }}>{sourceTotal}</strong>{methodInfo?.sourcesMinCount ? <span style={{ marginLeft: 8, fontSize: 11, color: "#8a5a1a" }}>(мін. {methodInfo.sourcesMinCount} за методичкою)</span> : null}</div>
        {methodInfo && (methodInfo.sourcesStyle || methodInfo.sourcesOrder) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {methodInfo.sourcesStyle && <span style={{ fontSize: 11, background: "#e4f0ff", color: "#1a5a8a", padding: "2px 10px", borderRadius: 10 }}>📋 {methodInfo.sourcesStyle}</span>}
            {methodInfo.sourcesOrder && <span style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 10px", borderRadius: 10 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 За алфавітом" : "🔢 За порядком появи"}</span>}
          </div>
        )}
        <GreenBtn onClick={() => { setKwError(""); doGenKeywords(); }} loading={kwLoading} msg="Генерую ключові слова..." label={Object.keys(keywords).length > 0 ? "Оновити ключові слова" : "Генерувати ключові слова →"} />
        {kwError && <div style={{ fontSize: 12, color: "#8a1a1a", background: "#fff5f5", border: "1px solid #e8b0b0", borderRadius: 6, padding: "4px 10px" }}>⚠ {kwError}</div>}
      </div>
      <div style={{ padding: "12px 16px", background: "#f0f5e8", border: "1px solid #c8dfa0", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#3a6010", lineHeight: "1.7" }}>
        <strong>Як це працює:</strong> Вставте знайдені джерела до кожного підрозділу (кожне з нового рядка). Після заповнення натисніть <em>"Розставити всі посилання"</em>.
        <div style={{ marginTop: 8 }}>
          <a
            href={`https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "4px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}
          >
            🎓 Шукати джерела на Google Scholar →
          </a>
        </div>
      </div>
      {(methodInfo?.recommendedSources || commentAnalysis?.sourcesHints) && (
        <div style={{ padding: "12px 16px", background: "#fff8e8", border: "1px solid #e8d48a", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#5a3a00", lineHeight: "1.7" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Рекомендації щодо джерел:</div>
          {methodInfo?.recommendedSources && (
            <div style={{ marginBottom: commentAnalysis?.sourcesHints ? 8 : 0 }}>
              <span style={{ fontSize: 11, color: "#8a6010", textTransform: "uppercase", letterSpacing: "0.5px" }}>З методички: </span>
              {methodInfo.recommendedSources}
            </div>
          )}
          {commentAnalysis?.sourcesHints && (
            <div>
              <span style={{ fontSize: 11, color: "#8a6010", textTransform: "uppercase", letterSpacing: "0.5px" }}>Від клієнта: </span>
              {commentAnalysis.sourcesHints}
            </div>
          )}
        </div>
      )}
      {allRefs.length > 0 && (
        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>ПОПЕРЕДНІЙ СПИСОК ДЖЕРЕЛ ({allRefs.length} позицій)</div>
          <div style={{ padding: "12px 16px", background: "#faf8f3", maxHeight: 180, overflowY: "auto" }}>
            {allRefs.map((r, i) => (
              <div key={i} style={{ fontSize: 12, color: "#444", marginBottom: 4, lineHeight: "1.5" }}>
                <span style={{ color: "#e8ff47", background: "#1a1a14", padding: "1px 6px", borderRadius: 4, marginRight: 8, fontSize: 11 }}>{i + 1}</span>{r}
              </div>
            ))}
          </div>
        </div>
      )}
      {visibleSections.map(sec => {
        const secRefs = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
        const startIdx = runningIdx + 1; runningIdx += secRefs.length;
        const hasSources = secRefs.length > 0;
        return (
          <div key={sec.id} style={{ border: `1.5px solid ${hasSources ? "#d4cfc4" : "#e8a050"}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
            <div style={{ background: "#1a1a14", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: hasSources ? "#5ad060" : "#e8a050", flexShrink: 0, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {secRefs.length > 0 && <div style={{ fontSize: 11, color: "#888" }}>джерела [{startIdx}–{startIdx + secRefs.length - 1}]</div>}
                <div style={{ fontSize: 12, color: "#e8ff47", background: "#2a2a1a", padding: "2px 10px", borderRadius: 10 }}>потрібно: {sourceDist[sec.id] || "?"} дж.</div>
              </div>
            </div>
            <div style={{ padding: "14px 18px", background: "#faf8f3" }}>
              {Array.isArray(keywords[sec.id]) && keywords[sec.id].length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Шукайте за фразами:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {keywords[sec.id].map((kw, ki) => <span key={ki} onClick={() => navigator.clipboard.writeText(kw)} title="Клікни щоб скопіювати" style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none" }}>{kw}</span>)}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Вставте джерела (кожне з нового рядка):</div>
              <textarea value={citInputs[sec.id] || ""}
                onChange={e => { setCitInputs(p => ({ ...p, [sec.id]: e.target.value })); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onFocus={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onPaste={e => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData("text");
                  const el = e.target;
                  const start = el.selectionStart;
                  const end = el.selectionEnd;
                  const prev = citInputs[sec.id] || "";
                  const next = prev.slice(0, start) + pasted + "\n" + prev.slice(end);
                  setCitInputs(p => ({ ...p, [sec.id]: next }));
                  requestAnimationFrame(() => {
                    el.style.height = "auto";
                    el.style.height = el.scrollHeight + "px";
                    const pos = start + pasted.length + 1;
                    el.setSelectionRange(pos, pos);
                  });
                }}
                placeholder={"Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с.\nSmirnova O. Child development. Oxford: OUP, 2019."}
                style={{ ...TA_WHITE, minHeight: 80, overflow: "hidden", resize: "none" }} />
              {secRefs.length > 0 && <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 4 }}>✓ {secRefs.length} джерело(а) введено → [{startIdx}–{startIdx + secRefs.length - 1}]</div>}
            </div>
          </div>
        );
      })}
      <div style={{ padding: "16px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "#3a6010", marginBottom: 12 }}>
          Всього введено: <strong>{allRefs.length}</strong> з {sourceTotal} рекомендованих.
        </div>
        {(() => {
          const alreadyDone = refList.length > 0 && citInputsSnapshot !== null;
          const sourcesChanged = alreadyDone && JSON.stringify(citInputs) !== citInputsSnapshot;
          if (!alreadyDone) return <GreenBtn onClick={doAddAllCitations} disabled={allRefs.length === 0} loading={allCitLoading} msg="Обробляю підрозділи..." label="Розставити всі посилання та сформувати список літератури →" />;
          if (sourcesChanged) return <GreenBtn onClick={doAddAllCitations} disabled={allRefs.length === 0} loading={allCitLoading} msg="Обробляю підрозділи..." label="Джерела змінились — перерозставити посилання →" />;
          return null;
        })()}
      </div>
      {refList.length > 0 && (
        <div style={{ border: "1.5px solid #2a3a1a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ ({methodInfo?.sourcesStyle || "ДСТУ 8302:2015"})</span>
            <button onClick={() => navigator.clipboard.writeText(refList.join("\n"))} style={{ background: "transparent", border: "1px solid #5a7a3a", color: "#a8d060", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}>COPY</button>
          </div>
          <div style={{ padding: "14px 18px", background: "#faf8f3", maxHeight: 300, overflowY: "auto" }}>
            {refList.map((r, i) => <div key={i} style={{ fontSize: 13, color: "#2a2a1e", marginBottom: 6, lineHeight: "1.7" }}>{r}</div>)}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
        <NavBtn onClick={() => setStage("writing")}>← До тексту</NavBtn>
        <PrimaryBtn onClick={onFinish} label="Завершити роботу →" />
      </div>
    </div>
  );
}
