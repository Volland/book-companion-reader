import { HandoffNeeded } from "./ai";

/** The obsidian:// action the Shortcut calls back with its answer. */
export const SHORTCUT_CALLBACK = "book-reader-answer";
export const DEFAULT_SHORTCUT_NAME = "Book Companion AI";
/** Questions longer than this are cut so the shortcuts:// link stays reliable. */
const MAX_PROMPT = 12000;
/** How long to wait for the Shortcut to call back before offering the chat app instead. */
const TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
	prompt: string;
	resolve: (text: string) => void;
	reject: (e: Error) => void;
	timer: number;
}

/**
 * iPhone and iPad only: asks the AI through an Apple Shortcut the person made once.
 * The Shortcut uses the "Ask Claude" action (Claude app) or "Use Model" with ChatGPT (iOS 26), so the question
 * runs on the subscription signed in to that app. Its answer comes back through x-callback-url to
 * obsidian://book-reader-answer, which the plugin passes to handle().
 */
export class ShortcutBridge {
	private pending = new Map<string, Pending>();

	constructor(
		private open: (url: string) => void,
		private vaultName: () => string,
		private readClipboard: () => Promise<string> = async () => "",
	) {}

	/** The shortcuts:// link that runs the Shortcut with the question and says where to send the answer. */
	buildUrl(name: string, prompt: string, id: string): string {
		const back = (status: string) => {
			const q = [`vault=${encodeURIComponent(this.vaultName())}`, `id=${id}`];
			if (status) q.push(`status=${status}`);
			return `obsidian://${SHORTCUT_CALLBACK}?${q.join("&")}`;
		};
		const text = prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + "…" : prompt;
		return "shortcuts://x-callback-url/run-shortcut?" + [
			`name=${encodeURIComponent(name)}`,
			"input=text",
			`text=${encodeURIComponent(text)}`,
			`x-success=${encodeURIComponent(back(""))}`,
			`x-cancel=${encodeURIComponent(back("cancel"))}`,
			`x-error=${encodeURIComponent(back("error"))}`,
		].join("&");
	}

	/** Runs the Shortcut and waits for its answer. Fails with HandoffNeeded so the reader can offer the chat app instead. */
	run(name: string, prompt: string): Promise<string> {
		const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
		return new Promise<string>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new HandoffNeeded(prompt, `The Shortcut "${name}" didn't send an answer back. Send the question to your chat app instead.`));
			}, TIMEOUT_MS);
			this.pending.set(id, { prompt, resolve, reject, timer });
			try {
				this.open(this.buildUrl(name, prompt, id));
			} catch (e) {
				window.clearTimeout(timer);
				this.pending.delete(id);
				reject(new HandoffNeeded(prompt, `Couldn't start the Shortcuts app (${e instanceof Error ? e.message : String(e)}). Send the question to your chat app instead.`));
			}
		});
	}

	/** True while a question is waiting for the Shortcut. */
	get waiting(): number {
		return this.pending.size;
	}

	/** Called with the parameters of obsidian://book-reader-answer?id=…&result=… (or status=cancel / error). */
	async handle(params: Record<string, string | undefined>): Promise<boolean> {
		const id = params.id ?? "";
		const p = this.pending.get(id);
		if (!p) return false;
		this.pending.delete(id);
		window.clearTimeout(p.timer);
		if (params.status === "cancel") {
			p.reject(new HandoffNeeded(p.prompt, "The Shortcut was cancelled. Try again, or send the question to your chat app."));
			return true;
		}
		if (params.status === "error") {
			const why = params.errorMessage ? ` (${params.errorMessage})` : "";
			p.reject(new HandoffNeeded(p.prompt, `The Shortcut stopped with an error${why}. Check that a Shortcut with that name exists (Settings → Book Companion Reader), or send the question to your chat app.`));
			return true;
		}
		let text = (params.result ?? "").trim();
		// A Shortcut that copies its answer instead of returning it still works.
		if (!text) {
			try { text = (await this.readClipboard()).trim(); } catch { text = ""; }
			if (text === p.prompt.trim()) text = "";
		}
		if (text) p.resolve(text);
		else p.reject(new HandoffNeeded(p.prompt, "The Shortcut finished without an answer. End it with \"Stop and Output\" of the AI's response, or send the question to your chat app."));
		return true;
	}

	/** Gives up on every waiting question (plugin unloading). */
	cancelAll() {
		for (const [id, p] of this.pending) {
			window.clearTimeout(p.timer);
			p.reject(new HandoffNeeded(p.prompt, "Answer in your chat app"));
			this.pending.delete(id);
		}
	}
}
