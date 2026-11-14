import type { LearnerSettings } from "./settings";

export type AiAction = "explain" | "simplify" | "define" | "card" | "translate" | "ask" | "study";

export const ACTION_LABELS: Record<AiAction, string> = {
	explain: "Explain",
	simplify: "Simplify for my level",
	define: "Word meaning",
	card: "Flashcard",
	translate: "Translate",
	ask: "Question",
	study: "Study this page",
};

export interface PromptInput {
	action: AiAction;
	selection: string;
	context?: string;
	question?: string;
	bookTitle?: string;
	bookAuthor?: string;
}

const LEVEL_TEXT: Record<string, string> = {
	A1: "A1 (beginner: knows only the most common words, short present-tense sentences)",
	A2: "A2 (elementary: everyday words, simple sentences)",
	B1: "B1 (intermediate: understands clear standard language on familiar topics)",
	B2: "B2 (upper intermediate: reads most texts, struggles with idioms, rare words and long sentences)",
	C1: "C1 (advanced: misses only rare words, literary or archaic language and subtle idioms)",
	C2: "C2 (proficient: near-native; only very rare or specialist words need help)",
	native: "native speaker",
};

export function explanationLanguage(l: LearnerSettings): string {
	return l.explainIn === "native" ? l.nativeLanguage : `simple ${l.learningLanguage} (at the reader's level)`;
}

export function buildSystemPrompt(l: LearnerSettings, bookTitle?: string, bookAuthor?: string): string {
	const lines = [
		"You are a patient reading companion built into an e-book reader, like a tutor sitting next to the reader.",
		`The reader's native language is ${l.nativeLanguage}. They are learning ${l.learningLanguage}; their level is ${LEVEL_TEXT[l.level] ?? l.level}.`,
		`Write your explanations in ${explanationLanguage(l)}.`,
		"Keep answers short and concrete. Use Markdown. Never invent facts about the book; if the context is not enough, say so.",
	];
	if (bookTitle) lines.push(`The book is "${bookTitle}"${bookAuthor ? ` by ${bookAuthor}` : ""}.`);
	if (l.extraInstructions.trim()) lines.push(`Reader's note: ${l.extraInstructions.trim()}`);
	return lines.join("\n");
}

function ctx(input: PromptInput): string {
	if (!input.context) return "";
	const c = input.context.length > 3000 ? input.context.slice(0, 3000) + "…" : input.context;
	return `\n\nSurrounding text from the book (for context):\n"""\n${c}\n"""`;
}

export function buildUserPrompt(input: PromptInput, l: LearnerSettings): string {
	const sel = input.selection.trim();
	switch (input.action) {
		case "explain":
			return `Explain what this passage means in its context: the idea, any references, idioms or difficult words, and why it matters in the story or argument. Two short paragraphs at most.\n\nSelected text:\n"""\n${sel}\n"""${ctx(input)}`;
		case "simplify":
			return [
				`Help me understand this passage at my level (${l.level}).`,
				"Reply in exactly this structure:",
				"## Simplified",
				`(the passage rewritten in simple ${l.learningLanguage} for my level, keeping the meaning)`,
				"## Hard sentences",
				"- (each complex sentence) → (a simpler version)",
				"## Words",
				`- **word or phrase** — short simple definition (${l.nativeLanguage} translation)`,
				"List only words above my level, at most 10. Leave a section out if it would be empty.",
				`\nSelected text:\n"""\n${sel}\n"""${ctx(input)}`,
			].join("\n");
		case "define":
			return [
				`Explain the word or phrase "${sel}" as it is used here, for a ${l.level} learner of ${l.learningLanguage}.`,
				"Start with exactly one line in this form:",
				`**${sel}** — short simple definition (${l.nativeLanguage} translation)`,
				"Then: part of speech, the meaning in this sentence, one simple example sentence, and 2-3 easier synonyms.",
				ctx(input),
			].join("\n");
		case "card":
			return [
				`Make a flashcard for the word or phrase "${sel}" as it is used in this passage, for a ${l.level} learner of ${l.learningLanguage}.`,
				"Reply with exactly these four lines and nothing else:",
				`Word: the dictionary form (a noun with its article if ${l.learningLanguage} uses articles, a verb in the infinitive, a phrase as it is)`,
				`Translation: the ${l.nativeLanguage} translation of the word as it is used here`,
				`Meaning: a short, simple definition in simple ${l.learningLanguage} that fits my level`,
				`Example: one new, simple example sentence in ${l.learningLanguage}`,
				ctx(input),
			].join("\n");
		case "translate":
			return `Translate this into ${l.nativeLanguage}. Keep the tone. After the translation add one line with any phrase that does not translate literally.\n\n"""\n${sel}\n"""${ctx(input)}`;
		case "study":
			return [
				`Here is a page I am reading. Find the sentences and words that are above my level (${l.level}) in ${l.learningLanguage}.`,
				"Reply in exactly this structure:",
				"## Summary",
				"(two or three simple sentences about what happens on this page)",
				"## Hard sentences",
				"- (complex sentence quoted) → (simpler version)",
				"## Words",
				`- **word or phrase** — short simple definition (${l.nativeLanguage} translation)`,
				"At most 8 sentences and 12 words.",
				`\nPage text:\n"""\n${sel.length > 6000 ? sel.slice(0, 6000) + "…" : sel}\n"""`,
			].join("\n");
		case "ask":
		default:
			return `${input.question ?? "What does this mean?"}${sel ? `\n\nSelected text:\n"""\n${sel}\n"""` : ""}${ctx(input)}`;
	}
}

export interface ParsedWord {
	word: string;
	definition: string;
}

/** Pull "- **word** — definition" lines out of an AI answer (the "Words" section, or any matching lines). */
export function parseVocabulary(markdown: string): ParsedWord[] {
	const out: ParsedWord[] = [];
	const seen = new Set<string>();
	const re = /^\s*(?:[-*]\s+)?\*\*(.+?)\*\*\s*(?:—|–|-|:)\s*(.+?)\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown))) {
		const word = m[1].trim();
		const definition = m[2].trim();
		const key = word.toLowerCase();
		if (!word || !definition || seen.has(key) || word.length > 60) continue;
		seen.add(key);
		out.push({ word, definition });
	}
	return out;
}

export interface ParsedCard {
	word?: string;
	translation?: string;
	meaning?: string;
	example?: string;
}

/** Read the "Word: / Translation: / Meaning: / Example:" lines of a flashcard answer. */
export function parseCard(answer: string): ParsedCard {
	const out: ParsedCard = {};
	const clean = (v: string) => v.replace(/^[\s*_`"“”]+|[\s*_`"“”]+$/g, "").trim();
	for (const [field, label] of [["word", "Word"], ["translation", "Translation"], ["meaning", "Meaning"], ["example", "Example"]] as const) {
		const m = new RegExp(`^[\\s>*_#-]*\\**${label}\\**\\s*:\\**\\s*(.+)$`, "im").exec(answer);
		const v = m ? clean(m[1]) : "";
		if (v) out[field] = v;
	}
	return out;
}
