// ── Перевірка фактичного обсягу згенерованого тексту ──
// ШІ інколи недописує (чи навпаки перегинає) заданий обсяг. countWords рахує
// реальну кількість слів, enforceWordCount звіряє її з ціллю і за потреби
// робить ще один виклик — "допиши ще N слів" або "скороти до N слів".
export function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export async function enforceWordCount({ text, targetWords, label, callClaude, sys, signal, onProgress, clean }) {
  const n = countWords(text);
  try {
    if (n < targetWords * 0.85) {
      const missing = targetWords - n;
      onProgress?.(`Дописую: ${label}...`);
      const contPrompt = `Ось поточний текст "${label}" (${n} слів):\n\n${text}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі. Не повторюй вже написане. Не додавай вступних фраз на кшталт "Продовжимо" чи "Отже". Просто продовжуй текст з того місця де він закінчився, без заголовків і міток.`;
      const contRaw = await callClaude([{ role: "user", content: contPrompt }], signal, sys, Math.min(20000, Math.max(2000, Math.round(missing * 3))));
      const contClean = clean ? clean(contRaw) : contRaw;
      return text + "\n\n" + contClean.trim();
    }
    if (n > targetWords * 1.2) {
      onProgress?.(`Скорочую: ${label}...`);
      const shortenPrompt = `Ось поточний текст "${label}" (${n} слів):\n\n${text}\n\nСкороти його до приблизно ${targetWords} слів: прибери повтори та другорядні деталі, збережи головні тези і структуру абзаців. Поверни лише скорочений текст, без коментарів.`;
      const shortRaw = await callClaude([{ role: "user", content: shortenPrompt }], signal, sys, Math.min(30000, Math.max(4000, Math.round(targetWords * 3))));
      const shortClean = clean ? clean(shortRaw) : shortRaw;
      return shortClean.trim();
    }
  } catch {
    // Якщо допис/скорочення не вдалось - лишаємо початковий текст як є
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
export async function trimToPageTarget({ sections, content, maxPages, callClaude, sys, clean, onProgress }) {
  const WORDS_PER_PAGE = 270;
  const eligibleTypes = new Set(["theory", "analysis", "recommendations"]);

  const wordsOf = (id) => countWords(content[id] || "");
  const totalWords = sections
    .filter(s => s.type !== "sources")
    .reduce((sum, s) => sum + wordsOf(s.id), 0);
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
    if (cut < 50) continue; // дрібне скорочення не варте окремого виклику
    const target = words - cut;
    onProgress?.(`Перевіряю обсяг: скорочую "${sec.label}"...`);
    try {
      const prompt = `Ось текст підрозділу "${sec.label}" (${words} слів):\n\n${updated[sec.id]}\n\nСкороти його до приблизно ${target} слів: прибери повтори, другорядні деталі й надлишкові приклади, збережи головні тези, структуру абзаців, усі цитати та посилання на джерела [N]. Поверни лише скорочений текст, без коментарів.`;
      const raw = await callClaude([{ role: "user", content: prompt }], null, sys, Math.min(30000, Math.max(4000, Math.round(target * 3))));
      const newText = (clean ? clean(raw) : raw).trim();
      const newWords = countWords(newText);
      updated[sec.id] = newText;
      excess -= (words - newWords);
    } catch {
      // якщо скорочення конкретного підрозділу не вдалось - лишаємо його як є й пробуємо наступний
    }
  }
  return updated;
}
