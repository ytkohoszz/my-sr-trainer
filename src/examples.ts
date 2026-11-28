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

export interface SynonymGroup {
  partOfSpeech: string;
  words: string[];
}

export interface SynonymsResult {
  groups: SynonymGroup[];
  sources: string[];
}

const synonymsCache = new Map<string, SynonymsResult>();

function normalizeSynonymQuery(word: string): string {
  const clean = normalizeExampleWord(word);
  return clean.replace(/^to\s+/i, "").trim() || clean;
}

function normalizePosLabel(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "n" || s === "noun") return "noun";
  if (s === "v" || s === "verb") return "verb";
  if (s === "adj" || s === "adjective") return "adj";
  if (s === "adv" || s === "adverb") return "adv";
  return "";
}

export function hasCachedSynonyms(word: string): boolean {
  const key = normalizeSynonymQuery(word).toLowerCase();
  return Boolean(key && synonymsCache.has(key));
}

export function getCachedSynonyms(word: string): SynonymsResult | undefined {
  const key = normalizeSynonymQuery(word).toLowerCase();
  return key ? synonymsCache.get(key) : undefined;
}

export async function fetchSynonyms(word: string): Promise<SynonymsResult> {
  const clean = normalizeSynonymQuery(word);
  if (!clean) throw new Error("пустой запрос");

  const cacheKey = clean.toLowerCase();
  const cached = synonymsCache.get(cacheKey);
  if (cached) return cached;

  const MAX_SYNONYMS = 12;
  const groupsMap = new Map<string, string[]>();
  const sources = new Set<string>();
  const seen = new Set<string>([
    cacheKey,
    normalizeExampleWord(word).toLowerCase(),
  ]);
  let total = 0;

  const pushSynonym = (raw: unknown, posRaw: unknown, source: string) => {
    if (total >= MAX_SYNONYMS) return;
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!s || s.length > 40) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);

    const pos = normalizePosLabel(posRaw);
    const list = groupsMap.get(pos) ?? [];
    list.push(s);
    groupsMap.set(pos, list);
    sources.add(source);
    total++;
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
          const meanings = Array.isArray(
            (entry as { meanings?: unknown[] })?.meanings
          )
            ? (entry as { meanings: unknown[] }).meanings
            : [];
          for (const m of meanings) {
            const pos = (m as { partOfSpeech?: unknown })?.partOfSpeech;
            const mSyns = Array.isArray((m as { synonyms?: unknown[] })?.synonyms)
              ? (m as { synonyms: unknown[] }).synonyms
              : [];
            for (const syn of mSyns) {
              pushSynonym(syn, pos, "Free Dictionary");
            }
            const defs = Array.isArray(
              (m as { definitions?: unknown[] })?.definitions
            )
              ? (m as { definitions: unknown[] }).definitions
              : [];
            for (const d of defs) {
              const dSyns = Array.isArray(
                (d as { synonyms?: unknown[] })?.synonyms
              )
                ? (d as { synonyms: unknown[] }).synonyms
                : [];
              for (const syn of dSyns) {
                pushSynonym(syn, pos, "Free Dictionary");
              }
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

  // 2. Datamuse API (если синонимов меньше 5)
  if (total < 5) {
    const encoded = encodeURIComponent(clean);
    const endpoints = [
      `https://api.datamuse.com/words?rel_syn=${encoded}&md=p&max=12`,
      `https://api.datamuse.com/words?ml=${encoded}&md=p&max=10`,
    ];

    for (let i = 0; i < endpoints.length; i++) {
      if (i === 1 && total > 0) break;
      const url = endpoints[i]!;
      try {
        const r = await withTimeout(
          requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
          TRANSLATE_TIMEOUT_MS
        );
        if (r.status !== 200) {
          lastErr = new Error("Datamuse: код " + r.status);
          continue;
        }
        answered = true;
        const data = readJson(r);
        if (Array.isArray(data)) {
          for (const item of data) {
            const w = (item as { word?: unknown })?.word;
            const tags = Array.isArray((item as { tags?: unknown[] })?.tags)
              ? (item as { tags: unknown[] }).tags
              : [];
            const posTag = tags.find((t) => normalizePosLabel(t) !== "");
            pushSynonym(w, posTag, "Datamuse");
          }
        }
      } catch (e) {
        lastErr = e;
        break;
      }
    }
  }

  if (!answered && total === 0) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("сервисы синонимов недоступны");
  }

  const posOrder = ["noun", "verb", "adj", "adv", ""];
  const groups: SynonymGroup[] = [];
  for (const pos of posOrder) {
    const words = groupsMap.get(pos);
    if (words && words.length > 0) {
      groups.push({ partOfSpeech: pos, words });
    }
  }

  const result: SynonymsResult = {
    groups,
    sources: [...sources],
  };
  synonymsCache.set(cacheKey, result);
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