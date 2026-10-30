import type { TFile } from "obsidian";

export const MATURE_DAYS = 21;
export const EXAMPLE_SEP = " — ";
export const HINT_SEP = " // ";

export type TrainerScope = "english" | "study";

export type EnglishTrainerMode =
  | "DUE_AND_NEW"
  | "DUE_ONLY"
  | "NEW_ONLY"
  | "HARD"
  | "BOOK";

export type StudyTrainerMode =
  | "DUE_AND_NEW"
  | "CRAM_ALL"
  | "DUE_ONLY"
  | "NEW_ONLY"
  | "HARD";

export type DirectionFilter = "BOTH" | "FORWARD" | "REVERSE";

export interface SrTrainerSettings {
  wordsFilePath: string;
  booksFolder: string;
  studyDecksFolder: string;
  knowledgeFolder: string;
  diaryFolder: string;
  englishNewSessionLimit: number;
  studyNewSessionLimit: number;
  autoSpeakEnglish: boolean;
  englishTypingMode: boolean;
  studyTypingMode: boolean;
}

export const DEFAULT_SETTINGS: SrTrainerSettings = {
  wordsFilePath: "Words Cards",
  booksFolder: "Знания/Книги",
  studyDecksFolder: "Знания/Карточки",
  knowledgeFolder: "Знания",
  diaryFolder: "Ежедневник",
  englishNewSessionLimit: 25,
  studyNewSessionLimit: 30,
  autoSpeakEnglish: false,
  englishTypingMode: false,
  studyTypingMode: false,
};

export interface BookInfo {
  path: string;
  fileName: string;
  title: string;
  author: string;
  status: string;
  epubPath: string | null;
}

export interface CardDirectionState {
  dirIndex: number;
  dateStr: string;
  interval: number;
  ease: number;
  isNew: boolean;
  isDue: boolean;
  reviewedToday: boolean;
}

export interface SrCard {
  uidKey: string;
  scope: TrainerScope;
  deckPath: string;
  deckTitle: string;
  lineIndex: number;
  lineNumber: number;
  question: string; // Для английского — английское слово (word)
  answer: string;   // Для английского — перевод (cleanBack)
  exampleOrHint: string; // Для английского — пример через " — ", для учёбы — подсказка через " // "
  rawSourceWiki: string | null;
  sourceTarget: string | null;
  sourceCfi: string | null;
  resolvedBook: BookInfo | null;
  isBidirectional: boolean;
  expectedDirections: number;
  isUnscheduled: boolean;
  hasReviewedDirection: boolean;
  minEase: number | null;
  minInterval: number | null;
  dueCount: number;
  srLineIndex: number | null;
  srOnNextLine: boolean;
  directions: CardDirectionState[];
}

export interface StudyDeckInfo {
  path: string;
  fileObj: TFile;
  fileName: string;
  title: string;
  discipline: string;
  parentName: string;
  defaultBi: boolean;
  cards: SrCard[];
  totalEntries: number;
  totalDirections: number;
  newDirections: number;
  learningDirections: number;
  matureDirections: number;
  dueDirections: number;
  reviewedTodayDirections: number;
}

export interface EnglishAnalysisResult {
  wordsFile: TFile;
  cards: SrCard[];
  totalEntries: number;
  totalCardDirections: number;
  newDirections: number;
  unscheduledDirections: number;
  learningDirections: number;
  matureDirections: number;
  dueScheduled: number;
  reviewedTodayDirections: number;
  reviewedTodayEntries: number;
}

export interface GradeOption {
  id: "again" | "hard" | "good" | "easy";
  key: string;
  label: string;
  sub: string;
  interval: number;
  ease: number;
  nextDateISO: string;
  color: string;
  requeue: boolean;
}

export interface GradeOptionsSet {
  again: GradeOption;
  hard: GradeOption;
  good: GradeOption;
  easy: GradeOption;
}

export interface TrainerQueueItem {
  uid: string;
  deckPath: string;
  lineIndex: number;
  dirIndex: number;
  isRelearning: boolean;
}

export interface UndoSnapshot {
  scope: TrainerScope;
  deckPath: string;
  rawContent: string;
  uid: string;
  lineIndex: number;
  dirIndex: number;
  prevDirState: CardDirectionState | null;
  wasCorrect: boolean;
}

export interface OpenTrainerParams {
  scope?: TrainerScope;
  mode?: string;
  deckPath?: string;
  bookPath?: string;
  directionFilter?: DirectionFilter;
}