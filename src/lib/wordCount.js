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
