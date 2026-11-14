import type { Loc } from "./types";

/** The parts of pdf.js that we use (Obsidian hands it to us untyped). */
export interface PdfViewport { width: number; height: number }
export interface PdfTextItem { str?: string; hasEOL?: boolean }
export interface PdfRenderTask { promise: Promise<void>; cancel(): void }
export interface PdfPage {
	getViewport(o: { scale: number }): PdfViewport;
	render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
export interface PdfOutlineItem { title: string; dest?: string | unknown[] | null; items?: PdfOutlineItem[] }
export interface PdfDoc {
	numPages: number;
	getPage(n: number): Promise<PdfPage>;
	getMetadata(): Promise<{ info?: { Title?: string; Author?: string } }>;
	getOutline(): Promise<PdfOutlineItem[] | null>;
	getDestination(id: string): Promise<unknown[] | null>;
	getPageIndex(ref: unknown): Promise<number>;
	destroy(): unknown;
}
interface TextLayerOptions { textContentSource: unknown; container: HTMLElement; viewport: PdfViewport; textContent?: unknown; textDivs?: unknown[] }
export interface PdfJs {
	getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc> };
	TextLayer?: new (o: TextLayerOptions) => { render(): Promise<void> };
	renderTextLayer?(o: TextLayerOptions): { promise: Promise<void> };
}

const itemsText = (items: PdfTextItem[]) => items.map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : " ")).join("");

export interface PageSlot {
	num: number;
	el: HTMLElement;
	width: number;
	height: number;
	rendered: boolean;
	rendering: boolean;
	canvas?: HTMLCanvasElement;
	textLayer?: HTMLElement;
	task?: PdfRenderTask;
}

export interface PdfCallbacks {
	onLocation(loc: Loc, progress: number, label: string): void;
	onPageRendered(slot: PageSlot): void;
	onPageReleased(slot: PageSlot): void;
}

const MAX_RENDERED = 10;

export class PdfRenderer {
	doc: PdfDoc | null = null;
	numPages = 0;
	viewport: HTMLElement;
	private pagesEl: HTMLElement;
	slots: PageSlot[] = [];
	zoom = 1;
	private baseWidth = 612;
	private baseHeight = 792;
	private sizes = new Map<number, [number, number]>();
	private observer: IntersectionObserver | null = null;
	private renderOrder: number[] = [];
	private textCache = new Map<number, string>();
	current = 1;
	private resizeObs: ResizeObserver | null = null;
	private lastWidth = 0;

	constructor(private parent: HTMLElement, private pdfjs: PdfJs, private cb: PdfCallbacks) {
		this.viewport = parent.createDiv({ cls: "bcr-pdf-viewport" });
		this.pagesEl = this.viewport.createDiv({ cls: "bcr-pdf-pages" });
		this.viewport.addEventListener("scroll", () => this.trackCurrent());
	}

	async open(data: ArrayBuffer) {
		const doc = await this.pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
		this.doc = doc;
		this.numPages = doc.numPages;
		const first = await doc.getPage(1);
		const vp = first.getViewport({ scale: 1 });
		this.baseWidth = vp.width;
		this.baseHeight = vp.height;
		for (let i = 1; i <= this.numPages; i++) {
			const el = this.pagesEl.createDiv({ cls: "bcr-page" });
			el.dataset.page = String(i);
			el.createDiv({ cls: "bcr-page-num bcr-skip-hl", text: String(i) });
			this.slots.push({ num: i, el, width: 0, height: 0, rendered: false, rendering: false });
		}
		this.layoutSizes();
		if (typeof IntersectionObserver !== "undefined") {
			this.observer = new IntersectionObserver((entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						const n = parseInt((e.target as HTMLElement).dataset.page ?? "0", 10);
						const slot = this.slots[n - 1];
						if (slot) void this.renderPage(slot);
					}
				}
			}, { root: this.viewport, rootMargin: "400px 0px" });
			for (const s of this.slots) this.observer.observe(s.el);
		}
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObs = new ResizeObserver(() => {
				const w = this.viewport.clientWidth;
				if (Math.abs(w - this.lastWidth) > 4) this.setZoom(this.zoom);
			});
			this.resizeObs.observe(this.viewport);
		}
	}

	async metadata(): Promise<{ title?: string; author?: string }> {
		try {
			const m = await this.doc?.getMetadata();
			return { title: m?.info?.Title || undefined, author: m?.info?.Author || undefined };
		} catch {
			return {};
		}
	}

	/** Scale so a page fits the width, times the reader's zoom. */
	private scaleFor(num: number): number {
		const avail = Math.max(200, this.viewport.clientWidth - 24);
		const [w] = this.sizes.get(num) ?? [this.baseWidth, this.baseHeight];
		return (Math.min(avail, 1000) / w) * this.zoom;
	}

	private layoutSizes() {
		this.lastWidth = this.viewport.clientWidth;
		for (const s of this.slots) {
			const [w, h] = this.sizes.get(s.num) ?? [this.baseWidth, this.baseHeight];
			const sc = this.scaleFor(s.num);
			s.width = Math.floor(w * sc);
			s.height = Math.floor(h * sc);
			s.el.setCssProps({ width: `${s.width}px`, height: `${s.height}px` });
		}
	}

	setZoom(z: number) {
		const keep = this.current;
		this.zoom = Math.max(0.5, Math.min(4, z));
		for (const s of this.slots) this.release(s);
		this.layoutSizes();
		this.goto(keep);
	}

	async renderPage(slot: PageSlot) {
		if (slot.rendered || slot.rendering || !this.doc) return;
		slot.rendering = true;
		try {
			const page = await this.doc.getPage(slot.num);
			const base = page.getViewport({ scale: 1 });
			if (!this.sizes.has(slot.num)) {
				this.sizes.set(slot.num, [base.width, base.height]);
				const sc0 = this.scaleFor(slot.num);
				slot.width = Math.floor(base.width * sc0);
				slot.height = Math.floor(base.height * sc0);
				slot.el.setCssProps({ width: `${slot.width}px`, height: `${slot.height}px` });
			}
			const scale = this.scaleFor(slot.num);
			const vp = page.getViewport({ scale });
			let dpr = Math.min(2, window.devicePixelRatio || 1);
			// keep each canvas under ~12 megapixels (phones run out of memory otherwise)
			while (vp.width * vp.height * dpr * dpr > 12e6 && dpr > 1) dpr -= 0.25;
			const canvas = slot.el.createEl("canvas", { cls: "bcr-page-canvas" });
			canvas.width = Math.floor(vp.width * dpr);
			canvas.height = Math.floor(vp.height * dpr);
			canvas.setCssProps({ width: `${Math.floor(vp.width)}px`, height: `${Math.floor(vp.height)}px` });
			slot.el.setCssProps({ "--scale-factor": String(scale), "--total-scale-factor": String(scale), "--user-unit": "1" });
			slot.el.prepend(canvas);
			const ctx = canvas.getContext("2d")!;
			const task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
			slot.task = task;
			await task.promise;
			slot.canvas = canvas;

			const tl = slot.el.createDiv({ cls: "textLayer bcr-textLayer bcr-selectable" });
			slot.textLayer = tl;
			const textContent = await page.getTextContent();
			this.textCache.set(slot.num, itemsText(textContent.items));
			try {
				if (this.pdfjs.TextLayer) {
					const layer = new this.pdfjs.TextLayer({ textContentSource: textContent, container: tl, viewport: vp });
					await layer.render();
				} else if (this.pdfjs.renderTextLayer) {
					await this.pdfjs.renderTextLayer({ textContentSource: textContent, textContent, container: tl, viewport: vp, textDivs: [] }).promise;
				}
			} catch (e) {
				console.warn("Book Companion: text layer failed", e);
			}
			slot.rendered = true;
			this.renderOrder.push(slot.num);
			this.cb.onPageRendered(slot);
			this.evict();
		} catch (e) {
			if ((e as { name?: string } | null)?.name !== "RenderingCancelledException") console.warn("Book Companion: page render failed", e);
		} finally {
			slot.rendering = false;
		}
	}

	private evict() {
		while (this.renderOrder.length > MAX_RENDERED) {
			// drop the rendered page farthest from where the reader is
			let far = 0;
			for (let i = 1; i < this.renderOrder.length; i++) {
				if (Math.abs(this.renderOrder[i] - this.current) > Math.abs(this.renderOrder[far] - this.current)) far = i;
			}
			const n = this.renderOrder.splice(far, 1)[0];
			this.release(this.slots[n - 1]);
		}
	}

	release(slot: PageSlot) {
		if (!slot) return;
		try { slot.task?.cancel?.(); } catch { /* ignore */ }
		if (slot.canvas) { slot.canvas.width = 0; slot.canvas.height = 0; slot.canvas.remove(); }
		slot.textLayer?.remove();
		for (const c of Array.from(slot.el.querySelectorAll(".bcr-ink-canvas"))) c.remove();
		const wasRendered = slot.rendered;
		slot.canvas = undefined;
		slot.textLayer = undefined;
		slot.rendered = false;
		this.renderOrder = this.renderOrder.filter((n) => n !== slot.num);
		if (wasRendered) this.cb.onPageReleased(slot);
		// render again if still on screen
		if (this.observer) { this.observer.unobserve(slot.el); this.observer.observe(slot.el); }
	}

	private trackCurrent() {
		const top = this.viewport.scrollTop + this.viewport.clientHeight * 0.35;
		let cur = 1;
		for (const s of this.slots) {
			if (s.el.offsetTop <= top) cur = s.num;
			else break;
		}
		if (cur !== this.current) {
			this.current = cur;
		}
		this.report();
	}

	private report() {
		this.cb.onLocation({ page: this.current }, this.numPages ? this.current / this.numPages : 0, `Page ${this.current} of ${this.numPages}`);
	}

	goto(page: number) {
		const p = Math.max(1, Math.min(this.numPages, page));
		const slot = this.slots[p - 1];
		if (!slot) return;
		this.current = p;
		this.viewport.scrollTop = slot.el.offsetTop - 8;
		void this.renderPage(slot);
		this.report();
	}

	next() { this.goto(this.current + 1); }
	prev() { this.goto(this.current - 1); }

	async pageText(num: number): Promise<string> {
		if (this.textCache.has(num)) return this.textCache.get(num)!;
		if (!this.doc) return "";
		const page = await this.doc.getPage(num);
		const tc = await page.getTextContent();
		const t = itemsText(tc.items);
		this.textCache.set(num, t);
		return t;
	}

	async outline(): Promise<{ title: string; page: number; depth: number }[]> {
		const out: { title: string; page: number; depth: number }[] = [];
		const doc = this.doc;
		let items: PdfOutlineItem[] | null = null;
		try { items = (await doc?.getOutline()) ?? null; } catch { items = null; }
		if (!doc || !items) return out;
		const walk = async (list: PdfOutlineItem[], depth: number) => {
			for (const it of list) {
				let page = 0;
				try {
					let dest: unknown = it.dest;
					if (typeof dest === "string") dest = await doc.getDestination(dest);
					if (Array.isArray(dest) && dest[0]) page = typeof dest[0] === "number" ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
				} catch { /* unresolved */ }
				if (page) out.push({ title: it.title, page, depth });
				if (it.items?.length) await walk(it.items, depth + 1);
			}
		};
		await walk(items, 0);
		return out;
	}

	destroy() {
		this.observer?.disconnect();
		this.resizeObs?.disconnect();
		for (const s of this.slots) this.release(s);
		try { this.doc?.destroy(); } catch { /* ignore */ }
		this.viewport.remove();
	}
}
