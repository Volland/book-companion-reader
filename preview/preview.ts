/* Browser preview: the real reader view running on a stand-in Obsidian, with a sample book and a pretend AI. */
import { Platform } from "obsidian";
import { BookNotes } from "../src/notes";
import { ReaderView } from "../src/readerView";
import { mergeSettings } from "../src/settings";
import { BookStore } from "../src/store";
import { MemoryVault, fakeAi, sampleEpub } from "../test/sample";
import { HandoffNeeded } from "../src/ai";

const g: any = globalThis;
g.__mockApp = { vault: {}, workspace: {} };

async function mount(frame: HTMLElement, opts: { phone: boolean; handoff?: boolean }) {
	const settings = mergeSettings({ learner: { level: "B1", nativeLanguage: "Ukrainian", learningLanguage: "English" }, reader: { paper: opts.phone ? "sepia" : "theme" } });
	const vault = new MemoryVault();
	const store = new BookStore(async () => {});
	const notes = new BookNotes(vault, () => settings.notes);
	const host = {
		settings, store, notes,
		askAi: async (sys: string, m: any) => {
			if (opts.handoff) throw new HandoffNeeded("…", "Your Claude subscription works through an app on a computer. On this phone, send the question to your chat app.");
			return fakeAi(sys, m);
		},
		loadPdf: async () => { throw new Error("pdf.js comes with Obsidian"); },
		openNote: () => {},
		listBookNotes: (meta: any) => vault.list(`${notes.folder(meta)}/Notes/`).map((p) => ({ path: p, name: p.split("/").pop()!.replace(/\.md$/, "") })),
	};
	(Platform as any).isMobile = opts.phone;
	const view = new ReaderView({} as any, host as any);
	frame.appendChild(view.containerEl);
	const bytes = sampleEpub();
	await view.openData("Books/Keeper.epub", "epub", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	(Platform as any).isMobile = false;
	return view;
}

async function main() {
	const desk = await mount(document.getElementById("desktop")!, { phone: false });
	const phone = await mount(document.getElementById("phone")!, { phone: true, handoff: true });

	// Desktop: a highlight, an explanation and a simplification in the panel, and the selection bar showing.
	await desk.addHighlight({ text: "polished the great lens until it gleamed like a second moon", loc: { chapter: 0, frac: 0 }, context: "" }, "yellow");
	const sentence = "Notwithstanding the gales that battered the headland every November";
	await desk.runAi("simplify", { text: sentence, loc: { chapter: 0, frac: 0 }, context: "" });
	await desk.runAi("explain", { text: "the sea spoke to her in a hundred dialects", loc: { chapter: 0, frac: 0 }, context: "" });

	// Phone: the words panel as a bottom sheet after a hand-off to the chat app.
	await phone.runAi("define", { text: "bewilderment", loc: { chapter: 0, frac: 0 }, context: "" });
	phone.epub?.relayout(0);
	desk.epub?.relayout(0);
	desk.selectText("few of them could fathom why anyone would choose such solitude");
	document.body.dataset.ready = "1";
}

main().catch((e) => {
	document.body.dataset.ready = "error";
	document.body.insertAdjacentHTML("beforeend", `<pre style="color:red">${String(e?.stack ?? e)}</pre>`);
});
