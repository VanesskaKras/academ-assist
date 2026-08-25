// ── Перевірка фактичного обсягу згенерованого тексту ──
// ШІ інколи недописує (чи навпаки перегинає) заданий обсяг. countWords рахує
// реальну кількість слів, enforceWordCount звіряє її з ціллю і за потреби
// робить ще один виклик — "допиши ще N слів" або "скороти до N слів".
export function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Кінець речення: крапка/!/?/… (можливо перед закриваючою лапкою/дужкою),
// після якого йде пробіл або кінець тексту.
const SENTENCE_END_RE = /[.!?…]+[»"'）)\]]*(?=\s|$)/g;

// Відрізає незавершений "хвіст" в кінці тексту (обрив ШІ посеред речення
// через ліміт токенів) — повертає текст по останню знайдену межу речення.
// Якщо в тексті взагалі немає завершеного речення - повертає як є (нема куди різати).
export function cutToLastSentence(text) {
  const trimmed = (text || "").replace(/\s+$/, "");
  let lastEnd = -1;
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(trimmed))) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1 || lastEnd === trimmed.length) return trimmed;
  return trimmed.slice(0, lastEnd).trim();
}

function endsWithSentence(text) {
  const trimmed = (text || "").replace(/\s+$/, "");
  if (!trimmed) return true;
  let lastEnd = -1;
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(trimmed))) lastEnd = m.index + m[0].length;
  return lastEnd === trimmed.length;
}

// Детерміновано скорочує текст до приблизно targetWords слів, набираючи цілі
// речення по порядку і зупиняючись, щойно ціль досягнута - завжди по межі
// речення, ніколи посеред слова.
export function trimToWordTarget(text, targetWords) {
  const sentences = text.match(/[\s\S]+?[.!?…]+[»"'）)\]]*(?:\s+|$)|[\s\S]+$/g) || [text];
  let result = "";
  let count = 0;
  for (const sentence of sentences) {
    const w = countWords(sentence);
    if (count > 0 && count + w > targetWords) break;
    result += sentence;
    count += w;
    if (count >= targetWords) break;
  }
  return (result.trim() || text.trim());
}

export async function enforceWordCount({ text, targetWords, label, callClaude, sys, signal, onProgress, clean, cacheOpts }) {
  const n = countWords(text);
  try {
    if (n < targetWords * 0.85) {
      const missing = targetWords - n;
      onProgress?.(`Дописую: ${label}...`);
      const contPrompt = `Ось поточний текст "${label}" (${n} слів):\n\n${text}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі. Не повторюй вже написане. Не додавай вступних фраз на кшталт "Продовжимо" чи "Отже". Просто продовжуй текст з того місця де він закінчився, без заголовків і міток.`;
      const contRaw = await callClaude([{ role: "user", content: contPrompt }], signal, sys, Math.min(20000, Math.max(2000, Math.round(missing * 3))), null, undefined, cacheOpts);
      let contClean = (clean ? clean(contRaw) : contRaw).trim();
      if (!endsWithSentence(contClean)) contClean = cutToLastSentence(contClean);
      return text + "\n\n" + contClean;
    }
    if (n > targetWords * 1.2) {
      // Скорочуємо детерміновано кодом (по межі речення), а не ще одним викликом ШІ:
      // це прибирає і зайвий виклик, і повторну пересилку вже написаного тексту як
      // input — той самий підхід, що вже давно й надійно працює в trimToPageTarget.
      onProgress?.(`Скорочую: ${label}...`);
      return trimToWordTarget(text, targetWords);
    }
  } catch {
    // Якщо допис не вдався - лишаємо початковий текст як є
  }
  return text;
}

// ── Фінальна перевірка сумарного обсягу готової роботи ──
// enforceWordCount тримає в межах кожен підрозділ окремо (з допуском ±10-20%),
// але через ці допуски, помножені на десятки підрозділів, сумарний обсяг усієї
// роботи може вийти за верхню межу заданого діапазону сторінок навіть якщо
// кожен підрозділ формально пройшов перевірку. trimToPageTarget рахує фактичний
// обсяг усієї роботи і, якщо він перевищує maxPages, скорочує найбільші основні
// підрозділи (теорія/аналіз/рекомендації) по черзі, поки сумарний обсяг не
// впишеться в межу — не займаючись вступом/висновками/додатками, де формат
// суворо фіксований.
//
// Скорочення тут робиться детерміновано кодом (по межі речення), а не викликом
// ШІ: скорочувальний виклик ШІ для великих текстів схильний перевищувати
// закладений бюджет токенів і обриватись посеред слова (саме так одного разу
// обірвався кінець підрозділу в готовій роботі) - різання по реченнях кодом
// такого ризику не має.
export function trimToPageTarget({ sections, content, maxPages, onProgress }) {
  const WORDS_PER_PAGE = 270;
  const eligibleTypes = new Set(["theory", "analysis", "recommendations"]);

  const wordsOf = (id) => countWords(content[id] || "");
  const totalWords = sections.reduce((sum, s) => sum + wordsOf(s.id), 0);
  let excess = totalWords - maxPages * WORDS_PER_PAGE;
  if (excess <= 0) return content;

  const updated = { ...content };
  const bySize = sections
    .filter(s => eligibleTypes.has(s.type) && updated[s.id])
    .sort((a, b) => wordsOf(b.id) - wordsOf(a.id));

  for (const sec of bySize) {
    if (excess <= 0) break;
    const words = countWords(updated[sec.id]);
    const maxCut = Math.floor(words * 0.25); // не більше 25% від підрозділу за один прохід
    const cut = Math.min(maxCut, excess);
    if (cut < 50) continue; // дрібне скорочення не варте окремого проходу
    const target = words - cut;
    onProgress?.(`Перевіряю обсяг: скорочую "${sec.label}"...`);
    const newText = trimToWordTarget(updated[sec.id], target);
    const newWords = countWords(newText);
    updated[sec.id] = newText;
    excess -= (words - newWords);
  }
  return updated;
}
