// ── Зворотна транслітерація прізвищ/імен: латиниця → кирилиця ──
// Виправляє артефакт баз даних (OpenAlex, CrossRef): українських авторів
// вони часто віддають ЛИШЕ латиницею (напр. display_name "Tetiana Leleka"),
// навіть коли стаття кирилична. Мапа побудована як точне дзеркало офіційної
// української таблиці транслітерації (постанова КМУ №55) — тому для типових
// прізвищ зворотне відображення однозначне (перевірено: "Savchuk" → "Савчук",
// що збігається з написанням цього ж прізвища кирилицею в тому самому записі).

export function isCyrillicText(s) {
  return /[А-ЯҐЄІЇа-яґєії]/.test(s || "");
}

function hasLatinLetters(s) {
  return /[A-Za-z]/.test(s || "");
}

const MULTI_ORDERED = [
  ["shch", "щ"], ["kh", "х"], ["ts", "ц"], ["ch", "ч"], ["sh", "ш"], ["zh", "ж"],
  ["yu", "ю"], ["ya", "я"], ["ye", "є"], ["yi", "ї"],
  ["iu", "ю"], ["ia", "я"], ["ie", "є"],
];

const SINGLE_MAP = {
  a: "а", b: "б", v: "в", g: "ґ", d: "д", e: "е", z: "з", i: "і", k: "к",
  l: "л", m: "м", n: "н", o: "о", p: "п", r: "р", s: "с", t: "т", u: "у",
  f: "ф", h: "г", c: "к", w: "в", x: "кс", j: "й", q: "к", y: "и",
};

function applyCase(original, translit) {
  if (!translit) return translit;
  return /^[A-Z]/.test(original) ? translit.charAt(0).toUpperCase() + translit.slice(1) : translit;
}

function translitWord(word) {
  const lower = word.toLowerCase();
  if (lower.length === 1) return applyCase(word, SINGLE_MAP[lower] || lower);
  let out = "";
  let i = 0;
  while (i < lower.length) {
    const hit = MULTI_ORDERED.find(([lat]) => lower.startsWith(lat, i));
    if (hit) { out += hit[1]; i += hit[0].length; continue; }
    if (lower[i] === "y") { out += i === 0 ? "й" : "и"; i += 1; continue; }
    out += SINGLE_MAP[lower[i]] || lower[i];
    i += 1;
  }
  return applyCase(word, out);
}

// Транслітерує кожне латинське "слово" (послідовність літер) у рядку,
// зберігаючи пробіли/крапки/дефіси/апострофи як є. Кириличні фрагменти —
// не чіпає.
export function transliterateLatinToCyrillic(text) {
  if (!text || !hasLatinLetters(text)) return text;
  return text.replace(/[A-Za-z]+/g, translitWord);
}

// Приводить масив імен (авторів одного джерела) до єдиної абетки: якщо
// хоч десь у записі (назва, чи інший автор) уже є кирилиця — усі суто
// латинські імена в масиві транслітеруються в кирилицю, щоб не виходило
// "Savchuk I., Лисецька Ю. В." замість "Савчук І., Лисецька Ю. В.".
export function normalizeAuthorsScript(names, recordIsCyrillic) {
  if (!names?.length) return names;
  const anyCyrillic = recordIsCyrillic || names.some(isCyrillicText);
  if (!anyCyrillic) return names;
  return names.map(n => (n && !isCyrillicText(n) && hasLatinLetters(n)) ? transliterateLatinToCyrillic(n) : n);
}
