import type { NotesSettings } from "./settings";
import { Card, Deck, deckToMarkdown } from "./decks";
import { BookMeta, ChatSession, Highlight, Loc, VocabEntry, bookLink, locLabel, locToString } from "./types";
import { COMPANION_SCHEMA, COMPANION_SCHEMA_NAME, LIBRARY_SCHEMA, LIBRARY_SCHEMA_NAME, TypedState, declaresBook, edgeLine } from "./typed";

/** The few vault operations the notes system needs (so it can be tested without Obsidian). */
export interface NotesHost {
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	ensureFolder(path: string): Promise<void>;
	/** Markdown files directly inside a folder (for finding Typed Graph schema notes). */
	list?(folder: string): string[];
}

export type NoteKind = "note" | "ai" | "handwriting";

export function safeName(s: string, max = 80): string {
	const cleaned = s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
	return (cleaned.slice(0, max).trim() || "Untitled").replace(/\.+$/, "");
}

export function today(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function yamlStr(s: string): string {
	return JSON.stringify(s);
}

/** Insert a line at the end of the "## heading" section (creating the section if needed). */
export function insertUnderHeading(content: string, heading: string, line: string): string {
	const lines = content.split("\n");
	const h = `## ${heading}`;
	let start = lines.findIndex((l) => l.trim() === h);
	if (start < 0) {
		const trimmed = content.replace(/\s+$/, "");
		return `${trimmed}\n\n${h}\n${line}\n`;
	}
	let end = start + 1;
	while (end < lines.length && !/^#{1,2} /.test(lines[end])) end++;
	// step back over trailing blank lines of the section
	let insertAt = end;
	while (insertAt - 1 > start && lines[insertAt - 1].trim() === "") insertAt--;
	lines.splice(insertAt, 0, line);
	return lines.join("\n");
}

/** Set (or add) one simple "key: value" field in the YAML front matter. */
export function setFrontmatterField(content: string, key: string, value: string | number): string {
	const v = typeof value === "number" ? String(value) : /^[\w.-]+$/.test(value) ? value : yamlStr(value);
	const m = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!m) return `---\n${key}: ${v}\n---\n${content}`;
	const body = m[1].split("\n");
	const idx = body.findIndex((l) => l.startsWith(`${key}:`));
	if (idx >= 0) body[idx] = `${key}: ${v}`;
	else body.push(`${key}: ${v}`);
	return `---\n${body.join("\n")}\n---` + content.slice(m[0].length);
}

export function getFrontmatterField(content: string, key: string): string | undefined {
	const m = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!m) return undefined;
	const line = m[1].split("\n").find((l) => l.startsWith(`${key}:`));
	return line?.slice(key.length + 1).trim();
}

export const HUB_SECTIONS = ["Highlights", "Notes", "Handwriting", "Vocabulary", "AI explanations", "Discussions"];

export class BookNotes {
	constructor(private host: NotesHost, private settings: () => NotesSettings, private typed: () => TypedState = () => ({ on: false, schemaFolder: "Types" })) {}

	isTyped(): boolean {
		return this.typed().on;
	}

	/**
	 * Make sure Typed Graph knows the types the reader writes: the reader's own schema note, plus Typed Graph's
	 * library ontology (Book, Author, Quote…) unless the vault already declares a Book type.
	 * Returns the schema notes it created.
	 */
	async ensureSchema(force = false): Promise<string[]> {
		const t = this.typed();
		if (!t.on && !force) return [];
		const folder = t.schemaFolder.replace(/\/+$/, "") || "Types";
		const created: string[] = [];
		await this.host.ensureFolder(folder);
		const companion = `${folder}/${COMPANION_SCHEMA_NAME}.md`;
		if (!this.host.exists(companion)) {
			await this.host.write(companion, COMPANION_SCHEMA);
			created.push(companion);
		}
		let hasBook = this.host.exists(`${folder}/Book.md`);
		for (const p of this.host.list?.(folder) ?? []) {
			if (hasBook) break;
			if (p === companion) continue;
			if (declaresBook(await this.host.read(p))) hasBook = true;
		}
		const library = `${folder}/${LIBRARY_SCHEMA_NAME}.md`;
		if (!hasBook && !this.host.exists(library)) {
			await this.host.write(library, LIBRARY_SCHEMA);
			created.push(library);
		}
		return created;
	}

	folder(meta: BookMeta): string {
		const root = this.settings().rootFolder.replace(/\/+$/, "") || "Books";
		return `${root}/${safeName(meta.title)}`;
	}

	hubName(meta: BookMeta): string {
		return safeName(meta.title);
	}

	hubPath(meta: BookMeta): string {
		return `${this.folder(meta)}/${this.hubName(meta)}.md`;
	}

	vocabPath(meta: BookMeta): string {
		return `${this.folder(meta)}/Vocabulary – ${safeName(meta.title, 60)}.md`;
	}

	link(meta: BookMeta, loc?: Loc, text?: string): string {
		return `[${text ?? (locLabel(loc) || "open")}](${bookLink(meta.path, loc)})`;
	}

	private vocabName(meta: BookMeta): string {
		return this.vocabPath(meta).split("/").pop()!.replace(/\.md$/, "");
	}

	hubTemplate(meta: BookMeta): string {
		if (this.isTyped()) return this.typedHubTemplate(meta);
		return [
			"---",
			"type: book",
			`title: ${yamlStr(meta.title)}`,
			`author: ${yamlStr(meta.author ?? "")}`,
			`file: ${yamlStr(`[[${meta.path}]]`)}`,
			`format: ${meta.format}`,
			"status: reading",
			"progress: 0",
			`started: ${today()}`,
			`last_read: ${today()}`,
			"tags:",
			"  - book",
			"---",
			`# ${meta.title}`,
			meta.author ? `*by ${meta.author}*\n` : "",
			`📖 ${this.link(meta, undefined, "Open in the reader")} · [[${meta.path}|Book file]] · [[${this.vocabPath(meta).split("/").pop()!.replace(/\.md$/, "")}|Vocabulary]]`,
			"",
			"## Highlights",
			"",
			"## Notes",
			"",
			"## Handwriting",
			"",
			"## Vocabulary",
			"",
			"## AI explanations",
			"",
			"## Discussions",
			"",
		].join("\n");
	}

	/** Book page as a Typed Graph `Book` (library ontology), with `written_by` to its author. */
	typedHubTemplate(meta: BookMeta): string {
		const author = meta.author?.trim();
		return [
			"---",
			"type: Book",
			`title: ${yamlStr(meta.title)}`,
			`author: ${yamlStr(author ?? "")}`,
			"status: reading",
			"format: ebook",
			`file_format: ${meta.format}`,
			`file: ${yamlStr(`[[${meta.path}]]`)}`,
			"progress: 0",
			`started: ${today()}`,
			`last_read: ${today()}`,
			"tags:",
			"  - book",
			"---",
			`# ${meta.title}`,
			author ? `*by ${author}*\n` : "",
			`📖 ${this.link(meta, undefined, "Open in the reader")} · [[${meta.path}|Book file]] · [[${this.vocabName(meta)}|Vocabulary]]`,
			"",
			"## Highlights",
			"",
			"## Notes",
			"",
			"## Handwriting",
			"",
			"## Vocabulary",
			"",
			"## AI explanations",
			"",
			"## Discussions",
			"",
			"## Links",
			"",
			author ? edgeLine("written_by", safeName(author), { role: "author" }) : "<!-- add written_by:: [[Author]] here -->",
			"",
		].join("\n");
	}

	async ensureHub(meta: BookMeta): Promise<string> {
		const path = this.hubPath(meta);
		if (!this.host.exists(path)) {
			await this.ensureSchema().catch(() => []);
			await this.host.ensureFolder(this.folder(meta));
			await this.host.write(path, this.hubTemplate(meta));
		}
		return path;
	}

	private async appendToHub(meta: BookMeta, section: string, line: string): Promise<void> {
		const path = await this.ensureHub(meta);
		const content = await this.host.read(path);
		await this.host.write(path, insertUnderHeading(content, section, line));
	}

	async addHighlight(meta: BookMeta, h: Highlight): Promise<void> {
		if (!this.settings().highlightsToBookPage) return;
		const quote = h.text.replace(/\s+/g, " ").trim();
		await this.appendToHub(meta, "Highlights", `- ==${quote}== — ${this.link(meta, h.loc)} ^${h.id}`);
	}

	async removeHighlight(meta: BookMeta, h: Highlight): Promise<void> {
		const path = this.hubPath(meta);
		if (!this.host.exists(path)) return;
		const content = await this.host.read(path);
		const next = content.split("\n").filter((l) => !l.endsWith(`^${h.id}`)).join("\n");
		if (next !== content) await this.host.write(path, next);
	}

	private async uniquePath(folder: string, base: string): Promise<string> {
		await this.host.ensureFolder(folder);
		let p = `${folder}/${base}.md`;
		for (let i = 2; this.host.exists(p); i++) p = `${folder}/${base} ${i}.md`;
		return p;
	}

	/** A note of its own, linked to the book page and back to the exact place in the book. */
	async createNote(meta: BookMeta, opts: { quote?: string; loc?: Loc; body: string; title?: string; tags?: string[]; section?: string; embed?: string; kind?: NoteKind; action?: string }): Promise<string> {
		await this.ensureHub(meta);
		const quote = (opts.quote ?? "").replace(/\s+/g, " ").trim();
		const title = safeName(opts.title || (quote ? quote.split(" ").slice(0, 7).join(" ") : `Note ${locLabel(opts.loc)}`), 60);
		const path = await this.uniquePath(`${this.folder(meta)}/Notes`, `${today()} ${title}`);
		const tags = ["book-note", ...(opts.tags ?? [])];
		const kind = opts.kind ?? "note";
		const typed = this.isTyped();
		const hub = this.hubName(meta);
		const locStr = locToString(opts.loc);
		const lines = ["---"];
		if (typed) {
			const base = kind === "ai" ? "Explanation" : kind === "handwriting" ? "Handwriting" : "ReadingNote";
			lines.push(quote ? `type: [${base}, Quote]` : `type: ${base}`);
			if (opts.action) lines.push(`action: ${yamlStr(opts.action)}`);
			if (quote && opts.loc?.page != null) lines.push(`page: ${opts.loc.page}`);
			if (quote) lines.push(`saved: ${today()}`);
		} else {
			lines.push("type: book-note");
		}
		lines.push(
			`book: ${yamlStr(`[[${hub}]]`)}`,
			`location: ${yamlStr(locStr)}`,
			`created: ${today()}`,
			"tags:",
			...tags.map((t) => `  - ${t}`),
			"---",
		);
		if (quote) lines.push(`> ${quote}`, `> — [[${hub}]], ${this.link(meta, opts.loc)}`, "");
		else lines.push(`From [[${hub}]], ${this.link(meta, opts.loc)}`, "");
		if (opts.embed) lines.push(`![[${opts.embed}]]`, "");
		lines.push(opts.body.trim(), "");
		if (typed) {
			lines.push("## Links", "");
			if (kind === "ai") lines.push(edgeLine("explains", hub, { loc: locStr, action: opts.action }));
			else lines.push(edgeLine("note_on", hub, { loc: locStr }));
			if (quote) lines.push(edgeLine("quoted_from", hub));
			lines.push("");
		}
		await this.host.write(path, lines.join("\n"));
		const name = path.split("/").pop()!.replace(/\.md$/, "");
		await this.appendToHub(meta, opts.section ?? "Notes", `- [[${name}]] — ${this.link(meta, opts.loc)}`);
		return path;
	}

	async saveAiAnswer(meta: BookMeta, action: string, quote: string, answer: string, loc?: Loc): Promise<string> {
		return this.createNote(meta, { quote, loc, body: `**${action}**\n\n${answer}`, title: `${action} – ${quote.split(/\s+/).slice(0, 5).join(" ")}`, tags: ["ai-explanation"], section: "AI explanations", kind: "ai", action });
	}

	async addVocabulary(meta: BookMeta, entries: VocabEntry[]): Promise<string> {
		const path = this.vocabPath(meta);
		await this.ensureHub(meta);
		if (!this.host.exists(path)) {
			const typed = this.isTyped();
			await this.host.write(path, [
				"---",
				typed ? "type: Vocabulary" : "type: vocabulary",
				`book: ${yamlStr(`[[${this.hubName(meta)}]]`)}`,
				"---",
				`#${this.settings().flashcardTag}`,
				"",
				`# Vocabulary from ${meta.title}`,
				"",
				...(typed ? [edgeLine("vocabulary_of", this.hubName(meta)), ""] : []),
				"Each line is a flashcard: word :: meaning.",
				"",
			].join("\n"));
			await this.appendToHub(meta, "Vocabulary", `- [[${path.split("/").pop()!.replace(/\.md$/, "")}]]`);
		}
		let content = await this.host.read(path);
		for (const e of entries) {
			if (new RegExp(`^${escapeRe(e.word)} ::`, "mi").test(content)) continue;
			content = content.replace(/\s+$/, "") + `\n${e.word} :: ${e.definition}` + (e.loc ? ` ${this.link(meta, e.loc)}` : "") + "\n";
			if (e.context) content += `<!-- ${e.context.replace(/-->/g, "").slice(0, 200)} -->\n`;
		}
		await this.host.write(path, content);
		return path;
	}

	/**
	 * A talk with the reading cat as a note in the book's Chats folder, linked from the book page. The transcript sits between
	 * two markers and is rewritten as the talk goes on; anything you write outside them is kept.
	 */
	async saveChat(meta: BookMeta, session: ChatSession): Promise<string> {
		const hub = this.hubName(meta);
		await this.ensureHub(meta);
		const callout = (kind: string, title: string, body: string[]) => [`> [!${kind}] ${title}`, ...body.map((l) => (l ? `> ${l}` : ">"))];
		const lines: string[] = [];
		for (const m of session.messages) {
			if (!m.text.trim() || m.error) continue;
			if (m.role === "user") {
				const place = m.loc ? ` · ${this.link(meta, m.loc)}` : "";
				const body = [...(m.quote ? [`> ${m.quote.replace(/\s+/g, " ").trim()}`, ""] : []), ...m.text.trim().split("\n")];
				lines.push(...callout("question", `You${place}`, body), "");
			} else lines.push(...callout("tip", "🐱 Cat", m.text.trim().split("\n")), "");
		}
		const block = `<!-- chat:start -->\n${lines.join("\n")}\n<!-- chat:end -->`;
		let path = session.notePath;
		if (path && this.host.exists(path)) {
			const old = await this.host.read(path);
			const next = /<!-- chat:start -->[\s\S]*<!-- chat:end -->/.test(old) ? old.replace(/<!-- chat:start -->[\s\S]*<!-- chat:end -->/, () => block) : `${old.replace(/\s+$/, "")}\n\n${block}\n`;
			if (next !== old) await this.host.write(path, next);
			return path;
		}
		path = await this.uniquePath(`${this.folder(meta)}/Chats`, `${today()} ${safeName(session.title, 50)}`);
		const typed = this.isTyped();
		const head = [
			"---",
			typed ? "type: ReadingNote" : "type: book-chat",
			`book: ${yamlStr(`[[${hub}]]`)}`,
			`created: ${today(new Date(session.created))}`,
			...(session.language ? [`language: ${yamlStr(session.language)}`] : []),
			"tags:",
			"  - book-chat",
			"---",
			`# 🐱 ${session.title}`,
			`A talk with the reading cat about [[${hub}]] · ${this.link(meta, undefined, "Open in the reader")}`,
			"",
			block,
			"",
		];
		if (typed) head.push("## Links", "", edgeLine("note_on", hub), "");
		await this.host.write(path, head.join("\n"));
		session.notePath = path;
		await this.appendToHub(meta, "Discussions", `- [[${path.split("/").pop()!.replace(/\.md$/, "")}]] — ${today(new Date(session.created))}`);
		return path;
	}

	/** A deck as a note in the Books folder, in the "word :: meaning" format flashcard plugins read. */
	async exportDeck(deck: Deck, cards: Card[]): Promise<string> {
		const root = this.settings().rootFolder.replace(/\/+$/, "") || "Books";
		const folder = `${root}/Flashcards`;
		await this.host.ensureFolder(folder);
		const path = `${folder}/${safeName(deck.name, 60)}.md`;
		await this.host.write(path, deckToMarkdown(deck, cards, this.settings().flashcardTag));
		return path;
	}

	async saveHandwriting(meta: BookMeta, svg: string, loc?: Loc, quote?: string, existingPath?: string): Promise<{ svgPath: string; notePath?: string }> {
		await this.ensureHub(meta);
		if (existingPath) {
			await this.host.write(existingPath, svg);
			return { svgPath: existingPath };
		}
		const folder = `${this.folder(meta)}/Handwriting`;
		await this.host.ensureFolder(folder);
		let svgPath = `${folder}/${today()} ${safeName(locLabel(loc) || "page")}.svg`;
		for (let i = 2; this.host.exists(svgPath); i++) svgPath = `${folder}/${today()} ${safeName(locLabel(loc) || "page")} ${i}.svg`;
		await this.host.write(svgPath, svg);
		const svgName = svgPath.split("/").pop()!;
		const notePath = await this.createNote(meta, { quote, loc, body: "", title: `Handwritten ${locLabel(loc)}`, tags: ["handwriting"], section: "Handwriting", embed: svgName, kind: "handwriting" });
		return { svgPath, notePath };
	}

	async updateProgress(meta: BookMeta, progress: number): Promise<void> {
		const path = this.hubPath(meta);
		if (!this.host.exists(path)) return;
		const content = await this.host.read(path);
		let next = setFrontmatterField(content, "progress", Math.round(progress * 100));
		next = setFrontmatterField(next, "last_read", today());
		if (progress >= 0.99 && getFrontmatterField(next, "status") !== "finished") {
			next = setFrontmatterField(next, "status", "finished");
			next = setFrontmatterField(next, "finished", today());
		}
		if (next !== content) await this.host.write(path, next);
	}
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
