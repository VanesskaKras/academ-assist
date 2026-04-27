import { useState, useEffect, useMemo } from "react";
import { db } from "./firebase";
import { collection, query, where, orderBy, getDocs, deleteDoc, doc } from "firebase/firestore";
import { useAuth } from "./AuthContext";

const STATUS_LABELS = {
    new: { label: "Нове", color: "#888", bg: "#f5f5f5", dot: "#ccc" },
    plan_ready: { label: "План готовий", color: "#5a7a2a", bg: "#eef5e4", dot: "#8ac040" },
    plan_approved: { label: "План затверджено", color: "#1a5a8a", bg: "#e4f0ff", dot: "#4a9ade" },
    writing: { label: "В роботі", color: "#2a7a6a", bg: "#e4f5f2", dot: "#3abfa0" },
    sources: { label: "Джерела", color: "#8a5a1a", bg: "#fff3e0", dot: "#e8a050" },
    done: { label: "Готово", color: "#1a6a1a", bg: "#e4ffe4", dot: "#4aba4a" },
};

export default function Dashboard({ onOpen, onNew, onAdmin }) {
    const { user, profile, logout } = useAuth();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterStatus, setFilterStatus] = useState(null); // null = всі
    const [infoOrder, setInfoOrder] = useState(null); // модалка деталей
    const [showHelp, setShowHelp] = useState(false);
    const [adminStats, setAdminStats] = useState(null);

    const getAdminOrderStatus = (o) => {
        const s = o.status || "new";
        if (o.stage === "sources" || (s === "done" && (!o.refList || o.refList.length === 0))) return "sources";
        return s;
    };

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                const q = query(
                    collection(db, "orders"),
                    where("uid", "==", user.uid),
                    orderBy("createdAt", "desc")
                );
                const snap = await getDocs(q);
                setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            } catch (e) {
                console.error(e);
            }
            setLoading(false);
        };
        load();
    }, [user.uid]);

    useEffect(() => {
        if (profile?.role !== "admin") return;
        const load = async () => {
            const snap = await getDocs(collection(db, "orders"));
            const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            const st = { total: all.length, new: 0, plan_ready: 0, plan_approved: 0, writing: 0, sources: 0, done: 0 };
            all.forEach(o => {
                const s = getAdminOrderStatus(o);
                if (st[s] !== undefined) st[s]++;
            });
            setAdminStats(st);
        };
        load();
    }, [profile?.role]);

    const deleteOrder = async (id, e) => {
        e.stopPropagation();
        if (!window.confirm("Видалити замовлення?")) return;
        await deleteDoc(doc(db, "orders", id));
        setOrders(p => p.filter(o => o.id !== id));
    };

    const needsSources = (o) => o.stage === "sources" || (o.status === "done" && (!o.refList || o.refList.length === 0));

    const filtered = useMemo(() => {
        let result = orders;
        // Фільтр по статусу
        if (filterStatus) {
            result = result.filter(o => {
                const s = o.status || "new";
                if (filterStatus === "sources") return needsSources(o);
                if (filterStatus === "writing") return s === "writing" && o.stage !== "sources";
                if (filterStatus === "plan_ready") return s === "plan_ready" || s === "plan_approved";
                if (filterStatus === "done") return s === "done" && !needsSources(o);
                if (filterStatus === "new") return s === "new";
                return true;
            });
        }
        // Пошук по тексту
        if (search.trim()) {
            const q = search.toLowerCase().trim();
            result = result.filter(o =>
                o.topic?.toLowerCase().includes(q) ||
                o.id?.toLowerCase().includes(q) ||
                o.type?.toLowerCase().includes(q) ||
                o.deadline?.toLowerCase().includes(q) ||
                o.info?.orderNumber?.toLowerCase().includes(q)
            );
        }
        return result;
    }, [orders, search, filterStatus]);

    const counts = useMemo(() => {
        const c = { all: orders.length, done: 0, writing: 0, sources: 0, plan_ready: 0, new: 0 };
        orders.forEach(o => {
            const s = o.status || "new";
            if (needsSources(o)) c.sources++;
            else if (s === "done") c.done++;
            else if (s === "writing") c.writing++;
            else if (s === "plan_ready" || s === "plan_approved") c.plan_ready++;
            else c.new++;
        });
        return c;
    }, [orders]);

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral', Georgia, serif" }}>
            <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&family=Spectral+SC:wght@600&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>

            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 20, letterSpacing: 4, color: "#e8ff47" }}>ACADEM</div>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 20, letterSpacing: 4 }}>ASSIST</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button onClick={() => setShowHelp(true)} title="Інструкція" style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontFamily: "inherit", fontSize: 14, lineHeight: 1 }}>ℹ</button>
                    {onAdmin && (
                        <button onClick={onAdmin} style={{ background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
                            ⚙ Адмін
                        </button>
                    )}
                    <div style={{ fontSize: 13, color: "#888" }}>{profile?.name || user.email}</div>
                    <button onClick={logout} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Вийти</button>
                </div>
            </div>

            {/* Admin stats bar */}
            {profile?.role === "admin" && adminStats && (
                <div style={{ background: "#242418", borderBottom: "1px solid #333", padding: "8px 32px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#666", letterSpacing: 1.5, textTransform: "uppercase", marginRight: 6 }}>Усі замовлення:</span>
                    <span style={{ padding: "3px 12px", borderRadius: 12, background: "#3a3a2e", color: "#e8ff47", fontSize: 12, fontWeight: 700 }}>
                        {adminStats.total} всього
                    </span>
                    {[
                        { key: "new",           label: "Нове",             color: "#aaa",    bg: "#2e2e2e" },
                        { key: "plan_ready",    label: "План готовий",     color: "#8ac040", bg: "#2a3020" },
                        { key: "plan_approved", label: "План затверджено", color: "#4a9ade", bg: "#1e2c3a" },
                        { key: "writing",       label: "В роботі",         color: "#3abfa0", bg: "#1e3030" },
                        { key: "sources",       label: "Джерела",          color: "#e8a050", bg: "#332a18" },
                        { key: "done",          label: "Готово",           color: "#4aba4a", bg: "#1e321e" },
                    ].filter(s => adminStats[s.key] > 0).map(s => (
                        <span key={s.key} style={{ padding: "3px 12px", borderRadius: 12, background: s.bg, color: s.color, fontSize: 12, fontWeight: 600 }}>
                            {adminStats[s.key]} {s.label}
                        </span>
                    ))}
                </div>
            )}

            <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

                {/* Top bar */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 18, letterSpacing: 2, color: "#1a1a14" }}>МОЇ ЗАМОВЛЕННЯ</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => onNew("small")} style={{ background: "transparent", color: "#1a1a14", border: "1.5px solid #1a1a14", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Мала робота
                        </button>
                        <button onClick={() => onNew("large")} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Нове замовлення
                        </button>
                    </div>
                </div>

                {/* Stats */}
                {!loading && orders.length > 0 && (
                    <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
                        {[
                            { label: "Всього", val: counts.all, color: "#1a1a14", bg: "#e8e4d8", key: null },
                            { label: "План", val: counts.plan_ready, color: "#1a5a8a", bg: "#e4f0ff", key: "plan_ready" },
                            { label: "В роботі", val: counts.writing, color: "#2a7a6a", bg: "#e4f5f2", key: "writing" },
                            { label: "Джерела", val: counts.sources, color: "#8a5a1a", bg: "#fff3e0", key: "sources" },
                            { label: "Готово", val: counts.done, color: "#1a6a1a", bg: "#e4ffe4", key: "done" },
                        ].map(s => {
                            const isActive = filterStatus === s.key;
                            return (
                                <div key={s.label}
                                    onClick={() => setFilterStatus(isActive ? null : s.key)}
                                    style={{
                                        padding: "8px 18px", borderRadius: 20, background: isActive ? s.color : s.bg,
                                        color: isActive ? "#fff" : s.color, fontSize: 12, fontWeight: 600,
                                        cursor: "pointer", transition: "all .15s",
                                        border: isActive ? `2px solid ${s.color}` : "2px solid transparent",
                                        userSelect: "none"
                                    }}>
                                    {s.val} {s.label}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Search */}
                {orders.length > 0 && (
                    <div style={{ marginBottom: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#aaa" }}>🔍</span>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Пошук за темою, типом, дедлайном, номером замовлення..."
                            style={{ width: "100%", padding: "11px 14px 11px 40px", border: "1.5px solid #d4cfc4", borderRadius: 8, fontSize: 14, fontFamily: "'Spectral',serif", background: "#fff", color: "#1a1a14", outline: "none" }}
                        />
                        {search && (
                            <button onClick={() => setSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#aaa", lineHeight: 1 }}>✕</button>
                        )}
                    </div>
                )}

                {/* List */}
                {loading ? (
                    <div style={{ textAlign: "center", padding: 60, color: "#888" }}>
                        <div style={{ fontSize: 14 }}>Завантаження...</div>
                    </div>
                ) : orders.length === 0 ? (
                    <div style={{ background: "#fff", borderRadius: 12, padding: 56, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
                        <div style={{ fontSize: 16, color: "#888", marginBottom: 20 }}>Замовлень ще немає</div>
                        <button onClick={onNew} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 24px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                            Створити перше замовлення →
                        </button>
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 40, color: "#888", fontSize: 14 }}>
                        Нічого не знайдено за запитом «{search}»
                    </div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {filtered.map(order => {
                            const st = (needsSources(order) ? STATUS_LABELS.sources : null) || STATUS_LABELS[order.status] || STATUS_LABELS.new;
                            const isSmall = order.mode === "small";
                            return (
                                <div key={order.id} onClick={() => onOpen(order.id, order.mode || "large")}
                                    style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", display: "flex", alignItems: "center", gap: 14, transition: "box-shadow .2s" }}
                                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 18px rgba(0,0,0,0.10)"}
                                    onMouseLeave={e => e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)"}>

                                    {/* Status dot */}
                                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: st.dot, flexShrink: 0 }} />

                                    {/* Info */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 15, fontWeight: 600, color: "#1a1a14", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {order.topic || "Без теми"}
                                        </div>
                                        <div style={{ fontSize: 12, color: "#888", display: "flex", gap: 12, flexWrap: "wrap" }}>
                                            {isSmall && <span style={{ background: "#f0e4ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11 }}>📝 Мала</span>}
                                            {order.type && <span>{order.type}</span>}
                                            {order.pages && <span>{order.pages} стор.</span>}
                                            {order.deadline && <span>⏰ {order.deadline}</span>}
                                            <span style={{ color: "#bbb" }}>{order.createdAt?.slice(0, 10) || ""}</span>
                                            {order.info?.orderNumber && <span style={{ background: "#f0e8ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontFamily: "monospace" }}>№ {order.info.orderNumber}</span>}
                                            <span style={{ color: "#ccc", fontFamily: "monospace", fontSize: 10 }}>#{order.id.slice(0, 8)}</span>
                                        </div>
                                    </div>

                                    {/* Status badge */}
                                    <div style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: st.bg, color: st.color, whiteSpace: "nowrap", flexShrink: 0 }}>
                                        {st.label}
                                    </div>

                                    {/* Delete */}
                                    <button onClick={e => deleteOrder(order.id, e)}
                                        style={{ background: "transparent", border: "1px solid #eee", color: "#ccc", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 }}
                                        onMouseEnter={e => { e.currentTarget.style.borderColor = "#f99"; e.currentTarget.style.color = "#c55"; }}
                                        onMouseLeave={e => { e.currentTarget.style.borderColor = "#eee"; e.currentTarget.style.color = "#ccc"; }}>
                                        ✕
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Модалка інструкції */}
            {showHelp && (
                <div onClick={() => setShowHelp(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: "#1a1a14", borderRadius: 14, padding: "32px 36px", maxWidth: 680, width: "100%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 12px 60px rgba(0,0,0,0.5)", fontFamily: "'Spectral',Georgia,serif", color: "#f5f2eb" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 16, letterSpacing: 3, color: "#e8ff47" }}>ІНСТРУКЦІЯ</div>
                            <button onClick={() => setShowHelp(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#888", lineHeight: 1 }}>✕</button>
                        </div>
                        {[
                            { title: "Що це за програма?", body: "ACADEM ASSIST — AI-асистент для написання академічних робіт. Він автоматично генерує текст курсових, дипломних та інших робіт на основі твоїх даних." },
                            { title: "Типи робіт", body: "Нове замовлення — для курсових, дипломних, бакалаврських робіт.\nМала робота — для рефератів, тез, статей, есе, презентацій." },
                            { title: "Крок 1 — Введення даних", body: "Вставте текст шаблону замовлення (бланк від викладача). За потреби додайте коментар та завантажте методичку (PDF). Якщо є готовий план — вставте або сфотографуйте його. Натисніть «Аналізувати»." },
                            { title: "Крок 2 — Перевірка даних", body: "Перевірте витягнуті дані: тему, напрям, кількість сторінок, мову, дедлайн. Відредагуйте за потреби. Натисніть «Генерувати план»." },
                            { title: "Крок 3 — План роботи", body: "Переглянте та відредагуйте назви розділів і підрозділів. Натисніть «Затвердити план» щоб розпочати написання." },
                            { title: "Крок 4 — Написання тексту", body: "Система генерує текст по кожному підрозділу поступово. Прогрес відображається у верхній панелі. Можна зупинити і продовжити пізніше. Кожен підрозділ можна перегенерувати з додатковими вимогами." },
                            { title: "Крок 5 — Джерела", body: "Введіть реальні джерела для кожного підрозділу. Скористайтесь кнопкою «Ключові слова» щоб знайти релевантні запити для пошуку. Натисніть «Сформувати список літератури»." },
                            { title: "Крок 6 — Готово", body: "Завантажити .docx — готова робота з титульною сторінкою.\nДоповідь — текст для захисту у .docx.\nПрезентація — автоматичний .pptx.\nДодатки — генерує додатки до роботи.\nКопіювати текст — весь текст у буфер обміну." },
                            { title: "Малі роботи", body: "Натисніть «Мала робота», оберіть тип (Реферат / Тези / Стаття / Есе / Презентація), заповніть форму і натисніть «Генерувати». Завантажте результат у .docx або .pptx." },
                            { title: "Корисні поради", body: "Методичка значно покращує якість роботи — завантажуй її якщо є.\nЯкщо генерація переривається — поверніться до замовлення і продовжіть.\nЗвук лунає коли генерація завершена, навіть якщо вкладка прихована.\nВсі дані зберігаються автоматично в хмарі." },
                        ].map(({ title, body }) => (
                            <div key={title} style={{ marginBottom: 22 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: "#e8ff47", letterSpacing: 1, marginBottom: 6, fontFamily: "'Spectral SC',serif" }}>{title}</div>
                                <div style={{ fontSize: 13, color: "#c8c4bb", lineHeight: 1.7, whiteSpace: "pre-line" }}>{body}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Модалка деталей замовлення */}
            {infoOrder && (
                <div onClick={() => setInfoOrder(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 28, maxWidth: 520, width: "100%", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", fontFamily: "'Spectral',Georgia,serif" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 2, color: "#1a1a14" }}>ДЕТАЛІ ЗАМОВЛЕННЯ</div>
                            <button onClick={() => setInfoOrder(null)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#aaa" }}>✕</button>
                        </div>
                        <div style={{ fontSize: 11, color: "#aaa", fontFamily: "monospace", marginBottom: 16 }}>#{infoOrder.id}</div>
                        {[
                            { label: "Тема", val: infoOrder.topic },
                            { label: "Тип роботи", val: infoOrder.type },
                            { label: "Галузь / спеціальність", val: infoOrder.subject },
                            { label: "К-сть сторінок", val: infoOrder.pages },
                            { label: "Мова", val: infoOrder.language },
                            { label: "Унікальність", val: infoOrder.uniqueness },
                            { label: "Дедлайн", val: infoOrder.deadline },
                            { label: "К-сть джерел", val: infoOrder.sourceCount },
                            { label: "Додатково", val: infoOrder.extras },
                            { label: "Вимоги методички", val: infoOrder.methodNotes },
                            { label: "Дата створення", val: infoOrder.createdAt?.slice(0, 10) },
                        ].filter(r => r.val).map(r => (
                            <div key={r.label} style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: 13 }}>
                                <div style={{ color: "#888", minWidth: 160, flexShrink: 0 }}>{r.label}</div>
                                <div style={{ color: "#1a1a14", fontWeight: 500 }}>{r.val}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
