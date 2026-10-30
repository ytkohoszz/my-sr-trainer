import { App, Modal, Notice } from "obsidian";
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
  formatShortDateRU,
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
  appendHighlightedSentence,
  evaluateWrittenAnswer,
  fetchExamples,
  getCachedExamples,
  hasCachedExamples,
  speakEnglishText,
} from "./examples";

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
  typedValue = "";
  examplesKey = "";
  examplesOffset = 0;

  sessionDone = 0;
  sessionCorrect = 0;
  sessionAgain = 0;
  undoStack: UndoSnapshot[] = [];

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private isGrading = false;

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
    this.contentEl.addClass("my-sr-modal");

    this.keyHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
    window.addEventListener("keydown", this.keyHandler);

    await this.reloadAllDataAndRebuildQueue();
  }

  onClose() {
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
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
    this.triggerAutoSpeakIfNeeded();
  }

  private getActiveCardsPool(): SrCard[] {
    if (this.trainerScope === "english") {
      return this.englishData?.cards ?? [];
    }
    return this.studyAllCards;
  }

  rebuildQueue() {
    const dueItems: TrainerQueueItem[] = [];
    const newItems: TrainerQueueItem[] = [];
    const extraItems: TrainerQueueItem[] = [];

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

        for (const dir of card.directions) {
          if (this.directionFilter === "FORWARD" && dir.dirIndex !== 0) continue;
          if (this.directionFilter === "REVERSE" && dir.dirIndex !== 1) continue;

          const item: TrainerQueueItem = {
            uid: `${card.deckPath}:${card.lineIndex}:${dir.dirIndex}`,
            deckPath: card.deckPath,
            lineIndex: card.lineIndex,
            dirIndex: dir.dirIndex,
            isRelearning: false,
          };

          if (this.englishMode === "DUE_ONLY") {
            if (dir.isDue) dueItems.push(item);
          } else if (this.englishMode === "NEW_ONLY") {
            if (dir.isNew) newItems.push(item);
          } else if (
            this.englishMode === "HARD" ||
            this.englishMode === "BOOK"
          ) {
            if (dir.isDue) dueItems.push(item);
            else if (dir.isNew) newItems.push(item);
            else extraItems.push(item);
          } else {
            if (dir.isDue) dueItems.push(item);
            else if (dir.isNew) newItems.push(item);
          }
        }
      }

      const newLimit = this.plugin.settings.englishNewSessionLimit || 25;
      if (this.englishMode === "DUE_AND_NEW") {
        this.queue = [...dueItems, ...newItems.slice(0, newLimit)];
      } else if (this.englishMode === "HARD" || this.englishMode === "BOOK") {
        this.queue = [...dueItems, ...newItems, ...extraItems];
      } else {
        this.queue = [...dueItems, ...newItems];
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

        for (const dir of card.directions) {
          if (this.directionFilter === "FORWARD" && dir.dirIndex !== 0) continue;
          if (this.directionFilter === "REVERSE" && dir.dirIndex !== 1) continue;

          const item: TrainerQueueItem = {
            uid: `${card.deckPath}:${card.lineIndex}:${dir.dirIndex}`,
            deckPath: card.deckPath,
            lineIndex: card.lineIndex,
            dirIndex: dir.dirIndex,
            isRelearning: false,
          };

          if (this.studyMode === "DUE_ONLY") {
            if (dir.isDue) dueItems.push(item);
          } else if (this.studyMode === "NEW_ONLY") {
            if (dir.isNew) newItems.push(item);
          } else if (
            this.studyMode === "CRAM_ALL" ||
            this.studyMode === "HARD"
          ) {
            if (dir.isDue) dueItems.push(item);
            else if (dir.isNew) newItems.push(item);
            else extraItems.push(item);
          } else {
            if (dir.isDue) dueItems.push(item);
            else if (dir.isNew) newItems.push(item);
          }
        }
      }

      const newLimit = this.plugin.settings.studyNewSessionLimit || 30;
      if (this.studyMode === "DUE_AND_NEW") {
        this.queue = [...dueItems, ...newItems.slice(0, newLimit)];
      } else {
        this.queue = [...dueItems, ...newItems, ...extraItems];
      }
    }

    this.currentItem = this.queue.shift() || null;
    this.isFlipped = false;
    this.inlineEditOpen = false;
    this.typedValue = "";
    this.examplesKey = "";
    this.examplesOffset = 0;
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

  private isTypingModeEnabled(): boolean {
    return this.trainerScope === "english"
      ? this.plugin.settings.englishTypingMode
      : this.plugin.settings.studyTypingMode;
  }

  private triggerAutoSpeakIfNeeded() {
    if (
      this.trainerScope === "english" &&
      this.plugin.settings.autoSpeakEnglish &&
      this.currentItem &&
      this.currentItem.dirIndex === 0
    ) {
      const { card } = this.getCurrentCardAndDirection();
      if (card) speakEnglishText(card.question);
    }
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
    if (
      this.trainerScope === "english" &&
      this.plugin.settings.autoSpeakEnglish
    ) {
      const { card } = this.getCurrentCardAndDirection();
      if (card) speakEnglishText(card.question);
    }
    this.render();
  }

  private toggleExamplesForActiveCard(card: SrCard) {
    const exKey = `${card.lineIndex}|${card.question}`;
    this.examplesKey = this.examplesKey === exKey ? "" : exKey;
    this.examplesOffset = 0;
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
      this.typedValue = "";
      this.examplesKey = "";

      this.render();
      this.triggerAutoSpeakIfNeeded();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("Ошибка сохранения ответа: " + msg);
    } finally {
      this.isGrading = false;
    }
  }

  private async handleUndo() {
    const snap = this.undoStack.pop();
    if (!snap) return;

    try {
      const fObj = resolveVaultFile(this.app, snap.deckPath);
      if (fObj) {
        await enqueueDiskWrite(() =>
          this.app.vault.modify(fObj, snap.rawContent)
        );
      }

      const pool = this.getActiveCardsPool();
      const restoredCard = pool.find(
        (c) => c.deckPath === snap.deckPath && c.lineIndex === snap.lineIndex
      );
      if (restoredCard && snap.prevDirState) {
        const curDir = restoredCard.directions[snap.dirIndex];
        if (curDir) {
          if (snap.scope === "english" && this.englishData) {
            if (snap.prevDirState.isDue && !curDir.isDue) {
              this.englishData.dueScheduled++;
            }
            if (snap.prevDirState.isNew && !curDir.isNew) {
              this.englishData.newDirections++;
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
      this.examplesKey = "";
      this.sessionDone = Math.max(0, this.sessionDone - 1);
      if (snap.wasCorrect) {
        this.sessionCorrect = Math.max(0, this.sessionCorrect - 1);
      } else {
        this.sessionAgain = Math.max(0, this.sessionAgain - 1);
      }

      new Notice("Последний ответ отменён.");
      this.render();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("Ошибка отмены: " + msg);
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    const activeTag = document.activeElement?.tagName;
    if (
      activeTag === "INPUT" ||
      activeTag === "TEXTAREA" ||
      activeTag === "SELECT" ||
      (document.activeElement as HTMLElement | null)?.isContentEditable
    ) {
      return;
    }

    const { card, dir } = this.getCurrentCardAndDirection();
    if (!card || !dir) return;

    const todayISO = getTodayISO();
    const gradeOptions = computeGradeOptions(
      dir,
      todayISO,
      Boolean(this.currentItem?.isRelearning)
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

      if (items.length > 3) {
        const moreBtn = head.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "↻ Ещё",
          attr: { type: "button", title: "Показать другие примеры" },
        });
        moreBtn.onclick = (ev) => {
          ev.stopPropagation();
          this.examplesOffset += 3;
          this.render();
        };
      }

      const count = Math.min(3, items.length);
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

        if (!mask) {
          const sp = row.createEl("button", {
            cls: "my-sr-chip-btn",
            text: "🔊",
            attr: {
              type: "button",
              title: "Озвучить предложение",
              "aria-label": "Озвучить предложение",
            },
          });
          sp.onclick = (ev) => {
            ev.stopPropagation();
            speakEnglishText(it.text);
          };
        }
      }

      const sources = [...new Set(shown.map((x) => x.source))].join(", ");
      panel.createDiv({
        cls: "my-sr-examples-foot",
        text: `Источник: ${sources} · не сохраняется в карточку`,
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

  render() {
    const { contentEl } = this;
    contentEl.empty();

    const todayISO = getTodayISO();

    // 1. Шапка переключения режима: 🇬🇧 Английский | 🎓 Учёба
    const scopeBar = contentEl.createDiv("my-sr-scope-bar");
    const scopes: Array<{ id: TrainerScope; label: string }> = [
      {
        id: "english",
        label: `🇬🇧 Английский (${this.englishData?.dueScheduled ?? 0})`,
      },
      {
        id: "study",
        label: `🎓 Учёба (${this.studyTotals.sumDue})`,
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
        this.triggerAutoSpeakIfNeeded();
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
          label: `🔥 По расписанию (${dueCnt}) + новые`,
        },
        { value: "DUE_ONLY", label: `⏰ К повторению (${dueCnt})` },
        { value: "NEW_ONLY", label: `✨ Только новые (${newCnt})` },
        { value: "HARD", label: "⚠️ Только сложные" },
        { value: "BOOK", label: "📖 Слова из книги" },
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
        this.triggerAutoSpeakIfNeeded();
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
          this.triggerAutoSpeakIfNeeded();
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
        { value: "DUE_AND_NEW", label: "🔥 По расписанию + новые" },
        { value: "CRAM_ALL", label: "🎯 Краш-тест (все)" },
        { value: "DUE_ONLY", label: "⏰ К повторению" },
        { value: "NEW_ONLY", label: "✨ Только новые" },
        { value: "HARD", label: "⚠️ Только сложные" },
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
      this.triggerAutoSpeakIfNeeded();
    };

    const toolsWrap = toolbar.createDiv("my-sr-tools");

    const typingOn = this.isTypingModeEnabled();
    const typingBtn = toolsWrap.createEl("button", {
      cls: "my-sr-chip-btn" + (typingOn ? " is-active" : ""),
      text: "⌨️ Ввод",
      attr: {
        type: "button",
        title: "Письменная проверка ответа перед переворотом",
      },
    });
    typingBtn.onclick = () => {
      if (this.trainerScope === "english") {
        this.plugin.settings.englishTypingMode = !typingOn;
      } else {
        this.plugin.settings.studyTypingMode = !typingOn;
      }
      this.plugin.requestSaveSettings();
      this.render();
    };

    if (this.trainerScope === "english") {
      const ttsOn = this.plugin.settings.autoSpeakEnglish;
      const ttsBtn = toolsWrap.createEl("button", {
        cls: "my-sr-chip-btn" + (ttsOn ? " is-active" : ""),
        text: "🔊 Авто",
        attr: {
          type: "button",
          title: "Автоматически озвучивать английское слово",
        },
      });
      ttsBtn.onclick = () => {
        this.plugin.settings.autoSpeakEnglish = !ttsOn;
        this.plugin.requestSaveSettings();
        this.render();
      };
    }

    const shuffleBtn = toolsWrap.createEl("button", {
      cls: "my-sr-chip-btn",
      text: "🔀",
      attr: {
        type: "button",
        title: "Перемешать очередь карточек",
        "aria-label": "Перемешать очередь",
      },
    });
    shuffleBtn.onclick = () => {
      if (this.currentItem) this.queue.push(this.currentItem);
      for (let i = this.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = this.queue[i];
        const swap = this.queue[j];
        if (temp && swap) {
          this.queue[i] = swap;
          this.queue[j] = temp;
        }
      }
      this.currentItem = this.queue.shift() || null;
      this.isFlipped = false;
      this.typedValue = "";
      this.examplesKey = "";
      this.render();
      this.triggerAutoSpeakIfNeeded();
    };

    if (this.undoStack.length > 0) {
      const undoBtn = toolsWrap.createEl("button", {
        cls: "my-sr-chip-btn my-sr-undo-btn",
        text: `↶ (${this.undoStack.length})`,
        attr: { type: "button", title: "Отменить последнюю оценку" },
      });
      undoBtn.onclick = () => void this.handleUndo();
    }

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
        { label: "Осталось", val: remainingCount, color: "#d69852" },
        { label: "Пройдено", val: this.sessionDone, color: "#599ed6" },
        { label: "За день", val: todayReviewedCount, color: "#4aab80" },
      ];
      for (const it of items) {
        const rect = row.createDiv("my-sr-counter-rect");
        rect.style.setProperty("--cnt-color", it.color);
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
            this.triggerAutoSpeakIfNeeded();
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
          this.triggerAutoSpeakIfNeeded();
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
      return;
    }

    // 5. Активная карточка
    const isForward = activeDir.dirIndex === 0;
    const isRelearning = Boolean(this.currentItem?.isRelearning);
    const borderCol = isRelearning
      ? "#d85b57"
      : activeDir.isNew
        ? "#599ed6"
        : activeDir.interval >= MATURE_DAYS
          ? "#4aab80"
          : this.trainerScope === "english"
            ? "#e5a158"
            : "#9c83e8";

    const flashcardEl = contentEl.createDiv("my-sr-flashcard");
    flashcardEl.style.borderTop = `3px solid ${borderCol}`;

    const topSection = flashcardEl.createDiv("my-sr-flashcard-top");
    renderCounters(topSection);

    const progTrack = topSection.createDiv("my-sr-progress-track");
    const progFill = progTrack.createDiv("my-sr-progress-fill");
    progFill.style.width = `${pctDone}%`;

    const metaRow = topSection.createDiv("my-sr-meta-row");
    const metaLeft = metaRow.createDiv("my-sr-meta-left");

    if (this.trainerScope === "english") {
      metaLeft.createSpan({
        cls: "my-sr-pill",
        text: isForward ? "🇬🇧 EN → RU" : "🇷🇺 RU → EN",
      });

      const stageLabel = isRelearning
        ? "↻ Повтор в сессии"
        : activeDir.isNew
          ? "✨ Новая"
          : activeDir.interval >= MATURE_DAYS
            ? "🌲 Закреплена"
            : "🌱 В изучении";
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
      metaLeft.createSpan({
        cls: "my-sr-pill",
        text: activeCard.isBidirectional
          ? isForward
            ? "⇄ Прямой"
            : "⇄ Обратный"
          : "→ Вопрос",
      });
      metaLeft.createSpan({
        cls: "my-sr-pill",
        text: isRelearning
          ? "↻ Повтор"
          : activeDir.isNew
            ? "✨ Новая"
            : `инт. ${activeDir.interval} дн. · Ease ${activeDir.ease}%`,
      });
    }

    const metaRight = metaRow.createDiv("my-sr-meta-right");

    const exKey = `${activeCard.lineIndex}|${activeCard.question}`;
    const examplesOpen =
      this.trainerScope === "english" && this.examplesKey === exKey;

    if (this.trainerScope === "english") {
      const speakBtn = metaRight.createEl("button", {
        cls: "my-sr-chip-btn",
        text: "🔊 Озвучить",
        attr: {
          type: "button",
          title: "Озвучить слово (клавиша R)",
          "aria-label": "Озвучить слово",
        },
      });
      speakBtn.onclick = (ev) => {
        ev.stopPropagation();
        speakEnglishText(activeCard.question);
      };

      const exBtn = metaRight.createEl("button", {
        cls: "my-sr-chip-btn" + (examplesOpen ? " is-active" : ""),
        text: "💬 Пример",
        attr: {
          type: "button",
          title: "Показать примеры предложений со словом (клавиша E)",
        },
      });
      exBtn.onclick = (ev) => {
        ev.stopPropagation();
        this.toggleExamplesForActiveCard(activeCard);
      };
    }

    const editBtn = metaRight.createEl("button", {
      cls: "my-sr-chip-btn" + (this.inlineEditOpen ? " is-active" : ""),
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
          value: activeCard.question,
          placeholder:
            this.trainerScope === "english"
              ? "Слово (EN) *"
              : "Вопрос / Термин *",
        },
      });
      const aInp = editBox.createEl("input", {
        cls: "my-sr-input",
        attr: {
          type: "text",
          value: activeCard.answer,
          placeholder:
            this.trainerScope === "english"
              ? "Перевод (RU) *"
              : "Ответ / Определение *",
        },
      });
      const exInp = editBox.createEl("input", {
        cls: "my-sr-input",
        attr: {
          type: "text",
          value: activeCard.exampleOrHint || "",
          placeholder:
            this.trainerScope === "english"
              ? "Пример предложения (сохраняется в карточке через « — »)"
              : "Пояснение на обороте (через « // »)",
        },
      });

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
        const nex = exInp.value.trim();
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
      "my-sr-center" +
        (!this.isFlipped && !typingOn ? " is-clickable" : "")
    );
    if (!this.isFlipped && !typingOn) {
      centerBox.onclick = () => this.doFlipCard();
    }

    const promptText = isForward ? activeCard.question : activeCard.answer;
    const targetAnswer = isForward ? activeCard.answer : activeCard.question;

    centerBox.createDiv({ cls: "my-sr-prompt-text", text: promptText });

    if (
      this.trainerScope === "english" &&
      isForward &&
      activeCard.exampleOrHint
    ) {
      centerBox.createDiv({
        cls: "my-sr-example-text",
        text: activeCard.exampleOrHint,
      });
    }

    const ctxGrid = centerBox.createDiv("my-sr-context-grid");
    if (activeDir.isNew) {
      ctxGrid.createSpan({
        cls: "my-sr-context-chip",
        text: "Показ: первый · База Ease 250%",
      });
    } else {
      ctxGrid.createSpan({
        cls: "my-sr-context-chip",
        text: `Инт.: ${activeDir.interval} дн. · Ease: ${activeDir.ease}% · План: ${formatShortDateRU(activeDir.dateStr)}`,
      });
    }
    if (this.sessionDone > 0) {
      ctxGrid.createSpan({
        cls: "my-sr-context-chip",
        text: `🎯 Точность: ${accuracyPct}%${this.sessionAgain > 0 ? ` · Повторов: ${this.sessionAgain}` : ""}`,
      });
    }

    if (typingOn && !this.isFlipped) {
      const typeWrap = centerBox.createDiv("my-sr-type-wrap");
      const typeInp = typeWrap.createEl("input", {
        cls: "my-sr-type-input",
        attr: {
          type: "text",
          placeholder:
            this.trainerScope === "english"
              ? isForward
                ? "Впиши перевод на русском и нажми Enter…"
                : "Впиши слово на английском и нажми Enter…"
              : "Впиши ответ и нажми Enter…",
          value: this.typedValue,
        },
      });
      typeInp.onclick = (ev) => ev.stopPropagation();
      typeInp.oninput = () => {
        this.typedValue = typeInp.value;
      };
      typeInp.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          this.doFlipCard();
        }
      };
      window.setTimeout(() => {
        if (typeInp.isConnected) typeInp.focus();
      }, 20);
    }

    if (this.isFlipped) {
      centerBox.createDiv("my-sr-divider");

      if (typingOn && this.typedValue.trim() !== "") {
        const evalRes = evaluateWrittenAnswer(
          this.typedValue,
          targetAnswer,
          this.trainerScope === "english"
        );
        const evalEl = centerBox.createDiv({
          cls: "my-sr-eval-result",
          text: evalRes.label,
        });
        evalEl.style.color = evalRes.color;
      }

      centerBox.createDiv({ cls: "my-sr-answer-text", text: targetAnswer });

      if (
        this.trainerScope === "english" &&
        !isForward &&
        activeCard.exampleOrHint
      ) {
        const exRow = centerBox.createDiv("my-sr-example-flip-row");
        exRow.createSpan({
          cls: "my-sr-example-text",
          text: activeCard.exampleOrHint,
        });
        const spExBtn = exRow.createEl("button", {
          cls: "my-sr-chip-btn",
          text: "🔊",
          attr: {
            type: "button",
            title: "Озвучить пример предложения",
            "aria-label": "Озвучить пример предложения",
          },
        });
        spExBtn.onclick = (ev) => {
          ev.stopPropagation();
          speakEnglishText(activeCard.exampleOrHint);
        };
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

    // 6. Нижний блок кнопок ответа
    const bottomControls = contentEl.createDiv("my-sr-bottom-controls");
    const gradeOptions = computeGradeOptions(
      activeDir,
      todayISO,
      isRelearning
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