import { findDanglingFigureRefs, getLangLabels } from "./planUtils.js";
import { buildFigureInsertPrompt } from "./prompts.js";
import { locateFragment } from "./textFragmentLocate.js";

// Спільна для academic-assistant.jsx, small-works.jsx і PracticePage.jsx (яка має свою
// локальну копію старшу за цей файл) добудова рисунків, які ШІ згадала в тексті ("...показано
// на Рис. X.Y"), але так і не намалювала (ні plantuml-блоку, ні таблиці з підписом) — типово
// тому, що модель обрала "запасний" варіант з FIGURES-правил промпту (голий підпис-плейсхолдер)
// замість того, щоб намалювати PlantUML-схему. findDanglingFigureRefs (planUtils.js) знаходить
// такі місця кодом; ця функція для kind:"missing" точково домальовує PlantUML-схему одним
// пакетним запитом, а для kind:"misplaced" (рисунок є, але задалеко від посилання) просто
// переносить блок кодом, без звернення до ШІ.
export async function fixDanglingFigures({ text, lang, callClaude, signal }) {
  const figWord = getLangLabels(lang).figWord;
  const dangling = findDanglingFigureRefs(text, figWord);
  if (!dangling.length) return text;

  let fixed = text;
  const misplaced = dangling.filter(d => d.kind === "misplaced").sort((a, b) => b.blockStart - a.blockStart);
  misplaced.forEach(d => {
    const blockText = fixed.slice(d.blockStart, d.blockEnd).trim();
    const before = fixed.slice(0, d.blockStart).replace(/\n{3,}$/, "\n\n");
    const after = fixed.slice(d.blockEnd).replace(/^\n{3,}/, "\n\n");
    const withoutBlock = before + after;
    const loc = locateFragment(withoutBlock, d.sentence, null);
    if (!loc) return; // не знайшли, куди переносити — лишаємо блок на місці, не втрачаємо рисунок
    fixed = withoutBlock.slice(0, loc.end) + "\n\n" + blockText + "\n" + withoutBlock.slice(loc.end);
  });

  const missing = dangling.filter(d => d.kind === "missing");
  if (!missing.length) return fixed;

  let raw;
  try {
    raw = await callClaude(
      [{ role: "user", content: buildFigureInsertPrompt({ sectionText: fixed, dangling: missing, lang }) }],
      signal || null, "Ти — редактор академічного тексту. Повертай лише JSON, без пояснень.", 4000,
    );
  } catch (e) {
    console.error("fixDanglingFigures error:", e.message);
    raw = null;
  }
  let parsed = [];
  try {
    const m = raw?.match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  } catch { /* нижче — фолбек: прибираємо речення без рисунка */ }

  missing.forEach((d, i) => {
    const loc = locateFragment(fixed, d.sentence, null);
    if (!loc) return;
    const item = parsed.find(p => p.index === i);
    if (item?.feasible && item?.plantuml) {
      const caption = item.caption?.trim() || `${figWord} ${d.number}`;
      const block = `\n\n\`\`\`plantuml\n${item.plantuml.trim()}\n\`\`\`\n${caption}`;
      fixed = fixed.slice(0, loc.end) + block + fixed.slice(loc.end);
    } else {
      // Модель визнала рисунок недоречним, чи відповідь не розпарсилась — прибираємо саме
      // речення-посилання, щоб текст не посилався на схему, якої так і не буде.
      const before = fixed.slice(0, loc.start).replace(/\s+$/, "");
      const after = fixed.slice(loc.end).replace(/^\s+/, "");
      fixed = before + (before && after ? " " : "") + after;
    }
  });
  return fixed;
}
