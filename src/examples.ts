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

export function stopEnglishSpeech() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
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

export interface TranslationResult {
  items: string[];
  sources: string[];
}

const translationsCache = new Map<string, TranslationResult>();

export function hasCachedTranslations(word: string): boolean {
  const key = normalizeExampleWord(word).toLowerCase();
  return Boolean(key && translationsCache.has(key));
}

export function getCachedTranslations(
  word: string
): TranslationResult | undefined {
  const key = normalizeExampleWord(word).toLowerCase();
  return key ? translationsCache.get(key) : undefined;
}

export async function fetchTranslations(
  word: string
): Promise<TranslationResult> {
  const clean = normalizeExampleWord(word);
  if (!clean) throw new Error("пустой запрос");

  const cacheKey = clean.toLowerCase();
  const cached = translationsCache.get(cacheKey);
  if (cached) return cached;

  const hasCyrillic = /[а-яё]/i;
  const scored = new Map<string, { text: string; score: number }>();
  const sources = new Set<string>();

  const pushTranslation = (raw: unknown, score: number, source: string) => {
    const s = String(raw ?? "")
      .replace(/\s+/g, " ")
      .replace(/^[.,;:\-–—\s]+|[.,;:\-–—\s]+$/g, "")
      .trim();
    if (s.length < 2 || s.length > 48) return;
    if (!hasCyrillic.test(s)) return;
    const k = s.toLowerCase();
    if (k === cacheKey) return;

    const prev = scored.get(k);
    if (!prev || score > prev.score) {
      scored.set(k, { text: prev ? prev.text : s, score });
    }
    sources.add(source);
  };

  const readJson = (r: { json?: unknown; text: string }): unknown =>
    typeof r.json === "object" && r.json !== null ? r.json : JSON.parse(r.text);

  let answered = false;
  let lastErr: unknown = null;

  // 1. Google Translate (основной перевод + словарь с оценкой частотности)
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&dt=bd&q=" +
      encodeURIComponent(cacheKey);
    const r = await withTimeout(
      requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
      TRANSLATE_TIMEOUT_MS
    );
    if (r.status === 200) {
      answered = true;
      const data = readJson(r);
      if (Array.isArray(data)) {
        const segs = Array.isArray(data[0]) ? data[0] : [];
        const mainParts: string[] = [];
        for (const seg of segs) {
          if (Array.isArray(seg) && typeof seg[0] === "string") {
            mainParts.push(seg[0]);
          }
        }
        const mainText = mainParts.join("").trim();
        if (mainText) pushTranslation(mainText, 1.0, "Google Translate");

        const dict = Array.isArray(data[1]) ? data[1] : [];
        for (const group of dict) {
          if (!Array.isArray(group)) continue;
          const detailed = Array.isArray(group[2]) ? group[2] : [];
          if (detailed.length > 0) {
            detailed.forEach((entry, idx) => {
              if (!Array.isArray(entry)) return;
              const rawScore = Number(entry[3]);
              const score =
                Number.isFinite(rawScore) && rawScore > 0
                  ? Math.min(0.99, rawScore)
                  : Math.max(0.001, 0.4 - idx * 0.02);
              pushTranslation(entry[0], score, "Google Translate");
            });
          } else {
            const simple = Array.isArray(group[1]) ? group[1] : [];
            simple.forEach((w, idx) => {
              pushTranslation(
                w,
                Math.max(0.001, 0.4 - idx * 0.02),
                "Google Translate"
              );
            });
          }
        }
      }
    } else {
      lastErr = new Error("Google Translate: код " + r.status);
    }
  } catch (e) {
    lastErr = e;
  }

  // 2. MyMemory API (фолбэк, если Google вернул меньше 2 вариантов)
  if (scored.size < 2) {
    try {
      const url =
        "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(cacheKey) +
        "&langpair=en|ru";
      const r = await withTimeout(
        requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
        TRANSLATE_TIMEOUT_MS
      );
      if (r.status === 200) {
        answered = true;
        const data = readJson(r) as {
          responseData?: { translatedText?: unknown };
          matches?: Array<{
            translation?: unknown;
            match?: unknown;
            "usage-count"?: unknown;
          }>;
        } | null;

        if (data?.responseData?.translatedText) {
          pushTranslation(data.responseData.translatedText, 0.9, "MyMemory");
        }
        const matches = Array.isArray(data?.matches) ? data.matches : [];
        for (const m of matches) {
          const quality = Number(m?.match);
          const usage = Number(m?.["usage-count"]);
          const qScore = Number.isFinite(quality) ? quality : 0.5;
          const uScore =
            Number.isFinite(usage) && usage > 0
              ? Math.min(0.3, Math.log10(usage + 1) * 0.08)
              : 0;
          pushTranslation(
            m?.translation,
            Math.min(0.85, qScore * 0.6 + uScore),
            "MyMemory"
          );
        }
      } else {
        lastErr = new Error("MyMemory: код " + r.status);
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!answered && scored.size === 0) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("сервисы перевода недоступны");
  }

  const items = [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.text);

  const result: TranslationResult = {
    items,
    sources: [...sources],
  };
  translationsCache.set(cacheKey, result);
  return result;
}

export interface LemmatizeResult {
  original: string;
  normalized: string;
  changed: boolean;
  isPhrase: boolean;
}

const singleLemmaCache = new Map<string, string | null>();

const LEXICALIZED_BASE_WORDS = new Set<string>([
  "evening",
  "morning",
  "ceiling",
  "wedding",
  "sibling",
  "darling",
  "sterling",
  "shilling",
  "herring",
  "pudding",
  "nothing",
  "something",
  "anything",
  "everything",
  "during",
  "according",
  "regarding",
  "concerning",
  "wicked",
  "naked",
  "sacred",
  "hundred",
  "kindred",
  "hatred",
  "instead",
  "indeed",
  "already",
  "always",
  "perhaps",
  "towards",
  "afterwards",
  "besides",
  "nowadays",
  "upstairs",
  "downstairs",
  "indoors",
  "outdoors",
  "news",
  "clothes",
  "scissors",
  "trousers",
  "glasses",
  "pants",
  "shorts",
  "jeans",
  "stairs",
  "means",
  "series",
  "species",
  "headquarters",
  "crossroads",
  "outskirts",
  "belongings",
  "surroundings",
  "earnings",
  "savings",
  "findings",
  "proceedings",
  "greetings",
  "thanks",
  "congratulations",
  "odds",
  "goods",
  "customs",
  "cattle",
]);

const IRREGULAR_VERBS: Record<string, string> = {
  am: "be",
  is: "be",
  are: "be",
  was: "be",
  were: "be",
  been: "be",
  being: "be",
  has: "have",
  had: "have",
  having: "have",
  does: "do",
  did: "do",
  done: "do",
  went: "go",
  gone: "go",
  goes: "go",
  said: "say",
  made: "make",
  took: "take",
  taken: "take",
  came: "come",
  saw: "see",
  seen: "see",
  knew: "know",
  known: "know",
  got: "get",
  gotten: "get",
  gave: "give",
  given: "give",
  found: "find",
  thought: "think",
  told: "tell",
  became: "become",
  shown: "show",
  left: "leave",
  felt: "feel",
  brought: "bring",
  began: "begin",
  begun: "begin",
  kept: "keep",
  held: "hold",
  wrote: "write",
  written: "write",
  stood: "stand",
  heard: "hear",
  meant: "mean",
  met: "meet",
  ran: "run",
  paid: "pay",
  sat: "sit",
  spoke: "speak",
  spoken: "speak",
  lain: "lie",
  lying: "lie",
  dying: "die",
  tying: "tie",
  vying: "vie",
  led: "lead",
  grew: "grow",
  grown: "grow",
  lost: "lose",
  fell: "fall",
  fallen: "fall",
  sent: "send",
  built: "build",
  understood: "understand",
  drew: "draw",
  drawn: "draw",
  broke: "break",
  broken: "break",
  spent: "spend",
  rose: "rise",
  risen: "rise",
  drove: "drive",
  driven: "drive",
  bought: "buy",
  wore: "wear",
  worn: "wear",
  chose: "choose",
  chosen: "choose",
  ate: "eat",
  eaten: "eat",
  drank: "drink",
  drunk: "drink",
  flew: "fly",
  flown: "fly",
  forgot: "forget",
  forgotten: "forget",
  forgave: "forgive",
  forgiven: "forgive",
  froze: "freeze",
  frozen: "freeze",
  hid: "hide",
  hidden: "hide",
  rode: "ride",
  ridden: "ride",
  rang: "ring",
  rung: "ring",
  sang: "sing",
  sung: "sing",
  sank: "sink",
  sunk: "sink",
  slept: "sleep",
  slid: "slide",
  sold: "sell",
  shook: "shake",
  shaken: "shake",
  shone: "shine",
  shot: "shoot",
  shrank: "shrink",
  shrunk: "shrink",
  stole: "steal",
  stolen: "steal",
  stuck: "stick",
  stung: "sting",
  stank: "stink",
  stunk: "stink",
  strode: "stride",
  stridden: "stride",
  struck: "strike",
  stricken: "strike",
  strung: "string",
  strove: "strive",
  striven: "strive",
  swore: "swear",
  sworn: "swear",
  swept: "sweep",
  swam: "swim",
  swum: "swim",
  swung: "swing",
  taught: "teach",
  tore: "tear",
  torn: "tear",
  threw: "throw",
  thrown: "throw",
  trod: "tread",
  trodden: "tread",
  woke: "wake",
  woken: "wake",
  wove: "weave",
  woven: "weave",
  wept: "weep",
  won: "win",
  wrung: "wring",
  bent: "bend",
  bled: "bleed",
  blew: "blow",
  blown: "blow",
  bred: "breed",
  burnt: "burn",
  caught: "catch",
  clung: "cling",
  crept: "creep",
  dealt: "deal",
  dug: "dig",
  dreamt: "dream",
  fed: "feed",
  fought: "fight",
  fled: "flee",
  flung: "fling",
  forbade: "forbid",
  forbidden: "forbid",
  hung: "hang",
  knelt: "kneel",
  leant: "lean",
  leapt: "leap",
  learnt: "learn",
  lent: "lend",
  lit: "light",
  mown: "mow",
  proven: "prove",
  sought: "seek",
  sewn: "sew",
  shorn: "shear",
  slew: "slay",
  slain: "slay",
  slung: "sling",
  slunk: "slink",
  smelt: "smell",
  sown: "sow",
  sped: "speed",
  spelt: "spell",
  spilt: "spill",
  spun: "spin",
  spat: "spit",
  spoilt: "spoil",
  sprang: "spring",
  sprung: "spring",
  swollen: "swell",
  beaten: "beat",
  bitten: "bite",
  borne: "bear",
  awoke: "awake",
  awoken: "awake",
  arose: "arise",
  arisen: "arise",
  overcame: "overcome",
  underwent: "undergo",
  undergone: "undergo",
  withdrew: "withdraw",
  withdrawn: "withdraw",
  withstood: "withstand",
  forsook: "forsake",
  forsaken: "forsake",
  beheld: "behold",
  outgrew: "outgrow",
  outgrown: "outgrow",
  outdid: "outdo",
  outdone: "outdo",
  overtook: "overtake",
  overtaken: "overtake",
  undertook: "undertake",
  undertaken: "undertake",
  misunderstood: "misunderstand",
  misled: "mislead",
  forwent: "forgo",
  forgone: "forgo",
  upheld: "uphold",
  withheld: "withhold",
  overslept: "oversleep",
  overheard: "overhear",
  overpaid: "overpay",
  overran: "overrun",
  overthrew: "overthrow",
  overthrown: "overthrow",
  undid: "undo",
  undone: "undo",
  outshone: "outshine",
  outspent: "outspend",
  rebuilt: "rebuild",
  repaid: "repay",
  retold: "retell",
  rewrote: "rewrite",
  rewritten: "rewrite",
  unwound: "unwind",
  foretold: "foretell",
  foresaw: "foresee",
  foreseen: "foresee",
};

const IRREGULAR_NOUNS_AND_ADJS: Record<string, string> = {
  children: "child",
  men: "man",
  women: "woman",
  mice: "mouse",
  lice: "louse",
  teeth: "tooth",
  feet: "foot",
  geese: "goose",
  oxen: "ox",
  wolves: "wolf",
  knives: "knife",
  wives: "wife",
  thieves: "thief",
  loaves: "loaf",
  halves: "half",
  shelves: "shelf",
  calves: "calf",
  elves: "elf",
  scarves: "scarf",
  hooves: "hoof",
  dwarves: "dwarf",
  cacti: "cactus",
  fungi: "fungus",
  nuclei: "nucleus",
  radii: "radius",
  stimuli: "stimulus",
  alumni: "alumnus",
  criteria: "criterion",
  phenomena: "phenomenon",
  analyses: "analysis",
  crises: "crisis",
  diagnoses: "diagnosis",
  hypotheses: "hypothesis",
  oases: "oasis",
  theses: "thesis",
  appendices: "appendix",
  indices: "index",
  matrices: "matrix",
  vertices: "vertex",
  bacteria: "bacterium",
  curricula: "curriculum",
  memoranda: "memorandum",
  strata: "stratum",
  better: "good",
  best: "good",
  worse: "bad",
  worst: "bad",
  farther: "far",
  farthest: "far",
  further: "far",
  furthest: "far",
  elder: "old",
  eldest: "old",
};

const INVARIANT_PARTICIPLES = new Set<string>([
  "put",
  "set",
  "cut",
  "shut",
  "hit",
  "let",
  "burst",
  "cast",
  "cost",
  "hurt",
  "quit",
  "split",
  "spread",
  "upset",
  "read",
  "run",
  "come",
  "become",
  "overcome",
  "beat",
  "bet",
  "bid",
  "rid",
  "shed",
]);

const PARTICIPIAL_ADJ_PREFIXES = new Set<string>([
  "mixed",
  "broken",
  "lost",
  "tired",
  "bored",
  "excited",
  "worried",
  "scared",
  "crowded",
  "married",
  "skilled",
  "talented",
  "complicated",
  "sophisticated",
  "limited",
  "detailed",
  "advanced",
  "fixed",
  "used",
  "armed",
  "fried",
  "baked",
  "boiled",
  "roasted",
  "frozen",
  "dried",
  "cooked",
  "burnt",
  "stained",
  "faded",
  "torn",
  "worn",
  "cracked",
  "hidden",
  "buried",
  "fallen",
  "abandoned",
  "deserted",
  "haunted",
  "cursed",
  "forgotten",
  "swollen",
  "sunken",
  "drunken",
  "molten",
]);

const VERB_FOLLOWERS = new Set<string>([
  "up",
  "out",
  "off",
  "down",
  "in",
  "on",
  "over",
  "back",
  "away",
  "into",
  "onto",
  "to",
  "for",
  "at",
  "with",
  "from",
  "after",
  "about",
  "around",
  "through",
  "across",
  "along",
  "aside",
  "apart",
  "forward",
  "of",
  "by",
  "the",
  "a",
  "an",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "it",
  "him",
  "them",
  "me",
  "us",
  "oneself",
  "myself",
  "yourself",
  "himself",
  "herself",
  "themselves",
]);

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWiktionaryInflectionLemma(
  defHtml: string,
  wordLower: string
): string | null {
  const plain = stripHtmlTags(defHtml);
  if (
    /\b(alternative|archaic|obsolete|dated|misspelling|eye dialect|pronunciation spelling|clipping|abbreviation|initialism|acronym|contraction|diminutive|nonstandard|proscribed|ellipsis|short for|synonym of)\b/i.test(
      plain
    )
  ) {
    return null;
  }

  const isInflection =
    /\b(simple past|past tense|past participle|present participle|gerund|third-person singular|second-person singular|first-person singular|plural|comparative|superlative|inflection|present indicative|present tense|participle)\b[^.;:]*\bof\b/i.test(
      plain
    );
  if (!isInflection) return null;

  let candidate = "";
  const linkSpan = defHtml.match(
    /class="[^"]*form-of-definition-link[^"]*"[^>]*>([\s\S]*?)<\/span>/i
  );
  if (linkSpan?.[1]) {
    candidate = stripHtmlTags(linkSpan[1]).toLowerCase();
  } else {
    const m = plain.match(/\bof\s+([a-z][a-z'-]*)/i);
    if (m?.[1]) candidate = m[1].toLowerCase();
  }

  candidate = candidate.replace(/^to\s+/i, "").trim();
  if (!/^[a-z][a-z'-]{1,35}$/.test(candidate)) return null;
  if (candidate === wordLower) return null;
  return candidate;
}

async function queryWiktionaryLemma(
  wordLower: string,
  preferVerb: boolean
): Promise<{ answered: boolean; lemma: string | null }> {
  const url =
    "https://en.wiktionary.org/api/rest_v1/page/definition/" +
    encodeURIComponent(wordLower);
  const r = await withTimeout(
    requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
    TRANSLATE_TIMEOUT_MS
  );
  if (r.status === 404) return { answered: true, lemma: null };
  if (r.status !== 200) throw new Error("Wiktionary: код " + r.status);

  const data = (
    typeof r.json === "object" && r.json !== null ? r.json : JSON.parse(r.text)
  ) as {
    en?: Array<{
      partOfSpeech?: string;
      definitions?: Array<{ definition?: string }>;
    }>;
  } | null;

  const sections = Array.isArray(data?.en) ? data!.en : [];
  if (!sections.length) return { answered: true, lemma: null };

  const candidates: Array<{ pos: string; lemma: string; pure: boolean }> = [];
  for (const sec of sections) {
    const pos = String(sec?.partOfSpeech ?? "").toLowerCase();
    const defs = Array.isArray(sec?.definitions) ? sec.definitions : [];
    const foundLemmas: string[] = [];
    let standaloneCount = 0;

    for (const d of defs) {
      const html = String(d?.definition ?? "");
      if (!html) continue;
      const extracted = extractWiktionaryInflectionLemma(html, wordLower);
      if (extracted) foundLemmas.push(extracted);
      else standaloneCount++;
    }

    if (foundLemmas.length > 0) {
      const first = foundLemmas[0]!;
      candidates.push({ pos, lemma: first, pure: standaloneCount === 0 });
    }
  }

  if (!candidates.length) return { answered: true, lemma: null };

  if (preferVerb) {
    const verbHit =
      candidates.find((c) => c.pos === "verb" && c.pure) ??
      candidates.find((c) => c.pos === "verb");
    if (verbHit) return { answered: true, lemma: verbHit.lemma };
  }

  const pureCandidates = candidates.filter((c) => c.pure);
  const pool = pureCandidates.length > 0 ? pureCandidates : candidates;
  const posRank = (pos: string): number => {
    if (pos === "verb") return 0;
    if (pos === "noun") return 1;
    if (pos === "adjective") return 2;
    if (pos === "adverb") return 3;
    return 4;
  };
  pool.sort((a, b) => posRank(a.pos) - posRank(b.pos));
  return { answered: true, lemma: pool[0]?.lemma ?? null };
}

function buildMorphCandidates(w: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length >= 2 && s !== w && !out.includes(s)) out.push(s);
  };

  if (w.endsWith("ing") && w.length > 5) {
    const stem = w.slice(0, -3);
    add(stem + "e");
    add(stem);
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1));
    }
  } else if (w.endsWith("ied") && w.length > 4) {
    add(w.slice(0, -3) + "y");
    add(w.slice(0, -1));
  } else if (w.endsWith("ed") && w.length > 4) {
    const stem = w.slice(0, -2);
    add(stem);
    add(stem + "e");
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1));
    }
  } else if (w.endsWith("ies") && w.length > 4) {
    add(w.slice(0, -3) + "y");
  } else if (w.endsWith("ves") && w.length > 4) {
    add(w.slice(0, -3) + "f");
    add(w.slice(0, -3) + "fe");
  } else if (/(?:shes|ches|xes|zes|sses|oes)$/.test(w) && w.length > 4) {
    add(w.slice(0, -2));
  } else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is") && w.length > 3) {
    add(w.slice(0, -1));
  } else if (w.endsWith("ier") && w.length > 4) {
    add(w.slice(0, -3) + "y");
  } else if (w.endsWith("iest") && w.length > 5) {
    add(w.slice(0, -4) + "y");
  } else if (w.endsWith("er") && w.length > 4) {
    const stem = w.slice(0, -2);
    add(stem);
    add(stem + "e");
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1));
    }
  } else if (w.endsWith("est") && w.length > 5) {
    const stem = w.slice(0, -3);
    add(stem);
    add(stem + "e");
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1));
    }
  }

  return out;
}

async function verifyDictionaryWord(candidate: string): Promise<boolean> {
  try {
    const url =
      "https://api.dictionaryapi.dev/api/v2/entries/en/" +
      encodeURIComponent(candidate);
    const r = await withTimeout(
      requestUrl({ url, headers: DESKTOP_HEADERS, throw: false }),
      TRANSLATE_TIMEOUT_MS
    );
    return r.status === 200;
  } catch {
    return false;
  }
}

async function lemmatizeSingleWord(
  rawWord: string,
  preferVerb: boolean
): Promise<string | null> {
  const w = rawWord.toLowerCase();
  if (!/^[a-z][a-z'-]*$/.test(w) || w.length < 2) return null;
  if (LEXICALIZED_BASE_WORDS.has(w)) return null;

  const cacheKey = `${preferVerb ? "v:" : "a:"}${w}`;
  if (singleLemmaCache.has(cacheKey)) {
    return singleLemmaCache.get(cacheKey) ?? null;
  }

  const irregVerb = IRREGULAR_VERBS[w];
  if (irregVerb) {
    singleLemmaCache.set(cacheKey, irregVerb);
    return irregVerb;
  }

  if (!preferVerb) {
    const irregOther = IRREGULAR_NOUNS_AND_ADJS[w];
    if (irregOther) {
      singleLemmaCache.set(cacheKey, irregOther);
      return irregOther;
    }
  }

  let wiktErr: unknown = null;
  try {
    const res = await queryWiktionaryLemma(w, preferVerb);
    if (res.answered) {
      singleLemmaCache.set(cacheKey, res.lemma);
      return res.lemma;
    }
  } catch (e) {
    wiktErr = e;
  }

  const fallbackCandidates = buildMorphCandidates(w);
  for (const cand of fallbackCandidates) {
    if (await verifyDictionaryWord(cand)) {
      singleLemmaCache.set(cacheKey, cand);
      return cand;
    }
  }

  if (wiktErr && fallbackCandidates.length > 0) {
    throw wiktErr instanceof Error
      ? wiktErr
      : new Error("сервис словаря недоступен");
  }

  singleLemmaCache.set(cacheKey, null);
  return null;
}

function applyOriginalCasing(original: string, normalized: string): string {
  const firstOrig = original[0] ?? "";
  const secondOrig = original[1] ?? "";
  const startsUpper =
    firstOrig !== firstOrig.toLowerCase() &&
    firstOrig === firstOrig.toUpperCase();
  const isAllUpper =
    original.length > 1 &&
    original === original.toUpperCase() &&
    original !== original.toLowerCase();

  if (isAllUpper) return normalized.toUpperCase();
  if (startsUpper && secondOrig === secondOrig.toLowerCase()) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

export async function lemmatizeEnglish(rawInput: string): Promise<LemmatizeResult> {
  const original = String(rawInput ?? "").trim();
  const cleaned = original
    .replace(/^[“”"'«»(\[\-–—.,;:!?…\s]+|[“”"'«»)\]\-–—.,;:!?…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return { original, normalized: original, changed: false, isPhrase: false };
  }

  const tokens = cleaned.split(" ");
  const isPhrase = tokens.length > 1;

  if (!isPhrase) {
    const lemma = await lemmatizeSingleWord(cleaned, false);
    if (!lemma || lemma.toLowerCase() === cleaned.toLowerCase()) {
      return { original, normalized: original, changed: false, isPhrase: false };
    }
    const normalized = applyOriginalCasing(cleaned, lemma);
    return {
      original,
      normalized,
      changed: normalized.toLowerCase() !== original.toLowerCase(),
      isPhrase: false,
    };
  }

  const lowerTokens = tokens.map((t) => t.toLowerCase());
  const t0 = lowerTokens[0] ?? "";
  const t1 = lowerTokens[1] ?? "";
  const t2 = lowerTokens[2] ?? "";

  let resultTokens: string[] | null = null;

  // Устойчивое выражение «used to» не трогаем
  if (t0 === "used" && t1 === "to") {
    return { original, normalized: original, changed: false, isPhrase: true };
  }

  const isBeForm =
    t0 === "am" || t0 === "is" || t0 === "are" || t0 === "was" || t0 === "were";
  const isNegBe =
    t0 === "isn't" || t0 === "aren't" || t0 === "wasn't" || t0 === "weren't";
  const isHaveForm = t0 === "has" || t0 === "have" || t0 === "had";
  const isFutureAux = t0 === "will" || t0 === "shall" || t0 === "would";

  if (isFutureAux && tokens.length >= 2) {
    if (t1 === "be" && t2.endsWith("ing") && tokens.length >= 3) {
      const base = (await lemmatizeSingleWord(t2, true)) ?? tokens[2]!;
      resultTokens = [base, ...tokens.slice(3)];
    } else if (t1 === "have" && tokens.length >= 3) {
      const base = (await lemmatizeSingleWord(t2, true)) ?? tokens[2]!;
      resultTokens = [base, ...tokens.slice(3)];
    } else if (t1 === "not" && tokens.length >= 3) {
      resultTokens = ["not", ...tokens.slice(2)];
    } else {
      resultTokens = tokens.slice(1);
    }
  } else if ((t0 === "did" || t0 === "does") && tokens.length >= 2) {
    if (t1 === "not" && tokens.length >= 3) {
      resultTokens = ["not", ...tokens.slice(2)];
    } else {
      resultTokens = tokens.slice(1);
    }
  } else if ((t0 === "didn't" || t0 === "doesn't") && tokens.length >= 2) {
    resultTokens = ["not", ...tokens.slice(1)];
  } else if (isBeForm || isNegBe) {
    const negated = isNegBe || t1 === "not";
    const restStart = !isNegBe && t1 === "not" ? 2 : 1;
    const nextTok = lowerTokens[restStart] ?? "";
    const afterNext = lowerTokens[restStart + 1] ?? "";
    const rest = tokens.slice(restStart);

    if (nextTok === "going" && afterNext === "to") {
      resultTokens = negated ? ["not", "be", ...rest] : ["be", ...rest];
    } else if (
      nextTok.endsWith("ing") &&
      !LEXICALIZED_BASE_WORDS.has(nextTok)
    ) {
      const base = await lemmatizeSingleWord(nextTok, true);
      if (base) {
        resultTokens = negated
          ? ["not", base, ...rest.slice(1)]
          : [base, ...rest.slice(1)];
      } else {
        resultTokens = negated ? ["not", "be", ...rest] : ["be", ...rest];
      }
    } else {
      resultTokens = negated ? ["not", "be", ...rest] : ["be", ...rest];
    }
  } else if (isHaveForm && tokens.length >= 2) {
    if (t1 === "to") {
      resultTokens = ["have", ...tokens.slice(1)];
    } else if (t1 === "been" && tokens.length >= 3) {
      if (t2.endsWith("ing") && !LEXICALIZED_BASE_WORDS.has(t2)) {
        const base = (await lemmatizeSingleWord(t2, true)) ?? tokens[2]!;
        resultTokens = [base, ...tokens.slice(3)];
      } else {
        resultTokens = ["be", ...tokens.slice(2)];
      }
    } else {
      const nextLemma = await lemmatizeSingleWord(t1, true);
      if (nextLemma) {
        resultTokens = [nextLemma, ...tokens.slice(2)];
      } else if (INVARIANT_PARTICIPLES.has(t1)) {
        resultTokens = tokens.slice(1);
      } else if (t0 !== "have") {
        resultTokens = ["have", ...tokens.slice(1)];
      }
    }
  } else if (t0 === "to" && tokens.length >= 2) {
    const lemma = await lemmatizeSingleWord(t1, true);
    if (lemma && lemma !== t1) {
      resultTokens = [tokens[0]!, lemma, ...tokens.slice(2)];
    }
  } else {
    const skipAsAdj =
      PARTICIPIAL_ADJ_PREFIXES.has(t0) && !VERB_FOLLOWERS.has(t1);
    if (!skipAsAdj) {
      const lemma = await lemmatizeSingleWord(t0, true);
      if (lemma && lemma !== t0) {
        resultTokens = [lemma, ...tokens.slice(1)];
      }
    }
  }

  if (!resultTokens) {
    return { original, normalized: original, changed: false, isPhrase: true };
  }

  const joined = resultTokens.join(" ").trim();
  if (!joined || joined.toLowerCase() === cleaned.toLowerCase()) {
    return { original, normalized: original, changed: false, isPhrase: true };
  }

  const normalized = applyOriginalCasing(cleaned, joined);
  return {
    original,
    normalized,
    changed: normalized.toLowerCase() !== original.toLowerCase(),
    isPhrase: true,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordPartToPattern(raw: string): string {
  if (/^[a-z]{4,}$/i.test(raw)) {
    if (/e$/i.test(raw)) {
      return escapeRegExp(raw.slice(0, -1)) + "(?:e\\w*|ing\\b|ed\\b)";
    }
    if (/[^aeiou]y$/i.test(raw)) {
      return escapeRegExp(raw.slice(0, -1)) + "(?:y\\w*|ie(?:s|d)\\b)";
    }
  }
  return escapeRegExp(raw) + "\\w*";
}

function buildHighlightRegex(word: string): RegExp | null {
  let base = normalizeExampleWord(word);
  const withoutTo = base.replace(/^to\s+/i, "").trim();
  if (withoutTo.length >= 3) base = withoutTo;

  const parts = base
    .split(/\s+/)
    .filter(Boolean)
    .map(wordPartToPattern);

  if (!parts.length) return null;
  return new RegExp("\\b(" + parts.join("\\s+") + ")", "gi");
}

export function canMaskWordInSentence(sentence: string, word: string): boolean {
  const re = buildHighlightRegex(word);
  return Boolean(re && re.test(sentence));
}

export function appendHighlightedSentence(
  parent: HTMLElement,
  sentence: string,
  word: string,
  mask: boolean
) {
  const re = buildHighlightRegex(word);
  if (!re) {
    parent.createSpan({ text: sentence });
    return;
  }

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