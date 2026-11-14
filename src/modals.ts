import { App, FuzzySuggestModal, FuzzyMatch, Modal, Notice, setIcon } from "obsidian";
import { InkStroke } from "./types";
import { InkSurface, InkTool, InkToolName, drawPaper, strokesToSvg } from "./ink";
import type { InkSettings } from "./settings";

export const INK_COLORS = ["#1b1b1b", "#1c7ed6", "#e03131", "#2f9e44", "#f59f00"];

/** Write a note about a quote. */
export class NoteModal extends Modal {
	constructor(app: App, private quote: string, private where: string, private onSave: (text: string) => void | Promise<void>, private initial = "") {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("bcr-modal");
		this.titleEl.setText("New note");
		if (this.quote) contentEl.createEl("blockquote", { cls: "bcr-modal-quote", text: this.quote });
		contentEl.createDiv({ cls: "bcr-muted", text: this.where });
		const ta = contentEl.createEl("textarea", { cls: "bcr-note-input", attr: { placeholder: "Your thoughts… (links like [[Another note]] work)", rows: "7" } });
		ta.value = this.initial;
		const row = contentEl.createDiv({ cls: "bcr-modal-buttons" });
		row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const save = row.createEl("button", { text: "Save note", cls: "mod-cta" });
		save.onclick = async () => {
			save.disabled = true;
			await this.onSave(ta.value);
			this.close();
		};
		window.setTimeout(() => ta.focus(), 50);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Ask a free question or type a page number. */
export class TextPromptModal extends Modal {
	constructor(app: App, private title: string, private placeholder: string, private onSubmit: (text: string) => void, private multiline = false) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("bcr-modal");
		this.titleEl.setText(this.title);
		const input = this.multiline
			? this.contentEl.createEl("textarea", { cls: "bcr-note-input", attr: { placeholder: this.placeholder, rows: "4" } })
			: this.contentEl.createEl("input", { cls: "bcr-text-input", attr: { placeholder: this.placeholder, type: "text" } });
		const submit = () => {
			const v = input.value.trim();
			if (!v) return;
			this.close();
			this.onSubmit(v);
		};
		(input as HTMLElement).addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (!this.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
		});
		const row = this.contentEl.createDiv({ cls: "bcr-modal-buttons" });
		row.createEl("button", { text: "OK", cls: "mod-cta" }).onclick = submit;
		window.setTimeout(() => input.focus(), 50);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export interface TocEntry {
	title: string;
	depth: number;
	go: () => void;
}

export class TocModal extends FuzzySuggestModal<TocEntry> {
	constructor(app: App, private entries: TocEntry[]) {
		super(app);
		this.setPlaceholder("Jump to a chapter…");
	}
	getItems() { return this.entries; }
	getItemText(e: TocEntry) { return e.title; }
	renderSuggestion(item: FuzzyMatch<TocEntry>, el: HTMLElement) {
		el.createDiv({ cls: "bcr-toc-item", text: item.item.title }).setCssProps({ "--bcr-indent": `${item.item.depth * 14}px` });
	}
	onChooseItem(e: TocEntry) { e.go(); }
}

/** Build the pen / highlighter / eraser / colour / undo bar used by both handwriting modes. */
export function buildInkToolbar(parent: HTMLElement, state: { tool: InkTool }, actions: { undo: () => void; redo: () => void; clear?: () => void; done?: () => void; doneLabel?: string }): HTMLElement {
	const bar = parent.createDiv({ cls: "bcr-ink-toolbar" });
	const toolBtns: Record<string, HTMLElement> = {};
	const tools: [InkToolName, string, string][] = [["pen", "pen-tool", "Pen"], ["highlighter", "highlighter", "Highlighter"], ["eraser", "eraser", "Eraser"]];
	for (const [t, icon, label] of tools) {
		const b = bar.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = () => { state.tool = { ...state.tool, tool: t }; refresh(); };
		toolBtns[t] = b;
	}
	bar.createDiv({ cls: "bcr-sep" });
	const swatches: HTMLElement[] = [];
	for (const c of INK_COLORS) {
		const sw = bar.createEl("button", { cls: "bcr-swatch", attr: { "aria-label": `Colour ${c}` } });
		sw.setCssProps({ background: c });
		sw.dataset.color = c;
		sw.onclick = () => { state.tool = { ...state.tool, color: c, tool: state.tool.tool === "eraser" ? "pen" : state.tool.tool }; refresh(); };
		swatches.push(sw);
	}
	bar.createDiv({ cls: "bcr-sep" });
	const undo = bar.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "Undo" } });
	setIcon(undo, "undo-2");
	undo.onclick = actions.undo;
	const redo = bar.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "Redo" } });
	setIcon(redo, "redo-2");
	redo.onclick = actions.redo;
	if (actions.clear) {
		const clr = bar.createEl("button", { cls: "bcr-icon-btn clickable-icon", attr: { "aria-label": "Clear page" } });
		setIcon(clr, "trash-2");
		clr.onclick = actions.clear;
	}
	if (actions.done) {
		const done = bar.createEl("button", { cls: "bcr-done-btn mod-cta", text: actions.doneLabel ?? "Done" });
		done.onclick = actions.done;
	}
	const refresh = () => {
		for (const [t, b] of Object.entries(toolBtns)) b.toggleClass("is-active", state.tool.tool === t);
		for (const sw of swatches) sw.toggleClass("is-active", sw.dataset.color === state.tool.color && state.tool.tool !== "eraser");
	};
	refresh();
	return bar;
}

/** A sheet of paper to write on by hand. Saved as an SVG picture you can open again and keep editing. */
export class HandwritingModal extends Modal {
	private surface: InkSurface | null = null;
	private state: { tool: InkTool };
	private aspect: number;

	constructor(app: App, private ink: InkSettings, private heading: string, private onSave: (svg: string, strokes: InkStroke[]) => Promise<void>, private initial?: { strokes: InkStroke[]; aspect: number; paper: string }) {
		super(app);
		this.state = { tool: { tool: "pen", color: ink.penColor, widthPx: ink.penWidth } };
		this.aspect = initial?.aspect ?? 1.3;
	}

	private paperStyle(): "lined" | "dotted" | "blank" {
		return (this.initial?.paper as "lined" | "dotted" | "blank" | undefined) ?? this.ink.paperStyle;
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("bcr-modal", "bcr-hw-modal");
		this.titleEl.setText(this.heading);
		buildInkToolbar(contentEl, this.state, {
			undo: () => this.surface?.undo(),
			redo: () => this.surface?.redo(),
			clear: () => this.surface?.clear(),
		});
		const scroller = contentEl.createDiv({ cls: "bcr-hw-scroller" });
		const sheet = scroller.createDiv({ cls: "bcr-hw-sheet" });
		this.surface = new InkSurface(sheet, {
			getTool: () => this.state.tool,
			penOnly: () => this.ink.penOnly,
			onChange: () => {},
			paper: (ctx, w, h) => drawPaper(this.paperStyle(), ctx, w, h),
		});
		this.surface.setEnabled(true);
		const size = () => {
			const w = Math.min(900, scroller.clientWidth - 8 || 600);
			sheet.setCssProps({ width: `${w}px`, height: `${w * this.aspect}px` });
			this.surface!.resize(w, w * this.aspect);
		};
		window.setTimeout(() => {
			size();
			if (this.initial) this.surface!.setStrokes(this.initial.strokes);
		}, 30);
		const more = contentEl.createDiv({ cls: "bcr-modal-buttons" });
		more.createEl("button", { text: "Longer page" }).onclick = () => {
			const strokes = this.surface!.strokes;
			this.aspect += 0.65;
			size();
			this.surface!.strokes = strokes;
			this.surface!.redraw();
		};
		more.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const save = more.createEl("button", { text: "Save to vault", cls: "mod-cta" });
		save.onclick = async () => {
			const strokes = this.surface!.strokes;
			if (!strokes.length) { new Notice("Nothing written yet."); return; }
			save.disabled = true;
			const svg = strokesToSvg(strokes, { aspect: this.aspect, paper: this.paperStyle(), background: "#fffdf7" });
			await this.onSave(svg, strokes);
			this.close();
		};
	}

	onClose() {
		this.surface?.destroy();
		this.contentEl.empty();
	}
}
