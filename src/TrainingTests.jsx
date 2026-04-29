import { useState, useEffect } from "react";
import { db } from "./firebase";
import { collection, getDocs, addDoc, setDoc, deleteDoc, doc, query, orderBy, where } from "firebase/firestore";
import { useAuth } from "./AuthContext";

function genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default function TrainingTests({ onBack }) {
    const { user, profile } = useAuth();
    const isAdmin = profile?.role === "admin";

    const [tests, setTests] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeTest, setActiveTest] = useState(null);
    const [answers, setAnswers] = useState({});
    const [submitted, setSubmitted] = useState(false);
    const [score, setScore] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [myResults, setMyResults] = useState([]);
    const [allResults, setAllResults] = useState([]);
    const [usersMap, setUsersMap] = useState({});
    const [editingTest, setEditingTest] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadTests();
        loadMyResults();
        if (isAdmin) loadAllResults();
    }, []);

    const loadTests = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(query(collection(db, "training_tests"), orderBy("order")));
            setTests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } finally {
            setLoading(false);
        }
    };

    const loadMyResults = async () => {
        const snap = await getDocs(query(collection(db, "training_results"), where("userId", "==", user.uid)));
        setMyResults(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    };

    const loadAllResults = async () => {
        const [resultsSnap, usersSnap] = await Promise.all([
            getDocs(collection(db, "training_results")),
            getDocs(collection(db, "users")),
        ]);
        setAllResults(resultsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        const um = {};
        usersSnap.docs.forEach(d => { um[d.id] = d.data(); });
        setUsersMap(um);
    };

    // ── Test-taking logic ──────────────────────────────────────────────────────

    const startTest = (test) => {
        setActiveTest(test);
        setAnswers({});
        setSubmitted(false);
        setScore(null);
    };

    const submitTest = async () => {
        if (!activeTest) return;
        const total = activeTest.questions?.length || 0;
        const correct = (activeTest.questions || []).filter((q, i) => answers[i] === q.correct).length;
        setSubmitting(true);
        try {
            const prevAttempts = myResults.filter(r => r.testId === activeTest.id);
            await addDoc(collection(db, "training_results"), {
                userId: user.uid,
                userEmail: user.email,
                userName: profile?.name || user.email,
                testId: activeTest.id,
                testTitle: activeTest.title,
                answers: (activeTest.questions || []).map((_, i) => answers[i] ?? null),
                score: correct,
                total,
                passed: correct === total,
                submittedAt: new Date().toISOString(),
                attempt: prevAttempts.length + 1,
            });
            setScore({ correct, total });
            setSubmitted(true);
            await loadMyResults();
            if (isAdmin) loadAllResults();
        } catch (e) { console.error(e); }
        setSubmitting(false);
    };

    const getBestResult = (testId) => {
        const r = myResults.filter(r => r.testId === testId);
        return r.length ? r.reduce((best, cur) => cur.score > best.score ? cur : best) : null;
    };

    // ── Test editor logic ──────────────────────────────────────────────────────

    const startNewTest = () => {
        setEditingTest({
            _new: true,
            id: genId(),
            title: "",
            order: tests.length + 1,
            questions: [],
        });
    };

    const startEditTest = (test) => {
        setEditingTest(JSON.parse(JSON.stringify(test)));
    };

    const saveTest = async () => {
        if (!editingTest.title.trim()) return alert("Введіть назву тесту");
        if (editingTest.questions.length === 0) return alert("Додайте хоча б одне питання");
        for (const q of editingTest.questions) {
            if (!q.text.trim()) return alert("Заповніть текст усіх питань");
            if (q.options.some(o => !o.trim())) return alert("Заповніть усі варіанти відповідей");
        }
        setSaving(true);
        try {
            const { _new, id, ...data } = editingTest;
            if (_new) {
                await addDoc(collection(db, "training_tests"), data);
            } else {
                await setDoc(doc(db, "training_tests", id), data);
            }
            await loadTests();
            setEditingTest(null);
        } catch (e) { console.error(e); }
        setSaving(false);
    };

    const deleteTest = async (testId) => {
        if (!window.confirm("Видалити тест? Результати збережуться.")) return;
        await deleteDoc(doc(db, "training_tests", testId));
        await loadTests();
    };

    // Edit helpers
    const updTest = (patch) => setEditingTest(p => ({ ...p, ...patch }));

    const addQuestion = () => setEditingTest(p => ({
        ...p,
        questions: [...p.questions, { id: genId(), text: "", options: ["", "", "", ""], correct: 0 }],
    }));

    const rmQuestion = (qi) => setEditingTest(p => ({
        ...p, questions: p.questions.filter((_, i) => i !== qi),
    }));

    const updQuestion = (qi, patch) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : { ...q, ...patch }),
    }));

    const updOption = (qi, oi, value) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, options: q.options.map((o, j) => j !== oi ? o : value),
        }),
    }));

    const addOption = (qi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => i !== qi ? q : {
            ...q, options: [...q.options, ""],
        }),
    }));

    const rmOption = (qi, oi) => setEditingTest(p => ({
        ...p, questions: p.questions.map((q, i) => {
            if (i !== qi) return q;
            const options = q.options.filter((_, j) => j !== oi);
            const correct = q.correct === oi ? 0 : q.correct > oi ? q.correct - 1 : q.correct;
            return { ...q, options, correct: Math.min(correct, options.length - 1) };
        }),
    }));

    const moveQuestion = (qi, dir) => setEditingTest(p => {
        const qs = [...p.questions];
        const t = qi + dir;
        if (t < 0 || t >= qs.length) return p;
        [qs[qi], qs[t]] = [qs[t], qs[qi]];
        return { ...p, questions: qs };
    });

    // ── Styles ─────────────────────────────────────────────────────────────────

    const allAnswered = activeTest ? Object.keys(answers).length >= (activeTest.questions?.length || 0) : false;
    const fmtTime = (iso) => iso
        ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
        : "—";

    const headerBtn = { background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 };
    const primBtn = { background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 6, padding: "8px 22px", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 };
    const miniBtn = { background: "transparent", border: "1px solid #ddd", borderRadius: 4, padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#666", fontFamily: "inherit" };

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "Georgia, serif" }}>
            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <button onClick={editingTest ? () => { if (window.confirm("Скасувати редагування?")) setEditingTest(null); } : activeTest ? () => setActiveTest(null) : onBack}
                        style={headerBtn}>
                        {editingTest ? "✕ Скасувати" : activeTest ? "← До списку" : "← Навчання"}
                    </button>
                    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 3 }}>ACADEM — ТЕСТИ</span>
                </div>
                {isAdmin && !activeTest && !editingTest && (
                    <button onClick={startNewTest}
                        style={{ background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "7px 18px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
                        + Новий тест
                    </button>
                )}
                {editingTest && (
                    <button onClick={saveTest} disabled={saving}
                        style={{ background: saving ? "#555" : "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "7px 20px", cursor: saving ? "default" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, opacity: saving ? 0.7 : 1 }}>
                        {saving ? "Збереження..." : "Зберегти тест"}
                    </button>
                )}
            </div>

            <div style={{ maxWidth: 800, margin: "0 auto", padding: "32px 20px" }}>

                {/* ── TEST EDITOR ── */}
                {editingTest ? (
                    <div style={{ background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ fontSize: 13, color: "#888", marginBottom: 20, fontStyle: "italic" }}>
                            {editingTest._new ? "Новий тест" : `Редагування: ${editingTest.title}`}
                        </div>

                        {/* Test title */}
                        <div style={{ marginBottom: 32 }}>
                            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6, fontFamily: "inherit" }}>Назва тесту</div>
                            <input
                                value={editingTest.title}
                                onChange={e => updTest({ title: e.target.value })}
                                placeholder="Наприклад: Тест — Основи роботи"
                                style={{ width: "100%", fontSize: 18, fontWeight: 700, fontFamily: "Georgia, serif", border: "none", borderBottom: "2px solid #e0ddd4", background: "transparent", padding: "6px 0", outline: "none", color: "#1a1a14", boxSizing: "border-box" }}
                            />
                        </div>

                        {/* Questions */}
                        {editingTest.questions.length === 0 && (
                            <div style={{ color: "#aaa", fontSize: 14, fontStyle: "italic", textAlign: "center", padding: "24px 0" }}>
                                Питань ще немає. Додайте перше питання.
                            </div>
                        )}

                        {editingTest.questions.map((q, qi) => (
                            <div key={q.id} style={{ border: "1.5px solid #e0ddd4", borderRadius: 10, padding: 20, marginBottom: 16, background: "#faf8f3" }}>
                                {/* Question header */}
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                                    <span style={{ fontSize: 11, color: "#888", background: "#f0ece2", padding: "2px 10px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 1, fontFamily: "inherit", flexShrink: 0 }}>
                                        Питання {qi + 1}
                                    </span>
                                    <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                                        {qi > 0 && <button onClick={() => moveQuestion(qi, -1)} style={miniBtn}>↑</button>}
                                        {qi < editingTest.questions.length - 1 && <button onClick={() => moveQuestion(qi, 1)} style={miniBtn}>↓</button>}
                                        <button onClick={() => { if (window.confirm("Видалити питання?")) rmQuestion(qi); }} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc" }}>✕</button>
                                    </div>
                                </div>

                                {/* Question text */}
                                <textarea
                                    value={q.text}
                                    onChange={e => updQuestion(qi, { text: e.target.value })}
                                    placeholder="Текст питання..."
                                    rows={2}
                                    style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e0ddd4", borderRadius: 6, fontSize: 14, fontFamily: "Georgia, serif", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6, outline: "none", marginBottom: 14 }}
                                />

                                {/* Options */}
                                <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, fontFamily: "inherit" }}>
                                    Варіанти відповідей — відмітьте правильний
                                </div>
                                {q.options.map((opt, oi) => (
                                    <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                        <input
                                            type="radio"
                                            name={`correct-${q.id}`}
                                            checked={q.correct === oi}
                                            onChange={() => updQuestion(qi, { correct: oi })}
                                            title="Правильна відповідь"
                                            style={{ accentColor: "#1a6a1a", width: 16, height: 16, flexShrink: 0, cursor: "pointer" }}
                                        />
                                        <input
                                            value={opt}
                                            onChange={e => updOption(qi, oi, e.target.value)}
                                            placeholder={`Варіант ${oi + 1}`}
                                            style={{
                                                flex: 1, padding: "7px 10px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box",
                                                border: `1.5px solid ${q.correct === oi ? "#8ac040" : "#e0ddd4"}`,
                                                background: q.correct === oi ? "#f0fff0" : "#fff",
                                            }}
                                        />
                                        {q.options.length > 2 && (
                                            <button onClick={() => rmOption(qi, oi)} style={{ ...miniBtn, color: "#c00", borderColor: "#ffcccc", flexShrink: 0 }}>✕</button>
                                        )}
                                    </div>
                                ))}

                                {q.options.length < 6 && (
                                    <button onClick={() => addOption(qi)}
                                        style={{ background: "transparent", border: "1.5px dashed #ccc", borderRadius: 6, padding: "5px 14px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#888", marginTop: 4 }}>
                                        + Варіант
                                    </button>
                                )}

                                <div style={{ fontSize: 11, color: "#8ac040", marginTop: 10, fontStyle: "italic" }}>
                                    Правильна відповідь: {q.options[q.correct] ? `"${q.options[q.correct]}"` : "не вибрано"}
                                </div>
                            </div>
                        ))}

                        {/* Add question */}
                        <button onClick={addQuestion}
                            style={{ width: "100%", background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 10, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }}>
                            + Додати питання
                        </button>
                    </div>

                ) : activeTest ? (
                    /* ── TAKING A TEST ── */
                    <div style={{ background: "#fff", borderRadius: 12, padding: 32, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ marginBottom: 28, paddingBottom: 20, borderBottom: "2px solid #f0ece2" }}>
                            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a14", margin: 0 }}>{activeTest.title}</h2>
                        </div>

                        {submitted && score ? (
                            <div style={{ textAlign: "center", padding: "32px 0" }}>
                                <div style={{
                                    fontSize: 72, fontWeight: 700, lineHeight: 1, marginBottom: 12,
                                    color: score.correct === score.total ? "#1a6a1a" : score.correct >= Math.ceil(score.total * 0.6) ? "#8a5a1a" : "#c00",
                                }}>
                                    {score.correct}/{score.total}
                                </div>
                                <div style={{ fontSize: 18, color: "#555", marginBottom: 32 }}>
                                    {score.correct === score.total
                                        ? "Відмінно! Всі відповіді правильні."
                                        : score.correct >= Math.ceil(score.total * 0.6)
                                            ? "Непогано! Є що покращити."
                                            : "Потрібно повторити матеріал і спробувати ще раз."}
                                </div>
                                <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
                                    <button onClick={() => startTest(activeTest)}
                                        style={{ ...primBtn, background: "transparent", color: "#1a1a14", border: "1.5px solid #1a1a14" }}>
                                        Пройти ще раз
                                    </button>
                                    <button onClick={() => setActiveTest(null)} style={primBtn}>
                                        До списку тестів
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {(activeTest.questions || []).map((q, qi) => (
                                    <div key={qi} style={{ marginBottom: 28 }}>
                                        <div style={{ fontSize: 15, fontWeight: 600, color: "#1a1a14", marginBottom: 12, lineHeight: 1.5 }}>
                                            {qi + 1}. {q.text}
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                            {(q.options || []).map((opt, oi) => (
                                                <label key={oi} style={{
                                                    display: "flex", alignItems: "center", gap: 12,
                                                    padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                                                    border: `1.5px solid ${answers[qi] === oi ? "#1a1a14" : "#e0ddd4"}`,
                                                    background: answers[qi] === oi ? "#f0ece2" : "#fff",
                                                    transition: "all .15s", userSelect: "none",
                                                }}>
                                                    <input type="radio" name={`q${qi}`} checked={answers[qi] === oi}
                                                        onChange={() => setAnswers(p => ({ ...p, [qi]: oi }))}
                                                        style={{ accentColor: "#1a1a14", width: 16, height: 16, flexShrink: 0 }} />
                                                    <span style={{ fontSize: 14, color: "#1a1a14" }}>{opt}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                ))}

                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 32, paddingTop: 20, borderTop: "1.5px solid #f0ece2", flexWrap: "wrap", gap: 12 }}>
                                    <div style={{ fontSize: 13, color: "#888" }}>
                                        Відповіді: {Object.keys(answers).length} / {activeTest.questions?.length || 0}
                                    </div>
                                    <button onClick={submitTest} disabled={submitting || !allAnswered}
                                        style={{ ...primBtn, opacity: submitting || !allAnswered ? 0.45 : 1, cursor: submitting || !allAnswered ? "default" : "pointer" }}>
                                        {submitting ? "Відправка..." : "Відправити →"}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                ) : (
                    /* ── TEST LIST ── */
                    <>
                        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, color: "#1a1a14", marginBottom: 24, textTransform: "uppercase" }}>
                            Тести
                        </div>

                        {loading ? (
                            <div style={{ color: "#888", fontSize: 14 }}>Завантаження...</div>
                        ) : tests.length === 0 ? (
                            <div style={{ background: "#fff", borderRadius: 12, padding: 40, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                                <div style={{ color: "#aaa", fontSize: 14, marginBottom: isAdmin ? 20 : 0 }}>Тести ще не додано.</div>
                                {isAdmin && (
                                    <button onClick={startNewTest} style={primBtn}>+ Створити перший тест</button>
                                )}
                            </div>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                                {tests.map(test => {
                                    const best = getBestResult(test.id);
                                    return (
                                        <div key={test.id} style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontSize: 16, fontWeight: 700, color: "#1a1a14", marginBottom: 5 }}>{test.title}</div>
                                                <div style={{ fontSize: 12, color: "#aaa" }}>
                                                    {test.questions?.length || 0} питань
                                                    {best && (
                                                        <span style={{ marginLeft: 14, color: best.passed ? "#1a6a1a" : "#8a5a1a", fontWeight: 600 }}>
                                                            Кращий результат: {best.score}/{best.total}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            {best && (
                                                <div style={{
                                                    padding: "4px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, flexShrink: 0,
                                                    background: best.passed ? "#e4ffe4" : "#fff3e0",
                                                    color: best.passed ? "#1a6a1a" : "#8a5a1a",
                                                }}>
                                                    {best.passed ? "Пройдено" : "Не пройдено"}
                                                </div>
                                            )}
                                            {isAdmin && (
                                                <>
                                                    <button onClick={() => startEditTest(test)}
                                                        style={{ background: "#f0f5ff", border: "1px solid #c0d0f0", color: "#1a5a8a", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                                        Редагувати
                                                    </button>
                                                    <button onClick={() => deleteTest(test.id)}
                                                        style={{ background: "transparent", border: "1px solid #ffcccc", color: "#c00", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                                        ✕
                                                    </button>
                                                </>
                                            )}
                                            <button onClick={() => startTest(test)} style={{ ...primBtn, flexShrink: 0 }}>
                                                {best ? "Ще раз" : "Почати →"}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Admin: all results */}
                        {isAdmin && allResults.length > 0 && (
                            <div style={{ marginTop: 48 }}>
                                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, color: "#1a1a14", marginBottom: 20, textTransform: "uppercase" }}>
                                    Результати менеджерів
                                </div>
                                <div style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                                        <thead>
                                            <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                                {["Менеджер", "Тест", "Результат", "Спроба", "Дата"].map(h => (
                                                    <th key={h} style={{ textAlign: h === "Результат" || h === "Спроба" ? "center" : "left", padding: "8px 12px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {allResults
                                                .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))
                                                .map((r, i) => {
                                                    const u = usersMap[r.userId];
                                                    return (
                                                        <tr key={r.id} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                                            <td style={{ padding: "10px 12px" }}>
                                                                <div style={{ fontWeight: 600, color: "#1a1a14" }}>{u?.name || r.userName || "—"}</div>
                                                                <div style={{ fontSize: 11, color: "#aaa" }}>{u?.email || r.userEmail}</div>
                                                            </td>
                                                            <td style={{ padding: "10px 12px", color: "#555" }}>{r.testTitle}</td>
                                                            <td style={{ textAlign: "center", padding: "10px 12px" }}>
                                                                <span style={{ fontWeight: 700, color: r.passed ? "#1a6a1a" : r.score >= Math.ceil(r.total * 0.6) ? "#8a5a1a" : "#c00" }}>
                                                                    {r.score}/{r.total}
                                                                </span>
                                                            </td>
                                                            <td style={{ textAlign: "center", padding: "10px 12px", color: "#888" }}>{r.attempt}</td>
                                                            <td style={{ padding: "10px 12px", color: "#888", fontSize: 12, whiteSpace: "nowrap" }}>{fmtTime(r.submittedAt)}</td>
                                                        </tr>
                                                    );
                                                })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
