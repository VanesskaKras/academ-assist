// ── Перевірка фактичного обсягу згенерованого тексту ──
// ШІ інколи недописує (чи навпаки перегинає) заданий обсяг. countWords рахує
// реальну кількість слів, enforceWordCount звіряє її з ціллю і за потреби
// робить ще один виклик — "допиши ще N слів" або "скороти до N слів".
import { estimateRealPages } from "./pageLayout.js";

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
  // Обсяг у прийнятних межах (85-120% цілі), тож жодна з гілок вище не спрацювала —
  // але текст все одно міг обірватись посеред речення (модель зупинилась невдало,
  // не через нестачу слів і не через ліміт токенів). Ріжемо по останній завершеній
  // межі речення незалежно від обсягу, а не лише в гілках "задовго"/"закоротко".
  return endsWithSentence(text) ? text : cutToLastSentence(text);
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
export function trimToPageTarget({ sections, content, maxPages, formatting, lang, onProgress }) {
  const eligibleTypes = new Set(["theory", "analysis", "recommendations"]);
  const fixedIds = new Set(["intro", "conclusions", "sources"]);
  // Курсові/дипломні проставляють sec.type ("theory"/"analysis"/"recommendations") на етапі
  // побудови структури — для них фільтруємо саме за типом. Звіти з практики (PracticePage.jsx)
  // такого поля взагалі не мають (буде sec.type undefined на кожній секції), тож без фолбека
  // eligibleTypes.has(undefined) завжди false і скорочення тихо не спрацьовує НІКОЛИ — саме
  // так і сталось: обсяг усе одно вийшов за межу навіть після підключення цієї функції.
  // Якщо type відсутній — придатність визначаємо за id (усе, крім фіксованих службових секцій).
  const isEligible = (s) => (s.type ? eligibleTypes.has(s.type) : !fixedIds.has(s.id));

  const updated = { ...content };
  // Рахуємо не приблизно "слова/270", а через реальну розкладку сторінки (pageLayout.js) —
  // враховує ширину сторінки, шрифт, таблиці, рисунки/схеми й посторінкові виноски, які
  // "слова/270" бачить як кілька слів, хоча реально вони займають значно більше місця.
  const pagesOf = (id) => estimateRealPages(updated[id] || "", formatting, lang);

  const totalPages = sections.reduce((sum, s) => sum + pagesOf(s.id), 0);
  let excessPages = totalPages - maxPages;
  if (excessPages <= 0) return content;

  // Один прохід ріже щонайбільше 25% від підрозділу — так свідомо, щоб текст не
  // спотворювався за одну ітерацію. Але якщо перевищення велике (напр. 50 стор.
  // замість 35 — це ~30% зайвого), 25% з ОДНОГО проходу по кожному підрозділу може
  // не вистачити: сума можливих 25%-скорочень по всіх придатних підрозділах менша за
  // excessPages, і без повторних проходів функція раніше просто зупинялась недорізаною.
  // Тому повторюємо проходи (кожен наступний рахує 25% від уже скороченого розміру),
  // поки excessPages не закриється або поки чергова ітерація нічого більше не змогла
  // зрізати. Межа ітерацій — не нескінченний цикл, а страховка: 0.75^6 ≈ 18% від
  // початкового обсягу придатних підрозділів лишиться незайманим у гіршому разі.
  for (let round = 0; round < 6 && excessPages > 0; round++) {
    const bySize = sections
      .filter(s => isEligible(s) && updated[s.id])
      .sort((a, b) => pagesOf(b.id) - pagesOf(a.id));
    if (!bySize.length) break;

    let cutThisRound = 0;
    for (const sec of bySize) {
      if (excessPages <= 0) break;
      const currentPages = pagesOf(sec.id);
      if (currentPages < 0.3) continue; // майже порожньо, нема сенсу різати

      // trimToWordTarget ріже по словах, а excessPages рахується в сторінках — переводимо
      // через локальну щільність "слів на реальну сторінку" САМЕ цього підрозділу (у ньому
      // може бути багато таблиць/рисунків, і глобальна константа тут спотворить оцінку).
      const currentWords = countWords(updated[sec.id]);
      const wordsPerPage = currentWords / currentPages;
      if (wordsPerPage < 1) continue; // секція — суцільні таблиці/рисунки, прозу різати нема чим

      const maxCutPages = currentPages * 0.25; // не більше 25% від підрозділу за один прохід
      const cutPages = Math.min(maxCutPages, excessPages);
      const wordsToCut = Math.round(cutPages * wordsPerPage);
      if (wordsToCut < 50) continue; // дрібне скорочення не варте окремого проходу

      const target = currentWords - wordsToCut;
      onProgress?.(`Перевіряю обсяг: скорочую "${sec.label}"...`);
      updated[sec.id] = trimToWordTarget(updated[sec.id], target);

      // Перевимірюємо ФАКТИЧНИЙ результат (текст могло зрізати не рівно по слову, а по
      // межі речення) — це самокоригується на наступних проходах, тож наближеної
      // конвертації слова↔сторінки вище достатньо.
      const newPages = pagesOf(sec.id);
      const actualCutPages = currentPages - newPages;
      excessPages -= actualCutPages;
      cutThisRound += actualCutPages;
    }
    if (cutThisRound < 0.05) break; // нема куди більше різати (усі підрозділи вже занадто малі)
  }
  return updated;
}
