import type { LearnerSettings, Level } from "./settings";

export interface LanguageProfile {
	language: string;
	level: Level;
}

export const LEVEL_LABELS: Record<string, string> = {
	A1: "A1 – beginner",
	A2: "A2 – elementary",
	B1: "B1 – intermediate",
	B2: "B2 – upper intermediate",
	C1: "C1 – advanced",
	C2: "C2 – proficient",
	native: "Native speaker",
};

const CODES: Record<string, string> = {
	en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch",
	pl: "Polish", uk: "Ukrainian", ru: "Russian", cs: "Czech", sk: "Slovak", sv: "Swedish", da: "Danish",
	no: "Norwegian", nb: "Norwegian", nn: "Norwegian", fi: "Finnish", tr: "Turkish", ja: "Japanese", zh: "Chinese",
	ko: "Korean", ar: "Arabic", el: "Greek", hu: "Hungarian", ro: "Romanian", he: "Hebrew", hi: "Hindi",
	la: "Latin", bg: "Bulgarian", hr: "Croatian", sr: "Serbian", lt: "Lithuanian", lv: "Latvian", et: "Estonian",
	ca: "Catalan", id: "Indonesian", vi: "Vietnamese", th: "Thai",
};

/** "de-AT" → "German". Anything that isn't a language code is returned as typed. */
export function languageName(codeOrName: string | undefined | null): string | undefined {
	const s = (codeOrName ?? "").trim();
	if (!s) return undefined;
	const primary = s.toLowerCase().split(/[-_]/)[0];
	if (/^[a-z]{2,3}$/.test(s.toLowerCase().split(/[-_]/)[0]) && /^[a-z]{2,3}([-_][a-z0-9]+)*$/i.test(s) && CODES[primary]) return CODES[primary];
	return s;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The language profiles a reader has set up: the main one first, then the others. */
export function languageProfiles(l: LearnerSettings): LanguageProfile[] {
	const out: LanguageProfile[] = [];
	const seen = new Set<string>();
	for (const p of [{ language: l.learningLanguage, level: l.level }, ...(l.otherLanguages ?? [])]) {
		const name = p.language.trim();
		if (!name || seen.has(norm(name))) continue;
		seen.add(norm(name));
		out.push({ language: name, level: p.level });
	}
	return out;
}

/** The reader's settings as they apply to a book in `language`: that language's level, or the main profile when unknown. */
export function profileFor(l: LearnerSettings, language?: string): LearnerSettings {
	const name = languageName(language);
	if (!name) return l;
	const hit = languageProfiles(l).find((p) => norm(p.language) === norm(name));
	return hit ? { ...l, learningLanguage: hit.language, level: hit.level } : l;
}
