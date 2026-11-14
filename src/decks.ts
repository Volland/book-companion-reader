import type { Loc, VocabEntry } from "./types";
import { uid } from "./types";

export type DeckKind = "book" | "topic";

export interface Deck {
	id: string;
	name: string;
	kind: DeckKind;
	/** Book decks belong to one book. */
	bookPath?: string;
	created: number;
}

export interface Card {
	id: string;
	deckId: string;
	/** The word or phrase in its dictionary form (what is on the front). */
	word: string;
	/** The form it had in the text, when that differs ("gleamed" for "gleam"). */
	form?: string;
	translation?: string;
	meaning?: string;
	example?: string;
	/** The sentence from the book. */
	context?: string;
	bookPath?: string;
	loc?: Loc;
	language?: string;
	created: number;
	/** Leitner box 0-5 (0 = new or forgotten). */
	box: number;
	/** Day number (local days since 1970) when it is due. */
	due: number;
	reps: number;
	lapses: number;
}

export type Grade = "again" | "good" | "easy";

/** Days until the next review, by box. */
export const INTERVALS = [0, 1, 3, 7, 14, 30];

export function dayNumber(t = Date.now()): number {
	return Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / 86400000);
}

export function nextBox(box: number, grade: Grade): number {
	if (grade === "again") return 0;
	return Math.min(INTERVALS.length - 1, box + (grade === "easy" ? 2 : 1));
}

export function intervalLabel(box: number, grade: Grade): string {
	if (grade === "again") return "today";
	const d = INTERVALS[nextBox(box, grade)];
	return d === 1 ? "1 day" : `${d} days`;
}

/** The sentence of `context` that holds `selection` (falls back to a short slice of the context). */
export function sentenceAround(context: string, selection: string): string {
	const text = context.replace(/\s+/g, " ").trim();
	const sel = selection.replace(/\s+/g, " ").trim();
	if (!text) return "";
	const at = sel ? text.indexOf(sel) : -1;
	if (at < 0) return text.length > 240 ? text.slice(0, 240).trim() + "…" : text;
	let start = at;
	while (start > 0 && !/[.!?…]/.test(text[start - 1]) && at - start < 260) start--;
	let end = at + sel.length;
	while (end < text.length && !/[.!?…]/.test(text[end - 1]) && end - at < 260) end++;
	return text.slice(start, end).trim();
}

export interface CardInput {
	deckId: string;
	word: string;
	form?: string;
	translation?: string;
	meaning?: string;
	example?: string;
	context?: string;
	bookPath?: string;
	loc?: Loc;
	language?: string;
}

const key = (s: string) => s.trim().toLowerCase();

export interface DeckStats {
	total: number;
	/** Cards to study today, new ones included. */
	due: number;
	fresh: number;
}

/** Decks and flashcards with a small spaced-repetition schedule. Pure data, so it works the same on phones. */
export class DeckStore {
	decks: Deck[] = [];
	cards: Card[] = [];
	private timer: number | null = null;

	constructor(private persist: () => Promise<void>) {}

	load(raw: unknown) {
		const data = (raw ?? {}) as { decks?: Partial<Deck>[]; cards?: Partial<Card>[] };
		this.decks = Array.isArray(data.decks) ? (data.decks.filter((d) => d?.id && d?.name) as Deck[]) : [];
		this.cards = Array.isArray(data.cards) ? (data.cards.filter((c) => c?.id && c?.deckId && c?.word) as Card[]) : [];
	}

	toJSON() {
		return { decks: this.decks, cards: this.cards };
	}

	saveSoon(ms = 600) {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.persist();
		}, ms);
	}

	async flush() {
		if (this.timer) { window.clearTimeout(this.timer); this.timer = null; }
		await this.persist();
	}

	// ----- decks

	deck(id: string | null | undefined): Deck | undefined {
		return id ? this.decks.find((d) => d.id === id) : undefined;
	}

	bookDeck(bookPath: string, title: string): Deck {
		let d = this.decks.find((x) => x.kind === "book" && x.bookPath === bookPath);
		if (!d) {
			d = { id: uid("deck-"), name: title, kind: "book", bookPath, created: Date.now() };
			this.decks.push(d);
			this.saveSoon();
		}
		return d;
	}

	createDeck(name: string, kind: DeckKind = "topic"): Deck {
		const clean = name.trim() || "New deck";
		const same = this.decks.find((d) => d.kind === kind && key(d.name) === key(clean) && !d.bookPath);
		if (same) return same;
		const d: Deck = { id: uid("deck-"), name: clean, kind, created: Date.now() };
		this.decks.push(d);
		this.saveSoon();
		return d;
	}

	renameDeck(id: string, name: string) {
		const d = this.deck(id);
		if (d && name.trim()) { d.name = name.trim(); this.saveSoon(); }
	}

	deleteDeck(id: string) {
		this.decks = this.decks.filter((d) => d.id !== id);
		this.cards = this.cards.filter((c) => c.deckId !== id);
		this.saveSoon();
	}

	/** Book decks first (alphabetical), then topic decks. */
	sortedDecks(): Deck[] {
		return this.decks.slice().sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "book" ? -1 : 1));
	}

	/** A book's own deck's follow-up: the book rename moves its deck's link. */
	renameBook(oldPath: string, newPath: string) {
		for (const d of this.decks) if (d.bookPath === oldPath) d.bookPath = newPath;
		for (const c of this.cards) if (c.bookPath === oldPath) c.bookPath = newPath;
		this.saveSoon();
	}

	// ----- cards

	deckCards(id: string): Card[] {
		return this.cards.filter((c) => c.deckId === id);
	}

	/** Adds a card; when the deck already has that word, only fills what the old card lacked. */
	addCard(input: CardInput): { card: Card; created: boolean } {
		const existing = this.cards.find((c) => c.deckId === input.deckId && key(c.word) === key(input.word));
		if (existing) {
			for (const f of ["form", "translation", "meaning", "example", "context", "bookPath", "loc", "language"] as const) {
				if (!existing[f] && input[f]) Object.assign(existing, { [f]: input[f] });
			}
			this.saveSoon();
			return { card: existing, created: false };
		}
		const card: Card = {
			id: uid("card-"), deckId: input.deckId, word: input.word.trim(), form: input.form, translation: input.translation, meaning: input.meaning,
			example: input.example, context: input.context, bookPath: input.bookPath, loc: input.loc, language: input.language,
			created: Date.now(), box: 0, due: dayNumber(), reps: 0, lapses: 0,
		};
		this.cards.push(card);
		this.saveSoon();
		return { card, created: true };
	}

	updateCard(id: string, patch: Partial<Omit<Card, "id">>) {
		const c = this.cards.find((x) => x.id === id);
		if (c) { Object.assign(c, patch); this.saveSoon(); }
	}

	deleteCard(id: string) {
		this.cards = this.cards.filter((c) => c.id !== id);
		this.saveSoon();
	}

	moveCard(id: string, deckId: string) {
		const c = this.cards.find((x) => x.id === id);
		if (!c || !this.deck(deckId) || c.deckId === deckId) return;
		if (this.cards.some((x) => x.deckId === deckId && key(x.word) === key(c.word))) { this.deleteCard(id); return; }
		c.deckId = deckId;
		this.saveSoon();
	}

	stats(deckIds?: string[], today = dayNumber()): DeckStats {
		const list = deckIds ? this.cards.filter((c) => deckIds.includes(c.deckId)) : this.cards;
		return { total: list.length, due: list.filter((c) => c.due <= today).length, fresh: list.filter((c) => c.reps === 0).length };
	}

	/** Cards to study today: the most overdue first, forgotten ones before new ones. */
	dueCards(deckIds?: string[], limit = 20, today = dayNumber()): Card[] {
		const list = deckIds ? this.cards.filter((c) => deckIds.includes(c.deckId)) : this.cards;
		return list
			.filter((c) => c.due <= today)
			.sort((a, b) => a.due - b.due || (a.reps === 0 ? 1 : 0) - (b.reps === 0 ? 1 : 0) || a.created - b.created)
			.slice(0, limit);
	}

	review(card: Card, grade: Grade, today = dayNumber()) {
		card.reps++;
		if (grade === "again") card.lapses++;
		card.box = nextBox(card.box, grade);
		card.due = today + INTERVALS[card.box];
		this.saveSoon();
	}

	/** Words saved by version 0.1 (kept on each book) become cards in that book's deck. */
	importLegacy(books: Record<string, { title?: string; vocab?: VocabEntry[] }>): number {
		let n = 0;
		for (const [path, b] of Object.entries(books)) {
			if (!b.vocab?.length) continue;
			const title = b.title ?? path.split("/").pop()!.replace(/\.\w+$/, "");
			const deck = this.bookDeck(path, title);
			for (const v of b.vocab) {
				if (!v?.word || this.cards.some((c) => c.id === v.id)) continue;
				const box = Math.max(0, Math.min(5, v.box ?? 0));
				this.cards.push({
					id: v.id ?? uid("card-"), deckId: deck.id, word: v.word, meaning: v.definition, context: v.context, bookPath: path, loc: v.loc,
					created: v.created ?? Date.now(), box, due: dayNumber() + (box > 0 ? INTERVALS[box] : 0), reps: box > 0 ? box : 0, lapses: 0,
				});
				n++;
			}
			b.vocab = [];
		}
		if (n) this.saveSoon();
		return n;
	}
}

/** The back of a card as one line, for flashcard notes: "translation — meaning". */
export function cardAnswer(c: Pick<Card, "translation" | "meaning">): string {
	return [c.translation, c.meaning].filter(Boolean).join(" — ");
}

/** A deck as a note in the "word :: meaning" format flashcard plugins read. */
export function deckToMarkdown(deck: Deck, cards: Card[], tag: string): string {
	const lines = ["---", "type: flashcards", `deck: ${JSON.stringify(deck.name)}`, "---", `#${tag}`, "", `# ${deck.name}`, ""];
	for (const c of cards) {
		lines.push(`${c.word} :: ${cardAnswer(c) || "?"}`);
		if (c.context) lines.push(`<!-- ${c.context.replace(/-->/g, "").slice(0, 200)} -->`);
	}
	return lines.join("\n") + "\n";
}
