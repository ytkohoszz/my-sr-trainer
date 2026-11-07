import type { CardSideContentType } from "./types";
import { HINT_SEP } from "./types";

export const STUDY_IMAGE_EXTENSIONS = new Set<string>([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "bmp",
  "avif",
  "heic",
]);

export function hasSupportedImageExtension(linkTarget: string): boolean {
  const clean = String(linkTarget ?? "")
    .split("|")[0]
    ?.split("#")[0]
    ?.split("?")[0]
    ?.trim() ?? "";
  const dotIdx = clean.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = clean.slice(dotIdx + 1).toLowerCase();
  return STUDY_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Ищет индекс подстроки вне $...$, $$...$$, `...`, [[...]] и ![...](...).
 */
export function findUnprotectedTokenIndex(
  input: string,
  predicate: (str: string, idx: number) => number
): { index: number; length: number } | null {
  let inBlockMath = false;
  let inInlineMath = false;
  let inCode = false;
  let wikiDepth = 0;
  let mdLinkDepth = 0;

  const len = input.length;
  for (let i = 0; i < len; i++) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < len) {
      i++;
      continue;
    }

    if (!inInlineMath && !inBlockMath && ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    if (wikiDepth === 0 && mdLinkDepth === 0) {
      if (ch === "$" && input[i + 1] === "$") {
        inBlockMath = !inBlockMath;
        i++;
        continue;
      }
      if (ch === "$" && !inBlockMath) {
        inInlineMath = !inInlineMath;
        continue;
      }
    }
    if (inBlockMath || inInlineMath) continue;

    if (ch === "[" && input[i + 1] === "[") {
      wikiDepth++;
      i++;
      continue;
    }
    if (ch === "]" && input[i + 1] === "]" && wikiDepth > 0) {
      wikiDepth--;
      i++;
      continue;
    }

    if (ch === "!" && input[i + 1] === "[" && input[i + 2] !== "[") {
      mdLinkDepth = 1;
      i++;
      continue;
    }
    if (mdLinkDepth === 1 && ch === "]" && input[i + 1] === "(") {
      mdLinkDepth = 2;
      i++;
      continue;
    }
    if (mdLinkDepth === 2 && ch === ")") {
      mdLinkDepth = 0;
      continue;
    }
    if (mdLinkDepth === 1 && ch === "]") {
      mdLinkDepth = 0;
      continue;
    }

    if (wikiDepth > 0 || mdLinkDepth > 0) continue;

    const matchLen = predicate(input, i);
    if (matchLen > 0) {
      return { index: i, length: matchLen };
    }
  }

  return null;
}

/**
 * Разрезает строку карточки по первому разделителю ::: или :: вне формул и вставок.
 */
export function splitCardSidesSafe(cardPart: string): {
  rawFront: string;
  rawBack: string;
  isBidirectional: boolean;
} | null {
  const trimmed = cardPart.trimStart();
  if (trimmed.startsWith("#") || trimmed.startsWith("```")) return null;

  const isDataviewInlineField =
    /^\([а-яА-Яa-zA-Z0-9_]+::\s*[^)]+\)$/.test(trimmed) ||
    (/\([а-яА-Яa-zA-Z0-9_]+::\s*[^)]+\)/.test(cardPart) &&
      !/\s:::{0,1}\s/.test(cardPart) &&
      !cardPart.includes("$") &&
      !cardPart.includes("![["));
  if (isDataviewInlineField) return null;

  const found = findUnprotectedTokenIndex(cardPart, (s, idx) => {
    if (s[idx] !== ":" || s[idx + 1] !== ":") return 0;
    if (idx > 0 && s[idx - 1] === "\\") return 0;
    let count = 2;
    while (s[idx + count] === ":") count++;
    return count;
  });

  if (!found) return null;

  const isBidirectional = found.length >= 3;
  const rawFront = cardPart.slice(0, found.index).trim();
  const rawBack = cardPart.slice(found.index + found.length).trim();

  if (!rawFront || !rawBack) return null;

  return { rawFront, rawBack, isBidirectional };
}

/**
 * Отделяет подсказку « // » на лицевой стороне вне формул и ссылок.
 */
export function splitStudyFrontSafe(rawFront: string): {
  question: string;
  hint: string;
} {
  const cleaned = String(rawFront ?? "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();

  const found = findUnprotectedTokenIndex(cleaned, (s, idx) =>
    s.startsWith(HINT_SEP, idx) ? HINT_SEP.length : 0
  );

  if (!found) {
    return { question: cleaned, hint: "" };
  }

  return {
    question: cleaned.slice(0, found.index).trim(),
    hint: cleaned.slice(found.index + found.length).trim(),
  };
}

/**
 * Извлекает все вставки изображений из стороны карточки.
 */
export function extractImageEmbeds(raw: string): Array<{
  fullMatch: string;
  target: string;
  width: string | null;
}> {
  const res: Array<{ fullMatch: string; target: string; width: string | null }> = [];
  const s = String(raw ?? "");

  const wikiRe = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(s)) !== null) {
    const target = (m[1] ?? "").trim();
    if (hasSupportedImageExtension(target)) {
      res.push({
        fullMatch: m[0] ?? "",
        target,
        width: m[2] ? m[2].trim() : null,
      });
    }
  }

  const mdRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = mdRe.exec(s)) !== null) {
    const target = (m[2] ?? "").trim();
    if (hasSupportedImageExtension(target) || /^https?:\/\//i.test(target)) {
      res.push({
        fullMatch: m[0] ?? "",
        target,
        width: (m[1] ?? "").trim() || null,
      });
    }
  }

  return res;
}

function findLatexFormulaRanges(
  input: string
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\\" && i + 1 < input.length) {
      i++;
      continue;
    }
    if (input[i] !== "$") continue;

    const delimiter = input[i + 1] === "$" ? "$$" : "$";
    let end = i + delimiter.length;
    while (end < input.length) {
      if (input[end] === "\\" && end + 1 < input.length) {
        end += 2;
        continue;
      }
      if (
        input.startsWith(delimiter, end) &&
        (delimiter === "$$" || input[end + 1] !== "$")
      ) {
        ranges.push({ start: i, end: end + delimiter.length });
        i = end + delimiter.length - 1;
        break;
      }
      end++;
    }
  }

  return ranges;
}

/**
 * Проверяет наличие LaTeX-формулы ($...$ или $$...$$) в строке.
 */
export function containsLatexFormula(raw: string): boolean {
  return findLatexFormulaRanges(String(raw ?? "")).length > 0;
}

/**
 * Классифицирует сторону карточки: image | formula | mixed | text.
 */
export function classifyCardSide(raw: string): CardSideContentType {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "text";

  const embeds = extractImageEmbeds(trimmed);
  const hasImages = embeds.length > 0;
  let withoutEmbeds = trimmed;

  for (const embed of embeds) {
    withoutEmbeds = withoutEmbeds.replace(embed.fullMatch, "");
  }

  const formulaRanges = findLatexFormulaRanges(withoutEmbeds);
  if (formulaRanges.length > 0) {
    let text = "";
    let cursor = 0;
    for (const range of formulaRanges) {
      text += withoutEmbeds.slice(cursor, range.start);
      cursor = range.end;
    }
    text += withoutEmbeds.slice(cursor);

    return text.trim() || hasImages ? "mixed" : "formula";
  }

  if (hasImages) return withoutEmbeds.trim() ? "mixed" : "image";

  return "text";
}