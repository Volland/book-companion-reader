import type { LearnerSettings } from "./settings";
import { uid } from "./types";

/** Reading status, the same values as Typed Graph's library ontology. */
export type Status = "wishlist" | "to-read" | "reading" | "finished" | "abandoned";
export type BookFormatKind = "paper" | "ebook" | "audio";

export const STATUS_LABELS: Record<Status, string> = {
	wishlist: "Wishlist",
	"to-read": "Up next",
	reading: "Reading now",
	finished: "Finished",
	abandoned: "Set aside",
};

export const STATUSES: Status[] = ["reading", "to-read", "wishlist", "finished", "abandoned"];

/** A book on the shelves: from its book page in the vault, or just a book file that has no page yet. */
export interface LibraryBook {
	/** The book page (note) in the vault, when there is one. */
	hub?: string;
	/** The PDF or EPUB, when there is one. */
	file?: string;
	title: string;
	author?: string;
	status: Status;
	rating?: number;
	format?: BookFormatKind;
	fileFormat?: "pdf" | "epub";
	/** 0 to 1. */
	progress: number;
	started?: string;
	finished?: string;
	lastRead?: string;
	lastOpened?: number;
	genres: string[];
	why?: string;
	pages?: number;
	year?: number;
}

export interface HubInfo {
	path: string;
	fm: Record<string, unknown>;
}

export interface FileInfo {
	path: string;
	extension: string;
	basename: string;
	title?: string;
	author?: string;
	progress?: number;
	lastOpened?: number;
}

// ---------- front matter ----------

function scalar(v: string): unknown {
	const t = v.trim();
	if (t === "") return "";
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	if (t === "true") return true;
	if (t === "false") return false;
	if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
	if (/^'.*'$/.test(t)) return t.slice(1, -1);
	return t;
}

/** The front matter of a note as an object (just enough YAML: scalars, [flow, lists] and "- block" lists). */
export function parseFrontmatter(text: string): Record<string, unknown> {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	const out: Record<string, unknown> = {};
	if (!m) return out;
	const lines = m[1].split("\n");
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([\w.-]+):\s*(.*)$/.exec(lines[i]);
		if (!kv) continue;
		const [, key, rest] = kv;
		if (rest === "") {
			const items: unknown[] = [];
			while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) items.push(scalar(lines[++i].replace(/^\s+-\s+/, "")));
			out[key] = items.length ? items : "";
		} else if (/^\[.*\]$/.test(rest.trim())) {
			out[key] = rest.trim().slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== "");
		} else out[key] = scalar(rest);
	}
	return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);

/** "[[Books/Dune/Dune.epub]]" or "[[path|alias]]" → the path. */
export function linkTarget(v: unknown): string | undefined {
	const s = str(v);
	if (!s) return undefined;
	const m = /^\[\[([^\]|#]+)/.exec(s);
	return (m ? m[1] : s).trim() || undefined;
}

export function normalizeStatus(v: unknown): Status {
	const s = (str(v) ?? "").toLowerCase().replace(/[\s_]+/g, "-");
	if (s === "to-read" || s === "toread" || s === "next" || s === "queue") return "to-read";
	if (s === "wishlist" || s === "wish" || s === "want-to-read") return "wishlist";
	if (s === "reading" || s === "current" || s === "in-progress") return "reading";
	if (s === "finished" || s === "read" || s === "done" || s === "completed") return "finished";
	if (s === "abandoned" || s === "dnf" || s === "set-aside" || s === "paused") return "abandoned";
	return "to-read";
}

function genresOf(fm: Record<string, unknown>): string[] {
	const tags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/) : [];
	const out: string[] = [];
	for (const t of tags) {
		const m = /^#?genre\/(.+)$/i.exec(String(t));
		if (m) out.push(m[1].replace(/-/g, " "));
	}
	return out;
}

export function isBookHub(fm: Record<string, unknown>): boolean {
	return str(fm.type)?.toLowerCase() === "book";
}

/** One book from its page's front matter. */
export function bookFromHub(h: HubInfo): LibraryBook {
	const fm = h.fm;
	const fmt = str(fm.format)?.toLowerCase();
	const ff = (str(fm.file_format) ?? (fmt === "pdf" || fmt === "epub" ? fmt : undefined))?.toLowerCase();
	const progress = num(fm.progress);
	return {
		hub: h.path,
		file: linkTarget(fm.file),
		title: str(fm.title) ?? h.path.split("/").pop()!.replace(/\.md$/, ""),
		author: str(fm.author),
		status: normalizeStatus(fm.status),
		rating: num(fm.rating),
		format: fmt === "paper" || fmt === "audio" || fmt === "ebook" ? fmt : ff ? "ebook" : undefined,
		fileFormat: ff === "pdf" || ff === "epub" ? ff : undefined,
		progress: Math.max(0, Math.min(1, (progress ?? 0) / 100)),
		started: str(fm.started),
		finished: str(fm.finished),
		lastRead: str(fm.last_read),
		genres: genresOf(fm),
		why: str(fm.why),
		pages: num(fm.pages),
		year: num(fm.year),
	};
}

/** Every book: those with a page, plus book files that have no page yet (shelved by how far you've read). */
export function collectBooks(hubs: HubInfo[], files: FileInfo[]): LibraryBook[] {
	const books = hubs.filter((h) => isBookHub(h.fm)).map(bookFromHub);
	const known = new Set(books.map((b) => b.file).filter(Boolean));
	const byFile = new Map(files.map((f) => [f.path, f]));
	for (const b of books) {
		const f = b.file ? byFile.get(b.file) : undefined;
		if (f) { b.lastOpened = f.lastOpened; if (!b.fileFormat) b.fileFormat = f.extension.toLowerCase() === "pdf" ? "pdf" : "epub"; }
	}
	for (const f of files) {
		if (known.has(f.path)) continue;
		const progress = f.progress ?? 0;
		books.push({
			file: f.path, title: f.title ?? f.basename, author: f.author, status: progress > 0 || f.lastOpened ? "reading" : "to-read",
			progress, fileFormat: f.extension.toLowerCase() === "pdf" ? "pdf" : "epub", format: "ebook", genres: [], lastOpened: f.lastOpened,
		});
	}
	return books;
}

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------- shelves ----------

export type ShelfId = Status | "all";

export interface ShelfOptions {
	author?: string;
	sort?: "recent" | "title" | "rating" | "finished" | "author";
	limit?: number;
	year?: number;
}

const lastTouched = (b: LibraryBook) => Math.max(b.lastOpened ?? 0, b.lastRead ? Date.parse(b.lastRead) || 0 : 0);

export function shelf(books: LibraryBook[], id: ShelfId, o: ShelfOptions = {}): LibraryBook[] {
	let list = id === "all" ? books.slice() : books.filter((b) => b.status === id);
	if (o.author) list = list.filter((b) => norm(b.author ?? "") === norm(o.author!));
	if (o.year) list = list.filter((b) => (b.finished ?? "").startsWith(String(o.year)));
	const sort = o.sort ?? (id === "reading" ? "recent" : id === "finished" ? "finished" : "title");
	const cmp: Record<string, (a: LibraryBook, b: LibraryBook) => number> = {
		recent: (a, b) => lastTouched(b) - lastTouched(a),
		finished: (a, b) => (b.finished ?? "").localeCompare(a.finished ?? ""),
		rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
		author: (a, b) => (a.author ?? "").localeCompare(b.author ?? "") || a.title.localeCompare(b.title),
		title: (a, b) => a.title.localeCompare(b.title),
	};
	list.sort(cmp[sort] ?? cmp.title);
	return o.limit ? list.slice(0, o.limit) : list;
}

export interface LibraryStats {
	year: number;
	finished: number;
	pages: number;
	avgRating?: number;
	byMonth: number[];
	counts: Record<Status, number>;
	goal: number;
	/** 0 to 1; 0 when there is no goal. */
	goalProgress: number;
	topAuthors: { author: string; books: number }[];
	topGenres: { genre: string; books: number }[];
}

export function libraryStats(books: LibraryBook[], year: number, goal = 0): LibraryStats {
	const counts: Record<Status, number> = { wishlist: 0, "to-read": 0, reading: 0, finished: 0, abandoned: 0 };
	for (const b of books) counts[b.status]++;
	const done = books.filter((b) => b.status === "finished" && (b.finished ?? "").startsWith(String(year)));
	const byMonth = Array<number>(12).fill(0);
	for (const b of done) { const m = parseInt((b.finished ?? "").slice(5, 7), 10); if (m >= 1 && m <= 12) byMonth[m - 1]++; }
	const rated = done.filter((b) => b.rating);
	const tally = (pick: (b: LibraryBook) => string[]) => {
		const t = new Map<string, number>();
		for (const b of books.filter((x) => x.status === "finished")) for (const k of pick(b)) t.set(k, (t.get(k) ?? 0) + 1);
		return [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
	};
	return {
		year, finished: done.length, pages: done.reduce((n, b) => n + (b.pages ?? 0), 0),
		avgRating: rated.length ? Math.round((rated.reduce((n, b) => n + (b.rating ?? 0), 0) / rated.length) * 10) / 10 : undefined,
		byMonth, counts, goal, goalProgress: goal > 0 ? Math.min(1, done.length / goal) : 0,
		topAuthors: tally((b) => (b.author ? [b.author] : [])).map(([author, n]) => ({ author, books: n })),
		topGenres: tally((b) => b.genres).map(([genre, n]) => ({ genre, books: n })),
	};
}

// ---------- the book-shelf code block ----------

export interface ShelfBlock {
	shelf: ShelfId | "suggested";
	view: "cards" | "list" | "stats";
	limit?: number;
	sort?: ShelfOptions["sort"];
	year?: number;
	author?: string;
}

/** The text of a `book-shelf` block: lines like "shelf: reading", "limit: 5", "view: list", "year: 2026". */
export function parseShelfBlock(source: string): ShelfBlock {
	const kv: Record<string, string> = {};
	let author: string | undefined;
	for (const line of source.split("\n")) {
		const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
		if (!m) continue;
		kv[m[1].toLowerCase()] = m[2].toLowerCase();
		if (m[1].toLowerCase() === "author") author = m[2].replace(/^["']|["']$/g, "");
	}
	const s = (kv.shelf ?? "all").replace(/_/g, "-");
	const shelfId = (["suggested", "all", ...STATUSES] as string[]).includes(s) ? (s as ShelfBlock["shelf"]) : "all";
	const view = kv.view === "list" || kv.view === "stats" ? kv.view : "cards";
	const sort = (["recent", "title", "rating", "finished", "author"] as string[]).includes(kv.sort) ? (kv.sort as ShelfOptions["sort"]) : undefined;
	const limit = parseInt(kv.limit ?? "", 10);
	const year = parseInt(kv.year ?? "", 10);
	return { shelf: shelfId, view, sort, limit: limit > 0 ? limit : undefined, year: year > 1000 ? year : undefined, author };
}

// ---------- suggestions from the librarian ----------

export interface Suggestion {
	id: string;
	title: string;
	author?: string;
	why: string;
	created: number;
	focus?: string;
}

export class SuggestionStore {
	items: Suggestion[] = [];
	/** Titles the reader waved away; the librarian won't offer them again. */
	dismissed: string[] = [];
	private timer: number | null = null;

	constructor(private persist: () => Promise<void>) {}

	load(raw: { items?: Suggestion[]; dismissed?: string[] } | undefined) {
		this.items = Array.isArray(raw?.items) ? raw.items.filter((s) => s?.id && s.title) : [];
		this.dismissed = Array.isArray(raw?.dismissed) ? raw.dismissed.filter((s) => typeof s === "string") : [];
	}

	toJSON() {
		return { items: this.items, dismissed: this.dismissed };
	}

	saveSoon(ms = 600) {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => { this.timer = null; void this.persist(); }, ms);
	}

	async flush() {
		if (this.timer) { window.clearTimeout(this.timer); this.timer = null; }
		await this.persist();
	}

	/** Adds the ones that are new (not already suggested, dismissed or on your shelves). Returns what was added. */
	add(list: { title: string; author?: string; why: string }[], owned: string[], focus?: string): Suggestion[] {
		const skip = new Set([...owned, ...this.dismissed, ...this.items.map((s) => s.title)].map(norm));
		const added: Suggestion[] = [];
		for (const s of list) {
			const key = norm(s.title);
			if (!key || skip.has(key)) continue;
			skip.add(key);
			added.push({ id: uid("sug-"), title: s.title.trim(), author: s.author?.trim() || undefined, why: s.why.trim(), created: Date.now(), focus });
		}
		this.items.unshift(...added);
		if (this.items.length > 60) this.items.length = 60;
		if (added.length) this.saveSoon();
		return added;
	}

	/** Takes a suggestion off the list (to shelve it, or to dismiss it for good). */
	take(id: string, dismiss = false): Suggestion | undefined {
		const s = this.items.find((x) => x.id === id);
		if (!s) return undefined;
		this.items = this.items.filter((x) => x.id !== id);
		if (dismiss && !this.dismissed.some((d) => norm(d) === norm(s.title))) this.dismissed.push(s.title);
		this.saveSoon();
		return s;
	}
}

export const SUGGEST_FOCUS = ["Something shorter", "More by authors I like", "Easier to read for my level", "Surprise me"];

const brief = (b: LibraryBook) => `- ${b.title}${b.author ? ` — ${b.author}` : ""}${b.rating ? ` (rated ${b.rating}/5)` : ""}${b.genres.length ? ` [${b.genres.join(", ")}]` : ""}`;

export function buildLibrarianSystem(l: LearnerSettings): string {
	return [
		"You are the librarian cat: a small, well-read cat who runs the reader's personal library and recommends what to read next. You are warm, specific and brief.",
		"Only recommend real, published books that you are sure exist, with their real authors. If you are not sure a book exists, leave it out. Never recommend a book the reader already has.",
		`The reader's native language is ${l.nativeLanguage}; they are learning ${l.learningLanguage} at level ${l.level}.`,
	].join("\n");
}

export function buildSuggestPrompt(books: LibraryBook[], l: LearnerSettings, o: { count: number; focus?: string; dismissed: string[]; pending: string[] }): string {
	const group = (s: Status) => books.filter((b) => b.status === s);
	const finished = group("finished").sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 25);
	const parts = [`Recommend ${o.count} books for me to read next, based on my library.`];
	if (finished.length) parts.push(`Books I finished (best rated first):\n${finished.map(brief).join("\n")}`);
	if (group("reading").length) parts.push(`I'm reading now:\n${group("reading").slice(0, 10).map(brief).join("\n")}`);
	if (group("to-read").length) parts.push(`Already on my list:\n${group("to-read").slice(0, 20).map(brief).join("\n")}`);
	if (group("wishlist").length) parts.push(`On my wishlist:\n${group("wishlist").slice(0, 20).map(brief).join("\n")}`);
	if (group("abandoned").length) parts.push(`I set these aside:\n${group("abandoned").slice(0, 10).map(brief).join("\n")}`);
	if (o.dismissed.length || o.pending.length) parts.push(`Do not suggest these again: ${[...o.dismissed, ...o.pending].slice(0, 60).join("; ")}`);
	if (!books.length) parts.push("My library is empty, so suggest a varied set of well-loved books.");
	if (o.focus?.trim()) {
		const f = o.focus.trim();
		parts.push(f === "Easier to read for my level" ? `Focus: books I can read comfortably in ${l.learningLanguage} at level ${l.level}.` : `Focus: ${f}`);
	}
	parts.push([
		"Reply with exactly one line per book, in this form and nothing else:",
		"- **Title** — Author — why I would like it (one short sentence that names one of my books it relates to, when there is one)",
	].join("\n"));
	return parts.join("\n\n");
}

/** Read "- **Title** — Author — why" lines out of the librarian's answer. */
export function parseSuggestions(answer: string): { title: string; author?: string; why: string }[] {
	const out: { title: string; author?: string; why: string }[] = [];
	for (const line of answer.split("\n")) {
		const m = /^\s*(?:[-*•]|\d+[.)])?\s*\*\*(.+?)\*\*\s*(?:—|–|-|,|by)\s*(.+)$/.exec(line);
		if (!m) continue;
		const rest = m[2].split(/\s+[—–]\s+/);
		const author = rest.length > 1 ? rest[0].trim() : undefined;
		const why = (rest.length > 1 ? rest.slice(1).join(" — ") : rest[0]).trim();
		if (m[1].trim() && why) out.push({ title: m[1].trim(), author, why });
	}
	return out;
}
