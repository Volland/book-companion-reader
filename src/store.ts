import { BookData, BookFormat, emptyBook } from "./types";

/** Reading positions, highlights, words, page handwriting and AI history for every book. */
export class BookStore {
	books: Record<string, BookData> = {};
	private timer: number | null = null;

	constructor(private persist: () => Promise<void>) {}

	load(raw: unknown) {
		this.books = {};
		if (raw && typeof raw === "object") {
			for (const [k, v] of Object.entries(raw)) {
				const b = v as BookData;
				if (!b || !b.format) continue;
				this.books[k] = { ...emptyBook(k, b.format), ...b, path: k };
			}
		}
	}

	get(path: string, format: BookFormat): BookData {
		let b = this.books[path];
		if (!b) {
			b = emptyBook(path, format);
			this.books[path] = b;
		}
		return b;
	}

	peek(path: string): BookData | undefined {
		return this.books[path];
	}

	rename(oldPath: string, newPath: string) {
		const b = this.books[oldPath];
		if (!b) return;
		delete this.books[oldPath];
		b.path = newPath;
		this.books[newPath] = b;
		this.saveSoon();
	}

	saveSoon(ms = 800) {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.persist();
		}, ms);
	}

	async flush() {
		if (this.timer) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		await this.persist();
	}
}
