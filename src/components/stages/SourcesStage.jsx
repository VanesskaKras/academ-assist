import { useState } from "react";
import { lookupDoiMetadata, paperToCitation } from "../../lib/sourcesSearch.js";
import { TA_WHITE } from "../../shared.jsx";
import { Heading, NavBtn, PrimaryBtn, GreenBtn } from "../Buttons.jsx";
import { SpinDot } from "../SpinDot.jsx";

// ── Картка одного знайденого джерела ──
function SourceCard({ paper, checked, onToggle }) {
  const authorsList = Array.isArray(paper.authors) ? paper.authors : [];
  const authLine = authorsList.length > 2
    ? `${authorsList.slice(0, 2).join(', ')} та ін.`
    : authorsList.join(', ') || 'Автор невідомий';
  const isUk = paper.lang === 'uk';
  const isPl = paper.lang === 'pl';
  const langBg = isUk ? '#e8f5e0' : isPl ? '#fff0f5' : '#e8f0ff';
  const langColor = isUk ? '#3a6010' : isPl ? '#8a1050' : '#1a4a8a';
  const langBorder = isUk ? '#b8dfa0' : isPl ? '#e0a0c0' : '#b0c8f0';
  const langLabel = isUk ? '🇺🇦 укр.' : isPl ? '🇵🇱 польськ.' : '🌐 зарубіж.';
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
      padding: '9px 12px', borderRadius: 7,
      background: checked ? '#f0f8e8' : '#faf8f3',
      border: `1.5px solid ${checked ? '#8cc84b' : '#e0ddd5'}`,
      marginBottom: 6, transition: 'all 0.15s',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginTop: 3, accentColor: '#5a9a1a', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: authorsList.length ? '#3a6010' : '#8a6010' }}>{authLine}</span>
          {!authorsList.length && paper.doi && <span style={{ fontSize: 10, color: '#8a6010', fontStyle: 'italic' }}>↗ буде уточнено по DOI</span>}
          {paper.year && <span style={{ fontSize: 11, color: '#888' }}>{paper.year}</span>}
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 8,
            background: langBg, color: langColor, border: `1px solid ${langBorder}`,
            flexShrink: 0,
          }}>{langLabel}</span>
          {paper.type === 'book' && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 8,
              background: '#fff5e0', color: '#8a5a00', border: '1px solid #e8c870',
              flexShrink: 0,
            }}>📚 книга</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#1a1a14', lineHeight: '1.4', marginBottom: 2 }}>
          {paper.title.length > 120 ? paper.title.slice(0, 120) + '…' : paper.title}
        </div>
        {(paper.venue || paper.pages) && (
          <div style={{ fontSize: 11, color: '#777', fontStyle: 'italic' }}>
            {paper.venue}{paper.pages ? ` · С. ${paper.pages}` : ''}
          </div>
        )}
        {paper.url && (
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ display: 'inline-block', marginTop: 4, fontSize: 11, color: '#1a5a8a', textDecoration: 'none' }}
          >
            🔗 Відкрити джерело →
          </a>
        )}
      </div>
    </label>
  );
}

export function SourcesStage({
  mainSections, citInputs, setCitInputs, citStructured, setCitStructured, sourceDist, sourceTotal,
  keywords, kwLoading, kwError, setKwError, methodInfo, commentAnalysis,
  allRefs, refList, showMissingSources, citInputsSnapshot, allCitLoading, info,
  suggestedSources, phraseGroups, sourcesSearchLoading, sourcesSearchError, doSearchSources, doRegenSectionSources,
  doGenKeywords, doAddAllCitations, onAddAbstracts, onFinish, onProceedToWriting, setStage, workflowMode,
}) {
  const [selectedSugg, setSelectedSugg] = useState({});
  const [suggOpen, setSuggOpen] = useState({});
  // "secId_phraseIdx" → поточна сторінка (1-based)
  const [phrasePages, setPhrasePages] = useState({});

  let runningIdx = 0;
  const missingSections = mainSections.filter(s => !(citInputs[s.id] || "").trim());
  const visibleSections = showMissingSources ? missingSections : mainSections;

  const isChecked = (secId, paperId) =>
    (selectedSugg[secId] || []).some(p => p.id === paperId);

  const togglePaper = (secId, paper) => {
    setSelectedSugg(prev => {
      const cur = prev[secId] || [];
      const exists = cur.some(p => p.id === paper.id);
      return {
        ...prev,
        [secId]: exists ? cur.filter(p => p.id !== paper.id) : [...cur, paper],
      };
    });
  };

  const selectAll = (secId) => {
    setSelectedSugg(prev => ({
      ...prev,
      [secId]: [...(suggestedSources[secId] || [])],
    }));
  };

  const clearAll = (secId) => {
    setSelectedSugg(prev => ({ ...prev, [secId]: [] }));
  };

  const handleAddSelected = async (secId) => {
    const allSelected = selectedSugg[secId] || [];
    if (!allSelected.length) return;

    // Збагачуємо всі записи з DOI через CrossRef (отримуємо структуровані дані)
    const enriched = await Promise.all(allSelected.map(async p => {
      if (!p.doi) return p;
      const meta = await lookupDoiMetadata(p.doi);
      if (!meta) return p;
      return {
        ...p,
        ...(meta.authorsStructured?.length ? { authorsStructured: meta.authorsStructured } : {}),
        ...(meta.authors?.length ? { authors: meta.authors } : {}),
        ...(meta.pages && !p.pages ? { pages: meta.pages } : {}),
        ...(meta.volume ? { volume: meta.volume } : {}),
        ...(meta.issue ? { issue: meta.issue } : {}),
        ...(meta.journal && (!p.venue || /^[\w.-]+\.[a-zA-Z]{2,}$/.test(p.venue.trim())) ? { venue: meta.journal } : {}),
        ...(meta.publisher ? { publisher: meta.publisher } : {}),
        ...(meta.publisherLocation ? { publisherLocation: meta.publisherLocation } : {}),
      };
    }));

    // Обмежуємо зарубіжні до 30%
    const needed = sourceDist[secId] || 4;
    const maxForeign = Math.max(1, Math.round(needed * 0.3));
    const ukPapers = enriched.filter(p => p.lang === 'uk');
    const enPapers = enriched.filter(p => p.lang !== 'uk').slice(0, maxForeign);
    const papers = [...ukPapers, ...enPapers];

    const newLines = papers.map(paperToCitation).filter(Boolean);
    if (!newLines.length) return;

    // Зберігаємо abstract snippets для промпту генерації тексту
    if (onAddAbstracts) {
      const entries = {};
      papers.forEach((p, i) => {
        if (p.abstract && newLines[i]) entries[newLines[i]] = p.abstract;
      });
      if (Object.keys(entries).length) onAddAbstracts(entries);
    }

    // Використовуємо prev щоб уникнути stale closure
    setCitInputs(prev => {
      const cur = (prev[secId] || '').trimEnd();
      const sep = cur ? '\n' : '';
      return { ...prev, [secId]: cur + sep + newLines.join('\n') };
    });

    // Зберігаємо структуровані об'єкти паперів для якісного форматування
    if (setCitStructured) {
      setCitStructured(prev => ({
        ...prev,
        [secId]: [...(prev[secId] || []), ...papers],
      }));
    }

    setSelectedSugg(prev => ({ ...prev, [secId]: [] }));

    // Авторозтягування textarea після програмного оновлення
    requestAnimationFrame(() => {
      const ta = document.querySelector(`textarea[data-secid="${secId}"]`);
      if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    });
  };

  return (
    <div className="fade">
      <Heading>{workflowMode === "sources-first" ? "04 / Джерела" : "05 / Джерела"}</Heading>

      {/* ── Заголовок: статистика + кнопка генерації ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#888" }}>
          Загальна к-сть джерел: <strong style={{ color: "#1a1a14" }}>{sourceTotal}</strong>
          {methodInfo?.sourcesMinCount
            ? <span style={{ marginLeft: 8, fontSize: 11, color: "#8a5a1a" }}>(мін. {methodInfo.sourcesMinCount} за методичкою)</span>
            : null}
        </div>
        {methodInfo && (methodInfo.sourcesStyle || methodInfo.sourcesOrder) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {methodInfo.sourcesStyle && <span style={{ fontSize: 11, background: "#e4f0ff", color: "#1a5a8a", padding: "2px 10px", borderRadius: 10 }}>📋 {methodInfo.sourcesStyle}</span>}
            {methodInfo.sourcesOrder && <span style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 10px", borderRadius: 10 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 За алфавітом" : "🔢 За порядком появи"}</span>}
          </div>
        )}
        <GreenBtn
          onClick={() => { setKwError(""); doGenKeywords(); }}
          loading={kwLoading}
          msg="Генерую ключові слова та шукаю джерела..."
          label={Object.keys(keywords).length > 0 ? "Оновити ключові слова та джерела" : "Знайти джерела автоматично →"}
        />
        {kwError && (
          <div style={{ fontSize: 12, color: "#8a1a1a", background: "#fff5f5", border: "1px solid #e8b0b0", borderRadius: 6, padding: "4px 10px" }}>
            ⚠ {kwError}
          </div>
        )}
      </div>

      {/* ── Підказка ── */}
      <div style={{ padding: "12px 16px", background: "#f0f5e8", border: "1px solid #c8dfa0", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#3a6010", lineHeight: "1.7" }}>
        <strong>Як це працює:</strong> Натисніть <em>"Знайти джерела автоматично"</em> — програма згенерує ключові слова і знайде відповідні джерела для кожного підрозділу. Виберіть потрібні галочкою та натисніть <em>"Додати вибрані"</em>. Після заповнення натисніть <em>"Розставити всі посилання"</em>.
        <div style={{ marginTop: 6, fontSize: 12, color: "#5a6a3a" }}>
          Обмеження: іноземних джерел (польськ. + зарубіж.) <strong>не більше 30%</strong> від загальної кількості. Російські та білоруські джерела <strong>заборонені</strong>.
        </div>
        <div style={{ marginTop: 8 }}>
          <a
            href={`https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "4px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}
          >
            🎓 Шукати додатково на Google Scholar →
          </a>
        </div>
      </div>

      {/* ── Рекомендації з методички / клієнта ── */}
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

      {/* ── Попередній список всіх джерел ── */}
      {allRefs.length > 0 && (
        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
            ПОПЕРЕДНІЙ СПИСОК ДЖЕРЕЛ ({allRefs.length} позицій)
          </div>
          <div style={{ padding: "12px 16px", background: "#faf8f3", maxHeight: 180, overflowY: "auto" }}>
            {allRefs.map((r, i) => (
              <div key={i} style={{ fontSize: 12, color: "#444", marginBottom: 4, lineHeight: "1.5" }}>
                <span style={{ color: "#e8ff47", background: "#1a1a14", padding: "1px 6px", borderRadius: 4, marginRight: 8, fontSize: 11 }}>{i + 1}</span>{r}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Підрозділи ── */}
      {visibleSections.map(sec => {
        const secRefs = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
        const startIdx = runningIdx + 1; runningIdx += secRefs.length;
        const hasSources = secRefs.length > 0;
        const alreadyAdded = (citInputs[sec.id] || '').toLowerCase();
        const suggestions = (suggestedSources[sec.id] || []).filter(p =>
          !alreadyAdded.includes((p.title || '').toLowerCase().slice(0, 60))
        );
        const isSearching = sourcesSearchLoading[sec.id] || false;
        const searchErr = sourcesSearchError?.[sec.id] || null;
        const isOpen = suggOpen[sec.id] ?? (suggestions.length > 0);
        const selectedList = selectedSugg[sec.id] || [];
        const selectedCount = selectedList.length;
        const ukCount = suggestions.filter(p => p.lang === 'uk').length;
        const plCount = suggestions.filter(p => p.lang === 'pl').length;
        const enCount = suggestions.filter(p => p.lang !== 'uk' && p.lang !== 'pl').length;
        const needed = sourceDist[sec.id] || 4;
        const maxForeign = Math.max(1, Math.round(needed * 0.3));
        const selectedForeign = selectedList.filter(p => p.lang !== 'uk').length;
        const foreignOverLimit = selectedForeign > maxForeign;

        return (
          <div key={sec.id} style={{ border: `1.5px solid ${hasSources ? "#d4cfc4" : "#e8a050"}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>

            {/* Заголовок підрозділу */}
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

              {/* Ключові слова */}
              {Array.isArray(keywords[sec.id]) && keywords[sec.id].length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Шукайте за фразами:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {keywords[sec.id].map((kw, ki) => (
                      <span
                        key={ki}
                        onClick={() => navigator.clipboard.writeText(kw)}
                        title="Клікни щоб скопіювати"
                        style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none" }}
                      >{kw}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Блок пропозицій ── */}
              {(isSearching || suggestions.length > 0 || searchErr) && (
                <div style={{ marginBottom: 12, border: "1.5px solid #c8dfa0", borderRadius: 8, overflow: "hidden" }}>

                  {/* Заголовок панелі */}
                  <div
                    onClick={() => setSuggOpen(prev => ({ ...prev, [sec.id]: !isOpen }))}
                    style={{ background: "#eef5e4", padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: 8, flexWrap: "wrap" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {isSearching
                        ? <><SpinDot size={12} /><span style={{ fontSize: 12, color: "#5a8a2a" }}>Шукаю джерела...</span></>
                        : <>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#3a6010" }}>Знайдені джерела ({suggestions.length})</span>
                          <span style={{ fontSize: 11, color: "#5a7a3a" }}>🇺🇦 {ukCount} укр.</span>
                          {plCount > 0 && <span style={{ fontSize: 11, color: "#9a3a6a" }}>🇵🇱 {plCount} польськ.</span>}
                          {enCount > 0 && <span style={{ fontSize: 11, color: "#3a6a9a" }}>🌐 {enCount} зарубіж.</span>}
                        </>
                      }
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {!isSearching && (
                        <button
                          onClick={e => { e.stopPropagation(); doRegenSectionSources(sec); }}
                          style={{ fontSize: 10, background: "transparent", border: "1px solid #8cc84b", color: "#3a6010", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}
                        >оновити</button>
                      )}
                      <span style={{ fontSize: 11, color: "#5a7a3a" }}>{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {/* Картки джерел */}
                  {isOpen && !isSearching && suggestions.length > 0 && (
                    <div style={{ padding: "10px 12px", background: "#f5faf0" }}>


                      {/* Картки — по фразах або плоский список */}
                      {(phraseGroups?.[sec.id] || []).length > 0
                        ? phraseGroups[sec.id].map((group, gi) => {
                            const groupPapers = group.papers.filter(p =>
                              !alreadyAdded.includes((p.title || '').toLowerCase().slice(0, 60))
                            );
                            if (!groupPapers.length) return null;
                            const pageKey = `${sec.id}_${gi}`;
                            const PAGE_SIZE = 5;
                            const currentPage = phrasePages[pageKey] || 1;
                            const totalPages = Math.ceil(groupPapers.length / PAGE_SIZE);
                            const visible = groupPapers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
                            return (
                              <div key={gi} style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 10, color: '#5a7a3a', padding: '3px 8px', background: '#f0f7e8', borderRadius: 4, marginBottom: 6, fontStyle: 'italic', display: 'inline-block' }}>
                                  🔍 {group.phrase}
                                </div>
                                {visible.map(paper => (
                                  <SourceCard key={paper.id} paper={paper} checked={isChecked(sec.id, paper.id)} onToggle={() => togglePaper(sec.id, paper)} />
                                ))}
                                {totalPages > 1 && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                                    <button
                                      onClick={() => setPhrasePages(prev => ({ ...prev, [pageKey]: Math.max(1, currentPage - 1) }))}
                                      disabled={currentPage === 1}
                                      style={{ fontSize: 11, background: 'transparent', border: '1px solid #c8dfa0', color: currentPage === 1 ? '#bbb' : '#5a7a3a', borderRadius: 5, padding: '2px 8px', cursor: currentPage === 1 ? 'default' : 'pointer' }}
                                    >←</button>
                                    <span style={{ fontSize: 11, color: '#5a7a3a' }}>{currentPage} / {totalPages}</span>
                                    <button
                                      onClick={() => setPhrasePages(prev => ({ ...prev, [pageKey]: Math.min(totalPages, currentPage + 1) }))}
                                      disabled={currentPage === totalPages}
                                      style={{ fontSize: 11, background: 'transparent', border: '1px solid #c8dfa0', color: currentPage === totalPages ? '#bbb' : '#5a7a3a', borderRadius: 5, padding: '2px 8px', cursor: currentPage === totalPages ? 'default' : 'pointer' }}
                                    >→</button>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        : suggestions.map(paper => (
                            <SourceCard key={paper.id} paper={paper} checked={isChecked(sec.id, paper.id)} onToggle={() => togglePaper(sec.id, paper)} />
                          ))
                      }

                      {/* Кнопки дій */}
                      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          onClick={() => handleAddSelected(sec.id)}
                          disabled={selectedCount === 0}
                          style={{
                            fontSize: 12, fontWeight: 600,
                            background: selectedCount > 0 ? "#5a9a1a" : "#ccc",
                            color: "#fff", border: "none", borderRadius: 6,
                            padding: "6px 14px", cursor: selectedCount > 0 ? "pointer" : "default",
                          }}
                        >
                          Додати вибрані ({selectedCount}) →
                        </button>
                        <button onClick={() => selectAll(sec.id)} style={{ fontSize: 11, background: "transparent", border: "1px solid #8cc84b", color: "#3a6010", borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>вибрати всі</button>
                        {selectedCount > 0 && (
                          <button onClick={() => clearAll(sec.id)} style={{ fontSize: 11, background: "transparent", border: "1px solid #ccc", color: "#888", borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>скинути</button>
                        )}
                      </div>
                    </div>
                  )}

                  {isOpen && !isSearching && suggestions.length === 0 && (
                    <div style={{ padding: "10px 14px", fontSize: 12, background: "#f5faf0", color: searchErr ? "#8a1a1a" : "#888" }}>
                      {searchErr
                        ? `⚠ Помилка пошуку: ${searchErr}. Спробуйте оновити або додайте джерела вручну.`
                        : "Джерел не знайдено. Спробуйте оновити або додайте вручну."}
                    </div>
                  )}
                </div>
              )}

              {/* Ручне введення */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase" }}>
                  {suggestions.length > 0 ? "Або додайте джерела вручну (кожне з нового рядка):" : "Вставте джерела (кожне з нового рядка):"}
                </div>
                {(citInputs[sec.id] || "").trim() && (
                  <button
                    onClick={() => {
                      setCitInputs(p => ({ ...p, [sec.id]: "" }));
                      if (setCitStructured) setCitStructured(p => ({ ...p, [sec.id]: [] }));
                      requestAnimationFrame(() => {
                        const ta = document.querySelector(`textarea[data-secid="${sec.id}"]`);
                        if (ta) { ta.style.height = "auto"; }
                      });
                    }}
                    style={{ fontSize: 11, background: "transparent", border: "1px solid #e0b0b0", color: "#a04040", borderRadius: 5, padding: "2px 8px", cursor: "pointer", flexShrink: 0 }}
                  >× Очистити</button>
                )}
              </div>
              <textarea
                data-secid={sec.id}
                value={citInputs[sec.id] || ""}
                onChange={e => {
                  setCitInputs(p => ({ ...p, [sec.id]: e.target.value }));
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                onFocus={e => {
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
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
                style={{ ...TA_WHITE, minHeight: 80, overflow: "hidden", resize: "none" }}
              />
              {secRefs.length > 0 && (
                <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 4 }}>
                  ✓ {secRefs.length} джерело(а) введено → [{startIdx}–{startIdx + secRefs.length - 1}]
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── Розставлення посилань ── */}
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

      {/* ── Фінальний список літератури ── */}
      {refList.length > 0 && (
        <div style={{ border: "1.5px solid #2a3a1a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ ({methodInfo?.sourcesStyle || "ДСТУ 8302:2015"})</span>
            <button
              onClick={() => navigator.clipboard.writeText(refList.join("\n"))}
              style={{ background: "transparent", border: "1px solid #5a7a3a", color: "#a8d060", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}
            >COPY</button>
          </div>
          <div style={{ padding: "14px 18px", background: "#faf8f3", maxHeight: 300, overflowY: "auto" }}>
            {refList.map((r, i) => (
              <div key={i} style={{ fontSize: 13, color: "#2a2a1e", marginBottom: 6, lineHeight: "1.7" }}>{r}</div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
        <NavBtn onClick={() => setStage(workflowMode === "sources-first" ? "plan" : "writing")}>
          {workflowMode === "sources-first" ? "← До плану" : "← До тексту"}
        </NavBtn>
        {workflowMode === "sources-first"
          ? <PrimaryBtn onClick={onProceedToWriting} label="Далі → Генерація тексту" />
          : <PrimaryBtn onClick={onFinish} label="Завершити роботу →" />
        }
      </div>
    </div>
  );
}
