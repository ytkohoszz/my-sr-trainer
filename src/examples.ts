import { requestUrl } from "obsidian";

export interface ExampleSentenceItem {
  text: string;
  source: string;
}

const TRANSLATE_TIMEOUT_MS = 10000;
const examplesCache = new Map<string, ExampleSentenceItem[]>();

const DESKTOP_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`нет ответа за ${ms / 1000} с`)), ms)
    ),
  ]);
}

export const normStr = (s: string): string =>
  String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export const normText = (s: string): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[“”"«»'.,!?;:()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const cleanExample = (s: string): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/:{2,}/g, ":")
    .replace(/==|\*\*/g, "")
    .trim();

export const cleanLineText = (s: string): string =>
  String(s ?? "")
    .replace(/\r?\n|\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function speakEnglishText(text: string) {
  const clean = String(text ?? "").replace(/\[.*?\]/g, "").trim();
  if (!clean || typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = "en-US";
    utter.rate = 0.94;
    const voices = window.speechSynthesis.getVoices?.() || [];
    const preferred =
      voices.find(
        (v) =>
          /en[-_](US|GB)/i.test(v.lang) &&
          /natural|google|samantha|daniel|alex/i.test(v.name)
      ) || voices.find((v) => /^en/i.test(v.lang));
    if (preferred) utter.voice = preferred;
    window.speechSynthesis.speak(utter);
  } catch {
    // Игнорируем ошибку синтезатора речи
  }
}

export function normalizeExampleWord(word: string): string {
  return String(word ?? "")
    .trim()
    .replace(/^to\s+(?=\S+$)/i, "")
    .replace(/[^\p{L}\p{N}'’\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasCachedExamples(word: string): boolean {
  const key = normalizeExampleWord(word).toLowerCase();
  return Boolean(key && examplesCache.has(key));
}

export function getCachedExamples(word: string): ExampleSentenceItem[] | undefined {
  const key = normalizeExampleWord(word).toLowerCase();
  return key ? examplesCache.get(key) : undefined;
}

export async function fetchExamples(word: string): Promise<ExampleSentenceItem[]> {
  const clean = normalizeExampleWord(word);
  if (!clean) throw new Error("пустой запрос");

  const cacheKey = clean.toLowerCase();
  const cached = examplesCache.get(cacheKey);
  if (cached) return cached;

  const items: ExampleSentenceItem[] = [];
  const seen = new Set<string>();
  const pushExample = (raw: unknown, source: string) => {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (s.length < 8 || s.length > 220) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    items.push({ text: s, source });
  };

  const readJson = (r: { json?: unknown; text: string }): unknown =>
    typeof r.json === "object" && r.json !== null ? r.json : JSON.parse(r.text);

  let answered = false;
  let lastErr: unknown = null;

  // 1. Free Dictionary API
  try {
    const url =
      "https://api.dictionaryapi.dev/api/v2/entries/en/" +
      encodeURIComponent(cacheKey);
    const r = await withTimeout(
      requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
      TRANSLATE_TIMEOUT_MS
    );
    if (r.status === 200) {
      answered = true;
      const data = readJson(r);
      if (Array.isArray(data)) {
        for (const entry of data) {
          const meanings = Array.isArray((entry as { meanings?: unknown[] })?.meanings)
            ? ((entry as { meanings: unknown[] }).meanings)
            : [];
          for (const m of meanings) {
            const defs = Array.isArray((m as { definitions?: unknown[] })?.definitions)
              ? ((m as { definitions: unknown[] }).definitions)
              : [];
            for (const d of defs) {
              pushExample((d as { example?: unknown })?.example, "Free Dictionary");
            }
          }
        }
      }
    } else if (r.status === 404) {
      answered = true;
    } else {
      lastErr = new Error("словарь: код " + r.status);
    }
  } catch (e) {
    lastErr = e;
  }

  // 2. Tatoeba API (если примеров меньше 3)
  if (items.length < 3) {
    const q = encodeURIComponent('"' + clean + '"');
    const base =
      "https://api.tatoeba.org/v1/sentences?lang=eng&q=" +
      q +
      "&sort=random&limit=8";
    for (const url of [base + "&is_unapproved=no", base]) {
      try {
        const r = await withTimeout(
          requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
          TRANSLATE_TIMEOUT_MS
        );
        if (r.status !== 200) {
          lastErr = new Error("Tatoeba: код " + r.status);
          continue;
        }
        answered = true;
        const data = readJson(r) as { data?: Array<{ text?: unknown }> } | null;
        const arr = Array.isArray(data?.data) ? data!.data : [];
        for (const s of arr) {
          pushExample(s?.text, "Tatoeba");
        }
        break;
      } catch (e) {
        lastErr = e;
        break;
      }
    }
  }

  if (!answered && !items.length) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("сервисы примеров недоступны");
  }

  const result = items.slice(0, 12);
  examplesCache.set(cacheKey, result);
  return result;
}

export function appendHighlightedSentence(
  parent: HTMLElement,
  sentence: string,
  word: string,
  mask: boolean
) {
  const base = normalizeExampleWord(word);
  const parts = base
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (!parts.length) {
    parent.createSpan({ text: sentence });
    return;
  }

  const re = new RegExp("\\b(" + parts.join("\\s+") + ")\\w*", "gi");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    const matchedWord = m[0] ?? "";
    if (matchedWord.length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) {
      parent.createSpan({ text: sentence.slice(last, m.index) });
    }
    if (mask) {
      parent.createSpan({
        text: "_____",
        cls: "my-sr-masked-word",
      });
    } else {
      parent.createEl("strong", { text: matchedWord });
    }
    last = m.index + matchedWord.length;
  }
  if (last < sentence.length) {
    parent.createSpan({ text: sentence.slice(last) });
  }
}

export function evaluateWrittenAnswer(
  userRaw: string,
  targetRaw: string,
  isEnglishScope: boolean
): { pct: number; label: string; color: string } {
  const uNorm = normText(userRaw);
  const tNorm = normText(targetRaw);
  if (!uNorm) return { pct: 0, label: "", color: "var(--text-muted)" };

  if (isEnglishScope) {
    const expectedVariants = targetRaw
      .split(/[;,/]/)
      .map((s) => normText(s))
      .filter(Boolean);
    const isExact = expectedVariants.includes(uNorm) || tNorm === uNorm;
    return {
      pct: isExact ? 100 : 0,
      label: isExact
        ? `✓ Точно: «${userRaw.trim()}»`
        : `Твой ввод: «${userRaw.trim()}»`,
      color: isExact ? "#4aab80" : "#e5a158",
    };
  }

  if (uNorm === tNorm) {
    return {
      pct: 100,
      label: `✓ Точное совпадение (100%) · «${userRaw.trim()}»`,
      color: "#4aab80",
    };
  }

  const stopWords = new Set([
    "и", "в", "на", "с", "по", "для", "от", "к", "из", "у", "о",
    "это", "как", "что", "или", "не", "а", "но", "при",
    "the", "a", "an", "of", "to", "in", "is", "are",
  ]);
  const targetTokens = tNorm
    .split(" ")
    .filter((w) => w.length > 1 && !stopWords.has(w));

  if (!targetTokens.length) {
    const ok = tNorm.includes(uNorm) || uNorm.includes(tNorm);
    return {
      pct: ok ? 100 : 0,
      label: ok ? "✓ Совпадает" : `Твой ответ: «${userRaw.trim()}»`,
      color: ok ? "#4aab80" : "#d85b57",
    };
  }

  const userTokens = uNorm.split(" ").filter(Boolean);
  let matched = 0;
  for (const tw of targetTokens) {
    const stem =
      tw.length > 5 ? tw.slice(0, -2) : tw.length > 3 ? tw.slice(0, -1) : tw;
    if (userTokens.some((uw) => uw.startsWith(stem) || tw.startsWith(uw))) {
      matched++;
    }
  }
  const pct = Math.round((matched / targetTokens.length) * 100);
  if (pct >= 85) {
    return {
      pct,
      label: `✓ Отлично (${pct}% ключевых слов) · «${userRaw.trim()}»`,
      color: "#4aab80",
    };
  }
  if (pct >= 45) {
    return {
      pct,
      label: `◐ Частично верно (${pct}% ключевых слов) · «${userRaw.trim()}»`,
      color: "#e5a158",
    };
  }
  return {
    pct,
    label: `✕ Мало совпадений (${pct}%) · «${userRaw.trim()}»`,
    color: "#d85b57",
  };
}