import { App, FuzzySuggestModal, FuzzyMatch, ItemView, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type BookCompanionPlugin from "./main";
import {
	BookFormatKind, LibraryBook, LibraryStats, STATUSES, STATUS_LABELS, SUGGEST_FOCUS, ShelfBlock, ShelfId, Status, Suggestion, libraryStats, shelf,
} from "./library";
import { formatOf } from "./types";

export const VIEW_TYPE_LIBRARY = "book-companion-library";

export function coverColors(title: string): [string, string] {
	let h = 0;
	for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
	const a = h % 360, b = (a + 40 + (h >> 9) % 80) % 360;
	return [`hsl(${a} 55% 42%)`, `hsl(${b} 60% 28%)`];
}

/** What the shelves can do to a book. The plugin supplies these. */
export interface ShelfActions {
	/** Read the book if there is a file, else open its page. */
	open(b: LibraryBook): void;
	openPage(b: LibraryBook): void;
	setStatus(b: LibraryBook, s: Status): Promise<void>;
	setRating(b: LibraryBook, n: number): Promise<void>;
	linkFile(b: LibraryBook): void;
	shelveSuggestion(s: Suggestion, status: Status): Promise<void>;
	dismissSuggestion(s: Suggestion): void;
}

export interface ShelfContext {
	books: LibraryBook[];
	suggestions: Suggestion[];
	goal: number;
	actions: ShelfActions;
}

const KIND_BADGE: Record<BookFormatKind, string> = { paper: "PAPER", ebook: "EBOOK", audio: "AUDIO" };

function stars(parent: HTMLElement, rating: number | undefined, onPick: (n: number) => void) {
	const row = parent.createDiv({ cls: "bcr-stars", attr: { role: "group", "aria-label": "Rating" } });
	for (let i = 1; i <= 5; i++) {
		const s = row.createEl("button", { cls: `bcr-star${(rating ?? 0) >= i ? " is-on" : ""}`, text: "★", attr: { "aria-label": `${i} star${i > 1 ? "s" : ""}` } });
		s.onclick = (e) => { e.stopPropagation(); onPick(rating === i ? 0 : i); };
	}
}

export function bookMenu(b: LibraryBook, actions: ShelfActions, e: MouseEvent) {
	const m = new Menu();
	m.addItem((i) => i.setTitle(b.file ? "Open in the reader" : "Open book page").setIcon(b.file ? "book-open" : "book-marked").onClick(() => actions.open(b)));
	if (b.file) m.addItem((i) => i.setTitle("Open book page").setIcon("book-marked").onClick(() => actions.openPage(b)));
	else m.addItem((i) => i.setTitle("Link a PDF or EPUB").setIcon("link").onClick(() => actions.linkFile(b)));
	m.addSeparator();
	for (const s of STATUSES) m.addItem((i) => i.setTitle(`Move to ${STATUS_LABELS[s]}`).setChecked(b.status === s).onClick(() => void actions.setStatus(b, s)));
	m.showAtMouseEvent(e);
}

/** Book covers with progress, status and rating. */
export function renderBookCards(parent: HTMLElement, books: LibraryBook[], actions: ShelfActions) {
	const grid = parent.createDiv({ cls: "bcr-lib-grid" });
	for (const b of books) {
		const card = grid.createDiv({ cls: "bcr-lib-card" });
		const cover = card.createDiv({ cls: "bcr-cover" });
		const [c1, c2] = coverColors(b.title);
		cover.setCssProps({ background: `linear-gradient(150deg, ${c1}, ${c2})` });
		cover.createDiv({ cls: "bcr-cover-title", text: b.title });
		if (b.author) cover.createDiv({ cls: "bcr-cover-author", text: b.author });
		cover.createDiv({ cls: "bcr-cover-badge", text: b.fileFormat ? b.fileFormat.toUpperCase() : KIND_BADGE[b.format ?? "paper"] });
		cover.onclick = () => actions.open(b);
		const info = card.createDiv({ cls: "bcr-lib-info" });
		if (b.status === "reading") {
			const bar = info.createDiv({ cls: "bcr-lib-bar" });
			bar.createDiv({ cls: "bcr-lib-bar-fill" }).setCssProps({ width: `${Math.round(b.progress * 100)}%` });
		}
		const line = info.createDiv({ cls: "bcr-lib-line" });
		const chip = line.createEl("button", { cls: `bcr-status bcr-status-${b.status}`, text: STATUS_LABELS[b.status], attr: { "aria-label": "Change shelf" } });
		chip.onclick = (e) => bookMenu(b, actions, e);
		if (b.status === "reading") line.createSpan({ cls: "bcr-muted", text: b.progress ? ` ${Math.round(b.progress * 100)}%` : " not started" });
		if (b.status === "finished" && b.finished) line.createSpan({ cls: "bcr-muted", text: ` ${b.finished}` });
		if (b.status === "finished") stars(info, b.rating, (n) => void actions.setRating(b, n));
		if (b.why && (b.status === "wishlist" || b.status === "to-read")) info.createDiv({ cls: "bcr-muted bcr-lib-why", text: b.why });
		const row = info.createDiv({ cls: "bcr-lib-actions" });
		const main = row.createEl("button", { cls: "bcr-chip" + (b.status === "reading" && b.file ? " mod-cta" : "") });
		setIcon(main.createSpan(), b.file ? "book-open" : "book-marked");
		main.createSpan({ text: b.file ? (b.status === "reading" && b.progress ? "Continue" : "Read") : "Book page" });
		main.onclick = () => actions.open(b);
		const more = row.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "More" } });
		setIcon(more, "more-horizontal");
		more.onclick = (e) => bookMenu(b, actions, e);
	}
}

/** One line per book. */
export function renderBookList(parent: HTMLElement, books: LibraryBook[], actions: ShelfActions) {
	const list = parent.createDiv({ cls: "bcr-lib-list" });
	for (const b of books) {
		const row = list.createDiv({ cls: "bcr-lib-row" });
		const t = row.createEl("a", { cls: "bcr-lib-row-title", text: b.title });
		t.onclick = () => actions.open(b);
		if (b.author) row.createSpan({ cls: "bcr-muted", text: ` · ${b.author}` });
		const right = row.createSpan({ cls: "bcr-lib-row-right" });
		if (b.status === "finished" && b.rating) right.createSpan({ cls: "bcr-stars-static", text: "★".repeat(b.rating) });
		if (b.finished) right.createSpan({ cls: "bcr-muted", text: b.finished });
		else if (b.status === "reading") right.createSpan({ cls: "bcr-muted", text: `${Math.round(b.progress * 100)}%` });
	}
}

export function renderSuggestions(parent: HTMLElement, items: Suggestion[], actions: ShelfActions) {
	const list = parent.createDiv({ cls: "bcr-sug-list" });
	for (const s of items) {
		const el = list.createDiv({ cls: "bcr-sug" });
		el.createDiv({ cls: "bcr-sug-title", text: s.title });
		if (s.author) el.createDiv({ cls: "bcr-muted", text: s.author });
		el.createDiv({ cls: "bcr-sug-why", text: s.why });
		const row = el.createDiv({ cls: "bcr-lib-actions" });
		row.createEl("button", { cls: "bcr-chip mod-cta", text: "Up next" }).onclick = () => void actions.shelveSuggestion(s, "to-read");
		row.createEl("button", { cls: "bcr-chip", text: "Wishlist" }).onclick = () => void actions.shelveSuggestion(s, "wishlist");
		row.createEl("button", { cls: "bcr-chip", text: "Not for me" }).onclick = () => actions.dismissSuggestion(s);
	}
}

export function renderStats(parent: HTMLElement, s: LibraryStats) {
	const box = parent.createDiv({ cls: "bcr-stats" });
	const tiles = box.createDiv({ cls: "bcr-stat-tiles" });
	const tile = (value: string, label: string) => {
		const t = tiles.createDiv({ cls: "bcr-stat-tile" });
		t.createDiv({ cls: "bcr-stat-value", text: value });
		t.createDiv({ cls: "bcr-muted", text: label });
	};
	tile(s.goal ? `${s.finished} / ${s.goal}` : String(s.finished), `finished in ${s.year}`);
	tile(String(s.counts.reading), "reading now");
	tile(String(s.counts["to-read"] + s.counts.wishlist), "waiting for you");
	if (s.pages) tile(s.pages.toLocaleString("en"), "pages read");
	if (s.avgRating) tile(`${s.avgRating} ★`, "average rating");
	if (s.goal) {
		const bar = box.createDiv({ cls: "bcr-lib-bar bcr-goal-bar", attr: { "aria-label": `${Math.round(s.goalProgress * 100)}% of your ${s.year} goal` } });
		bar.createDiv({ cls: "bcr-lib-bar-fill" }).setCssProps({ width: `${Math.round(s.goalProgress * 100)}%` });
	}
	const max = Math.max(1, ...s.byMonth);
	const chart = box.createDiv({ cls: "bcr-month-chart", attr: { "aria-label": "Books finished per month" } });
	["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"].forEach((m, i) => {
		const col = chart.createDiv({ cls: "bcr-month" });
		col.createDiv({ cls: "bcr-month-bar" }).setCssProps({ "--bcr-h": `${Math.round((s.byMonth[i] / max) * 100)}%` });
		col.createDiv({ cls: "bcr-muted", text: m });
	});
	const lists = box.createDiv({ cls: "bcr-stat-lists" });
	const top = (title: string, rows: { name: string; n: number }[]) => {
		if (!rows.length) return;
		const c = lists.createDiv();
		c.createEl("h4", { text: title });
		for (const r of rows) c.createDiv({ text: `${r.name} · ${r.n}` });
	};
	top("Authors you read most", s.topAuthors.map((a) => ({ name: a.author, n: a.books })));
	top("Genres", s.topGenres.map((g) => ({ name: g.genre, n: g.books })));
}

/** The content of a `book-shelf` block in a note. */
export function renderShelfBlock(el: HTMLElement, block: ShelfBlock, ctx: ShelfContext, year = new Date().getFullYear()) {
	el.addClass("bcr-shelf-block");
	if (block.view === "stats") { renderStats(el, libraryStats(ctx.books, block.year ?? year, ctx.goal)); return; }
	if (block.shelf === "suggested") {
		const items = ctx.suggestions.slice(0, block.limit ?? 50);
		if (!items.length) el.createDiv({ cls: "bcr-empty", text: "No suggestions yet. Open the library and ask the librarian cat." });
		else renderSuggestions(el, items, ctx.actions);
		return;
	}
	const books = shelf(ctx.books, block.shelf, { sort: block.sort, limit: block.limit, year: block.year, author: block.author });
	if (!books.length) { el.createDiv({ cls: "bcr-empty", text: "Nothing here yet." }); return; }
	if (block.view === "list") renderBookList(el, books, ctx.actions);
	else renderBookCards(el, books, ctx.actions);
}

/** Add a book that isn't a file: a paper book, something you want to read, a title a friend mentioned. */
export class AddBookModal extends Modal {
	constructor(app: App, private onAdd: (b: { title: string; author?: string; status: Status; format: BookFormatKind; genres: string[]; why?: string; pages?: number }) => void, private defaults: { status?: Status; title?: string; author?: string; why?: string } = {}) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("bcr-modal");
		this.titleEl.setText("Add a book");
		const form = this.contentEl.createDiv({ cls: "bcr-card-form" });
		const field = (label: string, value = "", placeholder = "") => {
			form.createEl("label", { text: label });
			const el = form.createEl("input", { cls: "bcr-text-input", attr: { type: "text", placeholder } });
			el.value = value;
			return el;
		};
		const select = (label: string, options: [string, string][], chosen: string) => {
			form.createEl("label", { text: label });
			const el = form.createEl("select", { cls: "dropdown" });
			for (const [v, t] of options) el.createEl("option", { text: t, attr: v === chosen ? { value: v, selected: "" } : { value: v } });
			return el;
		};
		const title = field("Title", this.defaults.title ?? "");
		const author = field("Author", this.defaults.author ?? "");
		const status = select("Shelf", STATUSES.map((s) => [s, STATUS_LABELS[s]] as [string, string]), this.defaults.status ?? "to-read");
		const format = select("Format", [["paper", "Paper book"], ["ebook", "E-book"], ["audio", "Audiobook"]], "paper");
		const genres = field("Genres", "", "fantasy, history");
		const pages = field("Pages", "", "optional");
		const why = field("Why do you want to read it?", this.defaults.why ?? "", "optional");
		const row = this.contentEl.createDiv({ cls: "bcr-modal-buttons" });
		row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		row.createEl("button", { text: "Add", cls: "mod-cta" }).onclick = () => {
			const t = title.value.trim();
			if (!t) { new Notice("Type the title first."); return; }
			this.close();
			this.onAdd({
				title: t, author: author.value.trim() || undefined, status: status.value as Status, format: format.value as BookFormatKind,
				genres: genres.value.split(",").map((g) => g.trim()).filter(Boolean), why: why.value.trim() || undefined, pages: parseInt(pages.value, 10) || undefined,
			});
		};
		window.setTimeout(() => title.focus(), 50);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Pick the PDF or EPUB that belongs to a book on the shelves. */
export class BookFileModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("Choose the book file…");
	}
	getItems() { return this.files; }
	getItemText(f: TFile) { return f.path; }
	renderSuggestion(item: FuzzyMatch<TFile>, el: HTMLElement) { el.createDiv({ text: item.item.path }); }
	onChooseItem(f: TFile) { this.onPick(f); }
}

type Tab = ShelfId | "suggested";

/** The librarian's desk: your books on shelves, what to read next, and a way to add or ask for more. */
export class LibraryView extends ItemView {
	private filter = "";
	private tab: Tab | null = null;
	private focus = "";
	private asking = false;

	constructor(leaf: WorkspaceLeaf, private plugin: BookCompanionPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE_LIBRARY; }
	getDisplayText() { return "Book library"; }
	getIcon() { return "library"; }

	async onOpen() {
		let t: number | undefined;
		const later = () => { window.clearTimeout(t); t = window.setTimeout(() => this.render(), 400); };
		this.registerEvent(this.app.vault.on("create", later));
		this.registerEvent(this.app.vault.on("delete", later));
		this.registerEvent(this.app.vault.on("rename", later));
		this.registerEvent(this.app.metadataCache.on("changed", later));
		this.render();
	}

	render() {
		const c = this.contentEl;
		c.empty();
		c.addClass("bcr-library");
		const plugin = this.plugin;
		const books = plugin.libraryBooks();
		const suggestions = plugin.suggestions.items;
		const count = (s: Status) => books.filter((b) => b.status === s).length;
		if (!this.tab) this.tab = count("reading") ? "reading" : count("to-read") ? "to-read" : suggestions.length ? "suggested" : "all";
		const tab = this.tab;

		const head = c.createDiv({ cls: "bcr-lib-head" });
		head.createEl("h2", { text: "Library" });
		const actions = head.createDiv({ cls: "bcr-deck-actions" });
		const reading = shelf(books, "reading", { sort: "recent" }).find((b) => b.file);
		if (reading) {
			const cont = actions.createEl("button", { cls: "mod-cta", text: "Continue reading" });
			cont.onclick = () => plugin.shelfActions.open(reading);
		}
		actions.createEl("button", { text: "Add book" }).onclick = () => plugin.addBookDialog();
		actions.createEl("button", { text: "Library pages" }).onclick = () => void plugin.openLibraryPages();

		const stats = libraryStats(books, new Date().getFullYear(), plugin.settings.library.yearlyGoal);
		if (stats.goal) {
			const g = c.createDiv({ cls: "bcr-goal" });
			g.createSpan({ text: `${stats.year} goal: ${stats.finished} of ${stats.goal} books` });
			g.createDiv({ cls: "bcr-lib-bar" }).createDiv({ cls: "bcr-lib-bar-fill" }).setCssProps({ width: `${Math.round(stats.goalProgress * 100)}%` });
		}

		const tabs = c.createDiv({ cls: "bcr-lib-tabs" });
		const mk = (id: Tab, label: string, n: number) => {
			if (!n && id !== tab && id !== "reading" && id !== "to-read" && id !== "suggested") return;
			const b = tabs.createEl("button", { cls: `bcr-lib-tab${id === tab ? " is-active" : ""}`, text: `${label} ${n}` });
			b.onclick = () => { this.tab = id; this.render(); };
		};
		mk("reading", STATUS_LABELS.reading, count("reading"));
		mk("to-read", STATUS_LABELS["to-read"], count("to-read"));
		mk("suggested", "Suggested", suggestions.length);
		mk("wishlist", STATUS_LABELS.wishlist, count("wishlist"));
		mk("finished", STATUS_LABELS.finished, count("finished"));
		mk("abandoned", STATUS_LABELS.abandoned, count("abandoned"));
		mk("all", "All", books.length);

		if (tab === "suggested") { this.renderSuggested(c); return; }
		const search = c.createEl("input", { cls: "bcr-text-input", attr: { type: "search", placeholder: "Find a book…" } });
		search.value = this.filter;
		const body = c.createDiv();
		const draw = () => {
			body.empty();
			const q = this.filter.toLowerCase();
			const list = shelf(books, tab, { sort: tab === "all" ? "recent" : undefined }).filter((b) => !q || `${b.title} ${b.author ?? ""} ${b.file ?? ""}`.toLowerCase().includes(q));
			if (!list.length) {
				const empty = body.createDiv({ cls: "bcr-empty" });
				empty.createEl("p", { text: q ? "No book matches." : tab === "reading" ? "Nothing in progress. Open a book from Up next, or add one." : "Nothing on this shelf yet. Drop a PDF or EPUB into the vault, or press Add book for a paper book or a title you want to read." });
				return;
			}
			renderBookCards(body, list, plugin.shelfActions);
		};
		search.addEventListener("input", () => { this.filter = search.value; draw(); });
		draw();
	}

	private renderSuggested(c: HTMLElement) {
		const plugin = this.plugin;
		const ask = c.createDiv({ cls: "bcr-librarian" });
		ask.createDiv({ cls: "bcr-librarian-hello", text: "🐱 Mrrp! Tell me what you're in the mood for, or let me look at what you've read and loved." });
		const row = ask.createDiv({ cls: "bcr-ask" });
		const input = row.createEl("input", { cls: "bcr-text-input", attr: { type: "text", placeholder: "Something funny, a short novel, more by an author…" } });
		input.value = this.focus;
		input.addEventListener("input", () => { this.focus = input.value; });
		const go = row.createEl("button", { cls: "mod-cta", text: this.asking ? "Looking…" : "Suggest books" });
		go.disabled = this.asking;
		const run = async () => {
			if (this.asking) return;
			this.asking = true;
			this.render();
			try { await plugin.askLibrarian(this.focus); } finally { this.asking = false; this.render(); }
		};
		go.onclick = () => void run();
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } });
		const chips = ask.createDiv({ cls: "bcr-chat-starters" });
		for (const f of SUGGEST_FOCUS) chips.createEl("button", { cls: "bcr-chip", text: f }).onclick = () => { this.focus = f; void run(); };
		const items = plugin.suggestions.items;
		if (!items.length) c.createDiv({ cls: "bcr-empty", text: "No suggestions yet." });
		else renderSuggestions(c, items, plugin.shelfActions);
	}
}

/** All the book files in the vault (for linking a file to a book on the shelves). */
export function vaultBookFiles(app: App): TFile[] {
	return app.vault.getFiles().filter((f) => formatOf(f.extension));
}
