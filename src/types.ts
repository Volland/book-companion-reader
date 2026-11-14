export type BookFormat = "pdf" | "epub";

/** A place in a book. PDFs use pages (1-based); EPUBs use chapter index + fraction through it. */
export interface Loc {
	page?: number;
	chapter?: number;
	frac?: number;
}

export interface Highlight {
	id: string;
	loc: Loc;
	text: string;
	color: string;
	created: number;
	notePath?: string;
}

export interface VocabEntry {
	id: string;
	word: string;
	definition: string;
	context?: string;
	loc?: Loc;
	created: number;
	/** Leitner box for the little quiz (0 = new). */
	box: number;
}

export interface InkStroke {
	tool: "pen" | "highlighter";
	color: string;
	/** Base width as a fraction of the surface width. */
	width: number;
	/** Flat list of x, y, pressure triples. x and y are fractions of the surface width. */
	points: number[];
}

export interface AiCard {
	id: string;
	action: string;
	quote: string;
	answer: string;
	loc?: Loc;
	created: number;
	error?: boolean;
	/** Set when the question is waiting to be answered in the person's chat app. */
	handoff?: string;
	handoffReason?: string;
}

/** One message in a talk with the reading cat. */
export interface ChatMsg {
	id: string;
	role: "user" | "cat";
	text: string;
	created: number;
	/** Where in the book the reader was when they asked. */
	loc?: Loc;
	/** A passage the question is about. */
	quote?: string;
	error?: boolean;
	/** Set when the question is waiting to be answered in the person's chat app. */
	handoff?: string;
	handoffReason?: string;
}

/** A discussion about the book, kept in the plugin data and as a note in the book's folder. */
export interface ChatSession {
	id: string;
	title: string;
	created: number;
	updated: number;
	messages: ChatMsg[];
	notePath?: string;
	language?: string;
}

export interface BookData {
	path: string;
	format: BookFormat;
	title?: string;
	author?: string;
	loc?: Loc;
	/** The language this book is read in, when picked by hand (otherwise taken from the EPUB). */
	language?: string;
	/** The book's page in the vault, when it was linked to one made earlier. */
	hub?: string;
	progress?: number;
	lastOpened?: number;
	highlights: Highlight[];
	vocab: VocabEntry[];
	/** Handwriting drawn straight onto PDF pages, keyed "p<page>". */
	ink: Record<string, InkStroke[]>;
	ai: AiCard[];
	chats: ChatSession[];
}

export interface BookMeta {
	path: string;
	/** The book's page in the vault, when it is not at the default place (a book added to the shelves before its file). */
	hub?: string;
	title: string;
	author?: string;
	format: BookFormat;
}

export function uid(prefix = ""): string {
	return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function locToString(loc: Loc | undefined): string {
	if (!loc) return "";
	if (loc.page != null) return `p${loc.page}`;
	if (loc.chapter != null) return `c${loc.chapter}@${(loc.frac ?? 0).toFixed(4)}`;
	return "";
}

export function locFromString(s: string | undefined | null): Loc | undefined {
	if (!s) return undefined;
	const p = /^p(\d+)$/.exec(s);
	if (p) return { page: parseInt(p[1], 10) };
	const c = /^c(\d+)(?:@([\d.]+))?$/.exec(s);
	if (c) return { chapter: parseInt(c[1], 10), frac: c[2] ? parseFloat(c[2]) : 0 };
	return undefined;
}

export function locLabel(loc: Loc | undefined): string {
	if (!loc) return "";
	if (loc.page != null) return `p. ${loc.page}`;
	if (loc.chapter != null) return `ch. ${loc.chapter + 1} (${Math.round((loc.frac ?? 0) * 100)}%)`;
	return "";
}

export function bookLink(path: string, loc?: Loc): string {
	let url = `obsidian://book-reader?file=${encodeURIComponent(path)}`;
	const l = locToString(loc);
	if (l) url += `&loc=${encodeURIComponent(l)}`;
	return url;
}

export function emptyBook(path: string, format: BookFormat): BookData {
	return { path, format, highlights: [], vocab: [], ink: {}, ai: [], chats: [] };
}

export function formatOf(ext: string): BookFormat | null {
	const e = ext.toLowerCase();
	return e === "pdf" ? "pdf" : e === "epub" ? "epub" : null;
}
