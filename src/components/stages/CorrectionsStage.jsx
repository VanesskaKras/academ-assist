import { SpinDot } from "../SpinDot.jsx";
import { Heading, NavBtn } from "../Buttons.jsx";
import { PhotoDropZone } from "../PhotoDropZone.jsx";

export function CorrectionsStage({
  sections,
  correctionText, setCorrectionText,
  correctionPhotos, setCorrectionPhotos,
  correctionAnalysis,
  correctionChecked, setCorrectionChecked,
  correctionLoading,
  correctionApplyLoading,
  correctionHistory,
  doAnalyzeCorrections,
  doApplyCorrections,
  setStage,
}) {
  const checkedCount = Object.values(correctionChecked).filter(Boolean).length;
  const analysisItems = correctionAnalysis || [];

  function toggleAll(val) {
    const next = {};
    analysisItems.forEach(item => { next[item.sectionId] = val; });
    setCorrectionChecked(next);
  }

  return (
    <div className="fade">
      <Heading>Правки від викладача</Heading>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
        Введіть зауваження — програма визначить які розділи потребують виправлення і переписує тільки їх,
        зберігаючи тему і контекст роботи.
      </p>

      {/* ── ВВЕДЕННЯ ПРАВОК ── */}
      <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 14, overflow: "hidden" }}>
        <div style={{ padding: "11px 16px", background: "#1a1a14", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47", flexShrink: 0 }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>Зауваження</div>
        </div>
        <div style={{ padding: "14px 16px", background: "#faf8f3" }}>
          <textarea
            value={correctionText}
            onChange={e => setCorrectionText(e.target.value)}
            placeholder="Вставте текст зауважень від викладача... Наприклад: «Висновки до розділу 2 надто короткі. Вступ не відповідає темі. Список літератури оформлено неправильно.»"
            style={{
              width: "100%", minHeight: 120, fontSize: 13, lineHeight: "1.8",
              color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6,
              padding: "12px 14px", border: "1px solid #d4cfc4",
              fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box",
            }}
          />
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>
              АБО ДОДАЙТЕ ФОТО ЗАУВАЖЕНЬ:
            </div>
            <PhotoDropZone
              photos={correctionPhotos}
              onAdd={photo => setCorrectionPhotos(prev => [...prev, photo])}
              onRemove={i => setCorrectionPhotos(prev => prev.filter((_, idx) => idx !== i))}
            />
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
            <button
              onClick={doAnalyzeCorrections}
              disabled={correctionLoading || (!correctionText.trim() && correctionPhotos.length === 0)}
              style={{
                background: (correctionLoading || (!correctionText.trim() && correctionPhotos.length === 0)) ? "#444" : "#e8ff47",
                color: "#111", border: "none", borderRadius: 6,
                padding: "9px 24px", fontFamily: "'Spectral',serif",
                fontSize: 13, cursor: correctionLoading ? "default" : "pointer",
                display: "inline-flex", alignItems: "center", gap: 8,
              }}
            >
              {correctionLoading ? <><SpinDot />Аналізую...</> : "Проаналізувати →"}
            </button>
            {correctionLoading && (
              <span style={{ fontSize: 12, color: "#888" }}>Claude визначає які розділи потребують змін</span>
            )}
          </div>
        </div>
      </div>

      {/* ── РЕЗУЛЬТАТ АНАЛІЗУ ── */}
      {analysisItems.length > 0 && (
        <div style={{ border: "1.5px solid #4a6a00", borderRadius: 8, marginBottom: 14, overflow: "hidden" }}>
          <div style={{ padding: "11px 16px", background: "#1a2a00", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#a8e060", flexShrink: 0 }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>
                Розділи для виправлення ({analysisItems.length})
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => toggleAll(true)} style={{ fontSize: 10, color: "#a8e060", background: "transparent", border: "1px solid #4a6a00", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "'Spectral',serif" }}>
                Всі
              </button>
              <button onClick={() => toggleAll(false)} style={{ fontSize: 10, color: "#888", background: "transparent", border: "1px solid #444", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "'Spectral',serif" }}>
                Жоден
              </button>
            </div>
          </div>
          <div style={{ background: "#faf8f3" }}>
            {analysisItems.map((item, i) => {
              const sec = sections.find(s => s.id === item.sectionId);
              const label = sec?.label || item.sectionId;
              const checked = correctionChecked[item.sectionId] !== false;
              return (
                <div key={i} style={{ padding: "12px 16px", borderBottom: i < analysisItems.length - 1 ? "1px solid #e8e4dc" : "none", display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => setCorrectionChecked(prev => ({ ...prev, [item.sectionId]: e.target.checked }))}
                    style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#2a2a1e", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 12, color: "#c04020", marginBottom: 3 }}>
                      <span style={{ fontWeight: 600 }}>Проблема:</span> {item.issue}
                    </div>
                    <div style={{ fontSize: 12, color: "#3a6010" }}>
                      <span style={{ fontWeight: 600 }}>Що виправити:</span> {item.suggestion}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "12px 16px", background: "#1a2a00", display: "flex", gap: 10, alignItems: "center" }}>
            <button
              onClick={doApplyCorrections}
              disabled={correctionApplyLoading || checkedCount === 0}
              style={{
                background: (correctionApplyLoading || checkedCount === 0) ? "#444" : "#1a4a1a",
                color: (correctionApplyLoading || checkedCount === 0) ? "#aaa" : "#a8e060",
                border: "none", borderRadius: 6,
                padding: "9px 24px", fontFamily: "'Spectral',serif",
                fontSize: 13, cursor: (correctionApplyLoading || checkedCount === 0) ? "default" : "pointer",
                display: "inline-flex", alignItems: "center", gap: 8,
              }}
            >
              {correctionApplyLoading
                ? <><SpinDot light />Виправляю...</>
                : `Виправити обрані (${checkedCount}) →`}
            </button>
            {correctionApplyLoading && (
              <span style={{ fontSize: 12, color: "#6a9000" }}>Claude переписує розділи зберігаючи тему і контекст</span>
            )}
          </div>
        </div>
      )}

      {/* ── ІСТОРІЯ ПРАВОК ── */}
      {correctionHistory.length > 0 && (
        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
          <div style={{ padding: "11px 16px", background: "#1a1a14", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>
              Історія правок ({correctionHistory.length})
            </div>
          </div>
          <div style={{ background: "#faf8f3" }}>
            {[...correctionHistory].reverse().map((entry, i) => {
              const date = entry.timestamp?.toDate
                ? entry.timestamp.toDate().toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
                : entry.clientTimestamp
                  ? new Date(entry.clientTimestamp).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
                  : "—";
              const affected = entry.sectionsAffected || [];
              return (
                <div key={i} style={{ padding: "10px 16px", borderBottom: i < correctionHistory.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "#2a2a1e", lineHeight: 1.6 }}>
                        {entry.text?.substring(0, 120)}{entry.text?.length > 120 ? "..." : ""}
                        {!entry.text && entry.hasPhoto && <span style={{ color: "#888", fontStyle: "italic" }}>Фото зауважень</span>}
                      </div>
                      {affected.length > 0 && (
                        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {affected.map((sid, j) => {
                            const s = correctionHistory[0] ? sections.find(sec => sec.id === sid) : null;
                            return (
                              <span key={j} style={{ fontSize: 10, background: "#e8f4d8", color: "#3a6010", borderRadius: 4, padding: "2px 7px" }}>
                                {s?.label || sid}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap", flexShrink: 0 }}>{date}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <NavBtn onClick={() => setStage("done")}>← Готово</NavBtn>
      </div>
    </div>
  );
}
