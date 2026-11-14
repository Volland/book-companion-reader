/* A small stand-in for the Obsidian API: enough to run the plugin's reader in Node (self-test) and in a browser (preview). */

type Attrs = { cls?: string | string[]; text?: string; attr?: Record<string, string>; type?: string; placeholder?: string; value?: string };

export function installDomHelpers(win: any) {
	const proto = win.HTMLElement.prototype;
	const ap = (el: any, o?: Attrs | string) => {
		if (typeof o === "string") { el.className = o; return el; }
		if (!o) return el;
		if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
		if (o.text != null) el.textContent = o.text;
		if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
		if (o.type) el.setAttribute("type", o.type);
		if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
		if (o.value != null) el.value = o.value;
		return el;
	};
	if (!proto.createEl) {
		proto.createEl = function (tag: string, o?: Attrs | string) { const el = this.ownerDocument.createElement(tag); ap(el, o); this.appendChild(el); return el; };
		proto.createDiv = function (o?: Attrs | string) { return this.createEl("div", o); };
		proto.createSpan = function (o?: Attrs | string) { return this.createEl("span", o); };
		proto.setCssProps = function (p: Record<string, string>) { for (const [k, v] of Object.entries(p)) this.style.setProperty(k, v); };
		(globalThis as any).createEl = (tag: string, o?: Attrs | string) => { const el = win.document.createElement(tag); ap(el, o); return el; };
		proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
		proto.appendText = function (t: string) { this.appendChild(this.ownerDocument.createTextNode(t)); };
		proto.setText = function (t: string) { this.textContent = t; };
		proto.addClass = function (...c: string[]) { this.classList.add(...c); };
		proto.removeClass = function (...c: string[]) { this.classList.remove(...c); };
		proto.toggleClass = function (c: string, on: boolean) { this.classList.toggle(c, on); };
		proto.hide = function () { this.style.display = "none"; };
		proto.show = function () { this.style.display = ""; };
		proto.isShown = function () { return this.style.display !== "none"; };
	}
}

const g: any = globalThis as any;
if (g.HTMLElement) installDomHelpers(g);

export const Platform = { isMobile: false, isPhone: false, isDesktopApp: false, isDesktop: true };

export class TAbstractFile { path = ""; name = ""; parent: TFolder | null = null; }
export class TFile extends TAbstractFile {
	basename = ""; extension = "";
	constructor(path = "") { super(); this.path = path; this.name = path.split("/").pop() ?? ""; this.extension = this.name.includes(".") ? this.name.split(".").pop()! : ""; this.basename = this.name.replace(/\.[^.]+$/, ""); }
}
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }

export class Component {
	private cleanups: (() => void)[] = [];
	load() {}
	unload() { for (const c of this.cleanups) c(); this.cleanups = []; }
	register(fn: () => void) { this.cleanups.push(fn); }
	registerEvent(_e: any) {}
	registerDomEvent(el: any, type: string, fn: any, opts?: any) { el.addEventListener(type, fn, opts); this.register(() => el.removeEventListener(type, fn, opts)); }
	registerInterval(id: number) { return id; }
	addChild<T>(c: T) { return c; }
}

export class WorkspaceLeaf { view: any = null; updateHeader() {} }

export class ItemView extends Component {
	app: any;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(public leaf: WorkspaceLeaf) {
		super();
		const doc: Document = g.document;
		this.app = g.__mockApp;
		this.containerEl = doc.createElement("div");
		this.containerEl.className = "workspace-leaf-content";
		this.contentEl = doc.createElement("div");
		this.contentEl.className = "view-content";
		this.containerEl.appendChild(this.contentEl);
	}
	getState(): any { return {}; }
	async setState(_s: any, _r: any) {}
	setEphemeralState(_s: any) {}
	onClose() {}
}

export class FileView extends ItemView {
	file: TFile | null = null;
	getState(): any { return { file: this.file?.path }; }
}

export class Notice {
	static log: string[] = [];
	constructor(public message: string, _t?: number) { Notice.log.push(message); if (g.__onNotice) g.__onNotice(message); }
}

export class Modal {
	app: any; containerEl: HTMLElement; modalEl: HTMLElement; titleEl: HTMLElement; contentEl: HTMLElement;
	static opened: Modal[] = [];
	constructor(app: any) {
		this.app = app;
		const doc: Document = g.document;
		this.containerEl = doc.createElement("div");
		this.containerEl.className = "modal-container";
		this.modalEl = doc.createElement("div");
		this.modalEl.className = "modal";
		this.titleEl = doc.createElement("div");
		this.titleEl.className = "modal-title";
		this.contentEl = doc.createElement("div");
		this.contentEl.className = "modal-content";
		this.modalEl.append(this.titleEl, this.contentEl);
		this.containerEl.appendChild(this.modalEl);
	}
	open() { g.document.body.appendChild(this.containerEl); Modal.opened.push(this); this.onOpen(); }
	close() { this.onClose(); this.containerEl.remove(); Modal.opened = Modal.opened.filter((m) => m !== this); }
	onOpen() {}
	onClose() {}
}

export class FuzzySuggestModal<T> extends Modal {
	setPlaceholder(_p: string) {}
	getItems(): T[] { return []; }
	getItemText(_t: T) { return ""; }
	onChooseItem(_t: T, _e?: any) {}
	onOpen() {
		for (const item of this.getItems()) {
			const row = this.contentEl.createDiv({ cls: "suggestion-item" });
			(this as any).renderSuggestion ? (this as any).renderSuggestion({ item }, row) : row.setText(this.getItemText(item));
			row.addEventListener("click", () => { this.close(); this.onChooseItem(item); });
		}
	}
}

export class Menu {
	items: { title: string; cb?: () => void }[] = [];
	addItem(fn: (i: any) => void) {
		const item: any = { title: "" };
		const api = { setTitle: (t: string) => { item.title = t; return api; }, setIcon: () => api, setChecked: () => api, onClick: (cb: () => void) => { item.cb = cb; return api; } };
		fn(api);
		this.items.push(item);
		return this;
	}
	addSeparator() { return this; }
	showAtMouseEvent(_e: any) { g.__lastMenu = this; }
	showAtPosition(_p: any) { g.__lastMenu = this; }
}

export class PluginSettingTab { containerEl: HTMLElement; constructor(public app: any, public plugin: any) { this.containerEl = g.document.createElement("div"); } display() {} }

export class Setting {
	settingEl: HTMLElement;
	constructor(parent: HTMLElement) { this.settingEl = (parent as any).createDiv({ cls: "setting-item" }); }
	setName(n: string) { (this.settingEl as any).createDiv({ cls: "setting-item-name", text: n }); return this; }
	setDesc(_d: string) { return this; }
	private ctl() { const c: any = { setValue: () => c, onChange: () => c, setPlaceholder: () => c, setLimits: () => c, setDynamicTooltip: () => c, addOption: () => c, setButtonText: () => c, onClick: () => c, inputEl: g.document.createElement("input") }; return c; }
	addText(f: any) { f(this.ctl()); return this; }
	addTextArea(f: any) { f(this.ctl()); return this; }
	addDropdown(f: any) { f(this.ctl()); return this; }
	addToggle(f: any) { f(this.ctl()); return this; }
	addSlider(f: any) { f(this.ctl()); return this; }
	addButton(f: any) { f(this.ctl()); return this; }
	addColorPicker(f: any) { f(this.ctl()); return this; }
}

export class Plugin extends Component {
	app: any; manifest: any;
	constructor(app: any, manifest: any) { super(); this.app = app; this.manifest = manifest; }
	async loadData() { return null; }
	async saveData(_d: any) {}
	registerView() {}
	registerExtensions() {}
	addSettingTab() {}
	addRibbonIcon() {}
	addCommand(c: any) { return c; }
	registerObsidianProtocolHandler() {}
}

/** Lucide-ish icons are just labelled boxes in the stand-in. */
const ICON_GLYPHS: Record<string, string> = {
	list: "☰", "chevron-left": "‹", "chevron-right": "›", type: "Aa", "zoom-in": "+", "zoom-out": "−", pencil: "✎", "notebook-pen": "✍", "graduation-cap": "🎓",
	"book-marked": "📘", "panel-right": "▥", sparkles: "✨", "book-a": "A", languages: "文", "message-circle-question": "?", "sticky-note": "🗒", copy: "⧉",
	x: "×", "file-plus": "+", "list-plus": "+", "message-circle": "💬", "external-link": "↗", "clipboard-paste": "📋", "pen-tool": "✒", highlighter: "▮", eraser: "⌫",
	"undo-2": "↶", "redo-2": "↷", "trash-2": "🗑", "file-text": "📄", "book-open": "📖", library: "📚",
};
export function setIcon(el: HTMLElement, icon: string) {
	el.textContent = "";
	const s = g.document.createElement("span");
	s.className = "mock-icon";
	s.textContent = ICON_GLYPHS[icon] ?? "•";
	el.appendChild(s);
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
	const t = g.document.createElement("template");
	t.innerHTML = html;
	return t.content;
}

/** Very small Markdown → HTML for the preview (headings, bold, lists, paragraphs). */
export const MarkdownRenderer = {
	async render(_app: any, md: string, el: HTMLElement, _src: string, _c: any) {
		const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
		const out: string[] = [];
		let list = false;
		for (const line of md.split("\n")) {
			if (/^\s*[-*] /.test(line)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`); continue; }
			if (list) { out.push("</ul>"); list = false; }
			const h = /^(#{1,4}) (.*)$/.exec(line);
			if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
			else if (line.trim() === "---") out.push("<hr>");
			else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
		}
		if (list) out.push("</ul>");
		el.innerHTML = out.join("");
	},
};

export function normalizePath(p: string) { return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export async function requestUrl(_r: any): Promise<any> { throw new Error("No network in the stand-in"); }
export async function loadPdfJs(): Promise<any> { throw new Error("pdf.js is provided by Obsidian"); }
export function debounce(fn: any, ms = 200) { let t: any; return (...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export class App {}
