import { App, ItemView, Menu, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type BookCompanionPlugin from "./main";
import { Card, Deck, DeckStore, Grade, cardAnswer, dayNumber, intervalLabel } from "./decks";
import { TextPromptModal } from "./modals";
import { locLabel } from "./types";

export const VIEW_TYPE_DECKS = "book-companion-decks";

export interface StudyHooks {
	/** Jump to the place in the book a card came from. */
	openBook?: (card: Card) => void;
	/** The session ended (all cards done, or the person left). */
	onDone?: () => void;
}

/** The sentence from the book with the word marked. */
function renderContext(parent: HTMLElement, card: Card) {
	if (!card.context) return;
	const el = parent.createDiv({ cls: "bcr-flash-context" });
	const needle = (card.form || card.word).trim();
	const at = needle ? card.context.toLowerCase().indexOf(needle.toLowerCase()) : -1;
	el.appendText("“");
	if (at < 0) el.appendText(card.context);
	else {
		el.appendText(card.context.slice(0, at));
		el.createEl("mark", { text: card.context.slice(at, at + needle.length) });
		el.appendText(card.context.slice(at + needle.length));
	}
	el.appendText("”");
}

/** One study session: front of the card, show the answer, grade it. Works in a modal or a view. */
export function renderStudy(parent: HTMLElement, store: DeckStore, cards: Card[], hooks: StudyHooks = {}) {
	const queue = cards.slice();
	const total = queue.length;
	let done = 0;
	let again = 0;
	let revealed = false;
	parent.empty();
	parent.addClass("bcr-study");
	parent.tabIndex = 0;

	const grade = (g: Grade) => {
		const c = queue.shift();
		if (!c) return;
		store.review(c, g);
		if (g === "again") { again++; queue.push(c); } else done++;
		revealed = false;
		draw();
	};

	parent.addEventListener("keydown", (e: KeyboardEvent) => {
		if (!queue.length) return;
		if (!revealed && (e.key === " " || e.key === "Enter")) { e.preventDefault(); revealed = true; draw(); }
		else if (revealed && (e.key === "1" || e.key === "2" || e.key === "3")) { e.preventDefault(); grade((["again", "good", "easy"] as Grade[])[Number(e.key) - 1]); }
	});

	const draw = () => {
		parent.empty();
		if (!total) {
			parent.createEl("p", { cls: "bcr-empty", text: "Nothing to study right now. Cards come back on the day they are due." });
			return;
		}
		if (!queue.length) {
			const end = parent.createDiv({ cls: "bcr-study-end" });
			end.createEl("h3", { text: "Done for now 🎉" });
			end.createEl("p", { text: `${done} card${done === 1 ? "" : "s"} reviewed${again ? `, ${again} needed another look` : ""}.` });
			end.createEl("button", { cls: "mod-cta", text: "Close" }).onclick = () => hooks.onDone?.();
			return;
		}
		const c = queue[0];
		const deck = store.deck(c.deckId);
		const bar = parent.createDiv({ cls: "bcr-study-bar" });
		bar.createSpan({ text: `${queue.length} left` });
		bar.createSpan({ cls: "bcr-muted", text: [deck?.name, c.language].filter(Boolean).join(" · ") });
		const prog = parent.createDiv({ cls: "bcr-study-progress" });
		prog.createDiv({ cls: "bcr-study-progress-fill" }).setCssProps({ width: `${Math.round((done / total) * 100)}%` });

		const face = parent.createDiv({ cls: "bcr-flashcard" });
		face.createDiv({ cls: "bcr-flash-word", text: c.word });
		if (c.form && c.form.toLowerCase() !== c.word.toLowerCase()) face.createDiv({ cls: "bcr-muted", text: `in the text: ${c.form}` });
		renderContext(face, c);
		if (revealed) {
			const back = face.createDiv({ cls: "bcr-flash-back" });
			if (c.translation) back.createDiv({ cls: "bcr-flash-translation", text: c.translation });
			if (c.meaning) back.createDiv({ cls: "bcr-flash-meaning", text: c.meaning });
			if (c.example) back.createDiv({ cls: "bcr-flash-example", text: c.example });
			if (!c.translation && !c.meaning) back.createDiv({ cls: "bcr-muted", text: "No meaning saved yet. Edit this card in Flashcards." });
			if (c.bookPath && hooks.openBook) {
				const a = back.createEl("a", { cls: "bcr-flash-open", text: `Open in the book${c.loc ? ` (${locLabel(c.loc)})` : ""}` });
				a.onclick = () => hooks.openBook?.(c);
			}
		}
		const row = parent.createDiv({ cls: "bcr-modal-buttons bcr-study-buttons" });
		if (!revealed) {
			const show = row.createEl("button", { cls: "mod-cta", text: "Show answer" });
			show.onclick = () => { revealed = true; draw(); };
		} else {
			for (const [g, label, cls] of [["again", "Again", ""], ["good", "Good", "mod-cta"], ["easy", "Easy", ""]] as [Grade, string, string][]) {
				const b = row.createEl("button", { cls });
				b.createSpan({ text: label });
				b.createSpan({ cls: "bcr-study-next", text: intervalLabel(c.box, g) });
				b.onclick = () => grade(g);
			}
		}
		parent.focus();
	};
	draw();
}

export class StudyModal extends Modal {
	constructor(app: App, private store: DeckStore, private cards: Card[], private title: string, private hooks: StudyHooks = {}) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("bcr-modal", "bcr-quiz");
		this.titleEl.setText(this.title);
		renderStudy(this.contentEl, this.store, this.cards, { ...this.hooks, onDone: () => { this.close(); this.hooks.onDone?.(); } });
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private message: string, private action: string, private onYes: () => void) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("bcr-modal");
		this.contentEl.createEl("p", { text: this.message });
		const row = this.contentEl.createDiv({ cls: "bcr-modal-buttons" });
		row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		row.createEl("button", { text: this.action, cls: "mod-warning" }).onclick = () => { this.close(); this.onYes(); };
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Create or edit one card. */
export class CardModal extends Modal {
	constructor(app: App, private store: DeckStore, private opts: { card?: Card; deckId?: string; onSave: () => void }) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("bcr-modal");
		const { card } = this.opts;
		this.titleEl.setText(card ? "Edit card" : "New card");
		const form = this.contentEl.createDiv({ cls: "bcr-card-form" });
		const field = (label: string, value: string, multiline = false) => {
			form.createEl("label", { text: label });
			const el = multiline
				? form.createEl("textarea", { cls: "bcr-note-input", attr: { rows: "2" } })
				: form.createEl("input", { cls: "bcr-text-input", attr: { type: "text" } });
			el.value = value;
			return el as HTMLInputElement;
		};
		form.createEl("label", { text: "Deck" });
		const deckSel = form.createEl("select", { cls: "dropdown" });
		const chosen = card?.deckId ?? this.opts.deckId ?? this.store.sortedDecks()[0]?.id ?? "";
		for (const d of this.store.sortedDecks()) {
			deckSel.createEl("option", { text: `${d.kind === "book" ? "📖 " : "🏷️ "}${d.name}`, attr: d.id === chosen ? { value: d.id, selected: "" } : { value: d.id } });
		}
		const word = field("Word or phrase", card?.word ?? "");
		const translation = field("Translation", card?.translation ?? "");
		const meaning = field("Meaning", card?.meaning ?? "", true);
		const example = field("Example", card?.example ?? "", true);
		const context = field("Sentence from the book", card?.context ?? "", true);
		const row = this.contentEl.createDiv({ cls: "bcr-modal-buttons" });
		row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		row.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => {
			const w = word.value.trim();
			if (!w) { new Notice("Type the word first."); return; }
			const deckId = deckSel.value;
			if (!this.store.deck(deckId)) { new Notice("Make a deck first."); return; }
			const patch = { word: w, translation: translation.value.trim() || undefined, meaning: meaning.value.trim() || undefined, example: example.value.trim() || undefined, context: context.value.trim() || undefined };
			if (card) {
				this.store.updateCard(card.id, patch);
				if (card.deckId !== deckId) this.store.moveCard(card.id, deckId);
			} else this.store.addCard({ deckId, ...patch });
			this.close();
			this.opts.onSave();
		};
		window.setTimeout(() => word.focus(), 50);
	}

	onClose() {
		this.contentEl.empty();
	}
}

type Mode = { kind: "list" } | { kind: "deck"; id: string } | { kind: "study"; cards: Card[]; title: string; back: Mode };

/** All decks: study what is due, browse and edit cards, group words by book or by topic. */
export class DecksView extends ItemView {
	private mode: Mode = { kind: "list" };
	private filter = "";

	constructor(leaf: WorkspaceLeaf, private plugin: BookCompanionPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE_DECKS; }
	getDisplayText() { return "Flashcards"; }
	getIcon() { return "layers"; }

	private get store() { return this.plugin.decks; }

	async onOpen() {
		this.render();
	}

	async onClose() {
		await this.store.flush();
	}

	showDeck(id: string) {
		this.mode = { kind: "deck", id };
		this.render();
	}

	startStudy(deckIds?: string[], title = "All decks") {
		const cards = this.store.dueCards(deckIds, this.plugin.settings.cards.sessionSize);
		if (!cards.length) { new Notice("Nothing is due. Come back tomorrow, or add more words."); return; }
		this.mode = { kind: "study", cards, title, back: this.mode.kind === "study" ? { kind: "list" } : this.mode };
		this.render();
	}

	render() {
		const c = this.contentEl;
		c.empty();
		c.addClass("bcr-decks");
		if (this.mode.kind === "study") this.renderStudyMode(c, this.mode);
		else if (this.mode.kind === "deck") this.renderDeck(c, this.mode.id);
		else this.renderList(c);
	}

	private renderList(c: HTMLElement) {
		const total = this.store.stats();
		const head = c.createDiv({ cls: "bcr-lib-head" });
		head.createEl("h2", { text: "Flashcards" });
		const actions = head.createDiv({ cls: "bcr-deck-actions" });
		const study = actions.createEl("button", { cls: "mod-cta", text: total.due ? `Study all due (${total.due})` : "All caught up" });
		study.disabled = !total.due;
		study.onclick = () => this.startStudy();
		actions.createEl("button", { text: "New deck" }).onclick = () => new TextPromptModal(this.app, "New deck", "A topic, like Sailing words", (name) => { this.store.createDeck(name); this.render(); }).open();
		const addCard = actions.createEl("button", { text: "Add card" });
		addCard.onclick = () => {
			if (!this.store.decks.length) this.store.createDeck("My words");
			new CardModal(this.app, this.store, { onSave: () => this.render() }).open();
		};

		if (!this.store.decks.length) {
			const empty = c.createDiv({ cls: "bcr-empty" });
			empty.createEl("p", { text: "No flashcards yet." });
			empty.createEl("p", { text: "While reading, select a word and tap Card. It is saved with the sentence it came from and its translation. Every book gets its own deck, and you can make topic decks to group words your own way." });
			return;
		}
		for (const [kind, label] of [["book", "Books"], ["topic", "Topics"]] as const) {
			const decks = this.store.sortedDecks().filter((d) => d.kind === kind);
			if (!decks.length) continue;
			c.createEl("h4", { cls: "bcr-deck-group", text: label });
			for (const d of decks) this.renderDeckRow(c, d);
		}
	}

	private renderDeckRow(parent: HTMLElement, d: Deck) {
		const st = this.store.stats([d.id]);
		const row = parent.createDiv({ cls: "bcr-deck-row" });
		const info = row.createDiv({ cls: "bcr-deck-info" });
		const name = info.createEl("a", { cls: "bcr-deck-name", text: d.name });
		name.onclick = () => this.showDeck(d.id);
		info.createDiv({ cls: "bcr-muted", text: `${st.total} card${st.total === 1 ? "" : "s"} · ${st.due ? `${st.due} due` : "none due"}` });
		const btns = row.createDiv({ cls: "bcr-deck-actions" });
		const study = btns.createEl("button", { cls: st.due ? "mod-cta" : "", text: st.due ? `Study (${st.due})` : "Study" });
		study.disabled = !st.due;
		study.onclick = () => this.startStudy([d.id], d.name);
		const more = btns.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "Deck options" } });
		setIcon(more, "more-horizontal");
		more.onclick = (e) => this.deckMenu(d, e);
	}

	private deckMenu(d: Deck, e: MouseEvent) {
		const m = new Menu();
		m.addItem((i) => i.setTitle("Browse cards").setIcon("list").onClick(() => this.showDeck(d.id)));
		m.addItem((i) => i.setTitle("Rename").setIcon("pencil").onClick(() => new TextPromptModal(this.app, "Rename deck", d.name, (n) => { this.store.renameDeck(d.id, n); this.render(); }).open()));
		m.addItem((i) => i.setTitle("Save as a note").setIcon("file-text").onClick(async () => {
			const path = await this.plugin.notes.exportDeck(d, this.store.deckCards(d.id));
			new Notice(`Saved ${path}`);
		}));
		m.addSeparator();
		m.addItem((i) => i.setTitle("Delete deck").setIcon("trash-2").onClick(() => {
			const n = this.store.deckCards(d.id).length;
			new ConfirmModal(this.app, `Delete "${d.name}" and its ${n} card${n === 1 ? "" : "s"}? This can't be undone.`, "Delete", () => { this.store.deleteDeck(d.id); this.render(); }).open();
		}));
		m.showAtMouseEvent(e);
	}

	private renderDeck(c: HTMLElement, id: string) {
		const d = this.store.deck(id);
		if (!d) { this.mode = { kind: "list" }; this.render(); return; }
		const head = c.createDiv({ cls: "bcr-lib-head" });
		const back = head.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "All decks" } });
		setIcon(back, "arrow-left");
		back.onclick = () => { this.mode = { kind: "list" }; this.filter = ""; this.render(); };
		head.createEl("h2", { text: d.name });
		const st = this.store.stats([id]);
		const actions = head.createDiv({ cls: "bcr-deck-actions" });
		const study = actions.createEl("button", { cls: "mod-cta", text: st.due ? `Study (${st.due})` : "Nothing due" });
		study.disabled = !st.due;
		study.onclick = () => this.startStudy([id], d.name);
		actions.createEl("button", { text: "Add card" }).onclick = () => new CardModal(this.app, this.store, { deckId: id, onSave: () => this.render() }).open();

		const search = c.createEl("input", { cls: "bcr-text-input", attr: { type: "search", placeholder: "Find a card…" } });
		search.value = this.filter;
		const list = c.createDiv({ cls: "bcr-deck-cards" });
		const draw = () => {
			list.empty();
			const q = this.filter.trim().toLowerCase();
			const cards = this.store.deckCards(id).filter((x) => !q || `${x.word} ${x.translation ?? ""} ${x.meaning ?? ""}`.toLowerCase().includes(q)).sort((a, b) => b.created - a.created);
			if (!cards.length) { list.createDiv({ cls: "bcr-empty", text: q ? "No card matches." : "This deck has no cards yet." }); return; }
			for (const card of cards) this.renderCardRow(list, card);
		};
		search.addEventListener("input", () => { this.filter = search.value; draw(); });
		draw();
	}

	private renderCardRow(list: HTMLElement, card: Card) {
		const row = list.createDiv({ cls: "bcr-deck-card" });
		const main = row.createDiv({ cls: "bcr-deck-card-main" });
		const top = main.createDiv({ cls: "bcr-word-head" });
		top.createSpan({ cls: "bcr-word", text: card.word });
		top.createSpan({ cls: "bcr-word-box", text: "●".repeat(card.box) + "○".repeat(Math.max(0, 5 - card.box)), attr: { title: card.due <= dayNumber() ? "Due today" : `Due in ${card.due - dayNumber()} days` } });
		const ans = cardAnswer(card);
		if (ans) main.createDiv({ cls: "bcr-word-def", text: ans });
		if (card.context) main.createDiv({ cls: "bcr-muted bcr-deck-context", text: `“${card.context.slice(0, 140)}${card.context.length > 140 ? "…" : ""}”` });
		const meta = main.createDiv({ cls: "bcr-hl-meta" });
		if (card.language) meta.createSpan({ text: card.language });
		if (card.bookPath) {
			const a = meta.createEl("a", { text: card.loc ? `Open in book (${locLabel(card.loc)})` : "Open book" });
			a.onclick = () => this.plugin.openBookPath(card.bookPath!, card.loc);
		}
		meta.createEl("a", { text: "edit" }).onclick = () => new CardModal(this.app, this.store, { card, onSave: () => this.render() }).open();
		meta.createEl("a", { text: "move" }).onclick = (e) => {
			const m = new Menu();
			for (const d of this.store.sortedDecks()) if (d.id !== card.deckId) m.addItem((i) => i.setTitle(d.name).setIcon(d.kind === "book" ? "book" : "tag").onClick(() => { this.store.moveCard(card.id, d.id); this.render(); }));
			m.showAtMouseEvent(e);
		};
		meta.createEl("a", { text: "remove" }).onclick = () => { this.store.deleteCard(card.id); this.render(); };
	}

	private renderStudyMode(c: HTMLElement, mode: Extract<Mode, { kind: "study" }>) {
		const head = c.createDiv({ cls: "bcr-lib-head" });
		const back = head.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "Stop studying" } });
		setIcon(back, "arrow-left");
		back.onclick = () => { this.mode = mode.back; this.render(); };
		head.createEl("h2", { text: mode.title });
		const box = c.createDiv({ cls: "bcr-study-wrap" });
		renderStudy(box, this.store, mode.cards, {
			openBook: (card) => { if (card.bookPath) void this.plugin.openBookPath(card.bookPath, card.loc); },
			onDone: () => { this.mode = mode.back; this.render(); },
		});
	}
}
