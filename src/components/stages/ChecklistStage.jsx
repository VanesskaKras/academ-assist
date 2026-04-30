import { useState } from "react";
import { Heading, NavBtn } from "../Buttons.jsx";

const CHECKLIST_LARGE = [
  "Перевірено унікальність тексту",
  "Оформлено список літератури",
  "Перевірено відповідність темі",
  "Перевірена кількість сторінок",
  "Підготовлено доповідь до захисту",
  "Збережено копію роботи",
];

const CHECKLIST_SMALL = [
  "Перевірено текст на помилки",
  "Перевірено відповідність темі",
  "Перевірена кількість сторінок",
  "Збережено копію роботи",
];

function InfoRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: "1.5px", color: "#555", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: "#f5f2eb", lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}

export function ChecklistStage({ info, setStage, mode = "large" }) {
  const items = mode === "large" ? CHECKLIST_LARGE : CHECKLIST_SMALL;
  const [checked, setChecked] = useState(() =>
    Object.fromEntries(items.map((_, i) => [i, false]))
  );

  const doneCount = Object.values(checked).filter(Boolean).length;
  const allDone = doneCount === items.length;

  return (
    <div className="fade">
      <Heading style={{ marginBottom: 4 }}>Перевірка роботи</Heading>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>Перевірте всі пункти перед здачею замовлення.</p>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>

        {/* ── Ліворуч: зведення замовлення ── */}
        <div style={{ flex: 1, minWidth: 260, background: "#1a1a14", border: "1.5px solid #333", borderRadius: 10, padding: "22px 24px" }}>
          <div style={{ fontSize: 11, letterSpacing: "2px", color: "#e8ff47", textTransform: "uppercase", marginBottom: 20 }}>Замовлення</div>
          <InfoRow label="Тема" value={info?.topic} />
          <InfoRow label="Тип роботи" value={info?.type} />
          <InfoRow label="Предмет / спеціальність" value={info?.subject || info?.direction} />
          <InfoRow label="Кількість сторінок" value={info?.pages} />
          <InfoRow label="Унікальність" value={info?.uniqueness} />
          <InfoRow label="Дедлайн" value={info?.deadline} />
          {mode === "large" && info?.sourceCount && (
            <InfoRow label="Кількість джерел" value={String(info.sourceCount)} />
          )}
        </div>

        {/* ── Праворуч: чек-лист ── */}
        <div style={{ flex: 1, minWidth: 260, background: "#faf8f3", border: "1.5px solid #d4cfc4", borderRadius: 10, padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 11, letterSpacing: "2px", color: "#7a7060", textTransform: "uppercase" }}>Чек-лист</div>
            <div style={{ fontSize: 12, color: allDone ? "#2a7a2a" : "#888" }}>
              {doneCount} / {items.length}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((label, i) => (
              <label
                key={i}
                style={{
                  display: "flex", alignItems: "center", gap: 12, cursor: "pointer",
                  padding: "11px 14px", borderRadius: 7,
                  background: checked[i] ? "#e8f5e8" : "#fff",
                  border: `1.5px solid ${checked[i] ? "#6a9a6a" : "#d4cfc4"}`,
                  transition: "background 0.15s, border-color 0.15s",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked[i]}
                  onChange={() => setChecked(c => ({ ...c, [i]: !c[i] }))}
                  style={{ width: 16, height: 16, accentColor: "#4a8a4a", cursor: "pointer", flexShrink: 0 }}
                />
                <span style={{
                  fontSize: 13, lineHeight: 1.4,
                  color: checked[i] ? "#3a6a3a" : "#2a2a1e",
                  textDecoration: checked[i] ? "line-through" : "none",
                }}>
                  {label}
                </span>
              </label>
            ))}
          </div>

          {allDone && (
            <div style={{ marginTop: 16, padding: "12px 14px", background: "#d4f0d4", borderRadius: 8, fontSize: 13, color: "#2a6a2a", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>✓</span> Усі пункти виконано — робота готова до здачі!
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <NavBtn onClick={() => setStage("done")}>← Готово</NavBtn>
      </div>
    </div>
  );
}
