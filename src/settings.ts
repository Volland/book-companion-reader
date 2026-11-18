import { App, PluginSettingTab, Setting } from "obsidian";
import type BookCompanionPlugin from "./main";
import { LEVEL_LABELS, type LanguageProfile } from "./languages";

export type Provider = "claude-sub" | "chatgpt-sub" | "gemini-sub" | "chat-app" | "anthropic" | "openai" | "openrouter" | "ollama" | "custom";
export type Level = "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | "native";

export interface AiSettings {
	provider: Provider;
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature: number;
	maxTokens: number;
	/** Full path to the subscription app's command line, when it isn't found by itself. */
	cliPath: string;
	/** Which chat app gets the question on phones (or with the "chat app" option). */
	chatApp: "chatgpt" | "claude" | "gemini";
	/** iPhone/iPad: ask through an Apple Shortcut ("Ask Claude" or "Use Model" → ChatGPT) and get the answer back by itself. */
	iosShortcut: boolean;
	/** Name of that Shortcut in the Shortcuts app. */
	shortcutName: string;
}

export interface LearnerSettings {
	nativeLanguage: string;
	learningLanguage: string;
	level: Level;
	/** More languages, each with its own level (the main one above is the default). */
	otherLanguages: LanguageProfile[];
	/** Which language explanations are written in. */
	explainIn: "native" | "learning";
	extraInstructions: string;
}

export interface CardSettings {
	/** Cards per study session. */
	sessionSize: number;
}

export interface LibrarySettings {
	/** Books to finish this year (0 = no goal). */
	yearlyGoal: number;
	/** How many books the librarian suggests at a time. */
	suggestionCount: number;
}

export interface NotesSettings {
	rootFolder: string;
	highlightsToBookPage: boolean;
	flashcardTag: string;
	/** Write Typed Graph types and edges: "auto" when the Typed Graph plugin is on. */
	typedNotes: "auto" | "on" | "off";
	/** Typed Graph schema folder; empty = the one Typed Graph uses. */
	schemaFolder: string;
}

export interface ReaderSettings {
	openPdfInReader: boolean;
	epubLayout: "paged" | "scroll";
	fontSize: number;
	lineHeight: number;
	fontFamily: "serif" | "sans" | "theme";
	paper: "theme" | "sepia" | "light" | "dark";
	defaultHighlight: string;
}

export interface InkSettings {
	penOnly: boolean;
	penColor: string;
	penWidth: number;
	paperStyle: "lined" | "dotted" | "blank";
}

export interface BookCompanionSettings {
	ai: AiSettings;
	learner: LearnerSettings;
	cards: CardSettings;
	library: LibrarySettings;
	notes: NotesSettings;
	reader: ReaderSettings;
	ink: InkSettings;
}

export const PROVIDER_DEFAULTS: Record<Provider, { baseUrl: string; model: string; needsKey: boolean; label: string; kind: "api" | "cli" | "handoff"; help?: string }> = {
	"claude-sub": { kind: "cli", baseUrl: "", model: "", needsKey: false, label: "My Claude subscription (Pro / Max)", help: "Uses the Claude Code app on this computer, signed in with your Claude account (run \"claude\" once in a terminal to sign in). On iPhone and iPad, questions go through your Shortcut (see below); on other phones, to your chat app." },
	"chatgpt-sub": { kind: "cli", baseUrl: "", model: "", needsKey: false, label: "My ChatGPT subscription (Plus / Pro)", help: "Uses the Codex app on this computer, signed in with your ChatGPT account (run \"codex\" once in a terminal to sign in). On iPhone and iPad, questions go through your Shortcut (see below); on other phones, to your chat app." },
	"gemini-sub": { kind: "cli", baseUrl: "", model: "", needsKey: false, label: "My Google account (Gemini)", help: "Uses the Gemini CLI on this computer. Since mid-2026 Google only lets work accounts (Gemini Code Assist Standard or Enterprise) sign in to it; with a personal Google AI Pro plan, choose \"My chat app\" or a free Gemini API key with \"Other OpenAI-compatible service\"." },
	"chat-app": { kind: "handoff", baseUrl: "", model: "", needsKey: false, label: "My chat app, any device (paste the answer back)", help: "Opens ChatGPT, Claude or Gemini with your question ready; paste the answer back into the reader. Works on phones with any subscription. On iPhone and iPad, a Shortcut can bring the answer back by itself (see below)." },
	anthropic: { kind: "api", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", needsKey: true, label: "Anthropic API key" },
	openai: { kind: "api", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true, label: "OpenAI API key" },
	openrouter: { kind: "api", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5-5", needsKey: true, label: "OpenRouter API key" },
	ollama: { kind: "api", baseUrl: "http://localhost:11434/v1", model: "llama3.1", needsKey: false, label: "Ollama (free, on this computer)" },
	custom: { kind: "api", baseUrl: "http://localhost:1234/v1", model: "local-model", needsKey: false, label: "Other OpenAI-compatible service" },
};

export const HIGHLIGHT_COLORS: Record<string, string> = {
	yellow: "#ffd43b",
	green: "#8ce99a",
	blue: "#74c0fc",
	pink: "#faa2c1",
	orange: "#ffa94d",
};

export const DEFAULT_SETTINGS: BookCompanionSettings = {
	ai: {
		provider: "claude-sub",
		apiKey: "",
		baseUrl: "",
		model: "",
		temperature: 0.3,
		maxTokens: 1200,
		cliPath: "",
		chatApp: "claude",
		iosShortcut: false,
		shortcutName: "Book Companion AI",
	},
	learner: {
		nativeLanguage: "Ukrainian",
		learningLanguage: "English",
		level: "B1",
		otherLanguages: [],
		explainIn: "learning",
		extraInstructions: "",
	},
	cards: {
		sessionSize: 20,
	},
	library: {
		yearlyGoal: 0,
		suggestionCount: 5,
	},
	notes: {
		rootFolder: "Books",
		highlightsToBookPage: true,
		flashcardTag: "flashcards",
		typedNotes: "auto",
		schemaFolder: "",
	},
	reader: {
		openPdfInReader: false,
		epubLayout: "paged",
		fontSize: 18,
		lineHeight: 1.6,
		fontFamily: "serif",
		paper: "theme",
		defaultHighlight: "yellow",
	},
	ink: {
		penOnly: false,
		penColor: "#1c7ed6",
		penWidth: 2.5,
		paperStyle: "lined",
	},
};

export function mergeSettings(saved: unknown): BookCompanionSettings {
	const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as BookCompanionSettings;
	if (!saved || typeof saved !== "object") return s;
	const data = saved as Record<string, unknown>;
	for (const k of Object.keys(s) as (keyof BookCompanionSettings)[]) {
		const part = data[k];
		if (part && typeof part === "object") Object.assign(s[k], part);
	}
	return s;
}

export class BookCompanionSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: BookCompanionPlugin) {
		super(app, plugin);
	}

	/** iPhone/iPad: answers come back from an Apple Shortcut that uses the person's Claude or ChatGPT app. */
	private shortcutSettings(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		new Setting(containerEl)
			.setName("Use a Shortcut on iPhone and iPad")
			.setDesc("Questions run through an Apple Shortcut that asks your Claude or ChatGPT app, and the answer comes back to the reader by itself. No API key: your subscription is used. If the Shortcut fails, the chat app buttons appear as before.")
			.addToggle((t) => t.setValue(s.ai.iosShortcut).onChange(async (v) => { s.ai.iosShortcut = v; await save(); this.display(); }));
		if (!s.ai.iosShortcut) return;
		new Setting(containerEl)
			.setName("Shortcut name")
			.setDesc("Exactly as it's called in the Shortcuts app.")
			.addText((t) => t.setPlaceholder("Book Companion AI").setValue(s.ai.shortcutName).onChange(async (v) => { s.ai.shortcutName = v.trim(); await save(); }));
		const steps = containerEl.createDiv({ cls: "setting-item-description bcr-shortcut-steps" });
		steps.createEl("p", { text: "Make the Shortcut once in the Shortcuts app on your iPhone or iPad:" });
		const ol = steps.createEl("ol");
		ol.createEl("li", { text: "New Shortcut, named as above. In its details, turn on \"Receive input\" for Text (from \"Nowhere\" is fine)." });
		ol.createEl("li", { text: "Claude: add \"Ask Claude\" (from the Claude app) with Shortcut Input as the prompt. ChatGPT: add \"Use Model\" (iOS 26), pick ChatGPT, with Shortcut Input as the request." });
		ol.createEl("li", { text: "Add \"Stop and Output\" with the AI's response. If no answer comes back, also add \"Copy to Clipboard\" before it." });
		ol.createEl("li", { text: "Press Test below on your iPhone or iPad. The Shortcuts app opens, runs, and returns to Obsidian." });
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("AI helper").setHeading();
		const pd = PROVIDER_DEFAULTS[s.ai.provider];
		new Setting(containerEl)
			.setName("AI service")
			.setDesc(pd.help ?? "Who answers your questions. Subscriptions you already pay for work without an API key.")
			.addDropdown((d) => {
				for (const [k, v] of Object.entries(PROVIDER_DEFAULTS)) d.addOption(k, v.label);
				d.setValue(s.ai.provider).onChange(async (v) => {
					const p = v as Provider;
					s.ai.provider = p;
					s.ai.baseUrl = PROVIDER_DEFAULTS[p].baseUrl;
					s.ai.model = PROVIDER_DEFAULTS[p].model;
					await save();
					this.display();
				});
			});
		if (pd.kind === "cli") {
			new Setting(containerEl)
				.setName("Model (optional)")
				.setDesc("Leave empty for your subscription's default, or type one such as sonnet or opus.")
				.addText((t) => t.setValue(s.ai.model).onChange(async (v) => { s.ai.model = v.trim(); await save(); }));
			new Setting(containerEl)
				.setName("App location (optional)")
				.setDesc("Only if it isn't found by itself: the full path to the app's command line.")
				.addText((t) => t.setPlaceholder("/opt/homebrew/bin/claude").setValue(s.ai.cliPath).onChange(async (v) => { s.ai.cliPath = v.trim(); await save(); }));
		}
		new Setting(containerEl)
			.setName("Chat app for phones")
			.setDesc("Where questions go when your subscription can't be reached from this device.")
			.addDropdown((d) => d.addOption("claude", "Claude").addOption("chatgpt", "ChatGPT").addOption("gemini", "Gemini")
				.setValue(s.ai.chatApp).onChange(async (v) => { s.ai.chatApp = v as typeof s.ai.chatApp; await save(); }));
		if (pd.kind !== "api") this.shortcutSettings(containerEl);
		if (pd.kind === "api") {
		new Setting(containerEl)
			.setName("API key")
			.setDesc("Saved in this vault's plugin settings in plain text. Leave empty for Ollama.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("sk-…").setValue(s.ai.apiKey).onChange(async (v) => {
					s.ai.apiKey = v.trim();
					await save();
				});
			});
		new Setting(containerEl)
			.setName("Model")
			.setDesc("Any model name your service offers.")
			.addText((t) => t.setValue(s.ai.model).onChange(async (v) => { s.ai.model = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("Service address")
			.setDesc("Change only for a self-hosted or compatible service.")
			.addText((t) => t.setValue(s.ai.baseUrl).onChange(async (v) => { s.ai.baseUrl = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("Creativity")
			.setDesc("Lower is more precise.")
			.addSlider((sl) => sl.setLimits(0, 1, 0.1).setValue(s.ai.temperature).onChange(async (v) => { s.ai.temperature = v; await save(); }));
		}
		new Setting(containerEl)
			.setName("Test the connection")
			.addButton((b) => b.setButtonText("Test").onClick(() => this.plugin.testAi()));

		new Setting(containerEl).setName("Language learning").setHeading();
		new Setting(containerEl)
			.setName("My native language")
			.addText((t) => t.setValue(s.learner.nativeLanguage).onChange(async (v) => { s.learner.nativeLanguage = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("Language I'm learning")
			.setDesc("Your main language. Books in other languages you add below use their own level.")
			.addText((t) => t.setValue(s.learner.learningLanguage).onChange(async (v) => { s.learner.learningLanguage = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("My level")
			.setDesc("A1 beginner … C2 near-native. Simplified text and word lists are written for this level.")
			.addDropdown((d) => {
				for (const [k, v] of Object.entries(LEVEL_LABELS)) d.addOption(k, v);
				d.setValue(s.learner.level).onChange(async (v) => { s.learner.level = v as Level; await save(); });
			});
		s.learner.otherLanguages ??= [];
		s.learner.otherLanguages.forEach((p, i) => {
			new Setting(containerEl)
				.setName(`Another language${s.learner.otherLanguages.length > 1 ? ` ${i + 1}` : ""}`)
				.setDesc(i === 0 ? "A book's language is read from the book (EPUB), or you pick it in the reader's panel." : "")
				.addText((t) => t.setPlaceholder("German").setValue(p.language).onChange(async (v) => { p.language = v.trim(); await save(); }))
				.addDropdown((d) => {
					for (const [k, v] of Object.entries(LEVEL_LABELS)) d.addOption(k, v);
					d.setValue(p.level).onChange(async (v) => { p.level = v as Level; await save(); });
				})
				.addButton((b) => b.setButtonText("Remove").onClick(async () => { s.learner.otherLanguages.splice(i, 1); await save(); this.display(); }));
		});
		new Setting(containerEl)
			.setName("Add a language")
			.setDesc("Learning more than one language? Give each its own level, such as German B1 next to English C1.")
			.addButton((b) => b.setButtonText("Add language").onClick(async () => { s.learner.otherLanguages.push({ language: "", level: "A2" }); await save(); this.display(); }));
		new Setting(containerEl)
			.setName("Explain in")
			.setDesc("Write explanations in my native language, or in simple words of the language I'm learning (more practice).")
			.addDropdown((d) => d.addOption("learning", "Simple words of the language I'm learning").addOption("native", "My native language")
				.setValue(s.learner.explainIn).onChange(async (v) => { s.learner.explainIn = v as typeof s.learner.explainIn; await save(); }));
		new Setting(containerEl)
			.setName("Anything else the AI should know")
			.setDesc("For example: \"I study biology\" or \"keep answers short\".")
			.addTextArea((t) => t.setValue(s.learner.extraInstructions).onChange(async (v) => { s.learner.extraInstructions = v; await save(); }));

		new Setting(containerEl).setName("Flashcards").setHeading();
		new Setting(containerEl)
			.setName("Cards per study session")
			.setDesc("Words you save from a book become flashcards in that book's deck. Make topic decks in the Flashcards view to group words your own way.")
			.addSlider((sl) => sl.setLimits(5, 100, 5).setValue(s.cards.sessionSize).onChange(async (v) => { s.cards.sessionSize = v; await save(); }));

		new Setting(containerEl).setName("Library").setHeading();
		new Setting(containerEl)
			.setName("Books to read this year")
			.setDesc("Your reading goal. Leave 0 for none. Progress shows in the library and on the library pages.")
			.addText((t) => t.setValue(String(s.library.yearlyGoal)).onChange(async (v) => { s.library.yearlyGoal = Math.max(0, parseInt(v, 10) || 0); await save(); }));
		new Setting(containerEl)
			.setName("Suggestions at a time")
			.setDesc("How many books the librarian cat suggests when you ask.")
			.addSlider((sl) => sl.setLimits(3, 10, 1).setValue(s.library.suggestionCount).onChange(async (v) => { s.library.suggestionCount = v; await save(); }));
		new Setting(containerEl)
			.setName("Library pages")
			.setDesc("Creates Currently reading, Up next, Wishlist, Suggested reading, Finished and Reading log pages in the Library folder inside your books folder. Existing pages are never changed.")
			.addButton((b) => b.setButtonText("Create pages").onClick(() => void this.plugin.openLibraryPages()));

		new Setting(containerEl).setName("Notes in your vault").setHeading();
		new Setting(containerEl)
			.setName("Books folder")
			.setDesc("Each book gets its own folder here with a book page, notes, vocabulary and handwriting.")
			.addText((t) => t.setValue(s.notes.rootFolder).onChange(async (v) => { s.notes.rootFolder = v.trim() || "Books"; await save(); }));
		new Setting(containerEl)
			.setName("Add highlights to the book page")
			.addToggle((t) => t.setValue(s.notes.highlightsToBookPage).onChange(async (v) => { s.notes.highlightsToBookPage = v; await save(); }));
		new Setting(containerEl)
			.setName("Flashcard tag")
			.setDesc("Vocabulary notes get this tag so flashcard plugins (like Spaced Repetition) pick them up.")
			.addText((t) => t.setValue(s.notes.flashcardTag).onChange(async (v) => { s.notes.flashcardTag = v.trim().replace(/^#/, ""); await save(); }));

		new Setting(containerEl).setName("Typed Graph").setHeading();
		const tgOn = this.plugin.typedGraphEnabled();
		new Setting(containerEl)
			.setName("Typed notes")
			.setDesc(`Give book pages, notes, AI explanations, handwriting and vocabulary Typed Graph types (Book, Quote, ReadingNote…) and typed links, so you can query your reading with openCypher and see it in the graph view. Typed Graph is ${tgOn ? "on in this vault" : "not on in this vault"}.`)
			.addDropdown((d) => d.addOption("auto", "When Typed Graph is on").addOption("on", "Always").addOption("off", "Never")
				.setValue(s.notes.typedNotes).onChange(async (v) => { s.notes.typedNotes = v as typeof s.notes.typedNotes; await save(); }));
		new Setting(containerEl)
			.setName("Schema folder")
			.setDesc("Leave empty to use Typed Graph's own schema folder.")
			.addText((t) => t.setPlaceholder("Types").setValue(s.notes.schemaFolder).onChange(async (v) => { s.notes.schemaFolder = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("Add the book types to the schema")
			.setDesc("Writes the reader's types, and Typed Graph's library ontology if your vault has no Book type yet. Happens by itself with the first book page.")
			.addButton((b) => b.setButtonText("Add types").onClick(() => void this.plugin.installTypedSchema()));

		new Setting(containerEl).setName("Reading").setHeading();
		new Setting(containerEl)
			.setName("Open PDFs in this reader")
			.setDesc("Replace Obsidian's own PDF viewer. When off, use \"Open in Book Reader\" from a PDF's menu.")
			.addToggle((t) => t.setValue(s.reader.openPdfInReader).onChange(async (v) => { s.reader.openPdfInReader = v; await save(); this.plugin.applyPdfOverride(); }));
		new Setting(containerEl)
			.setName("EPUB layout")
			.addDropdown((d) => d.addOption("paged", "Turn pages (like an e-reader)").addOption("scroll", "Scroll")
				.setValue(s.reader.epubLayout).onChange(async (v) => { s.reader.epubLayout = v as typeof s.reader.epubLayout; await save(); this.plugin.refreshReaders(); }));
		new Setting(containerEl)
			.setName("Text size")
			.addSlider((sl) => sl.setLimits(12, 32, 1).setValue(s.reader.fontSize).onChange(async (v) => { s.reader.fontSize = v; await save(); this.plugin.refreshReaders(); }));
		new Setting(containerEl)
			.setName("Font")
			.addDropdown((d) => d.addOption("serif", "Book (serif)").addOption("sans", "Clean (sans-serif)").addOption("theme", "Same as Obsidian")
				.setValue(s.reader.fontFamily).onChange(async (v) => { s.reader.fontFamily = v as typeof s.reader.fontFamily; await save(); this.plugin.refreshReaders(); }));
		new Setting(containerEl)
			.setName("Paper")
			.addDropdown((d) => d.addOption("theme", "Same as Obsidian").addOption("sepia", "Sepia").addOption("light", "Light").addOption("dark", "Dark")
				.setValue(s.reader.paper).onChange(async (v) => { s.reader.paper = v as typeof s.reader.paper; await save(); this.plugin.refreshReaders(); }));

		new Setting(containerEl).setName("Handwriting").setHeading();
		new Setting(containerEl)
			.setName("Draw with a pen only")
			.setDesc("Ignore fingers and palms while drawing (for Apple Pencil, S Pen and other styluses).")
			.addToggle((t) => t.setValue(s.ink.penOnly).onChange(async (v) => { s.ink.penOnly = v; await save(); }));
		new Setting(containerEl)
			.setName("Pen colour")
			.addColorPicker((c) => c.setValue(s.ink.penColor).onChange(async (v) => { s.ink.penColor = v; await save(); }));
		new Setting(containerEl)
			.setName("Paper for handwritten notes")
			.addDropdown((d) => d.addOption("lined", "Lined").addOption("dotted", "Dotted").addOption("blank", "Blank")
				.setValue(s.ink.paperStyle).onChange(async (v) => { s.ink.paperStyle = v as typeof s.ink.paperStyle; await save(); }));
	}
}
