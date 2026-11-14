import { FileView, MarkdownRenderer, Menu, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { CHAT_APPS, ChatMessage, HandoffNeeded } from "./ai";
import { EpubBook, parseEpub } from "./epub";
import { EpubRenderer } from "./epubRenderer";
import { wrapText, unwrapMarks } from "./highlight";
import { InkSurface, InkTool } from "./ink";
import { HandwritingModal, NoteModal, QuizModal, TextPromptModal, TocModal, buildInkToolbar } from "./modals";
import type { BookNotes } from "./notes";
import { PdfRenderer, PageSlot } from "./pdfRenderer";
import { ACTION_LABELS, AiAction, buildSystemPrompt, buildUserPrompt, parseVocabulary } from "./prompts";
import type { BookCompanionSettings } from "./settings";
import { HIGHLIGHT_COLORS } from "./settings";
import type { BookStore } from "./store";
import { AiCard, BookData, BookMeta, Loc, formatOf, locFromString, locLabel, locToString, uid } from "./types";

export const VIEW_TYPE_READER = "book-companion-reader";

/** What the reader needs from the plugin (the preview supplies a stand-in). */
export interface ReaderHost {
	settings: BookCompanionSettings;
	store: BookStore;
	notes: BookNotes;
	askAi(system: string, messages: ChatMessage[]): Promise<string>;
	loadPdf(): Promise<any>;
	openNote(path: string): void;
	listBookNotes(meta: BookMeta): { path: string; name: string }[];
	/** Typed Graph pairing (optional). */
	typedGraphEnabled?(): boolean;
	openTypedGraph?(): boolean;
}

interface Selected {
	text: string;
	loc: Loc;
	context: string;
}

type PanelTab = "ai" | "notes" | "words";

export class ReaderView extends FileView {
	allowNoFile = false;
	navigation = true;

	book: BookData | null = null;
	meta: BookMeta | null = null;
	pdf: PdfRenderer | null = null;
	epub: EpubRenderer | null = null;
	epubBook: EpubBook | null = null;

	private pendingLoc: Loc | undefined;
	private rootEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private inkbarEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	stageEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private locLabelEl!: HTMLElement;
	private selToolEl!: HTMLElement;
	panelEl!: HTMLElement;
	private panelBody!: HTMLElement;
	private panelTabs: Record<string, HTMLElement> = {};
	panelTab: PanelTab = "ai";
	panelOpen = false;
	private selected: Selected | null = null;
	private selTimer: any = null;
	private inkMode = false;
	private inkState: { tool: InkTool };
	private surfaces = new Map<number, InkSurface>();
	private lastSurface: InkSurface | null = null;
	private progressTimer: any = null;
	private aiThreads = new Map<string, ChatMessage[]>();
	private swipe: { x: number; y: number; t: number } | null = null;

	constructor(leaf: WorkspaceLeaf, public host: ReaderHost) {
		super(leaf);
		this.inkState = { tool: { tool: "pen", color: host.settings.ink.penColor, widthPx: host.settings.ink.penWidth } };
	}

	getViewType() { return VIEW_TYPE_READER; }
	getIcon() { return "book-open"; }
	getDisplayText() { return this.meta?.title ?? this.file?.basename ?? "Book"; }
	canAcceptExtension(ext: string) { return formatOf(ext) !== null; }

	getState(): any {
		const s: any = super.getState();
		const loc = this.currentLoc();
		if (loc) s.loc = locToString(loc);
		return s;
	}

	async setState(state: any, result: any) {
		if (state?.loc) this.pendingLoc = locFromString(state.loc);
		await super.setState(state, result);
		if (state?.loc && (this.pdf || this.epub)) this.goto(locFromString(state.loc));
	}

	setEphemeralState(state: any) {
		super.setEphemeralState?.(state);
		const loc = typeof state?.loc === "string" ? locFromString(state.loc) : state?.loc;
		if (!loc) return;
		if (this.pdf || this.epub) this.goto(loc);
		else this.pendingLoc = loc;
	}

	// ---------- building the screen ----------

	private buildUi() {
		const c = this.contentEl;
		c.empty();
		c.addClass("bcr-view");
		this.rootEl = c.createDiv({ cls: "bcr-reader" });
		this.rootEl.dataset.paper = this.host.settings.reader.paper;
		if (Platform.isMobile) this.rootEl.addClass("bcr-mobile");
		this.rootEl.tabIndex = 0;

		this.toolbarEl = this.rootEl.createDiv({ cls: "bcr-toolbar" });
		this.inkbarEl = this.rootEl.createDiv({ cls: "bcr-inkbar" });
		this.inkbarEl.hide();
		this.progressEl = this.rootEl.createDiv({ cls: "bcr-progress" }).createDiv({ cls: "bcr-progress-fill" });
		this.bodyEl = this.rootEl.createDiv({ cls: "bcr-body" });
		this.stageEl = this.bodyEl.createDiv({ cls: "bcr-stage" });
		this.panelEl = this.bodyEl.createDiv({ cls: "bcr-panel" });
		this.selToolEl = this.bodyEl.createDiv({ cls: "bcr-seltool" });
		this.selToolEl.hide();
		this.buildToolbar();
		this.buildPanel();
		this.buildSelectionTool();

		this.registerDomEvent(this.rootEl.ownerDocument, "selectionchange", () => this.queueSelectionCheck());
		this.registerDomEvent(this.stageEl, "pointerup", () => this.queueSelectionCheck(60));
		this.registerDomEvent(this.rootEl, "keydown", (e: KeyboardEvent) => this.onKey(e));
		this.registerDomEvent(this.stageEl, "click", (e: MouseEvent) => this.onStageClick(e));
		this.registerDomEvent(this.stageEl, "pointerdown", (e: PointerEvent) => {
			if (e.pointerType === "touch") this.swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
		});
		this.registerDomEvent(this.stageEl, "pointerup", (e: PointerEvent) => this.onSwipeEnd(e));
		this.registerDomEvent(this.stageEl, "scroll", () => this.hideSelectionTool(), { capture: true } as any);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLElement {
		const b = parent.createEl("button", { cls: `bcr-icon-btn clickable-icon ${cls}`, attr: { "aria-label": label, title: label } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
		return b;
	}

	private buildToolbar() {
		const t = this.toolbarEl;
		t.empty();
		const left = t.createDiv({ cls: "bcr-tb-group" });
		this.iconButton(left, "list", "Contents", () => void this.openToc());
		this.iconButton(left, "chevron-left", "Previous page", () => void this.prev());
		this.iconButton(left, "chevron-right", "Next page", () => void this.next());
		this.locLabelEl = t.createDiv({ cls: "bcr-loc-label" });
		this.locLabelEl.addEventListener("click", () => this.askGoto());
		const right = t.createDiv({ cls: "bcr-tb-group" });
		if (this.book?.format === "pdf") {
			this.iconButton(right, "zoom-out", "Smaller", () => this.pdf?.setZoom(this.pdf.zoom / 1.15));
			this.iconButton(right, "zoom-in", "Bigger", () => this.pdf?.setZoom(this.pdf.zoom * 1.15));
			this.iconButton(right, "pencil", "Write on the page", () => this.setInkMode(!this.inkMode), "bcr-ink-toggle");
		} else {
			this.iconButton(right, "type", "Text and layout", (e) => this.textMenu(e));
		}
		this.iconButton(right, "notebook-pen", "Handwritten note", () => this.handwritingNote());
		this.iconButton(right, "graduation-cap", "Study this page", () => void this.studyPage());
		this.iconButton(right, "book-marked", "Book page in your vault", () => void this.openHub());
		this.iconButton(right, "panel-right", "Companion panel", () => this.togglePanel());
	}

	private textMenu(e: MouseEvent) {
		const r = this.host.settings.reader;
		const m = new Menu();
		m.addItem((i) => i.setTitle("Larger text").setIcon("a-large-small").onClick(() => this.changeText(+1)));
		m.addItem((i) => i.setTitle("Smaller text").setIcon("a-large-small").onClick(() => this.changeText(-1)));
		m.addSeparator();
		m.addItem((i) => i.setTitle("Turn pages").setChecked(r.epubLayout === "paged").onClick(() => this.setLayout("paged")));
		m.addItem((i) => i.setTitle("Scroll").setChecked(r.epubLayout === "scroll").onClick(() => this.setLayout("scroll")));
		m.addSeparator();
		for (const [k, label] of [["theme", "Paper: like Obsidian"], ["sepia", "Paper: sepia"], ["light", "Paper: light"], ["dark", "Paper: dark"]] as const) {
			m.addItem((i) => i.setTitle(label).setChecked(r.paper === k).onClick(() => { r.paper = k; this.rootEl.dataset.paper = k; this.onSettingsChanged?.(); }));
		}
		m.showAtMouseEvent(e);
	}

	/** Set by the plugin so text changes made in the reader are saved to settings. */
	onSettingsChanged?: () => void;

	private changeText(delta: number) {
		const r = this.host.settings.reader;
		r.fontSize = Math.max(12, Math.min(34, r.fontSize + delta * 2));
		this.applyReaderSettings();
		this.onSettingsChanged?.();
	}

	private setLayout(l: "paged" | "scroll") {
		this.host.settings.reader.epubLayout = l;
		this.applyReaderSettings();
		this.onSettingsChanged?.();
	}

	applyReaderSettings() {
		const r = this.host.settings.reader;
		if (this.rootEl) this.rootEl.dataset.paper = r.paper;
		this.epub?.applyOptions({ layout: r.epubLayout, fontSize: r.fontSize, lineHeight: r.lineHeight, fontFamily: r.fontFamily });
		if (this.epub) this.applyHighlights(this.epub.content, `c${this.epub.chapter}`);
	}

	// ---------- loading ----------

	async onLoadFile(file: TFile) {
		const format = formatOf(file.extension);
		if (!format) return;
		this.book = this.host.store.get(file.path, format);
		this.book.lastOpened = Date.now();
		this.meta = { path: file.path, format, title: this.book.title ?? file.basename, author: this.book.author };
		this.buildUi();
		this.setLocLabel("Opening…");
		try {
			const data = await this.app.vault.readBinary(file);
			if (format === "pdf") await this.openPdf(data);
			else await this.openEpub(data);
		} catch (e: any) {
			console.error(e);
			this.stageEl.empty();
			this.stageEl.createDiv({ cls: "bcr-error", text: `Couldn't open this book: ${e?.message ?? e}` });
			return;
		}
		this.renderPanel();
		this.host.store.saveSoon();
		(this.leaf as any).updateHeader?.();
	}

	/** Open a book straight from its bytes (used by the preview and self-test). */
	async openData(path: string, format: "pdf" | "epub", data: ArrayBuffer) {
		this.book = this.host.store.get(path, format);
		this.meta = { path, format, title: this.book.title ?? path.split("/").pop()!.replace(/\.\w+$/, ""), author: this.book.author };
		this.buildUi();
		if (format === "pdf") await this.openPdf(data);
		else await this.openEpub(data);
		this.renderPanel();
	}

	private async openPdf(data: ArrayBuffer) {
		const pdfjs = await this.host.loadPdf();
		this.pdf = new PdfRenderer(this.stageEl, pdfjs, {
			onLocation: (loc, p, label) => this.onLocation(loc, p, label),
			onPageRendered: (slot) => this.onPageRendered(slot),
			onPageReleased: (slot) => { this.surfaces.get(slot.num)?.destroy(); this.surfaces.delete(slot.num); },
		});
		await this.pdf.open(data);
		const md = await this.pdf.metadata();
		if (md.title && md.title.length > 2 && !/^untitled|microsoft word/i.test(md.title)) this.setMeta(md.title, md.author);
		this.goto(this.pendingLoc ?? this.book!.loc ?? { page: 1 });
		this.pendingLoc = undefined;
	}

	private async openEpub(data: ArrayBuffer) {
		const parser = new DOMParser();
		this.epubBook = parseEpub(data, parser);
		this.setMeta(this.epubBook.title, this.epubBook.author);
		const r = this.host.settings.reader;
		this.epub = new EpubRenderer(this.stageEl, this.epubBook, parser, { layout: r.epubLayout, fontSize: r.fontSize, lineHeight: r.lineHeight, fontFamily: r.fontFamily }, {
			onLocation: (loc, p, label) => this.onLocation(loc, p, label),
			onRendered: (root, key) => this.applyHighlights(root, key),
		});
		await this.epub.show(this.pendingLoc ?? this.book!.loc);
		this.pendingLoc = undefined;
	}

	private setMeta(title?: string, author?: string) {
		if (!this.book || !this.meta) return;
		if (title) { this.book.title = title; this.meta.title = title; }
		if (author) { this.book.author = author; this.meta.author = author; }
		(this.leaf as any).updateHeader?.();
	}

	async onUnloadFile(_file: TFile) {
		this.saveLoc();
		this.pdf?.destroy();
		this.epub?.destroy();
		this.pdf = null;
		this.epub = null;
		this.epubBook = null;
		this.surfaces.clear();
		this.contentEl.empty();
		await this.host.store.flush();
	}

	async onClose() {
		this.pdf?.destroy();
		this.epub?.destroy();
	}

	// ---------- moving through the book ----------

	currentLoc(): Loc | undefined {
		if (this.pdf) return { page: this.pdf.current };
		if (this.epub) return this.epub.getLoc();
		return this.book?.loc;
	}

	goto(loc: Loc | undefined) {
		if (!loc) return;
		if (this.pdf && loc.page) this.pdf.goto(loc.page);
		else if (this.epub && loc.chapter != null) {
			if (loc.chapter === this.epub.chapter) this.epub.relayout(loc.frac ?? 0);
			else void this.epub.showChapter(loc.chapter, loc.frac ?? 0);
		}
	}

	async next() { this.hideSelectionTool(); if (this.pdf) this.pdf.next(); else await this.epub?.next(); }
	async prev() { this.hideSelectionTool(); if (this.pdf) this.pdf.prev(); else await this.epub?.prev(); }

	private setLocLabel(s: string) { if (this.locLabelEl) this.locLabelEl.setText(s); }

	private onLocation(loc: Loc, progress: number, label: string) {
		if (!this.book) return;
		this.book.loc = loc;
		this.book.progress = progress;
		this.setLocLabel(label);
		if (this.progressEl) this.progressEl.style.width = `${Math.round(progress * 100)}%`;
		this.host.store.saveSoon(1500);
		if (this.progressTimer) clearTimeout(this.progressTimer);
		this.progressTimer = setTimeout(() => { if (this.meta) void this.host.notes.updateProgress(this.meta, progress).catch(() => {}); }, 8000);
	}

	private saveLoc() {
		const loc = this.currentLoc();
		if (this.book && loc) { this.book.loc = loc; this.host.store.saveSoon(); }
	}

	private onKey(e: KeyboardEvent) {
		if ((e.target as HTMLElement).closest("input, textarea, .bcr-panel")) return;
		if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); void this.next(); }
		else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); void this.prev(); }
	}

	private hasSelection(): boolean {
		const s = this.rootEl.ownerDocument.getSelection?.();
		return !!s && !s.isCollapsed && !!s.toString().trim();
	}

	private onStageClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		const mark = target.closest?.("mark.bcr-hl") as HTMLElement | null;
		if (mark) { this.highlightMenu(mark, e); return; }
		if (!this.epub || this.host.settings.reader.epubLayout !== "paged" || this.hasSelection()) return;
		if (target.closest("a, button, img")) return;
		const r = this.stageEl.getBoundingClientRect();
		const x = (e.clientX - r.left) / r.width;
		if (x < 0.22) void this.prev();
		else if (x > 0.78) void this.next();
	}

	private onSwipeEnd(e: PointerEvent) {
		const s = this.swipe;
		this.swipe = null;
		if (!s || e.pointerType !== "touch" || this.inkMode || !this.epub || this.host.settings.reader.epubLayout !== "paged") return;
		const dx = e.clientX - s.x, dy = e.clientY - s.y;
		if (Date.now() - s.t < 600 && Math.abs(dx) > 60 && Math.abs(dy) < 60 && !this.hasSelection()) {
			if (dx < 0) void this.next(); else void this.prev();
		}
	}

	private askGoto() {
		if (this.pdf) {
			new TextPromptModal(this.app, "Go to page", `1 – ${this.pdf.numPages}`, (v) => { const n = parseInt(v, 10); if (n) this.pdf!.goto(n); }).open();
		} else void this.openToc();
	}

	async openToc() {
		if (this.epub && this.epubBook) {
			const entries = this.epubBook.toc.length
				? this.epubBook.toc.map((t) => ({ title: t.title, depth: t.depth, go: () => void this.epub!.showChapter(t.chapter, 0, t.fragment) }))
				: this.epubBook.chapters.map((c, i) => ({ title: c.title, depth: 0, go: () => void this.epub!.showChapter(i) }));
			new TocModal(this.app, entries).open();
		} else if (this.pdf) {
			const outline = await this.pdf.outline();
			if (!outline.length) { this.askGoto(); return; }
			new TocModal(this.app, outline.map((o) => ({ title: `${o.title}  ·  p. ${o.page}`, depth: o.depth, go: () => this.pdf!.goto(o.page) }))).open();
		}
	}

	// ---------- highlights ----------

	applyHighlights(root: HTMLElement, key: string) {
		if (!this.book) return;
		unwrapMarks(root, "mark.bcr-hl");
		for (const h of this.book.highlights) {
			const hk = h.loc.page != null ? `p${h.loc.page}` : `c${h.loc.chapter}`;
			if (hk !== key) continue;
			wrapText(root, h.text, (doc) => {
				const m = doc.createElement("mark");
				m.className = "bcr-hl";
				m.dataset.id = h.id;
				m.style.setProperty("--bcr-hl", HIGHLIGHT_COLORS[h.color] ?? h.color);
				return m;
			});
		}
	}

	private refreshHighlights(loc: Loc) {
		if (this.epub && loc.chapter === this.epub.chapter) this.applyHighlights(this.epub.content, `c${loc.chapter}`);
		if (this.pdf && loc.page) {
			const slot = this.pdf.slots[loc.page - 1];
			if (slot?.textLayer) this.applyHighlights(slot.textLayer, `p${loc.page}`);
		}
	}

	async addHighlight(sel: Selected, color = this.host.settings.reader.defaultHighlight) {
		if (!this.book || !this.meta) return null;
		const h = { id: uid("hl-"), loc: sel.loc, text: sel.text, color, created: Date.now() };
		this.book.highlights.push(h);
		this.host.store.saveSoon();
		this.refreshHighlights(sel.loc);
		this.clearSelection();
		try { await this.host.notes.addHighlight(this.meta, h); } catch (e) { console.warn(e); }
		if (this.panelTab === "notes") this.renderPanel();
		return h;
	}

	private highlightMenu(mark: HTMLElement, e: MouseEvent) {
		const h = this.book?.highlights.find((x) => x.id === mark.dataset.id);
		if (!h || !this.meta) return;
		const sel: Selected = { text: h.text, loc: h.loc, context: "" };
		const m = new Menu();
		m.addItem((i) => i.setTitle("Explain").setIcon("sparkles").onClick(() => void this.runAi("explain", sel)));
		m.addItem((i) => i.setTitle("Simplify for my level").setIcon("graduation-cap").onClick(() => void this.runAi("simplify", sel)));
		m.addItem((i) => i.setTitle("Add a note").setIcon("sticky-note").onClick(() => this.writeNote(sel)));
		m.addSeparator();
		for (const c of Object.keys(HIGHLIGHT_COLORS)) {
			m.addItem((i) => i.setTitle(`Colour: ${c}`).setChecked(h.color === c).onClick(() => { h.color = c; this.host.store.saveSoon(); this.refreshHighlights(h.loc); }));
		}
		m.addSeparator();
		m.addItem((i) => i.setTitle("Remove highlight").setIcon("trash-2").onClick(() => void this.removeHighlight(h.id)));
		m.showAtMouseEvent(e);
	}

	async removeHighlight(id: string) {
		if (!this.book || !this.meta) return;
		const h = this.book.highlights.find((x) => x.id === id);
		if (!h) return;
		this.book.highlights = this.book.highlights.filter((x) => x.id !== id);
		this.host.store.saveSoon();
		this.refreshHighlights(h.loc);
		await this.host.notes.removeHighlight(this.meta, h).catch(() => {});
		this.renderPanel();
	}

	// ---------- selection toolbar ----------

	private buildSelectionTool() {
		const t = this.selToolEl;
		t.empty();
		// keep the text selected while pressing toolbar buttons (desktop)
		t.addEventListener("mousedown", (e) => e.preventDefault());
		const btn = (icon: string, label: string, fn: () => void, cls = "") => {
			const b = t.createEl("button", { cls: `bcr-sel-btn ${cls}`, attr: { "aria-label": label } });
			setIcon(b.createSpan({ cls: "bcr-sel-icon" }), icon);
			b.createSpan({ cls: "bcr-sel-label", text: label });
			b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
			return b;
		};
		btn("sparkles", "Explain", () => this.withSel((s) => this.runAi("explain", s)), "is-primary");
		btn("graduation-cap", "Simplify", () => this.withSel((s) => this.runAi("simplify", s)));
		btn("book-a", "Word", () => this.withSel((s) => this.runAi("define", s)), "bcr-word-btn");
		btn("languages", "Translate", () => this.withSel((s) => this.runAi("translate", s)));
		btn("message-circle-question", "Ask", () => this.withSel((s) => this.askAbout(s)));
		const colors = t.createDiv({ cls: "bcr-sel-colors" });
		for (const [name, hex] of Object.entries(HIGHLIGHT_COLORS)) {
			const sw = colors.createEl("button", { cls: "bcr-swatch", attr: { "aria-label": `Highlight ${name}` } });
			sw.style.background = hex;
			sw.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.withSel((s) => this.addHighlight(s, name)); });
		}
		btn("sticky-note", "Note", () => this.withSel((s) => this.writeNote(s)));
		btn("notebook-pen", "Handwrite", () => this.withSel((s) => this.handwritingNote(s)));
		btn("copy", "Copy", () => this.withSel((s) => { void navigator.clipboard?.writeText(s.text); new Notice("Copied"); }));
	}

	private withSel(fn: (s: Selected) => unknown) {
		const s = this.selected;
		this.hideSelectionTool();
		if (s) void fn(s);
	}

	private queueSelectionCheck(ms = 220) {
		if (this.selTimer) clearTimeout(this.selTimer);
		this.selTimer = setTimeout(() => this.checkSelection(), ms);
	}

	private checkSelection() {
		if (!this.rootEl || this.inkMode) return;
		const sel = this.rootEl.ownerDocument.getSelection?.();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) { this.hideSelectionTool(); return; }
		const range = sel.getRangeAt(0);
		const anchor = range.commonAncestorContainer;
		const el = (anchor.nodeType === 1 ? anchor : anchor.parentElement) as HTMLElement | null;
		if (!el || !this.stageEl.contains(el) || !el.closest(".bcr-selectable")) { this.hideSelectionTool(); return; }
		const text = sel.toString().replace(/\s+/g, " ").trim();
		if (!text) { this.hideSelectionTool(); return; }
		this.selected = { text, loc: this.locForElement(el), context: this.contextFor(el, text) };
		this.showSelectionTool(range.getBoundingClientRect(), text);
	}

	private locForElement(el: HTMLElement): Loc {
		const page = el.closest(".bcr-page") as HTMLElement | null;
		if (page) return { page: parseInt(page.dataset.page ?? "1", 10) };
		return this.epub ? this.epub.getLoc() : (this.currentLoc() ?? {});
	}

	private contextFor(el: HTMLElement, text: string): string {
		if (this.pdf) {
			const page = el.closest(".bcr-page") as HTMLElement | null;
			const tl = page?.querySelector(".bcr-textLayer");
			const full = (tl?.textContent ?? "").replace(/\s+/g, " ");
			const at = full.indexOf(text.slice(0, 30));
			return at >= 0 ? full.slice(Math.max(0, at - 900), at + text.length + 900) : full.slice(0, 2000);
		}
		const block = el.closest("p, li, blockquote, dd, td, h1, h2, h3, h4, div") as HTMLElement | null;
		const parts: string[] = [];
		if (block?.previousElementSibling?.textContent) parts.push(block.previousElementSibling.textContent);
		if (block?.textContent) parts.push(block.textContent);
		if (block?.nextElementSibling?.textContent) parts.push(block.nextElementSibling.textContent);
		return parts.join("\n").replace(/[ \t]+/g, " ").slice(0, 2500);
	}

	private showSelectionTool(rect: DOMRect, text: string) {
		const t = this.selToolEl;
		t.show();
		t.toggleClass("is-word", text.split(/\s+/).length <= 4);
		const body = this.bodyEl.getBoundingClientRect();
		const tw = t.offsetWidth || 320, th = t.offsetHeight || 44;
		let left = rect.left + rect.width / 2 - body.left - tw / 2;
		left = Math.max(6, Math.min(body.width - tw - 6, left));
		// phones show their own copy menu above the text, so put ours below
		let top = Platform.isMobile ? rect.bottom - body.top + 12 : rect.top - body.top - th - 10;
		if (top < 4) top = rect.bottom - body.top + 10;
		if (top + th > body.height - 4) top = Math.max(4, rect.top - body.top - th - 10);
		t.style.left = `${left}px`;
		t.style.top = `${top}px`;
	}

	hideSelectionTool() {
		this.selToolEl?.hide();
	}

	private clearSelection() {
		this.rootEl.ownerDocument.getSelection?.()?.removeAllRanges();
		this.hideSelectionTool();
	}

	/** Select text programmatically (used by the self-test and preview). */
	selectText(text: string): boolean {
		const root = this.epub?.content ?? this.stageEl;
		const doc = root.ownerDocument;
		const walker = doc.createTreeWalker(root, 4);
		let n: Node | null;
		while ((n = walker.nextNode())) {
			const i = (n as Text).data.indexOf(text);
			if (i >= 0) {
				const r = doc.createRange();
				r.setStart(n, i);
				r.setEnd(n, i + text.length);
				const s = doc.getSelection?.()!;
				s.removeAllRanges();
				s.addRange(r);
				this.checkSelection();
				return !!this.selected;
			}
		}
		return false;
	}

	getSelected(): Selected | null { return this.selected; }

	// ---------- notes ----------

	writeNote(sel?: Selected) {
		if (!this.meta) return;
		const loc = sel?.loc ?? this.currentLoc();
		new NoteModal(this.app, sel?.text ?? "", `${this.meta.title} · ${locLabel(loc)}`, async (body) => {
			const path = await this.host.notes.createNote(this.meta!, { quote: sel?.text, loc, body });
			if (sel && this.book) {
				const h = { id: uid("hl-"), loc: sel.loc, text: sel.text, color: "blue", created: Date.now(), notePath: path };
				this.book.highlights.push(h);
				this.host.store.saveSoon();
				this.refreshHighlights(sel.loc);
			}
			this.clearSelection();
			new Notice("Note saved and linked to the book");
			this.renderPanel();
		}).open();
	}

	handwritingNote(sel?: Selected) {
		if (!this.meta) return;
		const loc = sel?.loc ?? this.currentLoc();
		new HandwritingModal(this.app, this.host.settings.ink, `Handwritten note · ${locLabel(loc)}`, async (svg) => {
			const r = await this.host.notes.saveHandwriting(this.meta!, svg, loc, sel?.text);
			new Notice("Handwritten note saved to the book's folder");
			if (r.notePath) this.renderPanel();
		}).open();
	}

	async openHub() {
		if (!this.meta) return;
		const path = await this.host.notes.ensureHub(this.meta);
		await this.host.notes.updateProgress(this.meta, this.book?.progress ?? 0).catch(() => {});
		this.host.openNote(path);
	}

	// ---------- handwriting on PDF pages ----------

	private onPageRendered(slot: PageSlot) {
		if (!this.book) return;
		if (slot.textLayer) this.applyHighlights(slot.textLayer, `p${slot.num}`);
		const key = `p${slot.num}`;
		const surface = new InkSurface(slot.el, {
			getTool: () => this.inkState.tool,
			penOnly: () => this.host.settings.ink.penOnly,
			onPan: (dx, dy) => { if (this.pdf) { this.pdf.viewport.scrollTop -= dy; this.pdf.viewport.scrollLeft -= dx; } },
			onChange: (strokes) => {
				if (!this.book) return;
				if (strokes.length) this.book.ink[key] = strokes; else delete this.book.ink[key];
				this.lastSurface = surface;
				this.host.store.saveSoon();
			},
		});
		surface.resize(slot.width, slot.height);
		surface.setStrokes(this.book.ink[key] ?? []);
		surface.setEnabled(this.inkMode);
		this.surfaces.get(slot.num)?.destroy();
		this.surfaces.set(slot.num, surface);
	}

	setInkMode(on: boolean) {
		if (!this.pdf) { this.handwritingNote(); return; }
		this.inkMode = on;
		this.hideSelectionTool();
		this.stageEl.toggleClass("is-inking", on);
		this.toolbarEl.querySelector(".bcr-ink-toggle")?.toggleClass("is-active", on);
		for (const s of this.surfaces.values()) s.setEnabled(on);
		this.inkbarEl.empty();
		if (on) {
			buildInkToolbar(this.inkbarEl, this.inkState, {
				undo: () => this.lastSurface?.undo(),
				redo: () => this.lastSurface?.redo(),
				done: () => this.setInkMode(false),
				doneLabel: "Done writing",
			});
			this.inkbarEl.show();
		} else this.inkbarEl.hide();
	}

	isInking() { return this.inkMode; }

	// ---------- AI ----------

	private bookSystem(): string {
		return buildSystemPrompt(this.host.settings.learner, this.meta?.title, this.meta?.author);
	}

	async runAi(action: AiAction, sel: Selected, question?: string): Promise<AiCard | null> {
		if (!this.book) return null;
		this.clearSelection();
		this.openPanel("ai");
		const card: AiCard = { id: uid("ai-"), action: action === "ask" && question ? question : ACTION_LABELS[action], quote: sel.text, answer: "", loc: sel.loc, created: Date.now() };
		this.book.ai.unshift(card);
		if (this.book.ai.length > 60) this.book.ai.length = 60;
		this.renderPanel(card.id);
		const user = buildUserPrompt({ action, selection: sel.text, context: sel.context, question, bookTitle: this.meta?.title, bookAuthor: this.meta?.author }, this.host.settings.learner);
		const messages: ChatMessage[] = [{ role: "user", content: user }];
		try {
			card.answer = await this.host.askAi(this.bookSystem(), messages);
			messages.push({ role: "assistant", content: card.answer });
			this.aiThreads.set(card.id, messages);
		} catch (e: any) {
			if (e instanceof HandoffNeeded) {
				card.handoff = e.prompt;
				card.handoffReason = e.reason;
			} else {
				card.answer = e?.message ?? String(e);
				card.error = true;
			}
		}
		this.host.store.saveSoon();
		this.renderPanel(card.id);
		return card;
	}

	private askAbout(sel: Selected) {
		new TextPromptModal(this.app, "Ask about this", "What would you like to know?", (q) => void this.runAi("ask", sel, q), true).open();
	}

	async pageText(): Promise<string> {
		if (this.pdf) return this.pdf.pageText(this.pdf.current);
		return this.epub?.visibleText() ?? "";
	}

	async studyPage() {
		const text = (await this.pageText()).trim();
		if (!text) { new Notice("There's no text on this page to study."); return; }
		await this.runAi("study", { text, loc: this.currentLoc() ?? {}, context: "" });
	}

	private async followUp(card: AiCard, q: string) {
		if (!this.book) return;
		const thread = this.aiThreads.get(card.id) ?? [
			{ role: "user" as const, content: `About this passage: """${card.quote}"""` },
			{ role: "assistant" as const, content: card.answer },
		];
		thread.push({ role: "user", content: q });
		card.answer += `\n\n---\n**You:** ${q}\n\n…`;
		this.renderPanel(card.id);
		try {
			const a = await this.host.askAi(this.bookSystem(), thread);
			thread.push({ role: "assistant", content: a });
			card.answer = card.answer.replace(/…$/, a);
		} catch (e: any) {
			if (e instanceof HandoffNeeded) {
				card.answer = card.answer.replace(/\n\n---\n\*\*You:\*\*[\s\S]*…$/, "");
				card.handoff = e.prompt;
				card.handoffReason = e.reason;
			} else card.answer = card.answer.replace(/…$/, `⚠️ ${e?.message ?? e}`);
		}
		this.aiThreads.set(card.id, thread);
		this.host.store.saveSoon();
		this.renderPanel(card.id);
	}

	async saveWords(card: AiCard): Promise<number> {
		if (!this.book || !this.meta) return 0;
		const words = parseVocabulary(card.answer);
		const fresh = words.filter((w) => !this.book!.vocab.some((v) => v.word.toLowerCase() === w.word.toLowerCase()));
		const entries = fresh.map((w) => ({ id: uid("w-"), word: w.word, definition: w.definition, context: card.quote.slice(0, 200), loc: card.loc, created: Date.now(), box: 0 }));
		this.book.vocab.push(...entries);
		this.host.store.saveSoon();
		if (entries.length) await this.host.notes.addVocabulary(this.meta, entries);
		return entries.length;
	}

	// ---------- companion panel ----------

	private buildPanel() {
		const p = this.panelEl;
		p.empty();
		const head = p.createDiv({ cls: "bcr-panel-head" });
		const tabs = head.createDiv({ cls: "bcr-tabs" });
		const mk = (id: PanelTab, icon: string, label: string) => {
			const b = tabs.createEl("button", { cls: "bcr-tab", attr: { "aria-label": label } });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.onclick = () => { this.panelTab = id; this.renderPanel(); };
			this.panelTabs[id] = b;
		};
		mk("ai", "sparkles", "AI");
		mk("notes", "sticky-note", "Notes");
		mk("words", "graduation-cap", "Words");
		const close = head.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "Close panel" } });
		setIcon(close, "x");
		close.onclick = () => this.togglePanel(false);
		this.panelBody = p.createDiv({ cls: "bcr-panel-body" });
		this.togglePanel(this.panelOpen);
	}

	togglePanel(force?: boolean) {
		this.panelOpen = force ?? !this.panelOpen;
		this.rootEl.toggleClass("panel-open", this.panelOpen);
		if (this.panelOpen) this.renderPanel();
		setTimeout(() => { this.epub?.relayout(); }, 260);
	}

	openPanel(tab: PanelTab) {
		this.panelTab = tab;
		if (!this.panelOpen) this.togglePanel(true);
		else this.renderPanel();
	}

	renderPanel(scrollToCard?: string) {
		if (!this.panelBody || !this.book) return;
		for (const [id, b] of Object.entries(this.panelTabs)) b.toggleClass("is-active", id === this.panelTab);
		const body = this.panelBody;
		body.empty();
		if (this.panelTab === "ai") this.renderAiTab(body, scrollToCard);
		else if (this.panelTab === "notes") this.renderNotesTab(body);
		else this.renderWordsTab(body);
	}

	private renderAiTab(body: HTMLElement, scrollTo?: string) {
		const book = this.book!;
		const ask = body.createDiv({ cls: "bcr-ask" });
		const input = ask.createEl("textarea", { cls: "bcr-ask-input", attr: { rows: "2", placeholder: "Ask anything about this page or the book…" } });
		const send = ask.createEl("button", { cls: "mod-cta", text: "Ask" });
		const go = async () => {
			const q = input.value.trim();
			if (!q) return;
			const page = (await this.pageText()).slice(0, 4000);
			await this.runAi("ask", { text: "", loc: this.currentLoc() ?? {}, context: page }, q);
		};
		send.onclick = () => void go();
		input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void go(); } });

		if (!book.ai.length) {
			const empty = body.createDiv({ cls: "bcr-empty" });
			empty.createEl("p", { text: "Select any words or sentences in the book, then tap Explain, Simplify, Word or Translate." });
			empty.createEl("p", { text: `Answers are written for a ${this.host.settings.learner.level} learner of ${this.host.settings.learner.learningLanguage}. Change this in the plugin settings.` });
			return;
		}
		for (const card of book.ai) {
			const el = body.createDiv({ cls: `bcr-card${card.error ? " is-error" : ""}` });
			el.dataset.id = card.id;
			const head = el.createDiv({ cls: "bcr-card-head" });
			head.createSpan({ cls: "bcr-card-action", text: card.action });
			if (card.loc) {
				const where = head.createEl("a", { cls: "bcr-card-loc", text: locLabel(card.loc) });
				where.onclick = () => this.goto(card.loc);
			}
			if (card.quote) el.createDiv({ cls: "bcr-card-quote", text: card.quote.length > 260 ? card.quote.slice(0, 260) + "…" : card.quote });
			if (card.handoff) {
				this.renderHandoff(el, card);
				if (!card.answer) continue;
			}
			const ans = el.createDiv({ cls: "bcr-card-answer markdown-rendered" });
			if (!card.answer) {
				ans.createDiv({ cls: "bcr-thinking", text: "Thinking…" });
				continue;
			}
			void MarkdownRenderer.render(this.app, card.answer, ans, this.file?.path ?? "", this);
			if (card.error) continue;
			const actions = el.createDiv({ cls: "bcr-card-actions" });
			const mkBtn = (icon: string, label: string, fn: () => void) => {
				const b = actions.createEl("button", { cls: "bcr-chip" });
				setIcon(b.createSpan(), icon);
				b.createSpan({ text: label });
				b.onclick = fn;
				return b;
			};
			mkBtn("file-plus", "Save as note", async () => {
				const path = await this.host.notes.saveAiAnswer(this.meta!, card.action, card.quote, card.answer, card.loc);
				new Notice(`Saved: ${path.split("/").pop()}`);
			});
			if (parseVocabulary(card.answer).length) {
				mkBtn("list-plus", "Save words", async () => {
					const n = await this.saveWords(card);
					new Notice(n ? `${n} new word${n > 1 ? "s" : ""} added to your vocabulary` : "These words are already saved");
				});
			}
			mkBtn("copy", "Copy", () => { void navigator.clipboard?.writeText(card.answer); new Notice("Copied"); });
			mkBtn("message-circle", "Follow up", () => {
				new TextPromptModal(this.app, "Follow-up question", "Ask more about this…", (q) => void this.followUp(card, q), true).open();
			});
			mkBtn("x", "", () => { book.ai = book.ai.filter((c) => c.id !== card.id); this.host.store.saveSoon(); this.renderPanel(); });
		}
		if (scrollTo) body.querySelector(`[data-id="${scrollTo}"]`)?.scrollIntoView?.({ block: "nearest" });
	}

	/** The question goes to the person's own ChatGPT / Claude / Gemini app; they paste the answer back. */
	private renderHandoff(el: HTMLElement, card: AiCard) {
		const box = el.createDiv({ cls: "bcr-handoff" });
		box.createDiv({ cls: "bcr-muted", text: card.handoffReason ?? "Answer in your chat app" });
		const row = box.createDiv({ cls: "bcr-card-actions" });
		const preferred = this.host.settings.ai.chatApp;
		const order = [preferred, ...Object.keys(CHAT_APPS).filter((k) => k !== preferred)];
		for (const key of order) {
			const app = CHAT_APPS[key];
			const b = row.createEl("button", { cls: key === preferred ? "bcr-chip mod-cta" : "bcr-chip" });
			setIcon(b.createSpan(), "external-link");
			b.createSpan({ text: `Ask ${app.label}` });
			b.onclick = () => {
				const prompt = card.handoff!.length > 6000 ? card.handoff!.slice(0, 6000) + "…" : card.handoff!;
				void navigator.clipboard?.writeText(card.handoff!).catch(() => {});
				window.open(app.url(prompt));
				new Notice(app.prefill ? `Opened ${app.label}. When it answers, copy the answer and tap "Paste answer".` : `Question copied. Paste it into ${app.label}, then copy the answer back.`, 7000);
			};
		}
		const paste = row.createEl("button", { cls: "bcr-chip" });
		setIcon(paste.createSpan(), "clipboard-paste");
		paste.createSpan({ text: "Paste answer" });
		paste.onclick = async () => {
			let text = "";
			try { text = (await navigator.clipboard?.readText()) ?? ""; } catch { text = ""; }
			const accept = (t: string) => {
				if (!t.trim() || t.trim() === card.handoff?.trim()) return;
				card.answer = (card.answer ? card.answer + "\n\n---\n" : "") + t.trim();
				card.handoff = undefined;
				card.handoffReason = undefined;
				this.host.store.saveSoon();
				this.renderPanel(card.id);
			};
			if (text.trim() && text.trim() !== card.handoff?.trim()) accept(text);
			else new TextPromptModal(this.app, "Paste the answer", "Paste the chat app's answer here…", accept, true).open();
		};
	}

	private renderNotesTab(body: HTMLElement) {
		const book = this.book!;
		const meta = this.meta!;
		const top = body.createDiv({ cls: "bcr-panel-actions" });
		const b1 = top.createEl("button", { cls: "mod-cta", text: "New note here" });
		b1.onclick = () => this.writeNote();
		top.createEl("button", { text: "Handwrite" }).onclick = () => this.handwritingNote();
		top.createEl("button", { text: "Book page" }).onclick = () => void this.openHub();
		if (this.host.typedGraphEnabled?.()) {
			top.createEl("button", { text: "Show in graph" }).onclick = async () => { await this.openHub(); this.host.openTypedGraph?.(); };
		}

		const notes = this.host.listBookNotes(meta);
		body.createEl("h4", { text: `Notes (${notes.length})` });
		if (!notes.length) body.createDiv({ cls: "bcr-empty", text: "Notes you write about this book appear here and in its folder in your vault." });
		for (const n of notes) {
			const row = body.createDiv({ cls: "bcr-row" });
			setIcon(row.createSpan({ cls: "bcr-row-icon" }), n.path.endsWith(".svg") ? "pen-tool" : "file-text");
			const a = row.createEl("a", { text: n.name });
			a.onclick = () => this.host.openNote(n.path);
		}

		body.createEl("h4", { text: `Highlights (${book.highlights.length})` });
		if (!book.highlights.length) body.createDiv({ cls: "bcr-empty", text: "Select text and tap a colour to highlight it." });
		const sorted = book.highlights.slice().sort((a, b) => (a.loc.page ?? a.loc.chapter ?? 0) - (b.loc.page ?? b.loc.chapter ?? 0) || (a.loc.frac ?? 0) - (b.loc.frac ?? 0));
		for (const h of sorted) {
			const row = body.createDiv({ cls: "bcr-hl-row" });
			row.style.setProperty("--bcr-hl", HIGHLIGHT_COLORS[h.color] ?? h.color);
			const txt = row.createDiv({ cls: "bcr-hl-text", text: h.text.length > 220 ? h.text.slice(0, 220) + "…" : h.text });
			txt.onclick = () => this.goto(h.loc);
			const meta2 = row.createDiv({ cls: "bcr-hl-meta" });
			meta2.createSpan({ text: locLabel(h.loc) });
			if (h.notePath) {
				const a = meta2.createEl("a", { text: "note" });
				a.onclick = () => this.host.openNote(h.notePath!);
			}
			const del = meta2.createEl("a", { text: "remove" });
			del.onclick = () => void this.removeHighlight(h.id);
		}

		const inkPages = Object.keys(book.ink).length;
		if (inkPages) body.createDiv({ cls: "bcr-muted", text: `Handwriting on ${inkPages} page${inkPages > 1 ? "s" : ""}.` });
	}

	private renderWordsTab(body: HTMLElement) {
		const book = this.book!;
		const top = body.createDiv({ cls: "bcr-panel-actions" });
		top.createEl("button", { cls: "mod-cta", text: "Study this page" }).onclick = () => void this.studyPage();
		top.createEl("button", { text: `Quiz me (${book.vocab.length})` }).onclick = () => new QuizModal(this.app, book.vocab, () => this.host.store.saveSoon()).open();
		const l = this.host.settings.learner;
		body.createDiv({ cls: "bcr-muted", text: `Level ${l.level} · learning ${l.learningLanguage} · native ${l.nativeLanguage}` });
		if (!book.vocab.length) {
			body.createDiv({ cls: "bcr-empty", text: "Select a word and tap Word, or use Simplify, then press \"Save words\". Your words also go to a flashcard note in the book's folder." });
			return;
		}
		for (const w of book.vocab.slice().reverse()) {
			const row = body.createDiv({ cls: "bcr-word-row" });
			const head = row.createDiv({ cls: "bcr-word-head" });
			head.createSpan({ cls: "bcr-word", text: w.word });
			head.createSpan({ cls: "bcr-word-box", text: "●".repeat(w.box) + "○".repeat(Math.max(0, 5 - w.box)), attr: { title: "How well you know it" } });
			row.createDiv({ cls: "bcr-word-def", text: w.definition });
			const m = row.createDiv({ cls: "bcr-hl-meta" });
			if (w.loc) { const a = m.createEl("a", { text: locLabel(w.loc) }); a.onclick = () => this.goto(w.loc); }
			const del = m.createEl("a", { text: "remove" });
			del.onclick = () => { book.vocab = book.vocab.filter((x) => x.id !== w.id); this.host.store.saveSoon(); this.renderPanel(); };
		}
	}
}
