import type { InkStroke } from "./types";

export type InkToolName = "pen" | "highlighter" | "eraser";

export interface InkTool {
	tool: InkToolName;
	color: string;
	/** Pen width in pixels at an 800 px wide surface. */
	widthPx: number;
}

export const INK_REFERENCE_WIDTH = 800;
export const SVG_WIDTH = 1000;

// ---------- pure helpers (tested) ----------

export function strokeBounds(s: InkStroke): [number, number, number, number] {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let i = 0; i < s.points.length; i += 3) {
		x0 = Math.min(x0, s.points[i]); x1 = Math.max(x1, s.points[i]);
		y0 = Math.min(y0, s.points[i + 1]); y1 = Math.max(y1, s.points[i + 1]);
	}
	return [x0, y0, x1, y1];
}

/** Remove whole strokes that pass within r of (x, y). Returns the strokes left. */
export function eraseAt(strokes: InkStroke[], x: number, y: number, r: number): InkStroke[] {
	return strokes.filter((s) => {
		for (let i = 0; i < s.points.length; i += 3) {
			const dx = s.points[i] - x, dy = s.points[i + 1] - y;
			if (dx * dx + dy * dy <= r * r) return false;
		}
		return true;
	});
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function unesc(s: string): string {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function strokePath(s: InkStroke, scale: number): string {
	const p = s.points;
	if (p.length < 3) return "";
	const f = (n: number) => (n * scale).toFixed(1);
	let d = `M${f(p[0])} ${f(p[1])}`;
	if (p.length === 3) return d + ` L${f(p[0] + 0.0005)} ${f(p[1])}`;
	// smooth with quadratic curves through midpoints
	for (let i = 3; i < p.length - 3; i += 3) {
		const mx = (p[i] + p[i + 3]) / 2, my = (p[i + 1] + p[i + 4]) / 2;
		d += ` Q${f(p[i])} ${f(p[i + 1])} ${f(mx)} ${f(my)}`;
	}
	d += ` L${f(p[p.length - 3])} ${f(p[p.length - 2])}`;
	return d;
}

function avgPressure(s: InkStroke): number {
	let sum = 0, n = 0;
	for (let i = 2; i < s.points.length; i += 3) { sum += s.points[i]; n++; }
	return n ? sum / n : 0.5;
}

export function strokeWidthFactor(tool: InkStroke["tool"], pressure: number): number {
	return tool === "highlighter" ? 1 : 0.55 + pressure * 0.9;
}

export interface SvgOptions {
	aspect: number; // height / width
	paper?: "lined" | "dotted" | "blank" | "none";
	background?: string;
}

/** Vector picture of the strokes, with the strokes themselves kept inside so it can be edited again. */
export function strokesToSvg(strokes: InkStroke[], opts: SvgOptions): string {
	const W = SVG_WIDTH, H = Math.round(SVG_WIDTH * opts.aspect);
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
		`<metadata id="bcr-ink">${esc(JSON.stringify({ v: 1, aspect: opts.aspect, paper: opts.paper ?? "blank", strokes }))}</metadata>`,
	];
	if (opts.background) out.push(`<rect width="${W}" height="${H}" fill="${opts.background}"/>`);
	if (opts.paper === "lined") {
		for (let y = 80; y < H; y += 44) out.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#a5c8e8" stroke-width="1"/>`);
	} else if (opts.paper === "dotted") {
		out.push(`<defs><pattern id="d" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="20" cy="20" r="1.6" fill="#b8c2cc"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#d)"/>`);
	}
	for (const s of strokes) {
		const d = strokePath(s, W);
		if (!d) continue;
		const w = (s.width * W * strokeWidthFactor(s.tool, avgPressure(s))).toFixed(2);
		const extra = s.tool === "highlighter" ? ` stroke-opacity="0.35" stroke-linecap="square"` : ` stroke-linecap="round"`;
		out.push(`<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="${w}" stroke-linejoin="round"${extra}/>`);
	}
	out.push("</svg>");
	return out.join("\n");
}

export function svgToStrokes(svg: string): { strokes: InkStroke[]; aspect: number; paper: string } | null {
	const m = /<metadata id="bcr-ink">([\s\S]*?)<\/metadata>/.exec(svg);
	if (!m) return null;
	try {
		const data = JSON.parse(unesc(m[1]));
		if (!Array.isArray(data.strokes)) return null;
		return { strokes: data.strokes, aspect: data.aspect ?? 1.3, paper: data.paper ?? "blank" };
	} catch {
		return null;
	}
}

// ---------- drawing surface (DOM) ----------

export interface InkSurfaceOptions {
	getTool: () => InkTool;
	penOnly: () => boolean;
	onChange: (strokes: InkStroke[]) => void;
	/** Draw paper lines etc. under the ink (surface width/height in CSS px). */
	paper?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
	/** With "pen only", a finger drag scrolls instead of drawing. */
	onPan?: (dx: number, dy: number) => void;
}

export class InkSurface {
	canvas: HTMLCanvasElement;
	strokes: InkStroke[] = [];
	private enabled = false;
	private current: InkStroke | null = null;
	private activePointer: number | null = null;
	private undoStack: InkStroke[][] = [];
	private redoStack: InkStroke[][] = [];
	private w = 1;
	private h = 1;
	private pan: { id: number; x: number; y: number } | null = null;

	constructor(private parent: HTMLElement, private opts: InkSurfaceOptions) {
		this.canvas = parent.ownerDocument.createElement("canvas");
		this.canvas.className = "bcr-ink-canvas";
		parent.appendChild(this.canvas);
		this.canvas.addEventListener("pointerdown", this.onDown);
		this.canvas.addEventListener("pointermove", this.onMove);
		this.canvas.addEventListener("pointerup", this.onUp);
		this.canvas.addEventListener("pointercancel", this.onUp);
		this.canvas.addEventListener("pointerleave", this.onUp);
		// Stop iOS from turning pen strokes into scrolling or magnifier gestures.
		this.canvas.addEventListener("touchstart", (e) => { if (this.enabled) e.preventDefault(); }, { passive: false });
		this.setEnabled(false);
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		this.canvas.toggleClass?.("is-drawing", on);
		this.canvas.style.pointerEvents = on ? "auto" : "none";
		this.canvas.style.touchAction = on ? "none" : "auto";
	}

	isEnabled() {
		return this.enabled;
	}

	setStrokes(strokes: InkStroke[]) {
		this.strokes = strokes.slice();
		this.undoStack = [];
		this.redoStack = [];
		this.redraw();
	}

	resize(width?: number, height?: number) {
		this.w = Math.max(1, width ?? this.parent.clientWidth);
		this.h = Math.max(1, height ?? this.parent.clientHeight);
		const dpr = Math.min(2, (globalThis as any).devicePixelRatio || 1);
		this.canvas.width = Math.round(this.w * dpr);
		this.canvas.height = Math.round(this.h * dpr);
		this.canvas.style.width = `${this.w}px`;
		this.canvas.style.height = `${this.h}px`;
		this.redraw();
	}

	undo() {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.strokes);
		this.strokes = prev;
		this.redraw();
		this.opts.onChange(this.strokes);
	}

	redo() {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.strokes);
		this.strokes = next;
		this.redraw();
		this.opts.onChange(this.strokes);
	}

	clear() {
		if (!this.strokes.length) return;
		this.undoStack.push(this.strokes);
		this.strokes = [];
		this.redraw();
		this.opts.onChange(this.strokes);
	}

	redraw() {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const dpr = this.canvas.width / this.w;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.w, this.h);
		this.opts.paper?.(ctx, this.w, this.h);
		for (const s of this.strokes) this.drawStroke(ctx, s);
		if (this.current) this.drawStroke(ctx, this.current);
	}

	private drawStroke(ctx: CanvasRenderingContext2D, s: InkStroke) {
		const p = s.points, W = this.w;
		if (p.length < 3) return;
		ctx.save();
		ctx.strokeStyle = s.color;
		ctx.lineJoin = "round";
		if (s.tool === "highlighter") {
			ctx.globalAlpha = 0.35;
			ctx.lineCap = "square";
			ctx.lineWidth = s.width * W;
			ctx.beginPath();
			ctx.moveTo(p[0] * W, p[1] * W);
			for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i] * W, p[i + 1] * W);
			ctx.stroke();
		} else {
			ctx.lineCap = "round";
			if (p.length === 3) {
				ctx.fillStyle = s.color;
				ctx.beginPath();
				ctx.arc(p[0] * W, p[1] * W, (s.width * W * strokeWidthFactor("pen", p[2])) / 2, 0, Math.PI * 2);
				ctx.fill();
			}
			for (let i = 3; i < p.length; i += 3) {
				ctx.lineWidth = s.width * W * strokeWidthFactor("pen", (p[i - 1] + p[i + 2]) / 2);
				ctx.beginPath();
				ctx.moveTo(p[i - 3] * W, p[i - 2] * W);
				ctx.lineTo(p[i] * W, p[i + 1] * W);
				ctx.stroke();
			}
		}
		ctx.restore();
	}

	private pos(e: PointerEvent): [number, number, number] {
		const r = this.canvas.getBoundingClientRect();
		const scale = r.width ? this.w / r.width : 1;
		const x = ((e.clientX - r.left) * scale) / this.w;
		const y = ((e.clientY - r.top) * scale) / this.w;
		const pr = e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5;
		return [x, y, pr];
	}

	private accepts(e: PointerEvent): boolean {
		if (!this.enabled) return false;
		if (this.opts.penOnly() && e.pointerType === "touch") return false;
		return true;
	}

	private onDown = (e: PointerEvent) => {
		if (this.enabled && this.opts.penOnly() && e.pointerType === "touch") {
			this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
			return;
		}
		if (!this.accepts(e) || this.activePointer !== null) return;
		e.preventDefault();
		this.activePointer = e.pointerId;
		try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not supported */ }
		const tool = this.opts.getTool();
		const [x, y, p] = this.pos(e);
		this.undoStack.push(this.strokes);
		this.redoStack = [];
		if (tool.tool === "eraser") {
			this.current = null;
			this.erase(x, y);
			return;
		}
		const width = (tool.tool === "highlighter" ? tool.widthPx * 6 : tool.widthPx) / INK_REFERENCE_WIDTH;
		this.current = { tool: tool.tool, color: tool.color, width, points: [x, y, p] };
		this.redraw();
	};

	private onMove = (e: PointerEvent) => {
		if (this.pan && e.pointerId === this.pan.id) {
			this.opts.onPan?.(e.clientX - this.pan.x, e.clientY - this.pan.y);
			this.pan.x = e.clientX;
			this.pan.y = e.clientY;
			return;
		}
		if (e.pointerId !== this.activePointer) return;
		e.preventDefault();
		const events = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
		const list = events && events.length ? events : [e];
		if (!this.current) {
			for (const ev of list) { const [x, y] = this.pos(ev); this.erase(x, y); }
			return;
		}
		for (const ev of list) {
			const [x, y, p] = this.pos(ev);
			const pts = this.current.points;
			const dx = x - pts[pts.length - 3], dy = y - pts[pts.length - 2];
			if (dx * dx + dy * dy < 0.0000015) continue;
			pts.push(x, y, p);
		}
		this.redraw();
	};

	private onUp = (e: PointerEvent) => {
		if (this.pan && e.pointerId === this.pan.id) { this.pan = null; return; }
		if (e.pointerId !== this.activePointer) return;
		this.activePointer = null;
		if (this.current) {
			this.strokes = [...this.strokes, this.current];
			this.current = null;
			this.redraw();
		}
		this.opts.onChange(this.strokes);
	};

	private erase(x: number, y: number) {
		const next = eraseAt(this.strokes, x, y, 14 / INK_REFERENCE_WIDTH);
		if (next.length !== this.strokes.length) {
			this.strokes = next;
			this.redraw();
		}
	}

	destroy() {
		this.canvas.remove();
	}
}

/** Paper lines drawn under handwriting (canvas version of the SVG paper). */
export function drawPaper(style: "lined" | "dotted" | "blank", ctx: CanvasRenderingContext2D, w: number, h: number, bg = "#fffdf7") {
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	const s = w / SVG_WIDTH;
	if (style === "lined") {
		ctx.strokeStyle = "#a5c8e8";
		ctx.lineWidth = 1;
		for (let y = 80 * s; y < h; y += 44 * s) {
			ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
		}
	} else if (style === "dotted") {
		ctx.fillStyle = "#b8c2cc";
		for (let y = 20 * s; y < h; y += 40 * s) for (let x = 20 * s; x < w; x += 40 * s) { ctx.beginPath(); ctx.arc(x, y, 1.6 * s, 0, Math.PI * 2); ctx.fill(); }
	}
}
