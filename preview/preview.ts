/* Browser preview: the real reader view running on a stand-in Obsidian, with a sample book and a pretend AI. */
import { Platform } from "obsidian";
import { BookNotes } from "../src/notes";
import { ReaderView } from "../src/readerView";
import { mergeSettings } from "../src/settings";
import { BookStore } from "../src/store";
import { DeckStore } from "../src/decks";
import { MemoryVault, fakeAi, sampleEpub } from "../test/sample";
import { HandoffNeeded } from "../src/ai";
import { DecksView, renderStudy } from "../src/decksView";

const g: any = globalThis;
g.__mockApp = { vault: {}, workspace: {} };

async function mount(frame: HTMLElement, opts: { phone: boolean; handoff?: boolean }) {
	const settings = mergeSettings({ learner: { level: "B1", nativeLanguage: "Ukrainian", learningLanguage: "English" }, reader: { paper: opts.phone ? "sepia" : "theme" } });
	const vault = new MemoryVault();
	const store = new BookStore(async () => {});
	const notes = new BookNotes(vault, () => settings.notes);
	const host = {
		settings, store, notes, decks: new DeckStore(async () => {}),
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

/** #flash: the flashcard decks on the desktop and a study session on the phone. */
async function flash() {
	const settings = mergeSettings({});
	const decks = new DeckStore(async () => {});
	const book = decks.bookDeck("Books/Keeper.epub", "The Keeper of Gull Point");
	const topic = decks.createDeck("Sailing words");
	const de = decks.bookDeck("Books/Leuchtturm.epub", "Der Leuchtturm");
	const add = (deckId: string, word: string, translation: string, meaning: string, context: string, form?: string, language = "English", box = 0) => {
		const { card } = decks.addCard({ deckId, word, form, translation, meaning, context, example: "", language, bookPath: "Books/Keeper.epub" });
		card.box = box; card.reps = box;
		if (box) card.due += 3;
	};
	add(book.id, "gale", "шторм", "a very strong wind", "Notwithstanding the gales that battered the headland every November, she climbed the steps.", "gales");
	add(book.id, "fathom", "збагнути", "to understand something difficult", "Few of them could fathom why anyone would choose such solitude.", undefined, "English", 2);
	add(book.id, "relish", "насолоджуватися", "to enjoy very much", "…let alone relish it.", undefined, "English", 1);
	add(topic.id, "squall", "шквал", "a sudden strong wind", "She had learned to tell a passing squall from a storm.", undefined, "English", 0);
	add(de.id, "der Leuchtturm", "маяк", "ein hoher Turm mit einem Licht für Schiffe", "Der Leuchtturm stand allein am Ende der Landzunge.", "Leuchtturm", "German");
	add(de.id, "die Sehnsucht", "туга", "ein starkes Verlangen nach etwas", "Eine tiefe Sehnsucht erfüllte sie.", "Sehnsucht", "German");
	const plugin: any = { decks, settings, notes: {}, openBookPath: () => {} };
	const dv = new DecksView({} as any, plugin);
	document.getElementById("desktop")!.appendChild(dv.containerEl);
	await dv.onOpen();
	const box = document.createElement("div");
	box.style.cssText = "padding:16px;width:100%;box-sizing:border-box;background:var(--background-primary)";
	document.getElementById("phone")!.appendChild(box);
	const cards = decks.dueCards([book.id]);
	renderStudy(box, decks, cards, {});
	(box.querySelector(".bcr-study-buttons button") as HTMLElement).click();
	document.body.dataset.ready = "1";
}

async function main() {
	if (location.hash === "#flash") return flash();
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
	if (location.hash === "#chat") {
		const loc = { chapter: 0, frac: 0.2 };
		await desk.chatSend("What does this line tell us about Mara?", { text: "The sea spoke to her in a hundred dialects", loc, context: "" });
		await desk.chatSend("And why does she like the silence?");
		desk.discuss({ text: "few of them could fathom why anyone would choose such solitude", loc, context: "" });
		desk.openPanel("cat");
	}
	document.body.dataset.ready = "1";
}

main().catch((e) => {
	document.body.dataset.ready = "error";
	document.body.insertAdjacentHTML("beforeend", `<pre style="color:red">${String(e?.stack ?? e)}</pre>`);
});
