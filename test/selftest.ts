/* Self-test: runs the real reader in Node with a stand-in Obsidian, drives it like a reader would, and records what worked. */
import { parseHTML } from "linkedom";
import * as fs from "node:fs";

const { window, document, DOMParser } = parseHTML("<!doctype html><html><body></body></html>") as any;
const g: any = globalThis;
window.setTimeout = setTimeout as any; window.clearTimeout = clearTimeout as any; g.window = window; g.document = document; g.DOMParser = DOMParser;
g.HTMLElement = window.HTMLElement; g.Node = window.Node; Object.defineProperty(g, "navigator", { value: { clipboard: { writeText: async () => {}, readText: async () => "" } }, configurable: true });
g.__mockApp = { vault: {}, workspace: {} };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mock = require("obsidian");
mock.installDomHelpers(window);

import { AiClient, HandoffNeeded } from "../src/ai";
import { buildCliCommand } from "../src/cliRunner";
import { parseEpub } from "../src/epub";
import { strokesToSvg, svgToStrokes, eraseAt } from "../src/ink";
import { BookNotes, HUB_SECTIONS, insertUnderHeading, setFrontmatterField, today } from "../src/notes";
import { buildUserPrompt, parseVocabulary } from "../src/prompts";
import { ReaderView } from "../src/readerView";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";
import { BookStore } from "../src/store";
import { Card, DeckStore, INTERVALS, dayNumber, deckToMarkdown, sentenceAround } from "../src/decks";
import { CardModal, DecksView, renderStudy } from "../src/decksView";
import { languageName, profileFor } from "../src/languages";
import { LibraryBook, SuggestionStore, buildLibrarianSystem, buildSuggestPrompt, collectBooks, libraryStats, parseFrontmatter, parseShelfBlock, parseSuggestions, shelf } from "../src/library";
import { renderShelfBlock } from "../src/libraryView";
import { buildCatSystemPrompt, buildCatTurn, buildSystemPrompt, parseCard } from "../src/prompts";
import { locFromString, locToString } from "../src/types";
import { MemoryVault, fakeAi, sampleEpub } from "./sample";

interface Step { step: string; passed: boolean; detail: string }
const steps: Step[] = [];
const check = (step: string, passed: boolean, detail: string) => steps.push({ step, passed: !!passed, detail });

async function main() {
	const outIdx = process.argv.indexOf("--self-test");
	const out = outIdx >= 0 ? process.argv[outIdx + 1] : "selftest.json";

	const settings = mergeSettings({ learner: { level: "B1", nativeLanguage: "Ukrainian", learningLanguage: "English" } });
	const vault = new MemoryVault();
	const store = new BookStore(async () => {});
	const decks = new DeckStore(async () => {});
	const notes = new BookNotes(vault, () => settings.notes);
	const host = {
		settings, store, notes, decks,
		askAi: fakeAi,
		loadPdf: async () => { throw new Error("no pdf.js here"); },
		openNote: (_p: string) => {},
		listBookNotes: (meta: any) => vault.list(`${notes.folder(meta)}/Notes/`).map((p) => ({ path: p, name: p.split("/").pop()!.replace(/\.md$/, "") })),
	};

	// --- the book file opens
	const bytes = sampleEpub();
	const book = parseEpub(bytes, new DOMParser());
	check("open-epub", book.title === "The Keeper of Gull Point" && book.chapters.length === 3 && book.toc.length === 3, `"${book.title}" by ${book.author}: ${book.chapters.length} chapters, ${book.toc.length} contents entries`);

	const view = new ReaderView(new mock.WorkspaceLeaf(), host as any);
	document.body.appendChild(view.containerEl);
	await view.openData("Library/Keeper.epub", "epub", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	const text0 = view.epub!.content.textContent ?? "";
	const cleaned = !view.epub!.content.querySelector("script, style") && !text0.includes("alert(1)");
	check("render", text0.includes("Mara had kept the lighthouse") && cleaned, `chapter 1 shown (${text0.length} characters); scripts and book styles removed: ${cleaned}`);

	// --- move: turn pages / chapters
	const before = locToString(view.currentLoc());
	await view.next();
	const after = locToString(view.currentLoc());
	const ch2 = (view.epub!.content.textContent ?? "").includes("A Letter in the Fog");
	await view.prev();
	const back = view.epub!.chapter;
	view.goto({ chapter: 2, frac: 0 });
	await new Promise((r) => setTimeout(r, 5));
	const jumped = view.epub!.chapter === 2;
	view.goto({ chapter: 0, frac: 0 });
	await new Promise((r) => setTimeout(r, 5));
	check("move", before !== after && ch2 && back === 0 && jumped, `turned from ${before} to ${after} ("A Letter in the Fog" shown), back to chapter ${back + 1}, jumped by contents to chapter 3: ${jumped}`);
	const lr = locFromString("c2@0.5000");
	check("locations", lr?.chapter === 2 && lr.frac === 0.5 && locToString({ page: 12 }) === "p12", "book positions survive links (p12, c2@0.5000)");

	// --- act: select text and ask the AI
	const sentence = "Notwithstanding the gales that battered the headland every November";
	let selected = false;
	try { selected = view.selectText(sentence); } catch { selected = false; }
	const sel = view.getSelected() ?? { text: sentence, loc: view.currentLoc()!, context: text0.slice(0, 800) };
	const explain = await view.runAi("explain", sel);
	const simplify = await view.runAi("simplify", sel);
	const savedWords = simplify ? await view.saveWords(simplify) : 0;
	const word = await view.runAi("define", { text: "meticulous", loc: sel.loc, context: text0 });
	const extraWord = word ? await view.saveWords(word) : 0;
	const vocabPath = notes.vocabPath(view.meta!);
	const vocabNote = vault.files.get(vocabPath) ?? "";
	check("act", !!explain?.answer && !explain.error && savedWords === 3 && vocabNote.includes("notwithstanding :: even though"),
		`selection ${selected ? "made in the page" : "given directly (no selection support in the test DOM)"}; Explain answered (${explain?.answer.length} chars); Simplify gave ${savedWords} words saved as flashcards; "meticulous" already known: ${extraWord === 0}`);

	// highlights + notes in the vault
	const h = await view.addHighlight({ text: "polished the great lens until it gleamed like a second moon", loc: { chapter: 0, frac: 0 }, context: "" }, "green");
	const marks = view.epub!.content.querySelectorAll("mark.bcr-hl").length;
	const hubPath = notes.hubPath(view.meta!);
	let hub = vault.files.get(hubPath) ?? "";
	const hubHasHl = hub.includes("==polished the great lens until it gleamed like a second moon==") && hub.includes(`^${h?.id}`);
	const notePath = await notes.createNote(view.meta!, { quote: sel.text, loc: sel.loc, body: "Mara's routine shows her devotion." });
	const aiPath = await notes.saveAiAnswer(view.meta!, "Explain", sel.text, explain!.answer, sel.loc);
	hub = vault.files.get(hubPath) ?? "";
	const noteText = vault.files.get(notePath) ?? "";
	check("notes", marks >= 1 && hubHasHl && noteText.includes('book: "[[The Keeper of Gull Point]]"') && noteText.includes("obsidian://book-reader?file=Library%2FKeeper.epub") && hub.includes(`[[${aiPath.split("/").pop()!.replace(/\.md$/, "")}]]`),
		`highlight drawn in the text (${marks} mark) and listed on the book page; note ${notePath.split("/").pop()} links to the book and back to the place; AI answer saved as a note`);

	// handwriting
	const strokes = [{ tool: "pen" as const, color: "#1c7ed6", width: 0.003, points: [0.1, 0.1, 0.5, 0.2, 0.15, 0.6, 0.3, 0.2, 0.7] }, { tool: "highlighter" as const, color: "#ffd43b", width: 0.02, points: [0.1, 0.5, 0.5, 0.6, 0.5, 0.5] }];
	const svg = strokesToSvg(strokes, { aspect: 1.3, paper: "lined", background: "#fffdf7" });
	const round = svgToStrokes(svg);
	const erased = eraseAt(strokes, 0.1, 0.1, 0.01);
	const hw = await notes.saveHandwriting(view.meta!, svg, { chapter: 0, frac: 0.2 }, sel.text);
	const hwNote = vault.files.get(hw.notePath!) ?? "";
	check("handwriting", round?.strokes.length === 2 && erased.length === 1 && svg.includes("<path") && hwNote.includes(`![[${hw.svgPath.split("/").pop()}]]`),
		`2 strokes saved as an SVG (${svg.length} bytes) and read back for editing; eraser removed 1 stroke; handwritten note embeds ${hw.svgPath.split("/").pop()}`);

	// --- Typed Graph pairing: typed notes and schema
	{
		const tv = new MemoryVault();
		const listAll = tv.list.bind(tv);
		(tv as any).list = (folder: string) => listAll(`${folder}/`).filter((p) => !p.slice(folder.length + 1).includes("/"));
		const tn = new BookNotes(tv, () => settings.notes, () => ({ on: true, schemaFolder: "Types" }));
		const meta = { path: "Library/Keeper.pdf", title: "The Keeper of Gull Point", author: "A. Sample", format: "pdf" as const };
		const hubP = await tn.ensureHub(meta);
		const n1 = await tn.createNote(meta, { quote: "the lamp had never once failed", loc: { page: 3 }, body: "Steady." });
		const n2 = await tn.saveAiAnswer(meta, "Simplify for my level", "Notwithstanding the gales", "Even with strong winds…", { page: 3 });
		const hw = await tn.saveHandwriting(meta, svg, { page: 4 });
		await tn.addVocabulary(meta, [{ id: "w1", word: "gale", definition: "a very strong wind", created: 0, box: 0 }]);
		await tn.updateProgress(meta, 1);
		const hubT = tv.files.get(hubP) ?? "";
		const t1 = tv.files.get(n1) ?? "", t2 = tv.files.get(n2) ?? "", t3 = tv.files.get(hw.notePath!) ?? "";
		const voc = tv.files.get(tn.vocabPath(meta)) ?? "";
		if (process.env.BCR_TYPED_VAULT) {
			// write the typed notes out as a vault, so Typed Graph's own tools can read them
			const pathMod = require("node:path");
			for (const [p, c] of tv.files) {
				const full = pathMod.join(process.env.BCR_TYPED_VAULT, p);
				fs.mkdirSync(pathMod.dirname(full), { recursive: true });
				fs.writeFileSync(full, c);
			}
		}
		const schemaOk = tv.files.has("Types/Book Companion.md") && tv.files.has("Types/Library.md");
		// a vault that already declares Book must not get a second Library schema
		const tv2 = new MemoryVault();
		const listAll2 = tv2.list.bind(tv2);
		(tv2 as any).list = (folder: string) => listAll2(`${folder}/`);
		await tv2.write("Types/Library.md", "---\ntgs: \"0.1\"\nschemas:\n  Book:\n    properties: {}\n---\n");
		const tn2 = new BookNotes(tv2, () => settings.notes, () => ({ on: true, schemaFolder: "Types" }));
		await tn2.ensureSchema();
		const noDup = tv2.files.get("Types/Library.md")!.length < 100 && tv2.files.has("Types/Book Companion.md");
		const ok = hubT.includes("type: Book") && hubT.includes('written_by:: [[A. Sample]] {role: "author"}') && hubT.includes("status: finished") && hubT.includes("finished: ")
			&& t1.includes("type: [ReadingNote, Quote]") && t1.includes("page: 3") && t1.includes('note_on:: [[The Keeper of Gull Point]] {loc: "p3"}') && t1.includes("quoted_from:: [[The Keeper of Gull Point]]")
			&& t2.includes("type: [Explanation, Quote]") && t2.includes('explains:: [[The Keeper of Gull Point]] {loc: "p3", action: "Simplify for my level"}')
			&& t3.includes("type: Handwriting") && voc.includes("type: Vocabulary") && voc.includes("vocabulary_of:: [[The Keeper of Gull Point]]") && schemaOk && noDup;
		check("typed-graph", ok, `book page is a Typed Graph Book written_by its author; notes are ReadingNote/Explanation/Handwriting (+Quote) with note_on, explains and quoted_from edges; vocabulary_of; schema notes added (${schemaOk}), never declared twice (${noDup})`);
	}

	// --- hud: what's on screen
	view.openPanel("ai");
	const toolbarBtns = view.containerEl.querySelectorAll(".bcr-toolbar button").length;
	const label = view.containerEl.querySelector(".bcr-loc-label")?.textContent ?? "";
	const cards = view.containerEl.querySelectorAll(".bcr-card").length;
	view.openPanel("words");
	const wordRows = view.containerEl.querySelectorAll(".bcr-word-row").length;
	view.openPanel("notes");
	const hlRows = view.containerEl.querySelectorAll(".bcr-hl-row").length;
	const tabs = view.containerEl.querySelectorAll(".bcr-tab").length;
	const selTool = view.containerEl.querySelectorAll(".bcr-seltool button").length;
	check("hud", toolbarBtns >= 8 && /%/.test(label) && cards >= 3 && wordRows === 3 && hlRows >= 1 && tabs === 4 && selTool >= 10 && HUB_SECTIONS.every((s) => hub.includes(`## ${s}`)),
		`toolbar ${toolbarBtns} buttons, position "${label}", selection bar ${selTool} buttons, panel tabs ${tabs}: ${cards} AI answers, ${wordRows} words, ${hlRows} highlights; book page has all ${HUB_SECTIONS.length} sections`);

	// --- flashcards: a card from a selected word, with its sentence and translation
	const gSel = { text: "dialects", loc: { chapter: 0, frac: 0.1 }, context: text0 };
	const gCard = await view.makeCard(gSel);
	const again = await view.makeCard(gSel);
	const bookDeck = decks.bookDeck(view.meta!.path, view.meta!.title);
	const inDeck = decks.deckCards(bookDeck.id);
	const vocabNow = vault.files.get(vocabPath) ?? "";
	check("flashcard", !!gCard && gCard.word === "dialect" && gCard.form === "dialects" && gCard.translation === "шторм" && !!gCard.example
		&& (gCard.context ?? "").includes("in a hundred dialects") && !(gCard.context ?? "").includes("Mara had kept") && again?.id === gCard.id
		&& inDeck.filter((c) => c.word === "dialect").length === 1 && vocabNow.includes("dialect :: шторм — a very strong wind"),
		`one tap on "dialects" made the card "${gCard?.word}" (${gCard?.translation}) with its sentence "${(gCard?.context ?? "").slice(0, 50)}"; doing it twice made no duplicate; it is also in the book's flashcard note`);

	// --- decks: topic decks next to the book deck
	const topic = decks.createDeck("Sailing words");
	const moved = decks.addCard({ deckId: topic.id, word: "fathom", translation: "зрозуміти", language: "English" });
	decks.moveCard(gCard!.id, topic.id);
	const dupTopic = decks.createDeck("sailing WORDS");
	const exportPath = await notes.exportDeck(topic, decks.deckCards(topic.id));
	const exported = vault.files.get(exportPath) ?? "";
	check("decks", dupTopic.id === topic.id && decks.deckCards(topic.id).length === 2 && decks.deckCards(bookDeck.id).every((c) => c.id !== gCard!.id) && moved.created
		&& decks.sortedDecks()[0].kind === "book" && exported.includes("dialect :: шторм — a very strong wind") && exported.includes("#flashcards") && deckToMarkdown(topic, [], "x").includes("deck: \"Sailing words\""),
		`a book deck and a topic deck "${topic.name}"; a card moved between them; the topic deck saved as a "word :: meaning" note`);

	// --- spaced repetition
	const t0 = dayNumber();
	const fresh = decks.dueCards([topic.id]);
	const c1 = fresh[0];
	decks.review(c1, "good", t0);
	const afterGood = { box: c1.box, due: c1.due };
	decks.review(c1, "easy", t0);
	const afterEasy = { box: c1.box, due: c1.due };
	decks.review(c1, "again", t0);
	const afterAgain = { box: c1.box, due: c1.due, lapses: c1.lapses };
	check("spaced-repetition", fresh.length === 2 && afterGood.box === 1 && afterGood.due === t0 + INTERVALS[1] && afterEasy.box === 3 && afterEasy.due === t0 + INTERVALS[3]
		&& afterAgain.box === 0 && afterAgain.due === t0 && afterAgain.lapses === 1 && !decks.dueCards([topic.id], 20, t0 - 1).length && decks.stats([topic.id], t0).due === 2,
		`good moves a card to the next box (due in ${INTERVALS[1]} day), easy skips ahead (${INTERVALS[3]} days), again brings it back today`);

	// --- the study screen: show the answer, grade it
	const studyBox = document.createElement("div");
	document.body.appendChild(studyBox);
	const session = decks.dueCards([topic.id]);
	let finished = false;
	renderStudy(studyBox, decks, session, { onDone: () => { finished = true; } });
	const front = studyBox.querySelector(".bcr-flash-word")?.textContent ?? "";
	const hasBackEarly = !!studyBox.querySelector(".bcr-flash-back");
	(studyBox.querySelector(".bcr-modal-buttons button") as any).click();
	const gradeBtns = Array.from(studyBox.querySelectorAll(".bcr-study-buttons button")).map((b: any) => b.textContent);
	const hasBack = !!studyBox.querySelector(".bcr-flash-translation");
	(studyBox.querySelectorAll(".bcr-study-buttons button")[2] as any).click();
	(studyBox.querySelector(".bcr-modal-buttons button") as any).click();
	(studyBox.querySelectorAll(".bcr-study-buttons button")[2] as any).click();
	const endText = studyBox.textContent ?? "";
	check("study", !!front && !hasBackEarly && hasBack && gradeBtns.length === 3 && finished === false && endText.includes("2 cards reviewed") && !decks.dueCards([topic.id]).length,
		`front "${front}" first, then the answer after "Show answer", buttons ${gradeBtns.map((t: string) => t.replace(/\d+ days?|today/, "").trim()).join("/")}; all cards done: "${endText.slice(0, 40)}"`);

	// --- the flashcards screen
	const plugin: any = { decks, settings, notes, openBookPath: () => {} };
	const dv = new DecksView(new mock.WorkspaceLeaf(), plugin);
	document.body.appendChild(dv.containerEl);
	await dv.onOpen();
	const deckRows = dv.contentEl.querySelectorAll(".bcr-deck-row").length;
	const groups = Array.from(dv.contentEl.querySelectorAll(".bcr-deck-group")).map((e: any) => e.textContent);
	dv.showDeck(topic.id);
	const cardRows = dv.contentEl.querySelectorAll(".bcr-deck-card").length;
	const modal = new CardModal(dv.app, decks, { deckId: topic.id, onSave: () => {} });
	modal.open();
	const formFields = modal.contentEl.querySelectorAll("input, textarea, select").length;
	modal.close();
	check("flashcards-screen", deckRows === 2 && groups.join() === "Books,Topics" && cardRows === 2 && formFields === 6, `${deckRows} decks under ${groups.join(" and ")}; the topic deck lists ${cardRows} cards; the card form has ${formFields} fields`);

	// --- cards saved by version 0.1 move into decks
	const old = new DeckStore(async () => {});
	const legacy: any = { "Books/Old.epub": { title: "Old Book", vocab: [{ id: "w-1", word: "tide", definition: "sea rising", context: "the tide", box: 2, created: 1 }] } };
	const n1 = old.importLegacy(legacy);
	const n2 = old.importLegacy(legacy);
	check("upgrade", n1 === 1 && n2 === 0 && old.decks[0].name === "Old Book" && old.cards[0].box === 2 && old.cards[0].due > dayNumber() && legacy["Books/Old.epub"].vocab.length === 0, "words saved by the first version became cards in their book's deck, once");

	// --- one reader, several languages
	const multi = { ...settings.learner, learningLanguage: "English", level: "C1" as const, otherLanguages: [{ language: "German", level: "B1" as const }] };
	const de = profileFor(multi, "de-AT");
	const en = profileFor(multi, "en");
	const unknown = profileFor(multi, "fr");
	const prompt = buildSystemPrompt(de, "Der Leuchtturm");
	const cardPrompt = buildUserPrompt({ action: "card", selection: "Sturm" }, de);
	view.book!.language = "German";
	settings.learner.otherLanguages = [{ language: "German", level: "A2" }];
	const viaView = view.learner();
	view.book!.language = undefined;
	settings.learner.otherLanguages = [];
	const pc = parseCard("**Word:** der Sturm\nTranslation: буря\n- Meaning: strong wind\nExample: Der Sturm kommt.");
	check("languages", languageName("de-AT") === "German" && languageName("Klingon") === "Klingon" && de.level === "B1" && de.learningLanguage === "German" && en.level === "C1" && unknown.level === "C1" && unknown.learningLanguage === "English"
		&& prompt.includes("learning German") && prompt.includes("B1 (") && cardPrompt.includes("B1 learner of German") && viaView.level === "A2" && viaView.learningLanguage === "German"
		&& pc.word === "der Sturm" && pc.translation === "буря" && pc.meaning === "strong wind" && pc.example === "Der Sturm kommt." && sentenceAround("One. The gales came. Three.", "gales") === "The gales came.",
		"German books use your German level (B1) and English books your English level (C1); the language comes from the EPUB or the reader's picker; flashcard answers are read into word, translation, meaning and example");

	// --- chat with the cat, kept as a note
	const calls: { system: string; messages: any[] }[] = [];
	(host as any).askAi = async (system: string, messages: any[]) => { calls.push({ system, messages }); return fakeAi(system, messages); };
	const quoted = { text: "the sea spoke to her in a hundred dialects", loc: { chapter: 0, frac: 0.2 }, context: "" };
	view.discuss(quoted);
	const chipShown = !!view.containerEl.querySelector(".bcr-chat-quote");
	const r1 = await view.chatSend("What does this line tell us about Mara?");
	const s1 = view.chatSession()!;
	const afterFirst = s1.messages.length;
	const notePath1 = s1.notePath!;
	const note1 = vault.files.get(notePath1) ?? "";
	await view.chatSend("And why does she like the silence?");
	const s2 = view.chatSession()!;
	const note2 = vault.files.get(s2.notePath!) ?? "";
	const hubNow = vault.files.get(notes.hubPath(view.meta!)) ?? "";
	const chatNotes = Array.from(vault.files.keys()).filter((k) => k.includes("/Chats/"));
	// a line the reader wrote under the transcript survives the next message
	vault.files.set(s2.notePath!, (vault.files.get(s2.notePath!) ?? "") + "\nMy own thought: she is brave.\n");
	await view.chatSend("Thanks, cat");
	const note3 = vault.files.get(s2.notePath!) ?? "";
	const bubbles = view.containerEl.querySelectorAll(".bcr-chat-msg").length;
	const lastCall = calls[calls.length - 1];
	const firstCall = calls[0];
	view.newChat();
	const startersShown = view.containerEl.querySelectorAll(".bcr-chat-starters button").length;
	check("cat-chat", chipShown && r1?.text.startsWith("Mrrp!") && afterFirst === 2 && s2.id === s1.id && s2.messages.length === 6
		&& firstCall.system.includes("reading cat") && firstCall.system.includes("B1") && firstCall.messages[0].content.includes("the sea spoke to her in a hundred dialects") && firstCall.messages[0].content.includes("Mara had kept")
		&& lastCall.messages.length === 5 && lastCall.messages[0].role === "user" && lastCall.messages[1].role === "assistant"
		&& note1.includes("> [!question] You") && note1.includes("> > the sea spoke to her") && note1.includes("> [!tip] 🐱 Cat") && note1.includes('book: "[[The Keeper of Gull Point]]"') && note1.includes("obsidian://book-reader")
		&& note2.includes("And why does she like the silence?") && !note2.includes("Thanks, cat") && note3.includes("Thanks, cat") && note3.includes("My own thought: she is brave.")
		&& chatNotes.length === 1 && hubNow.includes("## Discussions") && hubNow.includes(`[[${notePath1.split("/").pop()!.replace(/\.md$/, "")}]]`) && hubNow.split(notePath1.split("/").pop()!.replace(/\.md$/, "")).length === 2
		&& bubbles >= 1 && startersShown === 4 && buildCatTurn("hi").trim() === "hi" && buildCatSystemPrompt(settings.learner, "T").includes("do not spoil"),
		`the reader pointed the cat at a passage and talked over 3 messages; the cat got the page text and the earlier turns (${lastCall.messages.length} messages sent); one note ${notePath1.split("/").pop()} holds the transcript as callouts, is linked once under Discussions on the book page, and keeps what the reader wrote below it`);
	(host as any).askAi = fakeAi;

	// --- the library: books with and without files, statuses, shelves, stats
	const bookHubs = () => Array.from(vault.files.entries()).filter(([k]) => k.startsWith("Books/") && k.endsWith(".md")).map(([path, text]) => ({ path, fm: parseFrontmatter(text) }));
	const keeperFile = { path: "Library/Keeper.epub", extension: "epub", basename: "Keeper", title: "The Keeper of Gull Point", author: "A. Sample", progress: 0.2, lastOpened: Date.now() };
	const duneHub = await notes.createShelfBook({ title: "Dune", author: "Frank Herbert", status: "to-read", format: "paper", genres: ["Science fiction"], why: "A friend said it changed how they read.", pages: 612 });
	const duneAgain = await notes.createShelfBook({ title: "Dune", author: "Someone Else", status: "wishlist" });
	const emmaHub = await notes.createShelfBook({ title: "Emma", author: "Jane Austen", status: "wishlist", format: "ebook" });
	await notes.setStatus(duneHub, "reading");
	const dReading = parseFrontmatter(vault.files.get(duneHub) ?? "");
	await notes.setHubFields(duneHub, { rating: 5 });
	await notes.setStatus(duneHub, "finished");
	const dDone = parseFrontmatter(vault.files.get(duneHub) ?? "");
	const authorNote = vault.files.get("Books/Authors/Frank Herbert.md") ?? "";
	const dunePage = vault.files.get(duneHub) ?? "";
	let books = collectBooks(bookHubs(), [keeperFile, { path: "Library/Loose.pdf", extension: "pdf", basename: "Loose" }]);
	const byTitle = (t: string) => books.find((b) => b.title === t)!;
	const wrongYear = new Date().getFullYear() - 1;
	check("library-books", duneAgain === duneHub && (vault.files.get(duneHub) ?? "").includes("Frank Herbert") && dReading.status === "reading" && !!dReading.started && dDone.status === "finished" && dDone.finished === today() && dDone.rating === 5
		&& dunePage.includes("genre/science-fiction") && dunePage.includes("> A friend said it changed") && authorNote.includes("```book-shelf") && authorNote.includes("author: Frank Herbert")
		&& byTitle("Dune").status === "finished" && byTitle("Dune").pages === 612 && byTitle("Dune").genres[0] === "science fiction" && byTitle("Emma").status === "wishlist" && byTitle("Emma").format === "ebook"
		&& byTitle("The Keeper of Gull Point").file === "Library/Keeper.epub" && byTitle("The Keeper of Gull Point").status === "reading" && byTitle("Loose").status === "to-read" && byTitle("Loose").hub === undefined && wrongYear > 2000,
		"a paper book, a wishlist title and a finished book each got a page (not made twice) with status, dates, rating and genre; their author got a note; book files without a page appear on the shelves");

	const reading = shelf(books, "reading");
	const finishedShelf = shelf(books, "finished");
	const st = libraryStats(books, new Date().getFullYear(), 4);
	const dune = byTitle("Dune");
	check("shelves", reading.some((b) => b.title === "The Keeper of Gull Point") && !reading.some((b) => b.title === "Dune") && finishedShelf.length === 1 && shelf(books, "all").length === books.length
		&& shelf(books, "all", { author: "Frank Herbert" }).length === 1 && shelf(books, "finished", { year: 1999 }).length === 0
		&& st.finished === 1 && st.pages === 612 && st.avgRating === 5 && st.goalProgress === 0.25 && st.topAuthors[0].author === "Frank Herbert" && st.byMonth.reduce((a, b) => a + b, 0) === 1 && st.counts.wishlist === 1 && dune.rating === 5,
		`current reads, finished and wishlist shelves; ${st.finished} finished this year of a goal of ${st.goal} (${Math.round(st.goalProgress * 100)}%), ${st.pages} pages, average rating ${st.avgRating}`);

	// starting a book from the shelf, and linking a file to a book that had none
	await notes.updateProgress({ path: "Library/Emma.epub", format: "epub", title: "Emma", hub: emmaHub }, 0.1);
	const eStarted = parseFrontmatter(vault.files.get(emmaHub) ?? "");
	await notes.linkFile(emmaHub, "Library/Emma.epub", "epub");
	const eLinked = parseFrontmatter(vault.files.get(emmaHub) ?? "");
	const linkedMeta = { path: "Library/Emma.epub", format: "epub" as const, title: "Emma (Penguin edition)", hub: emmaHub };
	const eBook = collectBooks(bookHubs(), [{ path: "Library/Emma.epub", extension: "epub", basename: "Emma", progress: 0.1 }]).find((b) => b.title === "Emma")!;
	check("start-and-link", eStarted.status === "reading" && !!eStarted.started && eLinked.file === "[[Library/Emma.epub]]" && eLinked.file_format === "epub" && notes.hubPath(linkedMeta) === emmaHub && notes.folder(linkedMeta) === "Books/Emma"
		&& eBook.file === "Library/Emma.epub" && eBook.fileFormat === "epub" && collectBooks(bookHubs(), [{ path: "Library/Emma.epub", extension: "epub", basename: "Emma" }]).filter((b) => b.title === "Emma" || b.file === "Library/Emma.epub").length === 1,
		"opening a book from Up next or the wishlist starts it (status reading, start date); a book added without a file can be linked to its EPUB and keeps one page and one shelf entry, even when the file has another title");

	// --- the librarian cat: suggestions
	const sugStore = new SuggestionStore(async () => {});
	const prompt2 = buildSuggestPrompt(books, settings.learner, { count: 5, focus: "Easier to read for my level", dismissed: ["Ulysses"], pending: [] });
	const answer = await fakeAi(buildLibrarianSystem(settings.learner), [{ role: "user", content: prompt2 }]);
	const parsedSug = parseSuggestions(answer);
	const added1 = sugStore.add(parsedSug, books.map((b) => b.title), "Surprise me");
	const added2 = sugStore.add(parsedSug, books.map((b) => b.title));
	const first = sugStore.take(added1[0].id, true);
	const added3 = sugStore.add(parsedSug, books.map((b) => b.title));
	const reload = new SuggestionStore(async () => {});
	reload.load(JSON.parse(JSON.stringify(sugStore.toJSON())));
	check("librarian", parsedSug.length === 4 && parsedSug[0].title === "The Old Man and the Sea" && parsedSug[0].author === "Ernest Hemingway" && parsedSug[0].why.includes("Gull Point")
		&& added1.length === 3 && !added1.some((s) => s.title === "Dune") && added2.length === 0 && first?.title === "The Old Man and the Sea" && added3.length === 0 && reload.dismissed.length === 1 && reload.items.length === 2
		&& prompt2.includes("Dune — Frank Herbert (rated 5/5) [science fiction]") && prompt2.includes("Do not suggest these again: Ulysses") && prompt2.includes("level B1") && prompt2.includes("I'm reading now") && prompt2.includes("- **Title** — Author —"),
		"the librarian is told what you finished (best rated first), are reading and want, what to skip and your language level; its answer is read into suggestions, books you already have or waved away are left out, and the list survives a restart");

	// --- pages in the vault and the book-shelf block
	const created = await notes.ensureLibraryPages();
	const again2 = await notes.ensureLibraryPages();
	const libPage = vault.files.get("Books/Library/Library.md") ?? "";
	const logPage = vault.files.get("Books/Library/Reading log.md") ?? "";
	const tn2 = new BookNotes(new MemoryVault(), () => settings.notes, () => ({ on: true, schemaFolder: "Types" }));
	const typedLog = tn2.libraryPages().find((p) => p.name === "Reading log")!.content;
	const blockCfg = parseShelfBlock("shelf: reading\nlimit: 3\nview: list\nauthor: Frank Herbert\nsort: rating");
	const actions: any = { calls: [] as string[] };
	for (const k of ["open", "openPage", "setStatus", "setRating", "linkFile", "shelveSuggestion", "dismissSuggestion"]) actions[k] = async (...a: any[]) => { actions.calls.push(`${k}:${a.map((x) => x?.title ?? x?.id ?? x).join(",")}`); };
	const ctx = { books, suggestions: sugStore.items, goal: 4, actions };
	const shelfEl = document.createElement("div");
	renderShelfBlock(shelfEl, parseShelfBlock("shelf: finished"), ctx);
	(shelfEl.querySelector(".bcr-star:nth-child(4)") as any)?.click();
	(shelfEl.querySelector(".bcr-lib-actions button") as any)?.click();
	const list = document.createElement("div");
	renderShelfBlock(list, parseShelfBlock("shelf: all\nview: list"), ctx);
	const statsEl = document.createElement("div");
	renderShelfBlock(statsEl, parseShelfBlock("view: stats"), ctx);
	const sugEl = document.createElement("div");
	renderShelfBlock(sugEl, parseShelfBlock("shelf: suggested\nlimit: 1"), ctx);
	(sugEl.querySelector(".bcr-sug .bcr-chip.mod-cta") as any)?.click();
	const emptyEl = document.createElement("div");
	renderShelfBlock(emptyEl, parseShelfBlock("shelf: abandoned"), ctx);
	check("library-pages", created.length === 7 && again2.length === 0 && libPage.includes("```book-shelf\nshelf: reading") && libPage.includes("shelf: suggested") && libPage.includes("view: stats") && logPage.includes("sort: finished")
		&& !logPage.includes("graph-query") && typedLog.includes("MATCH (b:Book)-[:written_by]->(a:Author)") && typedLog.includes("has_genre")
		&& blockCfg.shelf === "reading" && blockCfg.limit === 3 && blockCfg.view === "list" && blockCfg.author === "Frank Herbert" && blockCfg.sort === "rating"
		&& shelfEl.querySelectorAll(".bcr-lib-card").length === 1 && shelfEl.querySelector(".bcr-status")?.textContent === "Finished" && actions.calls.includes("setRating:Dune,4") && actions.calls.some((c: string) => c.startsWith("open:"))
		&& list.querySelectorAll(".bcr-lib-row").length === books.length && statsEl.querySelectorAll(".bcr-stat-tile").length >= 3 && statsEl.querySelectorAll(".bcr-month").length === 12
		&& sugEl.querySelectorAll(".bcr-sug").length === 1 && actions.calls.some((c: string) => c.startsWith("shelveSuggestion:")) && (emptyEl.textContent ?? "").includes("Nothing here yet"),
		"seven library pages (never overwritten) made of live book-shelf blocks, with Typed Graph queries only when Typed Graph is on; shelf, list, stats and suggestion blocks draw; rating and shelving work from them");

	// --- subscriptions: phone hand-off and desktop app commands
	const sAi = { ...DEFAULT_SETTINGS.ai, provider: "claude-sub" as const };
	const phoneClient = new AiClient(() => sAi, async () => ({ status: 200, json: {}, text: "" }), async () => "desktop answer", () => false);
	let handoff = "";
	try { await phoneClient.chat("sys", [{ role: "user", content: "Explain X" }]); } catch (e) { if (e instanceof HandoffNeeded) handoff = e.prompt; }
	const deskClient = new AiClient(() => sAi, async () => ({ status: 200, json: {}, text: "" }), async () => "desktop answer", () => true);
	const desk = await deskClient.chat("sys", [{ role: "user", content: "Explain X" }]);
	const claudeCmd = buildCliCommand(sAi, "SYS", [{ role: "user", content: "Q" }], "/tmp/x");
	const codexCmd = buildCliCommand({ ...sAi, provider: "chatgpt-sub" }, "SYS", [{ role: "user", content: "Q" }], "/tmp/x");
	settings.ai.provider = "chat-app";
	(host as any).askAi = (sys: string, m: any) => new AiClient(() => settings.ai, async () => ({ status: 200, json: {}, text: "" })).chat(sys, m);
	const hoCard = await view.runAi("translate", sel);
	view.openPanel("ai");
	const hoButtons = Array.from(view.containerEl.querySelectorAll(".bcr-handoff button")).map((b: any) => b.textContent);
	check("subscriptions", handoff.includes("Explain X") && desk === "desktop answer" && claudeCmd.bin === "claude" && claudeCmd.args.includes("-p") && codexCmd.answerFile === "/tmp/x" && !!hoCard?.handoff && hoButtons.some((t: string) => t.includes("Claude")) && hoButtons.some((t: string) => t.includes("Paste")),
		`Claude subscription runs "claude -p" on a computer; on a phone the question goes to the chat app (${hoButtons.join(", ")})`);
	settings.ai.provider = "claude-sub";

	// --- small pure pieces
	const api = new AiClient(() => ({ ...DEFAULT_SETTINGS.ai, provider: "anthropic", apiKey: "k", model: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com/v1" }), async () => ({ status: 200, json: { content: [{ type: "text", text: "hi" }] }, text: "" }));
	const apiAns = await api.chat("s", [{ role: "user", content: "x" }]);
	const p = buildUserPrompt({ action: "simplify", selection: "x" }, settings.learner);
	const v = parseVocabulary("## Words\n- **gale** — strong wind (шторм)\n- **gale** — dup");
	const ins = insertUnderHeading("# T\n## A\n- one\n\n## B\n", "A", "- two");
	const fm = setFrontmatterField("---\nprogress: 0\n---\nbody", "progress", 42);
	check("helpers", apiAns === "hi" && p.includes("B1") && v.length === 1 && ins.includes("- one\n- two\n\n## B") && fm.startsWith("---\nprogress: 42"),
		"API answers read, prompts use the reader's level, word lists parsed, notes edited in the right section");

	const allPassed = steps.every((s) => s.passed);
	fs.writeFileSync(out, JSON.stringify({ version: 1, steps }, null, 2));
	for (const s of steps) console.log(`${s.passed ? "PASS" : "FAIL"}  ${s.step}: ${s.detail}`);
	console.log(allPassed ? "All steps passed" : "Some steps failed");
	view.unload();
	process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	steps.push({ step: "crash", passed: false, detail: String(e?.stack ?? e) });
	const outIdx = process.argv.indexOf("--self-test");
	fs.writeFileSync(outIdx >= 0 ? process.argv[outIdx + 1] : "selftest.json", JSON.stringify({ version: 1, steps }, null, 2));
	process.exit(1);
});
