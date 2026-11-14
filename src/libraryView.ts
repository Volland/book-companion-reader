import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type BookCompanionPlugin from "./main";
import { formatOf } from "./types";

export const VIEW_TYPE_LIBRARY = "book-companion-library";

export function coverColors(title: string): [string, string] {
	let h = 0;
	for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
	const a = h % 360, b = (a + 40 + (h >> 9) % 80) % 360;
	return [`hsl(${a} 55% 42%)`, `hsl(${b} 60% 28%)`];
}

/** Every PDF and EPUB in the vault as a shelf, with reading progress. */
export class LibraryView extends ItemView {
	private filter = "";

	constructor(leaf: WorkspaceLeaf, private plugin: BookCompanionPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE_LIBRARY; }
	getDisplayText() { return "Book library"; }
	getIcon() { return "library"; }

	async onOpen() {
		this.registerEvent(this.app.vault.on("create", () => this.render()));
		this.registerEvent(this.app.vault.on("delete", () => this.render()));
		this.registerEvent(this.app.vault.on("rename", () => this.render()));
		this.render();
	}

	render() {
		const c = this.contentEl;
		c.empty();
		c.addClass("bcr-library");
		const head = c.createDiv({ cls: "bcr-lib-head" });
		head.createEl("h2", { text: "Your books" });
		const search = head.createEl("input", { cls: "bcr-text-input", attr: { type: "search", placeholder: "Find a book…" } });
		search.value = this.filter;
		search.addEventListener("input", () => { this.filter = search.value; this.renderGrid(grid); });
		const grid = c.createDiv({ cls: "bcr-lib-grid" });
		this.renderGrid(grid);
	}

	private renderGrid(grid: HTMLElement) {
		grid.empty();
		const store = this.plugin.store;
		const q = this.filter.toLowerCase();
		const files = this.app.vault.getFiles()
			.filter((f) => formatOf(f.extension))
			.filter((f) => !q || f.path.toLowerCase().includes(q) || (store.peek(f.path)?.title ?? "").toLowerCase().includes(q))
			.sort((a, b) => (store.peek(b.path)?.lastOpened ?? 0) - (store.peek(a.path)?.lastOpened ?? 0) || a.basename.localeCompare(b.basename));
		if (!files.length) {
			grid.createDiv({ cls: "bcr-empty", text: "No PDF or EPUB files in this vault yet. Drop a book file into any folder and it will show up here." });
			return;
		}
		for (const f of files) this.card(grid, f);
	}

	private card(grid: HTMLElement, f: TFile) {
		const data = this.plugin.store.peek(f.path);
		const title = data?.title ?? f.basename;
		const card = grid.createDiv({ cls: "bcr-lib-card" });
		const cover = card.createDiv({ cls: "bcr-cover" });
		const [c1, c2] = coverColors(title);
		cover.style.background = `linear-gradient(150deg, ${c1}, ${c2})`;
		cover.createDiv({ cls: "bcr-cover-title", text: title });
		if (data?.author) cover.createDiv({ cls: "bcr-cover-author", text: data.author });
		cover.createDiv({ cls: "bcr-cover-badge", text: f.extension.toUpperCase() });
		const info = card.createDiv({ cls: "bcr-lib-info" });
		const bar = info.createDiv({ cls: "bcr-lib-bar" });
		bar.createDiv({ cls: "bcr-lib-bar-fill" }).style.width = `${Math.round((data?.progress ?? 0) * 100)}%`;
		const line = info.createDiv({ cls: "bcr-lib-line" });
		line.createSpan({ text: data?.progress ? `${Math.round(data.progress * 100)}%` : "Not started" });
		const counts = [data?.highlights.length ? `${data.highlights.length} highlights` : "", data?.vocab.length ? `${data.vocab.length} words` : ""].filter(Boolean).join(" · ");
		if (counts) line.createSpan({ cls: "bcr-muted", text: ` · ${counts}` });
		cover.onclick = () => void this.plugin.openBook(f);
		const hub = info.createEl("button", { cls: "bcr-chip" });
		setIcon(hub.createSpan(), "book-marked");
		hub.createSpan({ text: "Book page" });
		hub.onclick = () => void this.plugin.openHubFor(f);
	}
}
