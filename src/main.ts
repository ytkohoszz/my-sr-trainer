import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  DEFAULT_SETTINGS,
  DirectionFilter,
  OpenTrainerParams,
  SrTrainerSettings,
  TrainerScope,
} from "./types";
import { SrTrainerModal } from "./modal";

function migrateSettings(raw: unknown): SrTrainerSettings {
  const source =
    raw && typeof raw === "object" ? (raw as Partial<SrTrainerSettings>) : {};
  return Object.assign({}, DEFAULT_SETTINGS, source);
}

class SrTrainerSettingTab extends PluginSettingTab {
  plugin: MySrTrainerPlugin;

  constructor(app: App, plugin: MySrTrainerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Файл английских карточек")
      .setDesc("Путь к заметке со словами (по умолчанию: Words Cards)")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.wordsFilePath)
          .onChange((val) => {
            this.plugin.settings.wordsFilePath = val.trim() || "Words Cards";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Папка заметок книг")
      .setDesc("По умолчанию: Знания/Книги")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.booksFolder)
          .onChange((val) => {
            this.plugin.settings.booksFolder = val.trim() || "Знания/Книги";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Папка учебных колод")
      .setDesc("По умолчанию: Знания/Карточки")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.studyDecksFolder)
          .onChange((val) => {
            this.plugin.settings.studyDecksFolder =
              val.trim() || "Знания/Карточки";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Папка ежедневника")
      .setDesc(
        "Для автоматической синхронизации поля карточек_пройдено (по умолчанию: Ежедневник)"
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.diaryFolder)
          .onChange((val) => {
            this.plugin.settings.diaryFolder = val.trim() || "Ежедневник";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Лимит новых английских слов за сессию")
      .setDesc("В режиме «По расписанию + новые» (по умолчанию: 25)")
      .addSlider((slider) =>
        slider
          .setLimits(5, 100, 5)
          .setValue(this.plugin.settings.englishNewSessionLimit)
          .setDynamicTooltip()
          .onChange((val) => {
            this.plugin.settings.englishNewSessionLimit = val;
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Лимит новых учебных карточек за сессию")
      .setDesc("В режиме «По расписанию + новые» (по умолчанию: 30)")
      .addSlider((slider) =>
        slider
          .setLimits(5, 100, 5)
          .setValue(this.plugin.settings.studyNewSessionLimit)
          .setDynamicTooltip()
          .onChange((val) => {
            this.plugin.settings.studyNewSessionLimit = val;
            this.plugin.requestSaveSettings();
          })
      );
  }
}

export default class MySrTrainerPlugin extends Plugin {
  settings!: SrTrainerSettings;
  private saveTimer: number | null = null;

  async onload() {
    this.settings = migrateSettings(await this.loadData());
    this.addSettingTab(new SrTrainerSettingTab(this.app, this));

    // Кнопка на левой панели (и в мобильном меню)
    this.addRibbonIcon("layers", "Открыть тренажёр карточек SR", () => {
      this.openTrainer({ scope: "english" });
    });

    // Протокол obsidian://my-sr?scope=english|study&mode=...&deck=...&book=...
    this.registerObsidianProtocolHandler("my-sr", (params) => {
      const scope: TrainerScope =
        params.scope === "study" ? "study" : "english";
      this.openTrainer({
        scope,
        mode: params.mode,
        deckPath: params.deck,
        bookPath: params.book,
        directionFilter: params.dir as DirectionFilter | undefined,
      });
    });

    this.addCommand({
      id: "open-english-sr-trainer",
      name: "Тренировать английские слова (Words Cards)",
      callback: () => {
        this.openTrainer({ scope: "english" });
      },
    });

    this.addCommand({
      id: "open-study-sr-trainer",
      name: "Тренировать учебные карточки (Знания/Карточки)",
      callback: () => {
        this.openTrainer({ scope: "study" });
      },
    });
  }

  openTrainer(params?: OpenTrainerParams) {
    new SrTrainerModal(this.app, this, params).open();
  }

  requestSaveSettings() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.settings);
    }, 300);
  }

  onunload() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}