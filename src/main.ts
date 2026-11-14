import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, addIcon, loadPdfJs, normalizePath, requestUrl } from "obsidian";
import { LOGO_ICON_ID, LOGO_ICON_SVG } from "./logo";
import { DEFAULT_SCHEMA_FOLDER, TYPED_GRAPH_GRAPH_COMMAND, TYPED_GRAPH_ID, TypedState } from "./typed";
import { AiClient, ApiJson, ChatMessage, HandoffNeeded } from "./ai";
import { desktopCliAvailable, runCli } from "./cliRunner";
import { svgToStrokes } from "./ink";
import { DeckStore } from "./decks";
import { DecksView, StudyModal, VIEW_TYPE_DECKS } from "./decksView";
import { LibraryView, VIEW_TYPE_LIBRARY } from "./libraryView";
import { HandwritingModal } from "./modals";
import { BookNotes, NotesHost } from "./notes";
import { ReaderHost, ReaderView, VIEW_TYPE_READER } from "./readerView";
import { BookCompanionSettingTab, BookCompanionSettings, mergeSettings } from "./settings";
import { BookStore } from "./store";
import { BookMeta, Loc, formatOf, locFromString } from "./types";
import type { PdfJs } from "./pdfRenderer";

/** The parts of Obsidian's app object that aren't in its public types and that we use carefully (all optional). */
interface AppInternals {
	plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, { settings?: { schemaFolder?: string } } | undefined> };
	commands?: { executeCommandById(id: string): boolean };
	viewRegistry?: { unregisterExtensions(ext: string[]): void; registerExtensions(ext: string[], viewType: string): void };
}
const internals = (app: object) => app as AppInternals;

export default class BookCompanionPlugin extends Plugin implements ReaderHost {
	settings!: BookCompanionSettings;
	store!: BookStore;
	decks!: DeckStore;
	notes!: BookNotes;
	ai!: AiClient;
	private pdfOverridden = false;

	async onload() {
		const raw = ((await this.loadData()) ?? {}) as { settings?: unknown; books?: unknown; decks?: unknown };
		this.settings = mergeSettings(raw.settings);
		this.store = new BookStore(() => this.persist());
		this.store.load(raw.books);
		this.decks = new DeckStore(() => this.persist());
		this.decks.load(raw.decks);
		if (this.decks.importLegacy(this.store.books)) this.store.saveSoon();
		this.notes = new BookNotes(this.vaultHost(), () => this.settings.notes, () => this.typedState());
		addIcon(LOGO_ICON_ID, LOGO_ICON_SVG);
		this.ai = new AiClient(() => this.settings.ai, async (req) => {
			const r = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
			let json: ApiJson | null = null;
			try { json = r.json as ApiJson; } catch { json = null; }
			return { status: r.status, json, text: r.text };
		}, runCli, () => Platform.isDesktopApp && desktopCliAvailable());

		this.registerView(VIEW_TYPE_READER, (leaf) => {
			const v = new ReaderView(leaf, this);
			v.onSettingsChanged = () => void this.saveSettings();
			return v;
		});
		this.registerView(VIEW_TYPE_LIBRARY, (leaf) => new LibraryView(leaf, this));
		this.registerView(VIEW_TYPE_DECKS, (leaf) => new DecksView(leaf, this));
		try {
			this.registerExtensions(["epub"], VIEW_TYPE_READER);
		} catch (e) {
			console.warn("Book Companion: another plugin already opens .epub files; use \"Open in Book Reader\" from the file menu.", e);
		}

		this.addSettingTab(new BookCompanionSettingTab(this.app, this));
		this.addRibbonIcon(LOGO_ICON_ID, "Book library", () => void this.openLibrary());
		this.addRibbonIcon("layers", "Flashcards", () => void this.openDecks());

		this.registerObsidianProtocolHandler("book-reader", (params) => {
			const f = this.app.vault.getAbstractFileByPath(decodeURIComponent(params.file ?? ""));
			if (f instanceof TFile) void this.openBook(f, locFromString(params.loc));
			else new Notice("That book isn't in this vault any more.");
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile)) return;
			if (formatOf(file.extension)) {
				menu.addItem((i) => i.setTitle("Open in Book Reader").setIcon("book-open").onClick(() => void this.openBook(file)));
				menu.addItem((i) => i.setTitle("Open book page").setIcon("book-marked").onClick(() => void this.openHubFor(file)));
			} else if (file.extension === "svg") {
				menu.addItem((i) => i.setTitle("Edit handwriting").setIcon("pen-tool").onClick(() => void this.editHandwriting(file)));
			}
		}));

		this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile && formatOf(file.extension)) {
				this.store.rename(oldPath, file.path);
				this.decks.renameBook(oldPath, file.path);
			}
		}));

		this.addCommands();
		this.app.workspace.onLayoutReady(() => this.applyPdfOverride());
	}

	onunload() {
		void this.store.flush();
		void this.decks.flush();
		this.restorePdf();
	}

	// ---------- data ----------

	async persist() {
		await this.saveData({ settings: this.settings, books: this.store.books, decks: this.decks.toJSON() });
	}

	async saveSettings() {
		await this.persist();
	}

	private vaultHost(): NotesHost {
		const vault = this.app.vault;
		return {
			exists: (p) => !!vault.getAbstractFileByPath(normalizePath(p)),
			read: async (p) => {
				const f = vault.getAbstractFileByPath(normalizePath(p));
				return f instanceof TFile ? vault.read(f) : "";
			},
			write: async (p, content) => {
				const path = normalizePath(p);
				const f = vault.getAbstractFileByPath(path);
				if (f instanceof TFile) await vault.process(f, () => content);
				else await vault.create(path, content);
			},
			list: (p) => {
				const folder = vault.getAbstractFileByPath(normalizePath(p));
				if (!(folder instanceof TFolder)) return [];
				return folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md").map((c) => c.path);
			},
			ensureFolder: async (p) => {
				const parts = normalizePath(p).split("/");
				let cur = "";
				for (const part of parts) {
					cur = cur ? `${cur}/${part}` : part;
					if (!vault.getAbstractFileByPath(cur)) {
						try { await vault.createFolder(cur); } catch { /* created meanwhile */ }
					}
				}
			},
		};
	}

	// ---------- Typed Graph pairing ----------

	typedGraphEnabled(): boolean {
		return !!internals(this.app).plugins?.enabledPlugins?.has(TYPED_GRAPH_ID);
	}

	typedState(): TypedState {
		const mode = this.settings.notes.typedNotes;
		const on = mode === "on" || (mode === "auto" && this.typedGraphEnabled());
		const tgFolder = internals(this.app).plugins?.plugins?.[TYPED_GRAPH_ID]?.settings?.schemaFolder;
		return { on, schemaFolder: this.settings.notes.schemaFolder || tgFolder || DEFAULT_SCHEMA_FOLDER };
	}

	async installTypedSchema() {
		const created = await this.notes.ensureSchema(true);
		new Notice(created.length ? `Added ${created.map((p) => p.split("/").pop()).join(" and ")} to your Typed Graph schema.` : "The book types are already in your Typed Graph schema.");
	}

	/** Open Typed Graph's graph view (it follows the active note, so open the book page first). */
	openTypedGraph(): boolean {
		if (!this.typedGraphEnabled()) {
			new Notice("Install and turn on the Typed Graph plugin to see your reading as a graph.");
			return false;
		}
		return !!internals(this.app).commands?.executeCommandById(TYPED_GRAPH_GRAPH_COMMAND);
	}

	// ---------- ReaderHost ----------

	async askAi(system: string, messages: ChatMessage[]): Promise<string> {
		return this.ai.chat(system, messages);
	}

	loadPdf() {
		return loadPdfJs() as Promise<PdfJs>;
	}

	openNote(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		// beside the book on big screens, in a new tab on phones
		const leaf = Platform.isMobile ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf("split", "vertical");
		void leaf.openFile(f);
	}

	listBookNotes(meta: BookMeta): { path: string; name: string }[] {
		const out: { path: string; name: string }[] = [];
		const base = this.notes.folder(meta);
		for (const sub of ["Notes", "Handwriting"]) {
			const folder = this.app.vault.getAbstractFileByPath(normalizePath(`${base}/${sub}`));
			if (folder instanceof TFolder) {
				for (const c of folder.children) if (c instanceof TFile && c.extension === "md") out.push({ path: c.path, name: c.basename });
			}
		}
		return out.sort((a, b) => b.name.localeCompare(a.name));
	}

	// ---------- opening things ----------

	async openBook(file: TFile, loc?: Loc) {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_READER).find((l) => (l.view as ReaderView).file?.path === file.path);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			if (loc) (existing.view as ReaderView).goto(loc);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE_READER, state: { file: file.path, loc: loc ? (loc.page ? `p${loc.page}` : `c${loc.chapter}@${loc.frac ?? 0}`) : undefined }, active: true });
	}

	async openBookPath(path: string, loc?: Loc) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.openBook(f, loc);
		else new Notice("That book isn't in this vault any more.");
	}

	async openDecks(deckId?: string) {
		let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECKS)[0];
		if (!leaf) {
			leaf = Platform.isMobile ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf("split", "vertical");
			await leaf.setViewState({ type: VIEW_TYPE_DECKS, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const v = leaf.view;
		if (deckId && v instanceof DecksView) v.showDeck(deckId);
	}

	/** A quick study session over everything due, in a window over whatever you're doing. */
	studyDue(deckIds?: string[], title = "Flashcards") {
		const cards = this.decks.dueCards(deckIds, this.settings.cards.sessionSize);
		if (!cards.length) { new Notice("No flashcards are due. Add words while you read."); return; }
		new StudyModal(this.app, this.decks, cards, title, { openBook: (c) => c.bookPath && void this.openBookPath(c.bookPath, c.loc) }).open();
	}

	async openHubFor(file: TFile) {
		const format = formatOf(file.extension);
		if (!format) return;
		const data = this.store.get(file.path, format);
		const meta: BookMeta = { path: file.path, format, title: data.title ?? file.basename, author: data.author };
		const path = await this.notes.ensureHub(meta);
		this.openNote(path);
	}

	async openLibrary() {
		let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE_LIBRARY, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private activeReader(): ReaderView | null {
		return this.app.workspace.getActiveViewOfType(ReaderView);
	}

	async editHandwriting(file: TFile) {
		const svg = await this.app.vault.read(file);
		const data = svgToStrokes(svg);
		if (!data) { new Notice("This picture wasn't made with Book Companion handwriting, so it can't be edited here."); return; }
		new HandwritingModal(this.app, this.settings.ink, `Edit ${file.basename}`, async (newSvg) => {
			await this.app.vault.process(file, () => newSvg);
			new Notice("Handwriting updated");
		}, data).open();
	}

	refreshReaders() {
		for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE_READER)) (l.view as ReaderView).applyReaderSettings();
	}

	/** Optionally make this reader the default for PDFs (Obsidian has no public switch for this). */
	applyPdfOverride() {
		const registry = internals(this.app).viewRegistry;
		if (!registry) return;
		try {
			if (this.settings.reader.openPdfInReader && !this.pdfOverridden) {
				registry.unregisterExtensions(["pdf"]);
				registry.registerExtensions(["pdf"], VIEW_TYPE_READER);
				this.pdfOverridden = true;
			} else if (!this.settings.reader.openPdfInReader && this.pdfOverridden) {
				this.restorePdf();
			}
		} catch (e) {
			console.warn("Book Companion: couldn't change the PDF opener", e);
			new Notice("Couldn't make this the default PDF reader. Use \"Open in Book Reader\" from a PDF's menu instead.");
		}
	}

	private restorePdf() {
		if (!this.pdfOverridden) return;
		const registry = internals(this.app).viewRegistry;
		try {
			registry?.unregisterExtensions(["pdf"]);
			registry?.registerExtensions(["pdf"], "pdf");
		} catch (e) { console.warn(e); }
		this.pdfOverridden = false;
	}

	async testAi() {
		try {
			const a = await this.ai.chat("You are a helpful assistant.", [{ role: "user", content: "Reply with the single word: ready" }]);
			new Notice(`AI helper works: "${a.slice(0, 60)}"`);
		} catch (e) {
			if (e instanceof HandoffNeeded) { new Notice(`${e.reason} Questions will open in your chat app.`, 8000); return; }
			new Notice(e instanceof Error ? e.message : String(e), 8000);
		}
	}

	private addCommands() {
		this.addCommand({ id: "open-library", name: "Open book library", callback: () => void this.openLibrary() });
		this.addCommand({ id: "open-flashcards", name: "Open flashcard decks", callback: () => void this.openDecks() });
		this.addCommand({ id: "study-flashcards", name: "Study flashcards that are due", callback: () => this.studyDue() });
		this.addCommand({
			id: "open-in-reader", name: "Open current PDF or EPUB in Book Reader",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !formatOf(f.extension) || this.activeReader()) return false;
				if (!checking) void this.openBook(f);
				return true;
			},
		});
		const readerCmd = (id: string, name: string, fn: (v: ReaderView) => void) => this.addCommand({
			id, name,
			checkCallback: (checking) => {
				const v = this.activeReader();
				if (!v) return false;
				if (!checking) fn(v);
				return true;
			},
		});
		readerCmd("explain-selection", "Explain selected text", (v) => { const s = v.getSelected(); if (s) void v.runAi("explain", s); else new Notice("Select some text first."); });
		readerCmd("simplify-selection", "Simplify selected text for my level", (v) => { const s = v.getSelected(); if (s) void v.runAi("simplify", s); else new Notice("Select some text first."); });
		readerCmd("define-selection", "Explain selected word", (v) => { const s = v.getSelected(); if (s) void v.runAi("define", s); else new Notice("Select a word first."); });
		readerCmd("flashcard-selection", "Make a flashcard from selected word", (v) => { const s = v.getSelected(); if (s) void v.makeCard(s); else new Notice("Select a word first."); });
		readerCmd("highlight-selection", "Highlight selected text", (v) => { const s = v.getSelected(); if (s) void v.addHighlight(s); });
		readerCmd("note-selection", "New note about selection or this page", (v) => v.writeNote(v.getSelected() ?? undefined));
		readerCmd("handwritten-note", "New handwritten note", (v) => v.handwritingNote(v.getSelected() ?? undefined));
		readerCmd("toggle-ink", "Write on the PDF page", (v) => v.setInkMode(!v.isInking()));
		readerCmd("study-page", "Study this page (hard sentences and words)", (v) => void v.studyPage());
		readerCmd("toggle-panel", "Show or hide the companion panel", (v) => v.togglePanel());
		readerCmd("book-page", "Open this book's page in the vault", (v) => void v.openHub());
		readerCmd("next-page", "Next page", (v) => void v.next());
		readerCmd("prev-page", "Previous page", (v) => void v.prev());
		readerCmd("contents", "Table of contents", (v) => void v.openToc());
		this.addCommand({ id: "add-typed-graph-types", name: "Add book types to the Typed Graph schema", callback: () => void this.installTypedSchema() });
		readerCmd("book-graph", "Show this book in Typed Graph", (v) => void v.openHub().then(() => this.openTypedGraph()));
		this.addCommand({
			id: "edit-handwriting", name: "Edit this handwriting",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "svg") return false;
				if (!checking) void this.editHandwriting(f);
				return true;
			},
		});
	}
}
