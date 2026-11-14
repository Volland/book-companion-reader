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
import { LibraryBook, SuggestionStore, collectBooks } from "../src/library";
import { LibraryView, renderShelfBlock } from "../src/libraryView";

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

/** #library: the librarian's desk on the desktop and a library page with shelf blocks on the phone. */
async function library() {
	const settings = mergeSettings({ library: { yearlyGoal: 12 } });
	const y = new Date().getFullYear();
	const hub = (title: string, author: string, status: string, extra: Record<string, unknown> = {}) => ({ path: `Books/${title}/${title}.md`, fm: { type: "Book", title, author, status, progress: 0, tags: ["book"], ...extra } });
	const hubs = [
		hub("The Keeper of Gull Point", "A. Sample", "reading", { progress: 42, file: "[[Library/Keeper.epub]]", file_format: "epub" }),
		hub("Der Leuchtturm", "Anna Meier", "reading", { progress: 8, file: "[[Library/Leuchtturm.epub]]", file_format: "epub" }),
		hub("Dune", "Frank Herbert", "to-read", { format: "paper", why: "A friend said it changed how they read." }),
		hub("Emma", "Jane Austen", "to-read", { format: "ebook" }),
		hub("Piranesi", "Susanna Clarke", "wishlist", { format: "paper" }),
		hub("The Left Hand of Darkness", "Ursula K. Le Guin", "finished", { rating: 5, finished: `${y}-03-14`, pages: 304, tags: ["book", "genre/science-fiction"] }),
		hub("A Wizard of Earthsea", "Ursula K. Le Guin", "finished", { rating: 4, finished: `${y}-05-02`, pages: 183, tags: ["book", "genre/fantasy"] }),
		hub("Kindred", "Octavia E. Butler", "finished", { rating: 5, finished: `${y}-06-20`, pages: 264, tags: ["book", "genre/science-fiction"] }),
	];
	const books: LibraryBook[] = collectBooks(hubs, [{ path: "Library/Keeper.epub", extension: "epub", basename: "Keeper", lastOpened: Date.now() }, { path: "Library/Leuchtturm.epub", extension: "epub", basename: "Leuchtturm", lastOpened: Date.now() - 86400000 }]);
	const sug = new SuggestionStore(async () => {});
	sug.add([
		{ title: "Earthsea: The Tombs of Atuan", author: "Ursula K. Le Guin", why: "More Earthsea, since you rated A Wizard of Earthsea 4 stars." },
		{ title: "Parable of the Sower", author: "Octavia E. Butler", why: "Butler again, after Kindred." },
		{ title: "Solaris", author: "Stanisław Lem", why: "Thoughtful science fiction like The Left Hand of Darkness, and short." },
	], []);
	const noop = async () => {};
	const actions: any = { open: noop, openPage: noop, setStatus: noop, setRating: noop, linkFile: noop, shelveSuggestion: noop, dismissSuggestion: noop };
	const plugin: any = { settings, suggestions: sug, shelfActions: actions, libraryBooks: () => books, addBookDialog: noop, openLibraryPages: noop, askLibrarian: noop };
	const desk = new LibraryView({} as any, plugin);
	document.getElementById("desktop")!.appendChild(desk.containerEl);
	(desk as any).tab = location.search.includes("finished") ? "finished" : "suggested";
	desk.render();
	const page = document.createElement("div");
	page.style.cssText = "padding:14px;width:100%;box-sizing:border-box;overflow:auto;background:var(--background-primary)";
	document.getElementById("phone")!.appendChild(page);
	const ctx = { books, suggestions: sug.items, goal: 12, actions };
	page.createEl("h3", { text: "📚 Library" });
	page.createEl("h4", { text: "Currently reading" });
	renderShelfBlock(page.createDiv(), { shelf: "reading", view: "cards" }, ctx);
	page.createEl("h4", { text: "This year" });
	renderShelfBlock(page.createDiv(), { shelf: "all", view: "stats" }, ctx);
	document.body.dataset.ready = "1";
}

async function main() {
	if (location.hash === "#library") return library();
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
