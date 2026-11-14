/* A small original sample book and a pretend AI, shared by the self-test and the browser preview. */
import { strToU8, zipSync } from "fflate";
import type { ChatMessage } from "../src/ai";
import type { NotesHost } from "../src/notes";

const chapters = [
	{
		title: "1. The Lighthouse Keeper",
		body: [
			"Mara had kept the lighthouse on Gull Point for eleven winters, and in all that time the lamp had never once failed.",
			"Notwithstanding the gales that battered the headland every November, she climbed the hundred and twelve steps each evening, trimmed the wick with meticulous care, and polished the great lens until it gleamed like a second moon.",
			"The villagers regarded her with a mixture of gratitude and bewilderment; few of them could fathom why anyone would choose such solitude, let alone relish it.",
			"Yet Mara found the silence anything but empty. The sea spoke to her in a hundred dialects, and she had learned to tell a passing squall from a storm that meant business.",
		],
	},
	{
		title: "2. A Letter in the Fog",
		body: [
			"On the first morning of spring a boy arrived with a letter, its envelope soft and swollen from the damp.",
			"The handwriting was unfamiliar, cramped and hurried, as though the writer had been afraid of running out of either paper or courage.",
			"\"They are going to automate the light,\" it read. \"By autumn there will be no need for a keeper.\"",
			"Mara folded the page twice, then a third time, as if making it smaller might make the news less true.",
		],
	},
	{
		title: "3. The Last Watch",
		body: [
			"She spent the summer teaching the boy the names of the winds and the moods of the tide.",
			"He was an indefatigable pupil, scribbling notes in the margins of an old almanac and asking questions faster than she could answer them.",
			"When the engineers finally came, they found the logbook complete to the very last line, written in two hands.",
		],
	},
];

export function sampleEpub(): Uint8Array {
	const xhtml = (title: string, body: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>p{color:red}</style></head>
<body><h2>${title}</h2>${body.map((p) => `<p>${p.replace(/&/g, "&amp;")}</p>`).join("\n")}<script>alert(1)</script></body></html>`;
	const files: Record<string, Uint8Array> = {
		mimetype: strToU8("application/epub+zip"),
		"META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
		"OEBPS/content.opf": strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Keeper of Gull Point</dc:title><dc:creator>A. Sample</dc:creator><dc:language>en</dc:language><dc:identifier id="id">sample-1</dc:identifier></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`),
		"OEBPS/nav.xhtml": strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${chapters.map((c, i) => `<li><a href="text/ch${i + 1}.xhtml">${c.title}</a></li>`).join("")}</ol></nav></body></html>`),
	};
	chapters.forEach((c, i) => (files[`OEBPS/text/ch${i + 1}.xhtml`] = strToU8(xhtml(c.title, c.body))));
	return zipSync(files);
}

/** Answers shaped like a real model's, so every button has something to work with. */
export async function fakeAi(system: string, messages: ChatMessage[]): Promise<string> {
	if (system.includes("reading cat")) {
		const turns = messages.filter((m) => m.role === "user").length;
		const asked = messages[messages.length - 1].content.split("\n\n").pop() ?? "";
		return `Mrrp! (turn ${turns}) You asked: ${asked}. Mara guards the light, and **that** is what the page is about.`;
	}
	const last = messages[messages.length - 1].content;
	const quoted = /"""\n([\s\S]*?)\n"""/.exec(last)?.[1]?.trim() ?? "";
	if (last.startsWith("Help me understand this passage") || last.includes("## Hard sentences") && last.startsWith("Here is a page")) {
		return [
			last.startsWith("Here is a page") ? "## Summary\nMara looks after a lighthouse alone. She works hard every evening and she likes the quiet." : "## Simplified\nEven with the strong winds every November, she climbed the 112 steps each evening. She cut the wick very carefully and cleaned the big glass until it shone like a second moon.",
			"## Hard sentences",
			"- Notwithstanding the gales that battered the headland → Even though strong winds hit the land by the sea",
			"## Words",
			"- **notwithstanding** — even though; despite (незважаючи на)",
			"- **gale** — a very strong wind (шторм)",
			"- **meticulous** — very careful about small details (ретельний)",
		].join("\n");
	}
	if (last.startsWith("Explain the word")) {
		const w = /phrase "(.+?)"/.exec(last)?.[1] ?? "word";
		return `**${w}** — very careful about every small detail (ретельний)\n\n*Adjective.* Here it means Mara did the job slowly and perfectly.\n\nExample: *He keeps meticulous notes.*\n\nEasier words: careful, exact, precise.`;
	}
	if (last.startsWith("Make a flashcard")) {
		const w = /phrase "(.+?)"/.exec(last)?.[1] ?? "word";
		const lemma = w.toLowerCase().replace(/s$/, "");
		return `Word: ${lemma}\nTranslation: шторм\nMeaning: a very strong wind\nExample: The gale broke the old fence.`;
	}
	if (last.startsWith("Translate")) return "Незважаючи на шторми, що щолистопада били по мисі, вона щовечора підіймалася сто дванадцятьма сходинками…";
	return `This sentence shows how dedicated Mara is: ${quoted ? `“${quoted.slice(0, 60)}…”` : "the passage"} describes her daily routine. The comparison of the lens to *a second moon* tells us how bright and important the light is to her.`;
}

export class MemoryVault implements NotesHost {
	files = new Map<string, string>();
	folders = new Set<string>();
	exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) { return this.files.get(p) ?? ""; }
	async write(p: string, c: string) { this.files.set(p, c); }
	async ensureFolder(p: string) { const parts = p.split("/"); for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/")); }
	list(prefix: string) { return Array.from(this.files.keys()).filter((k) => k.startsWith(prefix)); }
}
