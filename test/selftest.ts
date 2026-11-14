/* Self-test: runs the real reader in Node with a stand-in Obsidian, drives it like a reader would, and records what worked. */
import { parseHTML } from "linkedom";
import * as fs from "node:fs";

const { window, document, DOMParser } = parseHTML("<!doctype html><html><body></body></html>") as any;
const g: any = globalThis;
g.window = window; g.document = document; g.DOMParser = DOMParser;
g.HTMLElement = window.HTMLElement; g.Node = window.Node; Object.defineProperty(g, "navigator", { value: { clipboard: { writeText: async () => {}, readText: async () => "" } }, configurable: true });
g.__mockApp = { vault: {}, workspace: {} };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mock = require("obsidian");
mock.installDomHelpers(window);

import { AiClient, HandoffNeeded } from "../src/ai";
import { buildCliCommand } from "../src/cliRunner";
import { parseEpub } from "../src/epub";
import { strokesToSvg, svgToStrokes, eraseAt } from "../src/ink";
import { BookNotes, HUB_SECTIONS, insertUnderHeading, setFrontmatterField } from "../src/notes";
import { buildUserPrompt, parseVocabulary } from "../src/prompts";
import { ReaderView } from "../src/readerView";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";
import { BookStore } from "../src/store";
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
	const notes = new BookNotes(vault, () => settings.notes);
	const host = {
		settings, store, notes,
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
	check("hud", toolbarBtns >= 8 && /%/.test(label) && cards >= 3 && wordRows === 3 && hlRows >= 1 && tabs === 3 && selTool >= 10 && HUB_SECTIONS.every((s) => hub.includes(`## ${s}`)),
		`toolbar ${toolbarBtns} buttons, position "${label}", selection bar ${selTool} buttons, panel tabs ${tabs}: ${cards} AI answers, ${wordRows} words, ${hlRows} highlights; book page has all ${HUB_SECTIONS.length} sections`);

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
