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

// Якщо в тексті непарна кількість ``` — останній fence не закрився (генерація
// обірвалась посеред коду plantuml-діаграми через ліміт токенів). У такому разі
// прибираємо весь незавершений блок від його відкриваючого маркера й далі: код
// діаграми часто містить крапки/знаки оклику (в підписах стрілок на кшталт
// "Alice -> Bob: Готово."), тож "останнє речення" всередині нього — не справжня
// межа речення, а випадковий збіг.
function stripUnterminatedFence(text) {
  const fences = [...text.matchAll(/```/g)];
  if (fences.length % 2 !== 1) return text;
  const lastOpenIdx = fences[fences.length - 1].index;
  return text.slice(0, lastOpenIdx).replace(/\s+$/, "");
}

// Відрізає незавершений "хвіст" в кінці тексту (обрив ШІ посеред речення
// через ліміт токенів) — повертає текст по останню знайдену межу речення.
// Якщо в тексті взагалі немає завершеного речення - повертає як є (нема куди різати).
export function cutToLastSentence(text) {
  const trimmed = stripUnterminatedFence((text || "").replace(/\s+$/, ""));
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
  const raw = (text || "").replace(/\s+$/, "");
  const trimmed = stripUnterminatedFence(raw);
  if (trimmed !== raw) return false; // незавершений fence - точно не коректний кінець
  if (!trimmed) return true;
  let lastEnd = -1;
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(trimmed))) lastEnd = m.index + m[0].length;
  return lastEnd === trimmed.length;
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
      onProgress?.(`Скорочую: ${label}...`);
      const shortenPrompt = `Ось поточний текст "${label}" (${n} слів, а потрібно приблизно ${targetWords}):\n\n${text}\n\nСкороти цей текст приблизно до ${targetWords} слів: прибери повтори, зайві деталі й другорядні речення, але збережи логічну цілісність викладу, усі цифри й факти, посилання на джерела у форматі [N] та рисунки/таблиці без змін. Не додавай вступних фраз на кшталт "Ось скорочений варіант". Поверни лише скорочений текст розділу, без заголовків і міток.`;
      const shortRaw = await callClaude([{ role: "user", content: shortenPrompt }], signal, sys, Math.min(20000, Math.max(2000, Math.round(targetWords * 3))), null, undefined, cacheOpts);
      let shortClean = (clean ? clean(shortRaw) : shortRaw).trim();
      if (!endsWithSentence(shortClean)) shortClean = cutToLastSentence(shortClean);
      return shortClean;
    }
  } catch {
    // Якщо допис не вдався - лишаємо початковий текст як є
  }
  // Обсяг у прийнятних межах (85-120% цілі), тож жодна з гілок вище не спрацювала —
  // але текст все одно міг обірватись посеред речення (модель зупинилась невдало,
  // не через нестачу слів і не через ліміт токенів). Ріжемо по останній завершеній
  // межі речення незалежно від обсягу, а не лише в гілках "задовго"/"закоротко".
  return endsWithSentence(text) ? text : cutToLastSentence(text);
}
