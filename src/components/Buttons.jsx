import { memo } from "react";
import { SpinDot } from "./SpinDot.jsx";

export function FieldBox({ label, children }) {
  return <div style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 11, color: "#888", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
    {children}
  </div>;
}

export function Heading({ children, style = {} }) {
  return <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 17, letterSpacing: 2, marginBottom: 20, ...style }}>{children}</div>;
}

export function NavBtn({ onClick, children, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: disabled ? "#ccc" : "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer" }}>{children}</button>;
}

export function PrimaryBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#1a1a14", color: (disabled || loading) ? "#eee" : "#e8ff47", border: "none", borderRadius: 7, padding: "11px 34px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: (disabled || loading) ? "default" : "pointer" }}>
    {loading ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><SpinDot light />{msg}</span> : label}
  </button>;
}

export function GreenBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#2a3a1a", color: (disabled || loading) ? "#eee" : "#a8d060", border: "none", borderRadius: 7, padding: "10px 24px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (disabled || loading) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
    {loading ? <><SpinDot light />{msg}</> : label}
  </button>;
}

export const SaveIndicator = memo(function SaveIndicator({ saving, saved }) {
  if (saving) return <span style={{ fontSize: 11, color: "#aaa", display: "inline-flex", alignItems: "center", gap: 5 }}><SpinDot />Збереження...</span>;
  if (saved) return <span style={{ fontSize: 11, color: "#6a9000" }}>✓ Збережено</span>;
  return null;
});
