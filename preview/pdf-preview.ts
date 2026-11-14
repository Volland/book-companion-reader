/* PDF preview: the real reader on pdf.js (the same engine Obsidian ships), with a small generated sample PDF. */
import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import { BookNotes } from "../src/notes";
import { ReaderView } from "../src/readerView";
import { mergeSettings } from "../src/settings";
import { BookStore } from "../src/store";
import { MemoryVault, fakeAi } from "../test/sample";

const g: any = globalThis;
g.__mockApp = { vault: {}, workspace: {} };
import * as pdfWorker from "pdfjs-dist/build/pdf.worker.mjs";
(globalThis as any).pdfjsWorker = pdfWorker; // run pdf.js in this page (headless preview has no worker)

/** A tiny PDF writer: pages of Helvetica text lines. */
function makePdf(pages: string[][]): Uint8Array {
	const objs: string[] = [];
	const add = (s: string) => { objs.push(s); return objs.length; };
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
	const pageIds: number[] = [];
	const pagesId = 2 + pages.length * 2; // font, then content+page per page
	for (const lines of pages) {
		const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
		let y = 720;
		const body = lines.map((l, i) => { const size = i === 0 ? 20 : 12; const s = `BT /F1 ${size} Tf 72 ${y} Td (${esc(l)}) Tj ET`; y -= i === 0 ? 40 : 18; return s; }).join("\n");
		const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
		pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
	}
	const pagesObj = add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
	const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
	const info = add("<< /Title (Notes on Tides) /Author (A. Sample) >>");
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
	out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF`;
	if (pagesObj !== pagesId) throw new Error(`pages object id ${pagesObj} != ${pagesId}`);
	return new TextEncoder().encode(out);
}

async function main() {
	const settings = mergeSettings({});
	const vault = new MemoryVault();
	const store = new BookStore(async () => {});
	const notes = new BookNotes(vault, () => settings.notes);
	const host = { settings, store, notes, askAi: fakeAi, loadPdf: async () => pdfjs, openNote: () => {}, listBookNotes: () => [] };
	const view = new ReaderView({} as any, host as any);
	document.getElementById("desktop")!.appendChild(view.containerEl);
	const bytes = makePdf([
		["Notes on Tides", "The tide rises and falls twice a day along most coasts.", "Notwithstanding the calm surface, strong currents move beneath it.", "Keepers learned to read the water long before tide tables existed."],
		["Chapter Two", "A spring tide comes with the new and full moon.", "A neap tide, by contrast, is gentle and modest."],
		["Chapter Three", "Storm surges can raise the sea far above the highest tide."],
	]);
	await view.openData("Books/Tides.pdf", "pdf", bytes.buffer as ArrayBuffer);
	await new Promise((r) => setTimeout(r, 800));
	const r: any = { pages: view.pdf?.numPages, title: view.meta?.title };
	r.rendered = view.pdf?.slots.filter((s) => s.rendered).length;
	r.textSpans = document.querySelectorAll(".bcr-textLayer span").length;
	r.text = (await view.pageText()).slice(0, 60);
	view.pdf!.goto(2);
	await new Promise((r2) => setTimeout(r2, 400));
	r.afterNext = view.currentLoc()?.page;
	view.pdf!.goto(1);
	await new Promise((r2) => setTimeout(r2, 300));
	await view.addHighlight({ text: "strong currents move beneath it", loc: { page: 1 }, context: "" }, "yellow");
	r.marks = document.querySelectorAll(".bcr-textLayer mark.bcr-hl").length;
	view.setInkMode(true);
	r.inkCanvases = document.querySelectorAll(".bcr-page .bcr-ink-canvas").length;
	r.selected = view.selectText("Keepers learned to read the water");
	await view.runAi("explain", view.getSelected() ?? { text: "x", loc: { page: 1 }, context: "" });
	view.togglePanel(true);
	view.setInkMode(false);
	view.selectText("Keepers learned to read the water");
	document.body.dataset.result = JSON.stringify(r);
	document.getElementById("result")!.textContent = JSON.stringify(r);
}

main().catch((e) => { document.getElementById("result")!.textContent = "ERROR " + String(e?.stack ?? e); });
