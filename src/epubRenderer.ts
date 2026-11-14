import { sanitizeHTMLToDom } from "obsidian";
import { EpubBook, chapterHtml, mimeFor } from "./epub";
import type { Loc } from "./types";

export interface EpubViewOptions {
	layout: "paged" | "scroll";
	fontSize: number;
	lineHeight: number;
	fontFamily: "serif" | "sans" | "theme";
}

export interface RendererCallbacks {
	onLocation(loc: Loc, progress: number, label: string): void;
	onRendered(root: HTMLElement, key: string): void;
}

const GAP = 48;
const MAX_COLUMN = 720;

type DomParserLike = { parseFromString(s: string, type: string): Document };

export class EpubRenderer {
	chapter = 0;
	page = 0;
	pages = 1;
	viewport: HTMLElement;
	clip: HTMLElement;
	content: HTMLElement;
	private footer: HTMLElement;
	private blobUrls = new Map<string, string>();
	private resizeObs: ResizeObserver | null = null;
	private colW = 600;
	private lastW = 0;
	private lastH = 0;

	constructor(private parent: HTMLElement, public book: EpubBook, private parser: DomParserLike, public opts: EpubViewOptions, private cb: RendererCallbacks) {
		this.viewport = parent.createDiv({ cls: "bcr-epub-viewport" });
		this.clip = this.viewport.createDiv({ cls: "bcr-epub-clip" });
		this.content = this.clip.createDiv({ cls: "bcr-epub-content bcr-selectable" });
		this.footer = this.viewport.createDiv({ cls: "bcr-epub-footer" });

		this.content.addEventListener("click", (e) => {
			const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-bcr-chapter]");
			if (!a) return;
			e.preventDefault();
			const idx = parseInt(a.getAttribute("data-bcr-chapter") ?? "-1", 10);
			if (idx >= 0) void this.showChapter(idx, 0, a.getAttribute("data-bcr-fragment") ?? undefined);
		});
		this.viewport.addEventListener("scroll", () => { if (this.opts.layout === "scroll") this.report(); });
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObs = new ResizeObserver(() => this.relayout());
			this.resizeObs.observe(this.viewport);
		}
		this.applyOptions(opts);
	}

	applyOptions(opts: EpubViewOptions) {
		const frac = this.getLoc().frac ?? 0;
		this.opts = opts;
		this.viewport.toggleClass?.("is-paged", opts.layout === "paged");
		this.viewport.toggleClass?.("is-scroll", opts.layout === "scroll");
		this.viewport.classList.toggle("is-paged", opts.layout === "paged");
		this.viewport.classList.toggle("is-scroll", opts.layout === "scroll");
		this.content.setCssProps({ "font-size": `${opts.fontSize}px`, "line-height": String(opts.lineHeight) });
		this.content.dataset.font = opts.fontFamily;
		this.lastW = 0;
		this.relayout(frac);
	}

	private resource(path: string): string | undefined {
		const cached = this.blobUrls.get(path);
		if (cached) return cached;
		const data = this.book.files[path];
		if (!data || typeof URL === "undefined" || !URL.createObjectURL) return undefined;
		const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mimeFor(path) }));
		this.blobUrls.set(path, url);
		return url;
	}

	async show(loc?: Loc) {
		const ch = Math.min(Math.max(loc?.chapter ?? 0, 0), this.book.chapters.length - 1);
		await this.showChapter(ch, loc?.frac ?? 0);
	}

	async showChapter(index: number, frac = 0, fragment?: string, atEnd = false) {
		if (index < 0 || index >= this.book.chapters.length) return;
		this.chapter = index;
		const html = chapterHtml(this.book, index, this.parser);
		const frag = sanitizeHTMLToDom(html);
		this.content.empty?.();
		while (this.content.firstChild) this.content.removeChild(this.content.firstChild);
		this.content.appendChild(frag);
		for (const img of Array.from(this.content.querySelectorAll<HTMLImageElement>("img[data-bcr-src]"))) {
			const url = this.resource(img.getAttribute("data-bcr-src")!);
			if (url) img.src = url;
			img.addEventListener("load", () => this.relayout());
		}
		// links that leave the book open in the browser
		for (const a of Array.from(this.content.querySelectorAll("a[href^='http']"))) {
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noopener");
		}
		const isLast = index === this.book.chapters.length - 1;
		this.footer.textContent = "";
		if (this.opts.layout === "scroll") {
			const btn = this.footer.createEl("button", { cls: "bcr-next-chapter" });
			btn.textContent = isLast ? "The end" : `Next: ${this.book.chapters[index + 1].title} ›`;
			btn.disabled = isLast;
			btn.addEventListener("click", () => void this.showChapter(index + 1));
		}
		this.cb.onRendered(this.content, `c${index}`);
		this.lastW = 0;
		this.relayout(atEnd ? 1 : frac);
		if (fragment) this.goToFragment(fragment);
		this.report();
	}

	/** Recompute columns (paged) after a size or font change, keeping the reading position. */
	relayout(keepFrac?: number) {
		const W = this.viewport.clientWidth, H = this.viewport.clientHeight;
		if (keepFrac === undefined && W === this.lastW && H === this.lastH) return;
		const frac = keepFrac ?? (this.getLoc().frac ?? 0);
		this.lastW = W;
		this.lastH = H;
		if (this.opts.layout === "paged") {
			this.colW = Math.max(200, Math.min(MAX_COLUMN, W - 40));
			const innerH = Math.max(200, H - 56);
			this.clip.setCssProps({ width: `${this.colW}px`, height: `${innerH}px` });
			this.content.setCssProps({ width: `${this.colW}px`, height: `${innerH}px`, "column-width": `${this.colW}px`, "column-gap": `${GAP}px`, "--bcr-img-max-h": `${innerH - 20}px` });
			this.pages = Math.max(1, Math.round((this.content.scrollWidth + GAP) / (this.colW + GAP)));
			this.setPage(Math.min(this.pages - 1, Math.round(frac * this.pages)));
		} else {
			this.clip.setCssProps({ width: "", height: "" });
			this.content.setCssProps({ width: "", height: "", "column-width": "", "column-gap": "", transform: "", "--bcr-img-max-h": "" });
			const max = this.viewport.scrollHeight - this.viewport.clientHeight;
			this.viewport.scrollTop = frac * Math.max(0, max);
		}
	}

	private setPage(p: number) {
		this.page = Math.max(0, Math.min(this.pages - 1, p));
		this.content.setCssProps({ transform: `translateX(${-this.page * (this.colW + GAP)}px)` });
		this.footer.textContent = this.pages > 1 ? `${this.book.chapters[this.chapter].title} · ${this.page + 1} / ${this.pages}` : this.book.chapters[this.chapter].title;
		this.report();
	}

	private goToFragment(id: string) {
		const el = this.content.querySelector<HTMLElement>(`[id="${CSS?.escape ? CSS.escape(id) : id}"]`);
		if (!el) return;
		if (this.opts.layout === "paged") {
			const base = this.content.getBoundingClientRect();
			const r = el.getBoundingClientRect();
			const x = r.left - base.left; // already includes current transform offset
			this.setPage(Math.floor(x / (this.colW + GAP)));
		} else {
			el.scrollIntoView();
		}
	}

	getLoc(): Loc {
		if (this.opts.layout === "paged") return { chapter: this.chapter, frac: this.pages > 1 ? this.page / this.pages : 0 };
		const max = this.viewport.scrollHeight - this.viewport.clientHeight;
		return { chapter: this.chapter, frac: max > 0 ? Math.min(1, this.viewport.scrollTop / max) : 0 };
	}

	progress(): number {
		const n = this.book.chapters.length;
		return Math.min(1, (this.chapter + (this.getLoc().frac ?? 0)) / n);
	}

	private report() {
		const loc = this.getLoc();
		this.cb.onLocation(loc, this.progress(), `${this.book.chapters[this.chapter].title} · ${Math.round(this.progress() * 100)}%`);
	}

	async next() {
		if (this.opts.layout === "paged") {
			if (this.page < this.pages - 1) this.setPage(this.page + 1);
			else if (this.chapter < this.book.chapters.length - 1) await this.showChapter(this.chapter + 1, 0);
		} else {
			const max = this.viewport.scrollHeight - this.viewport.clientHeight;
			if (this.viewport.scrollTop >= max - 2) {
				if (this.chapter < this.book.chapters.length - 1) await this.showChapter(this.chapter + 1, 0);
			} else this.viewport.scrollTop += this.viewport.clientHeight * 0.9;
		}
	}

	async prev() {
		if (this.opts.layout === "paged") {
			if (this.page > 0) this.setPage(this.page - 1);
			else if (this.chapter > 0) await this.showChapter(this.chapter - 1, 0, undefined, true);
		} else {
			if (this.viewport.scrollTop <= 2) {
				if (this.chapter > 0) await this.showChapter(this.chapter - 1, 0, undefined, true);
			} else this.viewport.scrollTop -= this.viewport.clientHeight * 0.9;
		}
	}

	/** The text the reader can see right now (for "Study this page"). */
	visibleText(): string {
		const vr = this.clip.getBoundingClientRect();
		const blocks = Array.from(this.content.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, td"));
		const out: string[] = [];
		for (const b of blocks) {
			if (b.querySelector("p, li, blockquote")) continue;
			const r = b.getBoundingClientRect();
			const visible = this.opts.layout === "paged" ? r.right > vr.left + 1 && r.left < vr.right - 1 : r.bottom > this.viewport.getBoundingClientRect().top && r.top < this.viewport.getBoundingClientRect().bottom;
			if (visible && b.textContent?.trim()) out.push(b.textContent.trim());
		}
		const text = out.join("\n\n");
		return text || (this.content.textContent ?? "").slice(0, 4000);
	}

	chapterText(): string {
		return this.content.textContent ?? "";
	}

	destroy() {
		this.resizeObs?.disconnect();
		for (const url of this.blobUrls.values()) URL.revokeObjectURL?.(url);
		this.blobUrls.clear();
		this.viewport.remove();
	}
}
