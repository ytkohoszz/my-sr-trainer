import { App, TFile } from "obsidian";
import {
  BookInfo,
  CardDirectionState,
  EXAMPLE_SEP,
  EnglishAnalysisResult,
  GradeOption,
  GradeOptionsSet,
  HINT_SEP,
  MATURE_DAYS,
  SrCard,
  SrTrainerSettings,
  StudyDeckInfo,
  TrainerScope,
  UndoSnapshot,
} from "./types";
import { cleanExample, cleanLineText, normStr } from "./examples";

const decodeInline = (s: string): string =>
  String(s ?? "").replace(/⟩/g, ")").replace(/⟨/g, "(").trim();

function stripOuterWikiBrackets(str: string): string {
  let s = String(str || "").trim();
  if (s.startsWith("[[")) s = s.slice(2);
  if (s.endsWith("]]")) s = s.slice(0, -2);
  return s;
}

export function getTodayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDaysToISO(baseISO: string, daysToAdd: number): string {
  const parts = baseISO.split("-").map(Number);
  const y = parts[0] ?? 2026;
  const m = (parts[1] ?? 1) - 1;
  const d = parts[2] ?? 1;
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + Math.round(daysToAdd));
  const ry = dt.getUTCFullYear();
  const rm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const rd = String(dt.getUTCDate()).padStart(2, "0");
  return `${ry}-${rm}-${rd}`;
}

export function diffDaysBetweenISO(laterISO: string, earlierISO: string): number {
  const p1 = laterISO.split("-").map(Number);
  const p2 = earlierISO.split("-").map(Number);
  if (p1.length < 3 || p2.length < 3) return 0;
  const utc1 = Date.UTC(p1[0] ?? 2026, (p1[1] ?? 1) - 1, p1[2] ?? 1);
  const utc2 = Date.UTC(p2[0] ?? 2026, (p2[1] ?? 1) - 1, p2[2] ?? 1);
  return Math.round((utc1 - utc2) / 86_400_000);
}

export function formatShortDateRU(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}.${parts[1]}`;
}

export function extractLinkTarget(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "object" && (raw as { path?: unknown }).path) {
    return String((raw as { path: unknown }).path).trim();
  }
  const str = decodeInline(String(raw)).trim();
  const inner =
    str.startsWith("[[") && str.endsWith("]]") ? str.slice(2, -2) : str;
  if (!inner) return null;
  const barIdx = inner.indexOf("|");
  const hashIdx = inner.indexOf("#");
  let cutIdx = inner.length;
  if (barIdx !== -1 && barIdx < cutIdx) cutIdx = barIdx;
  if (hashIdx !== -1 && hashIdx < cutIdx) cutIdx = hashIdx;
  const target = inner.slice(0, cutIdx).trim();
  return target || null;
}

export function extractLinkCfi(raw: unknown): string | null {
  if (!raw) return null;
  const str = decodeInline(String(raw)).trim();
  if (!str.startsWith("[[") || !str.endsWith("]]")) return null;
  const inner = str.slice(2, -2);
  const hashIdx = inner.indexOf("#");
  if (hashIdx === -1) return null;
  const barIdx = inner.indexOf("|");
  const endIdx = barIdx !== -1 && barIdx > hashIdx ? barIdx : inner.length;
  let anchor = inner.slice(hashIdx + 1, endIdx).trim();
  if (anchor.startsWith("cfi=")) anchor = anchor.slice(4).trim();
  return anchor.startsWith("epubcfi(") ? anchor : null;
}

export function resolveVaultFile(app: App, rawPath: string): TFile | null {
  const clean = rawPath.trim();
  const direct = app.vault.getAbstractFileByPath(clean);
  if (direct instanceof TFile) return direct;
  const withMd = app.vault.getAbstractFileByPath(
    clean.endsWith(".md") ? clean : `${clean}.md`
  );
  if (withMd instanceof TFile) return withMd;
  const dest = app.metadataCache.getFirstLinkpathDest(clean, "");
  return dest instanceof TFile ? dest : null;
}

export function loadBooksRegistry(
  app: App,
  booksFolder: string
): {
  books: BookInfo[];
  byPath: Map<string, BookInfo>;
  resolveByTarget: (targetStr: string | null) => BookInfo | null;
} {
  const prefix = booksFolder.replace(/\/+$/, "") + "/";
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(prefix));

  const books: BookInfo[] = [];
  const byPath = new Map<string, BookInfo>();

  for (const f of files) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter || {};
    const title = String(fm["название"] || f.basename).trim();
    const author = String(fm["автор"] || "").trim();
    const status = String(fm["статус"] || "В планах").trim();
    const rawEpub = fm["книга"];
    let epubPath: string | null = null;
    const epubTarget = extractLinkTarget(rawEpub);
    if (epubTarget) {
      const dest = app.metadataCache.getFirstLinkpathDest(epubTarget, f.path);
      epubPath = dest ? dest.path : epubTarget;
    }

    const info: BookInfo = {
      path: f.path,
      fileName: f.basename,
      title,
      author,
      status,
      epubPath,
    };
    books.push(info);
    byPath.set(info.path, info);
  }

  const resolveByTarget = (targetStr: string | null): BookInfo | null => {
    if (!targetStr) return null;
    const clean = targetStr.trim();
    if (byPath.has(clean)) return byPath.get(clean) || null;
    if (byPath.has(`${clean}.md`)) return byPath.get(`${clean}.md`) || null;
    const inFolder = `${booksFolder.replace(/\/+$/, "")}/${clean}.md`;
    if (byPath.has(inFolder)) return byPath.get(inFolder) || null;
    const dest = app.metadataCache.getFirstLinkpathDest(clean, "");
    if (dest && byPath.has(dest.path)) return byPath.get(dest.path) || null;
    const matches = books.filter(
      (b) =>
        normStr(b.fileName) === normStr(clean) ||
        normStr(b.title) === normStr(clean)
    );
    return matches.length === 1 ? (matches[0] ?? null) : null;
  };

  return { books, byPath, resolveByTarget };
}

function splitEnglishFront(rawFront: string): { word: string; example: string } {
  const raw = String(rawFront ?? "").replace(/^[-*+]\s+/, "").trim();
  const i = raw.indexOf(EXAMPLE_SEP);
  return i === -1
    ? { word: raw, example: "" }
    : {
        word: raw.slice(0, i).trim(),
        example: raw.slice(i + EXAMPLE_SEP.length).trim(),
      };
}

function splitStudyFront(rawFront: string): { question: string; hint: string } {
  const cleaned = String(rawFront ?? "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  const hIdx = cleaned.indexOf(HINT_SEP);
  if (hIdx === -1) return { question: cleaned, hint: "" };
  return {
    question: cleaned.slice(0, hIdx).trim(),
    hint: cleaned.slice(hIdx + HINT_SEP.length).trim(),
  };
}

function splitBackAndSource(rawBack: string): {
  cleanBack: string;
  rawSourceWiki: string | null;
  sourceTarget: string | null;
  sourceCfi: string | null;
} {
  const trimmed = String(rawBack ?? "").trim();
  const inlineMatch = trimmed.match(
    /^(.*?)\s*\((?:источник|книга)::\s*(\[\[[^\]]+\]\])\)\s*(?![\s\S])/i
  );
  if (inlineMatch && inlineMatch[1] !== undefined && inlineMatch[2] !== undefined) {
    const wiki = inlineMatch[2].trim();
    return {
      cleanBack: inlineMatch[1].trim(),
      rawSourceWiki: wiki,
      sourceTarget: extractLinkTarget(wiki),
      sourceCfi: extractLinkCfi(wiki),
    };
  }
  const dotMatch = trimmed.match(
    /^(.*?)\s*(?:·|\|)\s*(\[\[[^\]]+\]\])\s*(?![\s\S])/
  );
  if (dotMatch && dotMatch[1] !== undefined && dotMatch[2] !== undefined) {
    const wiki = dotMatch[2].trim();
    return {
      cleanBack: dotMatch[1].trim(),
      rawSourceWiki: wiki,
      sourceTarget: extractLinkTarget(wiki),
      sourceCfi: extractLinkCfi(wiki),
    };
  }
  return {
    cleanBack: trimmed,
    rawSourceWiki: null,
    sourceTarget: null,
    sourceCfi: null,
  };
}

export async function loadEnglishWordsData(
  app: App,
  settings: SrTrainerSettings,
  todayISO: string
): Promise<EnglishAnalysisResult | null> {
  const wordsFile = resolveVaultFile(app, settings.wordsFilePath || "Words Cards");
  if (!wordsFile) return null;

  const bookRegistry = loadBooksRegistry(app, settings.booksFolder || "Знания/Книги");
  const content = await app.vault.cachedRead(wordsFile);
  const lines = String(content ?? "").split(/\r?\n/);
  const cards: SrCard[] = [];

  let totalEntries = 0;
  let totalCardDirections = 0;
  let newDirections = 0;
  let unscheduledDirections = 0;
  let learningDirections = 0;
  let matureDirections = 0;
  let dueScheduled = 0;
  let reviewedTodayDirections = 0;
  let reviewedTodayEntries = 0;

  const srRegex = /!(\d{4}-\d{2}-\d{2}),(\d+),(\d+)/g;
  let pendingCard: SrCard | null = null;

  const finalizePendingAsUnscheduled = () => {
    if (!pendingCard) return;
    pendingCard.isUnscheduled = true;
    pendingCard.srLineIndex = null;
    pendingCard.srOnNextLine = false;
    pendingCard.directions = [];
    for (let d = 0; d < pendingCard.expectedDirections; d++) {
      pendingCard.directions.push({
        dirIndex: d,
        dateStr: "2000-01-01",
        interval: 0,
        ease: 250,
        isNew: true,
        isDue: false,
        reviewedToday: false,
      });
    }
    newDirections += pendingCard.expectedDirections;
    unscheduledDirections += pendingCard.expectedDirections;
    totalCardDirections += pendingCard.expectedDirections;
    cards.push(pendingCard);
    pendingCard = null;
  };

  const applySrMatchesToCard = (
    cardObj: SrCard,
    srText: string,
    srLineIdx: number,
    onNextLine: boolean
  ) => {
    const matches = [...srText.matchAll(srRegex)];
    if (!matches.length) {
      cardObj.isUnscheduled = true;
      cardObj.srLineIndex = null;
      cardObj.srOnNextLine = false;
      cardObj.directions = [];
      for (let d = 0; d < cardObj.expectedDirections; d++) {
        cardObj.directions.push({
          dirIndex: d,
          dateStr: "2000-01-01",
          interval: 0,
          ease: 250,
          isNew: true,
          isDue: false,
          reviewedToday: false,
        });
      }
      newDirections += cardObj.expectedDirections;
      unscheduledDirections += cardObj.expectedDirections;
      totalCardDirections += cardObj.expectedDirections;
      cards.push(cardObj);
      return;
    }

    cardObj.srLineIndex = srLineIdx;
    cardObj.srOnNextLine = onNextLine;
    cardObj.directions = [];

    let touchedToday = false;
    let minEase = Infinity;
    let minInterval = Infinity;
    let hasReviewedDirection = false;
    let cardDueCount = 0;

    const dirCount = Math.max(cardObj.expectedDirections, matches.length);
    for (let d = 0; d < dirCount; d++) {
      const m = matches[d];
      if (!m) {
        totalCardDirections++;
        newDirections++;
        unscheduledDirections++;
        cardObj.directions.push({
          dirIndex: d,
          dateStr: "2000-01-01",
          interval: 0,
          ease: 250,
          isNew: true,
          isDue: false,
          reviewedToday: false,
        });
        continue;
      }

      const dateStr = m[1] ?? "2000-01-01";
      const intervalStr = m[2] ?? "0";
      const easeStr = m[3] ?? "250";
      totalCardDirections++;

      if (dateStr === "2000-01-01") {
        newDirections++;
        cardObj.directions.push({
          dirIndex: d,
          dateStr: "2000-01-01",
          interval: 0,
          ease: Number(easeStr) || 250,
          isNew: true,
          isDue: false,
          reviewedToday: false,
        });
        continue;
      }

      const isDue = dateStr <= todayISO;
      if (isDue) {
        dueScheduled++;
        cardDueCount++;
      }

      const interval = Number(intervalStr);
      const ease = Number(easeStr);
      hasReviewedDirection = true;

      if (interval >= MATURE_DAYS) matureDirections++;
      else learningDirections++;

      if (Number.isFinite(ease) && ease < minEase) minEase = ease;
      if (Number.isFinite(interval) && interval < minInterval) {
        minInterval = interval;
      }

      let reviewedToday = false;
      if (interval > 0) {
        const lastReviewedISO = addDaysToISO(dateStr, -interval);
        if (lastReviewedISO === todayISO) {
          reviewedTodayDirections++;
          touchedToday = true;
          reviewedToday = true;
        }
      }

      cardObj.directions.push({
        dirIndex: d,
        dateStr,
        interval: Number.isFinite(interval) ? interval : 1,
        ease: Number.isFinite(ease) ? ease : 250,
        isNew: false,
        isDue,
        reviewedToday,
      });
    }

    if (touchedToday) reviewedTodayEntries++;

    cardObj.hasReviewedDirection = hasReviewedDirection;
    cardObj.minEase =
      hasReviewedDirection && Number.isFinite(minEase) ? minEase : null;
    cardObj.minInterval =
      hasReviewedDirection && Number.isFinite(minInterval) ? minInterval : null;
    cardObj.dueCount = cardDueCount;
    cards.push(cardObj);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const srIdx = line.indexOf("<!--SR:");
    const cardPart = srIdx === -1 ? line : line.slice(0, srIdx);
    const hasSeparator =
      /:{2,3}/.test(cardPart) && !cardPart.trimStart().startsWith("#");

    if (hasSeparator) {
      finalizePendingAsUnscheduled();

      totalEntries++;
      const isBidirectional = cardPart.includes(":::");
      const expectedDirections = isBidirectional ? 2 : 1;
      const parts = cardPart.split(/:{2,3}/);
      const rawFront = parts[0] ?? "";
      const rawBackJoined = parts.slice(1).join(" ").trim();
      const { word, example } = splitEnglishFront(rawFront);
      const { cleanBack, rawSourceWiki, sourceTarget, sourceCfi } =
        splitBackAndSource(rawBackJoined);

      const resolvedBook = sourceTarget
        ? bookRegistry.resolveByTarget(sourceTarget)
        : null;

      const cardObj: SrCard = {
        uidKey: `${wordsFile.path}:${i}`,
        scope: "english",
        deckPath: wordsFile.path,
        deckTitle: wordsFile.basename,
        lineIndex: i,
        lineNumber: i + 1,
        question: word,
        answer: cleanBack,
        exampleOrHint: example,
        rawSourceWiki,
        sourceTarget,
        sourceCfi,
        resolvedBook,
        isBidirectional,
        expectedDirections,
        isUnscheduled: false,
        hasReviewedDirection: false,
        minEase: null,
        minInterval: null,
        dueCount: 0,
        srLineIndex: null,
        srOnNextLine: false,
        directions: [],
      };

      if (srIdx !== -1) {
        applySrMatchesToCard(cardObj, line.slice(srIdx), i, false);
      } else {
        pendingCard = cardObj;
      }
    } else if (srIdx !== -1 && pendingCard) {
      applySrMatchesToCard(pendingCard, line.slice(srIdx), i, true);
      pendingCard = null;
    } else if (line.trim() !== "" && pendingCard) {
      finalizePendingAsUnscheduled();
    }
  }
  finalizePendingAsUnscheduled();

  return {
    wordsFile,
    cards,
    totalEntries,
    totalCardDirections,
    newDirections,
    unscheduledDirections,
    learningDirections,
    matureDirections,
    dueScheduled,
    reviewedTodayDirections,
    reviewedTodayEntries,
  };
}

export async function loadStudyDecksData(
  app: App,
  settings: SrTrainerSettings,
  todayISO: string
): Promise<{
  decks: StudyDeckInfo[];
  deckByPath: Map<string, StudyDeckInfo>;
  allCards: SrCard[];
  totals: {
    sumEntries: number;
    sumDirections: number;
    sumDue: number;
    sumNew: number;
    sumLearning: number;
    sumMature: number;
    sumReviewedToday: number;
  };
}> {
  const decksFolderPrefix =
    (settings.studyDecksFolder || "Знания/Карточки").replace(/\/+$/, "") + "/";
  const knowledgePrefix =
    (settings.knowledgeFolder || "Знания").replace(/\/+$/, "") + "/";

  const mdFiles = app.vault.getMarkdownFiles();
  const deckFilesMap = new Map<string, TFile>();

  for (const f of mdFiles) {
    if (f.path.startsWith(decksFolderPrefix)) {
      deckFilesMap.set(f.path, f);
      continue;
    }
    if (f.path.startsWith(knowledgePrefix)) {
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) continue;
      const isStudyArea = String(fm["направление"] ?? "").trim() === "Учёба";
      const isFlagged =
        Boolean(fm["колода_карточек"]) ||
        String(fm["подтип"] ?? "").trim().toLowerCase() === "карточки";
      if (isStudyArea && isFlagged) {
        deckFilesMap.set(f.path, f);
      }
    }
  }

  const decks: StudyDeckInfo[] = [];
  const deckByPath = new Map<string, StudyDeckInfo>();
  const allCards: SrCard[] = [];

  let sumEntries = 0;
  let sumDirections = 0;
  let sumDue = 0;
  let sumNew = 0;
  let sumLearning = 0;
  let sumMature = 0;
  let sumReviewedToday = 0;

  for (const [path, fileObj] of deckFilesMap.entries()) {
    const fm = app.metadataCache.getFileCache(fileObj)?.frontmatter || {};
    const title = String(fm["название_темы"] || fileObj.basename).trim();
    const discipline = String(fm["дисциплина"] || "").trim();
    const defaultBi = Boolean(fm["двусторонние_по_умолчанию"] ?? false);
    const rawParent = fm["родитель"];
    const parentName = rawParent
      ? stripOuterWikiBrackets(String(rawParent)).split("|").pop()?.trim() || ""
      : "";

    let content = "";
    try {
      content = await app.vault.cachedRead(fileObj);
    } catch {
      continue;
    }

    const parsed = parseStudyDeckFileContent(content, path, title, todayISO);
    const fullDeck: StudyDeckInfo = {
      path,
      fileObj,
      fileName: fileObj.basename,
      title,
      discipline,
      parentName,
      defaultBi,
      ...parsed,
    };

    decks.push(fullDeck);
    deckByPath.set(path, fullDeck);
    allCards.push(...parsed.cards);

    sumEntries += parsed.totalEntries;
    sumDirections += parsed.totalDirections;
    sumDue += parsed.dueDirections;
    sumNew += parsed.newDirections;
    sumLearning += parsed.learningDirections;
    sumMature += parsed.matureDirections;
    sumReviewedToday += parsed.reviewedTodayDirections;
  }

  decks.sort(
    (a, b) =>
      b.dueDirections - a.dueDirections || a.title.localeCompare(b.title, "ru")
  );

  return {
    decks,
    deckByPath,
    allCards,
    totals: {
      sumEntries,
      sumDirections,
      sumDue,
      sumNew,
      sumLearning,
      sumMature,
      sumReviewedToday,
    },
  };
}

function parseStudyDeckFileContent(
  content: string,
  deckPath: string,
  deckTitle: string,
  todayISO: string
): {
  cards: SrCard[];
  totalEntries: number;
  totalDirections: number;
  newDirections: number;
  learningDirections: number;
  matureDirections: number;
  dueDirections: number;
  reviewedTodayDirections: number;
} {
  const lines = String(content ?? "").split(/\r?\n/);
  const cards: SrCard[] = [];

  let totalEntries = 0;
  let totalDirections = 0;
  let newDirections = 0;
  let learningDirections = 0;
  let matureDirections = 0;
  let dueDirections = 0;
  let reviewedTodayDirections = 0;

  const srRegex = /!(\d{4}-\d{2}-\d{2}),(\d+),(\d+)/g;
  let pendingCard: SrCard | null = null;
  let inFrontmatter = false;

  const finalizePendingAsUnscheduled = () => {
    if (!pendingCard) return;
    pendingCard.isUnscheduled = true;
    pendingCard.srLineIndex = null;
    pendingCard.srOnNextLine = false;
    pendingCard.directions = [];
    for (let d = 0; d < pendingCard.expectedDirections; d++) {
      pendingCard.directions.push({
        dirIndex: d,
        dateStr: "2000-01-01",
        interval: 0,
        ease: 250,
        isNew: true,
        isDue: false,
        reviewedToday: false,
      });
    }
    newDirections += pendingCard.expectedDirections;
    totalDirections += pendingCard.expectedDirections;
    cards.push(pendingCard);
    pendingCard = null;
  };

  const applySrMatchesToCard = (
    cardObj: SrCard,
    srText: string,
    srLineIdx: number,
    onNextLine: boolean
  ) => {
    const matches = [...srText.matchAll(srRegex)];
    if (!matches.length) {
      cardObj.isUnscheduled = true;
      cardObj.srLineIndex = null;
      cardObj.srOnNextLine = false;
      cardObj.directions = [];
      for (let d = 0; d < cardObj.expectedDirections; d++) {
        cardObj.directions.push({
          dirIndex: d,
          dateStr: "2000-01-01",
          interval: 0,
          ease: 250,
          isNew: true,
          isDue: false,
          reviewedToday: false,
        });
      }
      newDirections += cardObj.expectedDirections;
      totalDirections += cardObj.expectedDirections;
      cards.push(cardObj);
      return;
    }

    cardObj.srLineIndex = srLineIdx;
    cardObj.srOnNextLine = onNextLine;
    cardObj.directions = [];

    let minEase = Infinity;
    let minInterval = Infinity;
    let hasReviewedDirection = false;
    let cardDueCount = 0;

    for (let d = 0; d < cardObj.expectedDirections; d++) {
      const m = matches[d];
      totalDirections++;
      if (!m) {
        newDirections++;
        cardObj.directions.push({
          dirIndex: d,
          dateStr: "2000-01-01",
          interval: 0,
          ease: 250,
          isNew: true,
          isDue: false,
          reviewedToday: false,
        });
        continue;
      }

      const dateStr = m[1] ?? "2000-01-01";
      const intervalStr = m[2] ?? "0";
      const easeStr = m[3] ?? "250";

      if (dateStr === "2000-01-01") {
        newDirections++;
        cardObj.directions.push({
          dirIndex: d,
          dateStr: "2000-01-01",
          interval: 0,
          ease: Number(easeStr) || 250,
          isNew: true,
          isDue: false,
          reviewedToday: false,
        });
        continue;
      }

      const isDue = dateStr <= todayISO;
      if (isDue) {
        dueDirections++;
        cardDueCount++;
      }

      const interval = Number(intervalStr);
      const ease = Number(easeStr);
      hasReviewedDirection = true;

      if (interval >= MATURE_DAYS) matureDirections++;
      else learningDirections++;

      if (Number.isFinite(ease) && ease < minEase) minEase = ease;
      if (Number.isFinite(interval) && interval < minInterval) {
        minInterval = interval;
      }

      let reviewedToday = false;
      if (interval > 0) {
        const lastReviewedISO = addDaysToISO(dateStr, -interval);
        if (lastReviewedISO === todayISO) {
          reviewedTodayDirections++;
          reviewedToday = true;
        }
      }

      cardObj.directions.push({
        dirIndex: d,
        dateStr,
        interval: Number.isFinite(interval) ? interval : 1,
        ease: Number.isFinite(ease) ? ease : 250,
        isNew: false,
        isDue,
        reviewedToday,
      });
    }

    cardObj.hasReviewedDirection = hasReviewedDirection;
    cardObj.minEase =
      hasReviewedDirection && Number.isFinite(minEase) ? minEase : null;
    cardObj.minInterval =
      hasReviewedDirection && Number.isFinite(minInterval) ? minInterval : null;
    cardObj.dueCount = cardDueCount;
    cards.push(cardObj);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false;
      continue;
    }

    const srIdx = line.indexOf("<!--SR:");
    const cardPart = srIdx === -1 ? line : line.slice(0, srIdx);
    const trimmedPart = cardPart.trimStart();

    const isDataviewInlineField =
      /\([а-яА-Яa-zA-Z0-9_]+::\s*[^)]+\)/.test(cardPart) &&
      !/\s:::{0,1}\s/.test(cardPart);
    const hasCardSep =
      !trimmedPart.startsWith("#") &&
      !trimmedPart.startsWith("```") &&
      !isDataviewInlineField &&
      /:{2,3}/.test(cardPart);

    if (hasCardSep) {
      finalizePendingAsUnscheduled();

      const isBidirectional = cardPart.includes(":::");
      const sepToken = isBidirectional ? ":::" : "::";
      const sepPos = cardPart.indexOf(sepToken);
      const rawFront = cardPart.slice(0, sepPos).trim();
      const rawBack = cardPart.slice(sepPos + sepToken.length).trim();

      if (!rawFront || !rawBack) continue;

      totalEntries++;
      const expectedDirections = isBidirectional ? 2 : 1;
      const { question, hint } = splitStudyFront(rawFront);

      const cardObj: SrCard = {
        uidKey: `${deckPath}:${i}`,
        scope: "study",
        deckPath,
        deckTitle,
        lineIndex: i,
        lineNumber: i + 1,
        question,
        answer: rawBack,
        exampleOrHint: hint,
        rawSourceWiki: null,
        sourceTarget: null,
        sourceCfi: null,
        resolvedBook: null,
        isBidirectional,
        expectedDirections,
        isUnscheduled: false,
        hasReviewedDirection: false,
        minEase: null,
        minInterval: null,
        dueCount: 0,
        srLineIndex: null,
        srOnNextLine: false,
        directions: [],
      };

      if (srIdx !== -1) {
        applySrMatchesToCard(cardObj, line.slice(srIdx), i, false);
      } else {
        pendingCard = cardObj;
      }
    } else if (srIdx !== -1 && pendingCard) {
      applySrMatchesToCard(pendingCard, line.slice(srIdx), i, true);
      pendingCard = null;
    } else if (line.trim() !== "" && pendingCard) {
      finalizePendingAsUnscheduled();
    }
  }
  finalizePendingAsUnscheduled();

  return {
    cards,
    totalEntries,
    totalDirections,
    newDirections,
    learningDirections,
    matureDirections,
    dueDirections,
    reviewedTodayDirections,
  };
}

export function computeGradeOptions(
  dirState: CardDirectionState,
  todayISO: string,
  isRelearning = false
): GradeOptionsSet {
  const isNew =
    Boolean(dirState.isNew) || !dirState.interval || dirState.interval <= 0;
  const baseEase =
    Number.isFinite(dirState.ease) && dirState.ease >= 130
      ? dirState.ease
      : 250;
  const baseInterval = isNew ? 0 : Math.max(1, Math.round(dirState.interval));

  let overdueDays = 0;
  if (!isNew && dirState.dateStr && dirState.dateStr !== "2000-01-01") {
    const diff = diffDaysBetweenISO(todayISO, dirState.dateStr);
    if (diff > 0) overdueDays = diff;
  }
  const effectiveInterval = baseInterval + Math.floor(overdueDays * 0.5);

  const againInterval = 1;
  const againEase = Math.max(130, baseEase - 20);

  const hardInterval =
    isNew || isRelearning
      ? 1
      : Math.max(
          baseInterval === 1 ? 1 : baseInterval + 1,
          Math.round(baseInterval * 1.2)
        );
  const hardEase = Math.max(130, baseEase - 15);

  let goodInterval: number;
  if (isRelearning) goodInterval = 1;
  else if (isNew) goodInterval = 2;
  else if (baseInterval === 1) goodInterval = 3;
  else {
    goodInterval = Math.max(
      hardInterval + 1,
      Math.round(effectiveInterval * (baseEase / 100))
    );
  }
  const goodEase = baseEase;

  let easyInterval: number;
  if (isNew || isRelearning) easyInterval = 4;
  else {
    easyInterval = Math.max(
      goodInterval + 1,
      Math.round(effectiveInterval * (baseEase / 100) * 1.35)
    );
  }
  const easyEase = baseEase + 15;

  const fmtDays = (d: number): string => {
    if (d === 1) return "1 дн.";
    if (d >= 365) return (d / 365).toFixed(1).replace(".", ",") + " г.";
    if (d >= 45) return (d / 30).toFixed(1).replace(".", ",") + " мес.";
    return `${d} дн.`;
  };

  return {
    again: {
      id: "again",
      key: "1",
      label: "Снова",
      sub: "повтор · 1 дн.",
      interval: againInterval,
      ease: againEase,
      nextDateISO: addDaysToISO(todayISO, againInterval),
      color: "#d85b57",
      requeue: true,
    },
    hard: {
      id: "hard",
      key: "2",
      label: "Трудно",
      sub: fmtDays(hardInterval),
      interval: hardInterval,
      ease: hardEase,
      nextDateISO: addDaysToISO(todayISO, hardInterval),
      color: "#e5a158",
      requeue: false,
    },
    good: {
      id: "good",
      key: "3",
      label: "Хорошо",
      sub: fmtDays(goodInterval),
      interval: goodInterval,
      ease: goodEase,
      nextDateISO: addDaysToISO(todayISO, goodInterval),
      color: "#599ed6",
      requeue: false,
    },
    easy: {
      id: "easy",
      key: "4",
      label: "Легко",
      sub: fmtDays(easyInterval),
      interval: easyInterval,
      ease: easyEase,
      nextDateISO: addDaysToISO(todayISO, easyInterval),
      color: "#4aab80",
      requeue: false,
    },
  };
}

let diskWriteQueue: Promise<unknown> = Promise.resolve();
export function enqueueDiskWrite<T>(taskFn: () => Promise<T>): Promise<T> {
  const next = diskWriteQueue.catch(() => {}).then(taskFn);
  diskWriteQueue = next;
  return next;
}

export async function saveCardReviewToDisk(
  app: App,
  card: SrCard,
  dirIndex: number,
  gradeOption: GradeOption
): Promise<UndoSnapshot> {
  return enqueueDiskWrite(async () => {
    const fileObj = app.vault.getAbstractFileByPath(card.deckPath);
    if (!(fileObj instanceof TFile)) {
      throw new Error("Файл колоды не найден.");
    }

    const rawContent = await app.vault.read(fileObj);
    const lines = rawContent.split(/\r?\n/);

    let targetIdx = card.lineIndex;
    const lineAtIdx = lines[targetIdx];
    if (!lineAtIdx || !lineAtIdx.includes(card.question)) {
      targetIdx = lines.findIndex(
        (l) => l.includes(card.question) && l.includes(card.answer)
      );
    }
    if (targetIdx === -1) {
      throw new Error("Строка карточки не найдена в файле.");
    }

    const existingDir = card.directions[dirIndex];
    const prevDirState: CardDirectionState | null = existingDir
      ? { ...existingDir }
      : null;

    const snapshot: UndoSnapshot = {
      scope: card.scope,
      deckPath: card.deckPath,
      rawContent,
      uid: `${card.deckPath}:${card.lineIndex}:${dirIndex}`,
      lineIndex: card.lineIndex,
      dirIndex,
      prevDirState,
      wasCorrect: !gradeOption.requeue,
    };

    const srParts: string[] = [];
    for (let d = 0; d < card.expectedDirections; d++) {
      if (d === dirIndex) {
        srParts.push(
          `!${gradeOption.nextDateISO},${gradeOption.interval},${gradeOption.ease}`
        );
      } else {
        const existing = card.directions[d];
        if (existing && !existing.isNew && existing.dateStr !== "2000-01-01") {
          srParts.push(
            `!${existing.dateStr},${existing.interval || 1},${existing.ease || 250}`
          );
        } else {
          srParts.push("!2000-01-01,1,250");
        }
      }
    }
    const newSrComment = `<!--SR:${srParts.join("")}-->`;

    const currentLine = lines[targetIdx] ?? "";
    const sameLineSrIdx = currentLine.indexOf("<!--SR:");

    if (sameLineSrIdx !== -1) {
      const cleanCardPart = currentLine.slice(0, sameLineSrIdx).trimEnd();
      lines[targetIdx] = `${cleanCardPart} ${newSrComment}`;
    } else if (
      card.srOnNextLine &&
      lines[targetIdx + 1] !== undefined &&
      (lines[targetIdx + 1] ?? "").includes("<!--SR:")
    ) {
      lines[targetIdx + 1] = newSrComment;
    } else {
      lines[targetIdx] = `${currentLine.trimEnd()} ${newSrComment}`;
    }

    await app.vault.modify(fileObj, lines.join("\n"));
    return snapshot;
  });
}

export async function updateCardLineOnDisk(
  app: App,
  card: SrCard,
  opts: {
    newQuestion: string;
    newAnswer: string;
    newExampleOrHint: string;
    newIsBi: boolean;
    newBook: BookInfo | null;
  }
): Promise<void> {
  return enqueueDiskWrite(async () => {
    const fileObj = app.vault.getAbstractFileByPath(card.deckPath);
    if (!(fileObj instanceof TFile)) {
      throw new Error("Файл колоды не найден.");
    }

    const rawContent = await app.vault.read(fileObj);
    const lines = rawContent.split(/\r?\n/);
    const idx = card.lineIndex;
    const currentLine = lines[idx];
    if (currentLine === undefined) {
      throw new Error("Строка карточки не найдена.");
    }

    const srIdx = currentLine.indexOf("<!--SR:");
    const srTail = srIdx !== -1 ? " " + currentLine.slice(srIdx).trim() : "";
    const sep = opts.newIsBi ? ":::" : "::";

    if (card.scope === "english") {
      const ex = cleanExample(opts.newExampleOrHint);
      const frontStr = ex ? `${opts.newQuestion}${EXAMPLE_SEP}${ex}` : opts.newQuestion;
      let backStr = opts.newAnswer;
      if (opts.newBook) {
        const preserveCfi =
          card.sourceCfi &&
          card.resolvedBook &&
          card.resolvedBook.path === opts.newBook.path
            ? card.sourceCfi
            : null;
        const wiki = preserveCfi
          ? `[[${opts.newBook.fileName}#${preserveCfi}|${opts.newBook.fileName}]]`
          : `[[${opts.newBook.fileName}]]`;
        backStr = `${opts.newAnswer} · ${wiki}`;
      }
      lines[idx] = `${frontStr} ${sep} ${backStr}${srTail}`;
    } else {
      const hint = cleanLineText(opts.newExampleOrHint);
      const frontStr = hint
        ? `${cleanLineText(opts.newQuestion)}${HINT_SEP}${hint}`
        : cleanLineText(opts.newQuestion);
      lines[idx] = `${frontStr} ${sep} ${cleanLineText(opts.newAnswer)}${srTail}`;
    }

    await app.vault.modify(fileObj, lines.join("\n"));
  });
}

export async function syncEnglishReviewedCountToDiary(
  app: App,
  diaryFolder: string,
  todayISO: string,
  reviewedTodayDirections: number
): Promise<number> {
  const prefix = (diaryFolder || "Ежедневник").replace(/\/+$/, "") + "/";
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(prefix));

  let todayFile: TFile | null = null;
  let currentSaved = 0;

  for (const f of files) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const rawDate = fm?.["дата"] ? String(fm["дата"]).slice(0, 10) : f.basename;
    if (rawDate === todayISO) {
      if (!todayFile || f.stat.mtime > todayFile.stat.mtime) {
        todayFile = f;
        const val = Number(fm?.["карточек_пройдено"]);
        currentSaved = Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
      }
    }
  }

  const effectiveCount = Math.max(currentSaved, reviewedTodayDirections);
  if (todayFile && effectiveCount > currentSaved) {
    try {
      await app.fileManager.processFrontMatter(
        todayFile,
        (fm: Record<string, unknown>) => {
          fm["карточек_пройдено"] = effectiveCount;
        }
      );
    } catch {
      // Игнорируем ошибку фоновой записи в дневник
    }
  }

  return effectiveCount;
}