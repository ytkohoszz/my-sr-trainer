import { App, Component, Modal, Notice, setIcon } from "obsidian";
import type MySrTrainerPlugin from "./main";
import {
  BookInfo,
  CardDirectionState,
  DirectionFilter,
  EnglishAnalysisResult,
  EnglishTrainerMode,
  GradeOption,
  MATURE_DAYS,
  OpenTrainerParams,
  SrCard,
  StudyDeckInfo,
  StudyTrainerMode,
  TrainerQueueItem,
  TrainerScope,
  UndoSnapshot,
} from "./types";
import {
  computeGradeOptions,
  enqueueDiskWrite,
  getTodayISO,
  loadBooksRegistry,
  loadEnglishWordsData,
  loadStudyDecksData,
  resolveVaultFile,
  saveCardReviewToDisk,
  syncEnglishReviewedCountToDiary,
  updateCardLineOnDisk,
} from "./parser";
import {
  ExampleSentenceItem,
  SynonymsResult,
  TranslationResult,
  appendHighlightedSentence,
  canMaskWordInSentence,
  fetchExamples,
  fetchSynonyms,
  fetchTranslations,
  getCachedExamples,
  getCachedSynonyms,
  getCachedTranslations,
  hasCachedExamples,
  hasCachedSynonyms,
  hasCachedTranslations,
  speakEnglishText,
  stopEnglishSpeech,
} from "./examples";
import { classifyCardSide } from "./media";
import { renderStudySide } from "./render-side";

export class SrTrainerModal extends Modal {
  plugin: MySrTrainerPlugin;
  trainerScope: TrainerScope = "english";
  englishMode: EnglishTrainerMode = "DUE_AND_NEW";
  studyMode: StudyTrainerMode = "DUE_AND_NEW";
  directionFilter: DirectionFilter = "BOTH";
  selectedStudyDeckPath = "ALL";
  selectedBookPath = "";

  englishData: EnglishAnalysisResult | null = null;
  books: BookInfo[] = [];
  studyDecks: StudyDeckInfo[] = [];
  studyAllCards: SrCard[] = [];
  studyTotals = {
    sumEntries: 0,
    sumDirections: 0,
    sumDue: 0,
    sumNew: 0,
    sumLearning: 0,
    sumMature: 0,
    sumReviewedToday: 0,
  };

  savedTodayCount = 0;

queue: TrainerQueueItem[] = [];
  currentItem: TrainerQueueItem | null = null;
  isFlipped = false;
  inlineEditOpen = false;
  examplesKey = "";
  examplesOffset = 0;
  synonymsKey = "";

  sessionDone = 0;
  sessionCorrect = 0;
  sessionAgain = 0;
  undoStack: UndoSnapshot[] = [];

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private modalClickHandler: ((e: MouseEvent) => void) | null = null;
  private touchStartHandler: ((e: TouchEvent) => void) | null = null;
  private touchEndHandler: ((e: TouchEvent) => void) | null = null;
  private touchStartY: number | null = null;
  private touchStartX: number | null = null;
  private touchStartedInScrollable = false;
  private isGrading = false;
  private sideRenderComponent: Component | null = null;
  private lastAutoSpokenKey = "";

  constructor(
    app: App,
    plugin: MySrTrainerPlugin,
    initialParams?: OpenTrainerParams
  ) {
    super(app);
    (
      this as unknown as { shouldRestoreSelection?: boolean }
    ).shouldRestoreSelection = false;
    this.plugin = plugin;

    if (initialParams?.scope) {
      this.trainerScope = initialParams.scope;
    }
    if (initialParams?.directionFilter) {
      this.directionFilter = initialParams.directionFilter;
    }
    if (initialParams?.deckPath) {
      this.selectedStudyDeckPath = initialParams.deckPath;
    }
    if (initialParams?.bookPath) {
      this.selectedBookPath = initialParams.bookPath;
      this.englishMode = "BOOK";
    }
    if (initialParams?.mode) {
      if (this.trainerScope === "english") {
        this.englishMode = initialParams.mode as EnglishTrainerMode;
      } else {
        this.studyMode = initialParams.mode as StudyTrainerMode;
      }
    }
  }

  safeClose() {
    try {
      (
        this as unknown as { shouldRestoreSelection?: boolean }
      ).shouldRestoreSelection = false;
      this.close();
    } catch {
      // Игнорируем
    }
  }

  async onOpen() {
    (
      this as unknown as { shouldRestoreSelection?: boolean }
    ).shouldRestoreSelection = false;
    this.modalEl.addClass("my-sr-modal-container");
    this.containerEl.addClass("my-sr-overlay");
    this.contentEl.addClass("my-sr-modal");

    this.keyHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
    window.addEventListener("keydown", this.keyHandler);

    this.modalClickHandler = (e: MouseEvent) => {
      if (e.target === this.modalEl) {
        this.safeClose();
      }
    };
    this.modalEl.addEventListener("click", this.modalClickHandler);

    this.touchStartHandler = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const target = e.target as HTMLElement | null;
      const card = target?.closest(".my-sr-flashcard") as HTMLElement | null;
      this.touchStartedInScrollable = Boolean(card && card.scrollTop > 2);
      this.touchStartY = touch.clientY;
      this.touchStartX = touch.clientX;
    };

    this.touchEndHandler = (e: TouchEvent) => {
      if (this.touchStartY === null || this.touchStartX === null) return;
      const touch = e.changedTouches[0];
      const startY = this.touchStartY;
      const startX = this.touchStartX;
      const inScroll = this.touchStartedInScrollable;
      this.touchStartY = null;
      this.touchStartX = null;
      this.touchStartedInScrollable = false;

      if (!touch || inScroll) return;
      const dy = touch.clientY - startY;
      const dx = Math.abs(touch.clientX - startX);
      if (dy > 80 && dy > dx * 1.5) {
        this.safeClose();
      }
    };

    this.modalEl.addEventListener("touchstart", this.touchStartHandler, {
      passive: true,
    });
    this.modalEl.addEventListener("touchend", this.touchEndHandler, {
      passive: true,
    });

    await this.reloadAllDataAndRebuildQueue();
  }

  onClose() {
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    if (this.modalClickHandler) {
      this.modalEl.removeEventListener("click", this.modalClickHandler);
      this.modalClickHandler = null;
    }
    if (this.touchStartHandler) {
      this.modalEl.removeEventListener("touchstart", this.touchStartHandler);
      this.touchStartHandler = null;
    }
    if (this.touchEndHandler) {
      this.modalEl.removeEventListener("touchend", this.touchEndHandler);
      this.touchEndHandler = null;
    }
    stopEnglishSpeech();
    this.lastAutoSpokenKey = "";
    this.sideRenderComponent?.unload();
    this.sideRenderComponent = null;
    this.contentEl.empty();
  }

  async reloadAllDataAndRebuildQueue() {
    const todayISO = getTodayISO();
    const s = this.plugin.settings;

    const bookReg = loadBooksRegistry(this.app, s.booksFolder);
    this.books = bookReg.books;

    const [engRes, studyRes] = await Promise.all([
      loadEnglishWordsData(this.app, s, todayISO),
      loadStudyDecksData(this.app, s, todayISO),
    ]);

    this.englishData = engRes;
    this.studyDecks = studyRes.decks;
    this.studyAllCards = studyRes.allCards;
    this.studyTotals = studyRes.totals;

    if (this.englishData) {
      this.savedTodayCount = await syncEnglishReviewedCountToDiary(
        this.app,
        s.diaryFolder,
        todayISO,
        this.englishData.reviewedTodayDirections
      );
    }

    if (
      this.selectedStudyDeckPath !== "ALL" &&
      !studyRes.deckByPath.has(this.selectedStudyDeckPath)
    ) {
      this.selectedStudyDeckPath = "ALL";
    }

this.rebuildQueue();
    this.render();
  }

  private getActiveCardsPool(): SrCard[] {
    if (this.trainerScope === "english") {
      return this.englishData?.cards ?? [];
    }
    return this.studyAllCards;
  }

  private shouldBurySiblings(): boolean {
    if (!this.plugin.settings.burySiblings) return false;
    if (this.trainerScope === "study" && this.studyMode === "CRAM_ALL") {
      return false;
    }
    return true;
  }

  private shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = arr[i];
      const b = arr[j];
      if (a !== undefined && b !== undefined) {
        arr[i] = b;
        arr[j] = a;
      }
    }
  }

  private enqueueCardDirections(
    card: SrCard,
    mode: EnglishTrainerMode | StudyTrainerMode,
    burySiblings: boolean,
    shuffle: boolean,
    dueItems: TrainerQueueItem[],
    newItems: TrainerQueueItem[],
    extraItems: TrainerQueueItem[]
  ) {
    const cardDue: TrainerQueueItem[] = [];
    const cardNew: TrainerQueueItem[] = [];
    const cardExtra: TrainerQueueItem[] = [];

    for (const dir of card.directions) {
      if (this.directionFilter === "FORWARD" && dir.dirIndex !== 0) continue;
      if (this.directionFilter === "REVERSE" && dir.dirIndex !== 1) continue;

      if (
        burySiblings &&
        card.directions.some(
          (other) => other.dirIndex !== dir.dirIndex && other.reviewedToday
        )
      ) {
        continue;
      }

      const item: TrainerQueueItem = {
        uid: `${card.deckPath}:${card.lineIndex}:${dir.dirIndex}`,
        deckPath: card.deckPath,
        lineIndex: card.lineIndex,
        dirIndex: dir.dirIndex,
        isRelearning: false,
      };

      if (mode === "DUE_ONLY") {
        if (dir.isDue) cardDue.push(item);
      } else if (mode === "NEW_ONLY") {
        if (dir.isNew) cardNew.push(item);
      } else if (mode === "HARD" || mode === "BOOK" || mode === "CRAM_ALL") {
        if (dir.isDue) cardDue.push(item);
        else if (dir.isNew) cardNew.push(item);
        else cardExtra.push(item);
      } else {
        if (dir.isDue) cardDue.push(item);
        else if (dir.isNew) cardNew.push(item);
      }
    }

    if (!burySiblings) {
      dueItems.push(...cardDue);
      newItems.push(...cardNew);
      extraItems.push(...cardExtra);
      return;
    }

    const pickOne = (arr: TrainerQueueItem[]): TrainerQueueItem | null => {
      if (!arr.length) return null;
      if (arr.length === 1 || !shuffle) return arr[0] ?? null;
      const idx = Math.floor(Math.random() * arr.length);
      return arr[idx] ?? arr[0] ?? null;
    };

    const chosenDue = pickOne(cardDue);
    if (chosenDue) {
      dueItems.push(chosenDue);
      return;
    }
    const chosenNew = pickOne(cardNew);
    if (chosenNew) {
      newItems.push(chosenNew);
      return;
    }
    const chosenExtra = pickOne(cardExtra);
    if (chosenExtra) {
      extraItems.push(chosenExtra);
    }
  }

  rebuildQueue() {
    const dueItems: TrainerQueueItem[] = [];
    const newItems: TrainerQueueItem[] = [];
    const extraItems: TrainerQueueItem[] = [];
    const bury = this.shouldBurySiblings();
    const shuffle = this.plugin.settings.shuffleQueue;

    if (this.trainerScope === "english") {
      const cards = this.englishData?.cards ?? [];
      for (const card of cards) {
        if (this.englishMode === "BOOK" && this.selectedBookPath) {
          if (
            !card.resolvedBook ||
            card.resolvedBook.path !== this.selectedBookPath
          ) {
            continue;
          }
        }
        if (this.englishMode === "HARD") {
          const isHard =
            card.hasReviewedDirection &&
            ((card.minEase !== null && card.minEase < 250) ||
              (card.minInterval !== null && card.minInterval <= 3));
          if (!isHard) continue;
        }

        this.enqueueCardDirections(
          card,
          this.englishMode,
          bury,
          shuffle,
          dueItems,
          newItems,
          extraItems
        );
      }

      const newLimit = this.plugin.settings.englishNewSessionLimit || 25;
      const pickedNew =
        this.englishMode === "DUE_AND_NEW"
          ? newItems.slice(0, newLimit)
          : newItems;
      if (shuffle) {
        this.shuffleInPlace(dueItems);
        this.shuffleInPlace(pickedNew);
        this.shuffleInPlace(extraItems);
      }

      if (this.englishMode === "HARD" || this.englishMode === "BOOK") {
        this.queue = [...dueItems, ...pickedNew, ...extraItems];
      } else {
        this.queue = [...dueItems, ...pickedNew];
      }
    } else {
      for (const card of this.studyAllCards) {
        if (
          this.selectedStudyDeckPath !== "ALL" &&
          card.deckPath !== this.selectedStudyDeckPath
        ) {
          continue;
        }

        if (this.studyMode === "HARD") {
          const isHard =
            card.hasReviewedDirection &&
            ((card.minEase !== null && card.minEase < 250) ||
              (card.minInterval !== null && card.minInterval <= 3));
          if (!isHard) continue;
        }

        this.enqueueCardDirections(
          card,
          this.studyMode,
          bury,
          shuffle,
          dueItems,
          newItems,
          extraItems
        );
      }

      const newLimit = this.plugin.settings.studyNewSessionLimit || 30;
      const pickedNew =
        this.studyMode === "DUE_AND_NEW"
          ? newItems.slice(0, newLimit)
          : newItems;
      if (shuffle) {
        this.shuffleInPlace(dueItems);
        this.shuffleInPlace(pickedNew);
        this.shuffleInPlace(extraItems);
      }

      this.queue = [...dueItems, ...pickedNew, ...extraItems];
    }

this.currentItem = this.queue.shift() || null;
    this.isFlipped = false;
    this.inlineEditOpen = false;
    this.examplesKey = "";
    this.examplesOffset = 0;
    this.synonymsKey = "";
    this.lastAutoSpokenKey = "";
  }

  private getCurrentCardAndDirection(): {
    card: SrCard | null;
    dir: CardDirectionState | null;
  } {
    const pool = this.getActiveCardsPool();
    while (this.currentItem) {
      const item = this.currentItem;
      const found =
        pool.find(
          (c) =>
            c.deckPath === item.deckPath && c.lineIndex === item.lineIndex
        ) || null;
      if (found) {
        const dir =
          found.directions[item.dirIndex] ?? found.directions[0] ?? null;
        if (dir) return { card: found, dir };
      }
      this.currentItem = this.queue.shift() || null;
    }
    return { card: null, dir: null };
  }

  private openBookInEpubReader(epubPath: string | null, cfi: string | null) {
    if (!epubPath) {
      new Notice("У этой книги не привязан файл .epub (свойство «книга»).");
      return;
    }
    this.safeClose();
    const pluginsMap = (
      this.app as unknown as {
        plugins?: {
          plugins?: Record<
            string,
            { openEpubAt?: (path: string, cfi?: string) => Promise<void> }
          >;
        };
      }
    ).plugins?.plugins;
    const epubPlugin = pluginsMap?.["my-epub-reader"];
    if (epubPlugin && typeof epubPlugin.openEpubAt === "function") {
      void epubPlugin.openEpubAt(epubPath, cfi || undefined);
      return;
    }
    void this.app.workspace.openLinkText(epubPath, "", false);
  }

  private async openFileAtLine(filePath: string, lineIndex: number) {
    const file = resolveVaultFile(this.app, filePath);
    if (!file) return;
    this.safeClose();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    window.setTimeout(() => {
      try {
        const view = this.app.workspace.activeLeaf?.view as unknown as {
          editor?: {
            setCursor: (pos: { line: number; ch: number }) => void;
            scrollIntoView: (
              range: {
                from: { line: number; ch: number };
                to: { line: number; ch: number };
              },
              center: boolean
            ) => void;
            focus: () => void;
          };
        };
        if (view?.editor) {
          const safeLine = Math.max(0, lineIndex);
          view.editor.setCursor({ line: safeLine, ch: 0 });
          view.editor.scrollIntoView(
            {
              from: { line: safeLine, ch: 0 },
              to: { line: safeLine, ch: 0 },
            },
            true
          );
          view.editor.focus();
        }
      } catch {
        // Игнорируем
      }
    }, 120);
  }

private doFlipCard() {
    if (this.isFlipped) return;
    this.isFlipped = true;
    this.render();
  }

  private toggleExamplesForActiveCard(card: SrCard) {
    const exKey = `${card.lineIndex}|${card.question}`;
    const next = this.examplesKey === exKey ? "" : exKey;
    this.examplesKey = next;
    this.examplesOffset = 0;
    if (next) this.synonymsKey = "";
    this.render();
  }

  private toggleSynonymsForActiveCard(card: SrCard) {
    const synKey = `${card.lineIndex}|${card.question}`;
    const next = this.synonymsKey === synKey ? "" : synKey;
    this.synonymsKey = next;
    if (next) this.examplesKey = "";
    this.render();
  }

  private async doGradeCard(
    card: SrCard,
    dir: CardDirectionState,
    gradeOpt: GradeOption
  ) {
    if (this.isGrading) return;
    this.isGrading = true;
    const todayISO = getTodayISO();

    try {
      const snap = await saveCardReviewToDisk(
        this.app,
        card,
        dir.dirIndex,
        gradeOpt
      );
      this.undoStack.push(snap);
      if (this.undoStack.length > 15) this.undoStack.shift();

      const wasDue = dir.isDue;
      const wasNew = dir.isNew;
      const wasReviewedToday = dir.reviewedToday;

      dir.dateStr = gradeOpt.nextDateISO;
      dir.interval = gradeOpt.interval;
      dir.ease = gradeOpt.ease;
      dir.isNew = false;
      dir.isDue = gradeOpt.nextDateISO <= todayISO;
      dir.reviewedToday = true;

      if (this.trainerScope === "english" && this.englishData) {
        if (wasDue && !dir.isDue) {
          this.englishData.dueScheduled = Math.max(
            0,
            this.englishData.dueScheduled - 1
          );
        }
        if (wasNew) {
          this.englishData.newDirections = Math.max(
            0,
            this.englishData.newDirections - 1
          );
        }
        if (!wasReviewedToday) {
          this.englishData.reviewedTodayDirections++;
          this.savedTodayCount = Math.max(
            this.savedTodayCount + 1,
            this.englishData.reviewedTodayDirections
          );
          void syncEnglishReviewedCountToDiary(
            this.app,
            this.plugin.settings.diaryFolder,
            todayISO,
            this.savedTodayCount
          );
        }
      } else {
        const deck = this.studyDecks.find((d) => d.path === card.deckPath);
        if (wasDue && !dir.isDue) {
          this.studyTotals.sumDue = Math.max(0, this.studyTotals.sumDue - 1);
          if (deck) deck.dueDirections = Math.max(0, deck.dueDirections - 1);
        }
        if (wasNew) {
          this.studyTotals.sumNew = Math.max(0, this.studyTotals.sumNew - 1);
          if (deck) deck.newDirections = Math.max(0, deck.newDirections - 1);
        }
        if (!wasReviewedToday) {
          this.studyTotals.sumReviewedToday++;
          if (deck) deck.reviewedTodayDirections++;
        }
      }

      if (this.shouldBurySiblings()) {
        this.queue = this.queue.filter(
          (q) =>
            !(
              q.deckPath === card.deckPath &&
              q.lineIndex === card.lineIndex &&
              q.dirIndex !== dir.dirIndex
            )
        );
      }

      this.sessionDone++;
      if (gradeOpt.requeue && this.currentItem) {
        this.sessionAgain++;
        const reItem: TrainerQueueItem = {
          uid: this.currentItem.uid,
          deckPath: card.deckPath,
          lineIndex: card.lineIndex,
          dirIndex: dir.dirIndex,
          isRelearning: true,
        };
        const insertPos = Math.min(this.queue.length, 4);
        this.queue.splice(insertPos, 0, reItem);
      } else {
        this.sessionCorrect++;
      }

this.currentItem = this.queue.shift() || null;
      this.isFlipped = false;
      this.inlineEditOpen = false;
      this.examplesKey = "";
      this.synonymsKey = "";

      this.render();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("Ошибка сохранения ответа: " + msg);
    } finally {
      this.isGrading = false;
    }
  }

  private canUndoInCurrentScope(): boolean {
    const top = this.undoStack[this.undoStack.length - 1];
    return Boolean(top && top.scope === this.trainerScope);
  }

  private async handleUndo() {
    if (this.isGrading || !this.canUndoInCurrentScope()) return;
    const snap = this.undoStack.pop();
    if (!snap) return;

    this.isGrading = true;
    stopEnglishSpeech();

    try {
      const fObj = resolveVaultFile(this.app, snap.deckPath);
      if (fObj) {
        await enqueueDiskWrite(() =>
          this.app.vault.modify(fObj, snap.rawContent)
        );
      }

      const pool =
        snap.scope === "english"
          ? (this.englishData?.cards ?? [])
          : this.studyAllCards;
      const restoredCard = pool.find(
        (c) => c.deckPath === snap.deckPath && c.lineIndex === snap.lineIndex
      );
      if (restoredCard && snap.prevDirState) {
        const curDir = restoredCard.directions[snap.dirIndex];
        if (curDir) {
          const restoredReviewedToday =
            !snap.prevDirState.reviewedToday && curDir.reviewedToday;

          if (snap.scope === "english" && this.englishData) {
            if (snap.prevDirState.isDue && !curDir.isDue) {
              this.englishData.dueScheduled++;
            }
            if (snap.prevDirState.isNew && !curDir.isNew) {
              this.englishData.newDirections++;
            }
            if (restoredReviewedToday) {
              this.englishData.reviewedTodayDirections = Math.max(
                0,
                this.englishData.reviewedTodayDirections - 1
              );
              this.savedTodayCount = Math.max(0, this.savedTodayCount - 1);
            }
          } else if (snap.scope === "study") {
            const deck = this.studyDecks.find((d) => d.path === snap.deckPath);
            if (snap.prevDirState.isDue && !curDir.isDue) {
              this.studyTotals.sumDue++;
              if (deck) deck.dueDirections++;
            }
            if (snap.prevDirState.isNew && !curDir.isNew) {
              this.studyTotals.sumNew++;
              if (deck) deck.newDirections++;
            }
            if (restoredReviewedToday) {
              this.studyTotals.sumReviewedToday = Math.max(
                0,
                this.studyTotals.sumReviewedToday - 1
              );
              if (deck) {
                deck.reviewedTodayDirections = Math.max(
                  0,
                  deck.reviewedTodayDirections - 1
                );
              }
            }
          }

          Object.assign(curDir, snap.prevDirState);
        }
      }

      if (this.currentItem) this.queue.unshift(this.currentItem);
      this.queue = this.queue.filter((x) => x.uid !== snap.uid);
      this.currentItem = {
        uid: snap.uid,
        deckPath: snap.deckPath,
        lineIndex: snap.lineIndex,
        dirIndex: snap.dirIndex,
        isRelearning: false,
      };
      this.isFlipped = false;
      this.inlineEditOpen = false;
      this.examplesKey = "";
      this.synonymsKey = "";
      this.lastAutoSpokenKey = "";
      this.sessionDone = Math.max(0, this.sessionDone - 1);
      if (snap.wasCorrect) {
        this.sessionCorrect = Math.max(0, this.sessionCorrect - 1);
      } else {
        this.sessionAgain = Math.max(0, this.sessionAgain - 1);
      }

      new Notice("Последний ответ отменён.");
      this.render();
    } catch (e: unknown) {
      this.undoStack.push(snap);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("Ошибка отмены: " + msg);
    } finally {
      this.isGrading = false;
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (document.querySelector(".my-sr-image-overlay")) return;

    const activeTag = document.activeElement?.tagName;
    if (
      activeTag === "INPUT" ||
      activeTag === "TEXTAREA" ||
      activeTag === "SELECT" ||
      (document.activeElement as HTMLElement | null)?.isContentEditable
    ) {
      return;
    }

    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "z" || e.key === "Z" || e.key === "я" || e.key === "Я")
    ) {
      if (this.canUndoInCurrentScope()) {
        e.preventDefault();
        void this.handleUndo();
      }
      return;
    }

    const { card, dir } = this.getCurrentCardAndDirection();
    if (!card || !dir) return;

    const todayISO = getTodayISO();
    const gradeOptions = computeGradeOptions(
      dir,
      todayISO,
      Boolean(this.currentItem?.isRelearning),
      `${card.uidKey}:${dir.dirIndex}:${todayISO}`
    );

    if (e.code === "Space" && !this.isFlipped) {
      e.preventDefault();
      this.doFlipCard();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!this.isFlipped) this.doFlipCard();
      else void this.doGradeCard(card, dir, gradeOptions.good);
    } else if (
      this.isFlipped &&
      (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")
    ) {
      e.preventDefault();
      const map: Record<string, GradeOption> = {
        "1": gradeOptions.again,
        "2": gradeOptions.hard,
        "3": gradeOptions.good,
        "4": gradeOptions.easy,
      };
      const picked = map[e.key];
      if (picked) void this.doGradeCard(card, dir, picked);
    } else if (
      this.trainerScope === "english" &&
      (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К")
    ) {
      e.preventDefault();
      speakEnglishText(card.question);
    } else if (
      this.trainerScope === "english" &&
      (e.key === "e" || e.key === "E" || e.key === "у" || e.key === "У")
    ) {
      e.preventDefault();
      this.toggleExamplesForActiveCard(card);
    } else if (
      this.trainerScope === "english" &&
      (e.key === "s" || e.key === "S" || e.key === "ы" || e.key === "Ы")
    ) {
      e.preventDefault();
      this.toggleSynonymsForActiveCard(card);
    }
  }

  private renderExamplesBox(
    parentEl: HTMLElement,
    word: string,
    mask: boolean
  ) {
    const panel = parentEl.createDiv("my-sr-examples-panel");

    const drawHint = (text: string, withRetry: boolean) => {
      panel.empty();
      panel.createDiv({ cls: "my-sr-examples-hint", text });
      if (withRetry) {
        const retryBtn = panel.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "↻ Повторить",
          attr: { type: "button" },
        });
        retryBtn.onclick = () => this.render();
      }
    };

    const drawItems = (items: ExampleSentenceItem[]) => {
      panel.empty();
      const head = panel.createDiv("my-sr-examples-head");
      head.createSpan({
        cls: "my-sr-examples-title",
        text: "💬 Примеры" + (mask ? " (слово скрыто)" : ""),
      });

      if (!items.length) {
        panel.createDiv({
          cls: "my-sr-examples-hint",
          text: "Примеры в словарях не найдены.",
        });
        return;
      }

      if (items.length > 1) {
        head.createSpan({
          cls: "my-sr-examples-position",
          text: `${(this.examplesOffset % items.length) + 1} / ${items.length}`,
        });
        const moreBtn = head.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "↻ Ещё",
          attr: { type: "button", title: "Показать другие примеры" },
        });
        moreBtn.onclick = (ev) => {
          ev.stopPropagation();
          this.examplesOffset = (this.examplesOffset + 1) % items.length;
          drawItems(items);
        };
      }

      const count = Math.min(1, items.length);
      const start = this.examplesOffset % items.length;
      const shown: ExampleSentenceItem[] = [];
      for (let i = 0; i < count; i++) {
        const item = items[(start + i) % items.length];
        if (item) shown.push(item);
      }

      for (const it of shown) {
        const row = panel.createDiv("my-sr-example-row");
        const line = row.createDiv("my-sr-example-line");
        appendHighlightedSentence(line, it.text, word, mask);

      }

      const sources = [...new Set(shown.map((x) => x.source))].join(", ");
      panel.createDiv({
        cls: "my-sr-examples-foot",
        text: `Источник: ${sources}`,
      });
    };

    if (hasCachedExamples(word)) {
      drawItems(getCachedExamples(word) ?? []);
      return;
    }

    drawHint("Ищу примеры в Free Dictionary и Tatoeba…", false);
    fetchExamples(word)
      .then((items) => {
        if (panel.isConnected) drawItems(items);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "нет сети";
        if (panel.isConnected) {
          drawHint(`Не удалось загрузить примеры (${msg}).`, true);
        }
      });
  }

  private renderSynonymsBox(parentEl: HTMLElement, word: string) {
    const panel = parentEl.createDiv("my-sr-examples-panel my-sr-synonyms-panel");

    const drawHint = (text: string, withRetry: boolean) => {
      panel.empty();
      panel.createDiv({ cls: "my-sr-examples-hint", text });
      if (withRetry) {
        const retryBtn = panel.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "↻ Повторить",
          attr: { type: "button" },
        });
        retryBtn.onclick = () => this.render();
      }
    };

    const drawResult = (res: SynonymsResult) => {
      panel.empty();
      const head = panel.createDiv("my-sr-examples-head");
      head.createSpan({
        cls: "my-sr-examples-title",
        text: "≈ Синонимы",
      });

      if (!res.groups.length) {
        panel.createDiv({
          cls: "my-sr-examples-hint",
          text: "Синонимы не найдены.",
        });
        return;
      }

      const groupsEl = panel.createDiv("my-sr-syn-groups");
      const showPosLabels = res.groups.some((g) => Boolean(g.partOfSpeech));

      for (const group of res.groups) {
        const row = groupsEl.createDiv("my-sr-syn-group");
        if (showPosLabels && group.partOfSpeech) {
          row.createSpan({
            cls: "my-sr-syn-pos",
            text: group.partOfSpeech,
          });
        }
        const chips = row.createDiv("my-sr-syn-chips");
        for (const syn of group.words) {
          chips.createSpan({ cls: "my-sr-syn-chip", text: syn });
        }
      }

      if (res.sources.length) {
        panel.createDiv({
          cls: "my-sr-examples-foot",
          text: `Источник: ${res.sources.join(", ")}`,
        });
      }
    };

    if (hasCachedSynonyms(word)) {
      drawResult(getCachedSynonyms(word) ?? { groups: [], sources: [] });
      return;
    }

    drawHint("Ищу синонимы…", false);
    fetchSynonyms(word)
      .then((res) => {
        if (panel.isConnected) drawResult(res);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "нет сети";
        if (panel.isConnected) {
          drawHint(`Не удалось загрузить синонимы (${msg}).`, true);
        }
      });
  }

  render() {
    const { contentEl } = this;
    this.sideRenderComponent?.unload();
    this.sideRenderComponent = new Component();
    this.sideRenderComponent.load();
    contentEl.empty();

    const todayISO = getTodayISO();

// 1. Верхняя панель: вкладки 🇬🇧 Английский | 🎓 Учёба
    const scopeBar = contentEl.createDiv("my-sr-scope-bar");
    const scopes: Array<{ id: TrainerScope; label: string }> = [
      {
        id: "english",
        label: "🇬🇧 Английский",
      },
      {
        id: "study",
        label: "🎓 Учёба",
      },
    ];

    for (const sc of scopes) {
      const btn = scopeBar.createEl("button", {
        cls:
          "my-sr-scope-tab" +
          (this.trainerScope === sc.id ? " is-active" : ""),
        text: sc.label,
        attr: { type: "button" },
      });
      btn.onclick = () => {
        if (this.trainerScope === sc.id) return;
        this.trainerScope = sc.id;
        this.rebuildQueue();
        this.render();
      };
    }

    // 2. Панель фильтров и инструментов
    const toolbar = contentEl.createDiv("my-sr-toolbar");
    const selectsWrap = toolbar.createDiv("my-sr-selects");

    if (this.trainerScope === "english") {
      const dueCnt = this.englishData?.dueScheduled ?? 0;
      const newCnt = this.englishData?.newDirections ?? 0;

      const modeSel = selectsWrap.createEl("select", {
        cls: "dropdown",
        attr: { title: "Режим выборки карточек" },
      });
      const engModes: Array<{ value: EnglishTrainerMode; label: string }> = [
        {
          value: "DUE_AND_NEW",
          label: `План + новые (${dueCnt})`,
        },
        { value: "DUE_ONLY", label: `К повторению (${dueCnt})` },
        { value: "NEW_ONLY", label: `Только новые (${newCnt})` },
        { value: "HARD", label: "⚠️ Сложные" },
        { value: "BOOK", label: "📖 Из книги" },
      ];
      for (const m of engModes) {
        const o = modeSel.createEl("option", { text: m.label, value: m.value });
        if (this.englishMode === m.value) o.selected = true;
      }
      modeSel.onchange = () => {
        this.englishMode = modeSel.value as EnglishTrainerMode;
        if (this.englishMode === "BOOK" && !this.selectedBookPath) {
          const cards = this.englishData?.cards ?? [];
          const firstBook = this.books.find((b) =>
            cards.some((c) => c.resolvedBook?.path === b.path)
          );
          if (firstBook) this.selectedBookPath = firstBook.path;
        }
        this.rebuildQueue();
        this.render();
      };

      if (this.englishMode === "BOOK") {
        const bookSel = selectsWrap.createEl("select", {
          cls: "dropdown",
          attr: { title: "Выбор книги" },
        });
        const cards = this.englishData?.cards ?? [];
        const booksWithWords = this.books.filter((b) =>
          cards.some((c) => c.resolvedBook?.path === b.path)
        );
        if (!booksWithWords.length) {
          bookSel.createEl("option", { text: "Нет книг со словами", value: "" });
        } else {
          for (const b of booksWithWords) {
            const cnt = cards.filter(
              (c) => c.resolvedBook?.path === b.path
            ).length;
            const o = bookSel.createEl("option", {
              text: `${b.title} (${cnt})`,
              value: b.path,
            });
            if (b.path === this.selectedBookPath) o.selected = true;
          }
        }
        bookSel.onchange = () => {
          this.selectedBookPath = bookSel.value;
          this.rebuildQueue();
          this.render();
        };
      }
    } else {
      const deckSel = selectsWrap.createEl("select", {
        cls: "dropdown",
        attr: { title: "Выбор учебной темы" },
      });
      deckSel.createEl("option", {
        text: `📚 Все темы (${this.studyTotals.sumEntries})`,
        value: "ALL",
      });
      for (const d of this.studyDecks) {
        const duePart = d.dueDirections > 0 ? ` · 🔥${d.dueDirections}` : "";
        const o = deckSel.createEl("option", {
          text: `${d.title} (${d.totalEntries}${duePart})`,
          value: d.path,
        });
        if (this.selectedStudyDeckPath === d.path) o.selected = true;
      }
      deckSel.onchange = () => {
        this.selectedStudyDeckPath = deckSel.value;
        this.rebuildQueue();
        this.render();
      };

      const modeSel = selectsWrap.createEl("select", {
        cls: "dropdown",
        attr: { title: "Режим тренировки" },
      });
      const stModes: Array<{ value: StudyTrainerMode; label: string }> = [
        { value: "DUE_AND_NEW", label: "План + новые" },
        { value: "CRAM_ALL", label: "🎯 Краш-тест (все)" },
        { value: "DUE_ONLY", label: "⏰ К повторению" },
        { value: "NEW_ONLY", label: "✨ Только новые" },
        { value: "HARD", label: "⚠️ Сложные" },
      ];
      for (const m of stModes) {
        const o = modeSel.createEl("option", { text: m.label, value: m.value });
        if (this.studyMode === m.value) o.selected = true;
      }
      modeSel.onchange = () => {
        this.studyMode = modeSel.value as StudyTrainerMode;
        this.rebuildQueue();
        this.render();
      };
    }

    const dirSel = selectsWrap.createEl("select", {
      cls: "dropdown",
      attr: { title: "Направление карточек" },
    });
    const dirOptions: Array<{ value: DirectionFilter; label: string }> =
      this.trainerScope === "english"
        ? [
            { value: "BOTH", label: "⇄ Обе стороны" },
            { value: "FORWARD", label: "🇬🇧 EN → RU" },
            { value: "REVERSE", label: "🇷🇺 RU → EN" },
          ]
        : [
            { value: "BOTH", label: "⇄ Все стороны" },
            { value: "FORWARD", label: "→ Прямые" },
            { value: "REVERSE", label: "← Обратные (:::)" },
          ];
    for (const dOpt of dirOptions) {
      const o = dirSel.createEl("option", {
        text: dOpt.label,
        value: dOpt.value,
      });
      if (this.directionFilter === dOpt.value) o.selected = true;
    }
    dirSel.onchange = () => {
      this.directionFilter = dirSel.value as DirectionFilter;
      this.rebuildQueue();
      this.render();
    };

    // 3. Счётчики сессии
    const { card: activeCard, dir: activeDir } =
      this.getCurrentCardAndDirection();
    const remainingCount = this.queue.length + (activeCard ? 1 : 0);
    const totalPool = this.sessionDone + remainingCount;
    const pctDone =
      totalPool > 0 ? Math.round((this.sessionDone / totalPool) * 100) : 100;
    const accuracyPct =
      this.sessionDone > 0
        ? Math.round((this.sessionCorrect / this.sessionDone) * 100)
        : 100;

    const todayReviewedCount =
      this.trainerScope === "english"
        ? this.savedTodayCount
        : this.studyTotals.sumReviewedToday;

    const renderCounters = (parent: HTMLElement) => {
      const row = parent.createDiv("my-sr-counter-row");
      const items = [
        { label: "Осталось", val: remainingCount },
        { label: "Пройдено", val: this.sessionDone },
        { label: "За день", val: todayReviewedCount },
      ];
      for (const it of items) {
        const rect = row.createDiv("my-sr-counter-rect");
        rect.createSpan({ cls: "my-sr-counter-label", text: it.label });
        rect.createSpan({ cls: "my-sr-counter-val", text: String(it.val) });
      }
    };

    // 4. Экран завершения очереди
    if (!activeCard || !activeDir) {
      const doneCard = contentEl.createDiv("my-sr-flashcard is-done-card");
      renderCounters(doneCard);

      const center = doneCard.createDiv("my-sr-done-center");
      center.createDiv({
        cls: "my-sr-done-title",
        text: "🎉 Очередь карточек пройдена!",
      });
      center.createDiv({
        cls: "my-sr-done-sub",
        text: `Точность за сессию: ${accuracyPct}%`,
      });

      const nextRow = center.createDiv("my-sr-done-actions");
      if (this.trainerScope === "english") {
        const newLeft = this.englishData?.newDirections ?? 0;
        if (newLeft > 0) {
          const moreNewBtn = nextRow.createEl("button", {
            cls: "mod-cta my-sr-action-btn",
            text: `✨ Учить новые (${newLeft})`,
            attr: { type: "button" },
          });
moreNewBtn.onclick = () => {
            this.englishMode = "NEW_ONLY";
            this.rebuildQueue();
            this.render();
          };
        }
        const hardBtn = nextRow.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "⚠️ Только сложные",
          attr: { type: "button" },
        });
        hardBtn.onclick = () => {
          this.englishMode = "HARD";
          this.rebuildQueue();
          this.render();
        };
      } else {
        const cramBtn = nextRow.createEl("button", {
          cls: "mod-cta my-sr-action-btn",
          text: "🎯 Краш-тест (все карточки)",
          attr: { type: "button" },
        });
        cramBtn.onclick = () => {
          this.studyMode = "CRAM_ALL";
          this.rebuildQueue();
          this.render();
        };
        const hardBtn = nextRow.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "⚠️ Только сложные",
          attr: { type: "button" },
        });
        hardBtn.onclick = () => {
          this.studyMode = "HARD";
          this.rebuildQueue();
          this.render();
        };
      }

      if (this.canUndoInCurrentScope()) {
        const undoDoneBtn = nextRow.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "↩ Отменить последний ответ",
          attr: { type: "button", title: "Отменить последний ответ (Ctrl+Z)" },
        });
        undoDoneBtn.onclick = () => void this.handleUndo();
      }
      return;
    }

    // 5. Активная карточка
    const isForward = activeDir.dirIndex === 0;
    const isRelearning = Boolean(this.currentItem?.isRelearning);

    const flashcardEl = contentEl.createDiv("my-sr-flashcard");

    const topSection = flashcardEl.createDiv("my-sr-flashcard-top");
    renderCounters(topSection);

    const progTrack = topSection.createDiv("my-sr-progress-track");
    const progFill = progTrack.createDiv("my-sr-progress-fill");
    progFill.style.width = `${pctDone}%`;

    // Единая компактная строка бейджей и кнопок карточки
    const metaRow = topSection.createDiv("my-sr-meta-row");
    const metaLeft = metaRow.createDiv("my-sr-meta-left");

    const stageLabel = isRelearning
      ? "↻ Повтор"
      : activeDir.isNew
        ? "✨ Новая"
        : activeDir.interval >= MATURE_DAYS
          ? "🌲 Закреплена"
          : "🌱 В изучении";

    if (this.trainerScope === "english") {
      metaLeft.createSpan({ cls: "my-sr-pill", text: stageLabel });

      if (activeCard.resolvedBook) {
        const b = activeCard.resolvedBook;
        const bookPill = metaLeft.createSpan({
          cls:
            "my-sr-pill" + (b.epubPath ? " my-sr-pill-clickable" : ""),
          text: `📖 ${b.title}${activeCard.sourceCfi ? " ↗" : ""}`,
          attr: {
            title:
              activeCard.sourceCfi && b.epubPath
                ? "Открыть книгу на месте, где встретилось слово"
                : b.title,
          },
        });
        if (b.epubPath) {
          bookPill.onclick = (ev) => {
            ev.stopPropagation();
            this.openBookInEpubReader(b.epubPath, activeCard.sourceCfi);
          };
        }
      }
    } else {
      metaLeft.createSpan({
        cls: "my-sr-pill",
        text: `📚 ${activeCard.deckTitle}`,
      });
      metaLeft.createSpan({ cls: "my-sr-pill", text: stageLabel });
    }

    if (!activeDir.isNew && activeDir.ease <= 160) {
      metaLeft.createSpan({
        cls: "my-sr-pill my-sr-pill-leech",
        text: "Сложная",
        attr: {
          title: `Часто забывается (лёгкость ${activeDir.ease}%) — стоит уточнить перевод или добавить пример`,
        },
      });
    }

    if (this.sessionDone > 0) {
      metaLeft.createSpan({
        cls: "my-sr-pill my-sr-pill-accuracy",
        text: `Точность ${accuracyPct}%`,
        attr: {
          title:
            this.sessionAgain > 0
              ? `Точность за сессию (повторов: ${this.sessionAgain})`
              : "Точность за сессию",
        },
      });
    }

    const metaRight = metaRow.createDiv("my-sr-meta-right");

    const exKey = `${activeCard.lineIndex}|${activeCard.question}`;
    const examplesOpen =
      this.trainerScope === "english" && this.examplesKey === exKey;
    const synonymsOpen =
      this.trainerScope === "english" && this.synonymsKey === exKey;
    flashcardEl.toggleClass("has-examples", examplesOpen || synonymsOpen);

    if (this.trainerScope === "english") {
      const speakBtn = metaRight.createEl("button", {
        cls: "my-sr-card-tool-btn",
        attr: {
          type: "button",
          title: "Озвучить слово (клавиша R)",
          "aria-label": "Озвучить слово",
        },
      });
      speakBtn.createSpan({ text: "🔊" });
      speakBtn.createSpan({ cls: "my-sr-btn-label", text: " Озвучить" });
      speakBtn.onclick = (ev) => {
        ev.stopPropagation();
        speakEnglishText(activeCard.question);
      };

      const exBtn = metaRight.createEl("button", {
        cls: "my-sr-card-tool-btn" + (examplesOpen ? " is-active" : ""),
        attr: {
          type: "button",
          title: "Показать примеры предложений со словом (клавиша E)",
          "aria-label": "Примеры предложений",
          "aria-expanded": String(examplesOpen),
        },
      });
      exBtn.createSpan({ text: "💬" });
      exBtn.createSpan({ cls: "my-sr-btn-label", text: " Пример" });
      exBtn.onclick = (ev) => {
        ev.stopPropagation();
        this.toggleExamplesForActiveCard(activeCard);
      };

      const synBtn = metaRight.createEl("button", {
        cls: "my-sr-card-tool-btn" + (synonymsOpen ? " is-active" : ""),
        attr: {
          type: "button",
          title: "Показать английские синонимы (клавиша S)",
          "aria-label": "Синонимы",
          "aria-expanded": String(synonymsOpen),
        },
      });
      synBtn.createSpan({ text: "≈" });
      synBtn.createSpan({ cls: "my-sr-btn-label", text: " Синонимы" });
      synBtn.onclick = (ev) => {
        ev.stopPropagation();
        this.toggleSynonymsForActiveCard(activeCard);
      };
    }

    if (this.canUndoInCurrentScope()) {
      const undoBtn = metaRight.createEl("button", {
        cls: "my-sr-card-tool-btn",
        text: "↩",
        attr: {
          type: "button",
          title: "Отменить последний ответ (Ctrl+Z)",
          "aria-label": "Отменить последний ответ",
        },
      });
      undoBtn.onclick = (ev) => {
        ev.stopPropagation();
        void this.handleUndo();
      };
    }

    const editBtn = metaRight.createEl("button", {
      cls: "my-sr-card-tool-btn" + (this.inlineEditOpen ? " is-active" : ""),
      text: "✎",
      attr: {
        type: "button",
        title: "Редактировать карточку",
        "aria-label": "Редактировать карточку",
      },
    });
    editBtn.onclick = (ev) => {
      ev.stopPropagation();
      this.inlineEditOpen = !this.inlineEditOpen;
      this.render();
    };

    // Инлайн-редактор карточки
    if (this.inlineEditOpen) {
      const editBox = flashcardEl.createDiv("my-sr-edit-box");
      editBox.onclick = (ev) => ev.stopPropagation();

      const qInp = editBox.createEl("input", {
        cls: "my-sr-input",
        attr: {
          type: "text",
          value: activeCard.rawQuestion ?? activeCard.question,
          placeholder:
            this.trainerScope === "english"
              ? "Слово (EN) *"
              : "Вопрос / Термин *",
        },
      });

      const answerRow = editBox.createDiv("my-sr-edit-answer-row");
      const aInp = answerRow.createEl("input", {
        cls: "my-sr-input",
        attr: {
          type: "text",
          value: activeCard.rawAnswer ?? activeCard.answer,
          placeholder:
            this.trainerScope === "english"
              ? "Перевод (RU) *"
              : "Ответ / Определение *",
        },
      });

      let exInp: HTMLInputElement | null = null;

      if (this.trainerScope === "english") {
        const trBtn = answerRow.createEl("button", {
          cls: "my-sr-chip-btn my-sr-tr-trigger-btn",
          attr: {
            type: "button",
            title: "Подобрать популярные переводы",
            "aria-label": "Подобрать популярные переводы",
            "aria-expanded": "false",
          },
        });
        const trIcon = trBtn.createSpan({ cls: "my-sr-tr-btn-icon" });
        setIcon(trIcon, "languages");
        trBtn.createSpan({ cls: "my-sr-tr-btn-label", text: "Варианты" });

        const trPanel = editBox.createDiv("my-sr-tr-panel is-hidden");
        let loadedWord = "";
        let lastResult: TranslationResult | null = null;
        let requestSeq = 0;

        const parseParts = (raw: string): string[] =>
          raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        const isSelected = (raw: string, candidate: string): boolean => {
          const target = candidate.trim().toLowerCase();
          return parseParts(raw).some((p) => p.toLowerCase() === target);
        };

        const toggleCandidate = (raw: string, candidate: string): string => {
          const parts = parseParts(raw);
          const target = candidate.trim().toLowerCase();
          const idx = parts.findIndex((p) => p.toLowerCase() === target);
          if (idx !== -1) parts.splice(idx, 1);
          else parts.push(candidate.trim());
          return parts.join(", ");
        };

        const syncChipStates = () => {
          const buttons = trPanel.querySelectorAll<HTMLButtonElement>(
            "button.my-sr-tr-chip"
          );
          buttons.forEach((btn) => {
            const val = btn.dataset.trValue ?? "";
            btn.toggleClass("is-selected", isSelected(aInp.value, val));
          });
        };

        const drawTrHint = (text: string, withRetry: boolean) => {
          trPanel.empty();
          trPanel.createDiv({ cls: "my-sr-examples-hint", text });
          if (withRetry) {
            const retryBtn = trPanel.createEl("button", {
              cls: "my-sr-chip-btn",
              text: "↻ Повторить",
              attr: { type: "button" },
            });
            retryBtn.onclick = () => void loadTranslations(true);
          }
        };

        const drawTrResult = (res: TranslationResult) => {
          lastResult = res;
          trPanel.empty();
          if (!res.items.length) {
            trPanel.createDiv({
              cls: "my-sr-examples-hint",
              text: "Варианты перевода не найдены.",
            });
            return;
          }

          const chips = trPanel.createDiv("my-sr-tr-chips");
          for (const item of res.items) {
            const chip = chips.createEl("button", {
              cls:
                "my-sr-tr-chip" +
                (isSelected(aInp.value, item) ? " is-selected" : ""),
              text: item,
              attr: { type: "button" },
            });
            chip.dataset.trValue = item;
            chip.onclick = () => {
              aInp.value = toggleCandidate(aInp.value, item);
              syncChipStates();
            };
          }

          if (res.sources.length) {
            trPanel.createDiv({
              cls: "my-sr-examples-foot",
              text: `Источник: ${res.sources.join(", ")}`,
            });
          }
        };

        const loadTranslations = async (forceReload = false) => {
          const word = qInp.value.trim();
          if (!word) {
            drawTrHint("Введите английское слово.", false);
            return;
          }

          loadedWord = word.toLowerCase();
          if (!forceReload && hasCachedTranslations(word)) {
            drawTrResult(
              getCachedTranslations(word) ?? { items: [], sources: [] }
            );
            return;
          }

          const seq = ++requestSeq;
          drawTrHint("Ищу переводы…", false);
          try {
            const res = await fetchTranslations(word);
            if (!trPanel.isConnected || seq !== requestSeq) return;
            drawTrResult(res);
          } catch (err: unknown) {
            if (!trPanel.isConnected || seq !== requestSeq) return;
            const msg = err instanceof Error ? err.message : "нет сети";
            drawTrHint(`Не удалось загрузить переводы (${msg}).`, true);
          }
        };

        aInp.oninput = () => {
          if (lastResult && !trPanel.hasClass("is-hidden")) {
            syncChipStates();
          }
        };

        trBtn.onclick = () => {
          const currentWord = qInp.value.trim().toLowerCase();
          const isOpen = !trPanel.hasClass("is-hidden");
          if (isOpen && loadedWord === currentWord) {
            trPanel.addClass("is-hidden");
            trBtn.removeClass("is-active");
            trBtn.setAttr("aria-expanded", "false");
            return;
          }
          trPanel.removeClass("is-hidden");
          trBtn.addClass("is-active");
          trBtn.setAttr("aria-expanded", "true");
          void loadTranslations();
        };
      } else {
        exInp = editBox.createEl("input", {
          cls: "my-sr-input",
          attr: {
            type: "text",
            value: activeCard.exampleOrHint || "",
            placeholder: "Пояснение на обороте (через « // »)",
          },
        });
      }

      const foot = editBox.createDiv("my-sr-edit-foot");
      let bookSel: HTMLSelectElement | null = null;
      let biChk: HTMLInputElement | null = null;

      if (this.trainerScope === "english") {
        bookSel = foot.createEl("select", { cls: "dropdown" });
        bookSel.createEl("option", { text: "Источник: без книги", value: "" });
        for (const b of this.books) {
          const o = bookSel.createEl("option", {
            text: b.title,
            value: b.path,
          });
          if (activeCard.resolvedBook?.path === b.path) o.selected = true;
        }
      } else {
        const biLabel = foot.createEl("label", { cls: "my-sr-check-label" });
        biChk = biLabel.createEl("input", { attr: { type: "checkbox" } });
        biChk.checked = activeCard.isBidirectional;
        biLabel.createSpan({ text: "Двусторонняя (:::)" });
      }

      const btns = foot.createDiv("my-sr-edit-btns");
      const openLineBtn = btns.createEl("button", {
        cls: "my-sr-chip-btn",
        text: `Стр. ${activeCard.lineNumber}`,
        attr: { type: "button" },
      });
      openLineBtn.onclick = () =>
        void this.openFileAtLine(activeCard.deckPath, activeCard.lineIndex);

      const saveBtn = btns.createEl("button", {
        cls: "mod-cta my-sr-action-btn",
        text: "✓ Сохранить",
        attr: { type: "button" },
      });
      saveBtn.onclick = async () => {
        const nq = qInp.value.trim();
        const na = aInp.value.trim();
        const nex = exInp ? exInp.value.trim() : activeCard.exampleOrHint;
        if (!nq || !na) {
          new Notice("Вопрос и ответ не могут быть пустыми.");
          return;
        }
        saveBtn.disabled = true;
        try {
          const chosenBook = bookSel
            ? this.books.find((b) => b.path === bookSel!.value) || null
            : activeCard.resolvedBook;
          const nextBi = biChk ? biChk.checked : activeCard.isBidirectional;
          await updateCardLineOnDisk(this.app, activeCard, {
            newQuestion: nq,
            newAnswer: na,
            newExampleOrHint: nex,
            newIsBi: nextBi,
            newBook: chosenBook,
          });
          activeCard.question = nq;
          activeCard.answer = na;
          activeCard.rawQuestion = nq;
          activeCard.rawAnswer = na;
          activeCard.questionType = classifyCardSide(nq);
          activeCard.answerType = classifyCardSide(na);
          activeCard.exampleOrHint = nex;
          activeCard.isBidirectional = nextBi;
          activeCard.resolvedBook = chosenBook;
          this.inlineEditOpen = false;
          new Notice("Карточка обновлена.");
          this.render();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice("Ошибка: " + msg);
          saveBtn.disabled = false;
        }
      };
    }

// Центральная область вопроса и ответа
    const centerBox = flashcardEl.createDiv(
      "my-sr-center" + (!this.isFlipped ? " is-clickable" : "")
    );
    if (!this.isFlipped) {
      centerBox.onclick = () => this.doFlipCard();
    }

    const promptText = isForward ? activeCard.question : activeCard.answer;
    const targetAnswer = isForward ? activeCard.answer : activeCard.question;
    const promptRaw = isForward
      ? activeCard.rawQuestion ?? activeCard.question
      : activeCard.rawAnswer ?? activeCard.answer;
    const targetRaw = isForward
      ? activeCard.rawAnswer ?? activeCard.answer
      : activeCard.rawQuestion ?? activeCard.question;

    if (this.trainerScope === "study") {
      const promptEl = centerBox.createDiv("my-sr-prompt-text");
      if (this.sideRenderComponent) {
        void renderStudySide(
          this.app,
          promptRaw,
          activeCard.deckPath,
          this.sideRenderComponent
        )
          .then((rendered) => {
            rendered.classList.add("my-sr-prompt-text");
            if (promptEl.isConnected) promptEl.replaceWith(rendered);
          })
          .catch((error: unknown) => {
            console.error(
              "Не удалось отобразить вопрос учебной карточки.",
              error
            );
            if (promptEl.isConnected) promptEl.setText(promptRaw);
          });
      } else {
        promptEl.setText(promptRaw);
      }
    } else {
      centerBox.createDiv({ cls: "my-sr-prompt-text", text: promptText });
    }

    if (this.trainerScope === "english" && activeCard.exampleOrHint) {
      if (isForward) {
        const exEl = centerBox.createDiv("my-sr-example-text");
        appendHighlightedSentence(
          exEl,
          activeCard.exampleOrHint,
          activeCard.question,
          false
        );
      } else if (
        !this.isFlipped &&
        this.plugin.settings.showMaskedExampleOnReverse &&
        canMaskWordInSentence(activeCard.exampleOrHint, activeCard.question)
      ) {
        const exEl = centerBox.createDiv("my-sr-example-text");
        appendHighlightedSentence(
          exEl,
          activeCard.exampleOrHint,
          activeCard.question,
          true
        );
      }
    }

    if (this.isFlipped) {
      centerBox.createDiv("my-sr-divider");

      if (this.trainerScope === "study") {
        const answerEl = centerBox.createDiv("my-sr-answer-text");
        if (this.sideRenderComponent) {
          void renderStudySide(
            this.app,
            targetRaw,
            activeCard.deckPath,
            this.sideRenderComponent
          )
            .then((rendered) => {
              rendered.classList.add("my-sr-answer-text");
              if (answerEl.isConnected) answerEl.replaceWith(rendered);
            })
            .catch((error: unknown) => {
              console.error(
                "Не удалось отобразить ответ учебной карточки.",
                error
              );
              if (answerEl.isConnected) answerEl.setText(targetRaw);
            });
        } else {
          answerEl.setText(targetRaw);
        }
      } else {
        centerBox.createDiv({ cls: "my-sr-answer-text", text: targetAnswer });
      }

      if (
        this.trainerScope === "english" &&
        !isForward &&
        activeCard.exampleOrHint
      ) {
        const exRow = centerBox.createDiv("my-sr-example-flip-row");
        const exSpan = exRow.createSpan({ cls: "my-sr-example-text" });
        appendHighlightedSentence(
          exSpan,
          activeCard.exampleOrHint,
          activeCard.question,
          false
        );
      }

      if (this.trainerScope === "study" && activeCard.exampleOrHint) {
        centerBox.createDiv({
          cls: "my-sr-example-text",
          text: `📌 ${activeCard.exampleOrHint}`,
        });
      }
    }

    if (examplesOpen) {
      this.renderExamplesBox(
        flashcardEl,
        activeCard.question,
        !isForward && !this.isFlipped
      );
    }

    if (synonymsOpen) {
      this.renderSynonymsBox(flashcardEl, activeCard.question);
    }

    if (
      this.trainerScope === "english" &&
      this.plugin.settings.autoSpeakEnglish &&
      (isForward || this.isFlipped)
    ) {
      const speakKey = `${this.currentItem?.uid ?? activeCard.uidKey}:${this.sessionDone}:${isForward ? "front" : "back"}`;
      if (this.lastAutoSpokenKey !== speakKey) {
        this.lastAutoSpokenKey = speakKey;
        speakEnglishText(activeCard.question);
      }
    }

    // 6. Нижний блок кнопок ответа
    const bottomControls = contentEl.createDiv("my-sr-bottom-controls");
    const gradeOptions = computeGradeOptions(
      activeDir,
      todayISO,
      isRelearning,
      `${activeCard.uidKey}:${activeDir.dirIndex}:${todayISO}`
    );

    if (!this.isFlipped) {
      const flipBtn = bottomControls.createEl("button", {
        cls: "mod-cta my-sr-flip-btn",
        text: "Показать ответ",
        attr: { type: "button" },
      });
      flipBtn.onclick = () => this.doFlipCard();
    } else {
      const gradeGrid = bottomControls.createDiv("my-sr-grade-grid");
      const opts = [
        gradeOptions.again,
        gradeOptions.hard,
        gradeOptions.good,
        gradeOptions.easy,
      ];
      for (const gOpt of opts) {
        const gBtn = gradeGrid.createEl("button", {
          cls: "my-sr-grade-btn",
          attr: { type: "button" },
        });
        gBtn.style.setProperty("--grade-color", gOpt.color);

        const titleSpan = gBtn.createSpan({ cls: "my-sr-grade-title" });
        titleSpan.createSpan({ cls: "my-sr-grade-key", text: gOpt.key });
        titleSpan.createSpan({ text: gOpt.label });

        gBtn.createSpan({ cls: "my-sr-grade-sub", text: gOpt.sub });

        gBtn.onclick = () => {
          gBtn.disabled = true;
          void this.doGradeCard(activeCard, activeDir, gOpt);
        };
      }
    }
  }
}
