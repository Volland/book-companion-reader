import type { AiSettings } from "./settings";
import { PROVIDER_DEFAULTS } from "./settings";

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

/** The few fields of the AI services' JSON replies that we read. */
export interface ApiJson {
	error?: { message?: string };
	content?: { type?: string; text?: string }[];
	choices?: { message?: { content?: string } }[];
}

export interface HttpResponse {
	status: number;
	json: ApiJson | null;
	text: string;
}

/** Sends one HTTP request. In Obsidian this is requestUrl, which works on mobile and has no CORS limits. */
export type Requester = (req: HttpRequest) => Promise<HttpResponse>;

export class AiError extends Error {}

/** The question has to go to the person's own chat app (phone, or no subscription app on this computer). */
export class HandoffNeeded extends Error {
	constructor(public prompt: string, public reason: string) {
		super(reason);
	}
}

export type CliRunner = (s: AiSettings, system: string, messages: ChatMessage[]) => Promise<string>;

/** One block of text with the instructions and the conversation, for apps that take a single prompt. */
export function plainPrompt(system: string, messages: ChatMessage[]): string {
	const parts: string[] = [];
	if (system) parts.push(system, "");
	if (messages.length === 1) parts.push(messages[0].content);
	else for (const m of messages) parts.push(`${m.role === "user" ? "Reader" : "You (earlier answer)"}:\n${m.content}\n`);
	return parts.join("\n");
}

export const CHAT_APPS: Record<string, { label: string; url: (q: string) => string; prefill: boolean }> = {
	chatgpt: { label: "ChatGPT", url: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`, prefill: true },
	claude: { label: "Claude", url: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`, prefill: true },
	gemini: { label: "Gemini", url: () => "https://gemini.google.com/app", prefill: false },
};

export class AiClient {
	constructor(private settings: () => AiSettings, private request: Requester, private cli?: CliRunner, private canRunCli: () => boolean = () => false) {}

	isConfigured(): boolean {
		const s = this.settings();
		const d = PROVIDER_DEFAULTS[s.provider];
		if (d.kind !== "api") return true;
		return !!s.model && (!d.needsKey || !!s.apiKey);
	}

	buildRequest(system: string, messages: ChatMessage[]): HttpRequest {
		const s = this.settings();
		const base = (s.baseUrl || PROVIDER_DEFAULTS[s.provider].baseUrl).replace(/\/+$/, "");
		if (s.provider === "anthropic") {
			return {
				url: `${base}/messages`,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": s.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: s.model,
					max_tokens: s.maxTokens,
					temperature: s.temperature,
					system,
					messages,
				}),
			};
		}
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (s.apiKey) headers["authorization"] = `Bearer ${s.apiKey}`;
		if (s.provider === "openrouter") headers["X-Title"] = "Book Companion Reader";
		return {
			url: `${base}/chat/completions`,
			method: "POST",
			headers,
			body: JSON.stringify({
				model: s.model,
				max_tokens: s.maxTokens,
				temperature: s.temperature,
				messages: [{ role: "system", content: system }, ...messages],
			}),
		};
	}

	async chat(system: string, messages: ChatMessage[]): Promise<string> {
		const s = this.settings();
		const kind = PROVIDER_DEFAULTS[s.provider].kind;
		if (kind === "handoff") throw new HandoffNeeded(plainPrompt(system, messages), "Answer in your chat app");
		if (kind === "cli") {
			if (!this.cli || !this.canRunCli()) {
				throw new HandoffNeeded(plainPrompt(system, messages), `${PROVIDER_DEFAULTS[s.provider].label} works through an app on a computer. On this device, send the question to your chat app.`);
			}
			try {
				return await this.cli(s, system, messages);
			} catch (e) {
				throw new AiError(e instanceof Error ? e.message : String(e));
			}
		}
		if (!this.isConfigured()) {
			throw new AiError("The AI helper isn't set up yet. Open Settings → Book Companion Reader and add your AI service and key.");
		}
		const req = this.buildRequest(system, messages);
		let res: HttpResponse;
		try {
			res = await this.request(req);
		} catch (e) {
			// requestUrl throws on non-2xx; try to keep the service's own message.
			const err = e as { json?: ApiJson; message?: string };
			const msg = err.json?.error?.message ?? err.message ?? String(e);
			throw new AiError(`Couldn't reach the AI service: ${msg}`);
		}
		if (res.status >= 400) {
			const msg = res.json?.error?.message ?? res.text?.slice(0, 300);
			throw new AiError(`The AI service said no (${res.status}): ${msg}`);
		}
		const text = AiClient.extractText(this.settings().provider, res.json);
		if (!text) throw new AiError("The AI service sent an empty answer.");
		return text.trim();
	}

	static extractText(provider: string, json: ApiJson | null): string {
		if (!json) return "";
		if (provider === "anthropic") {
			const parts = Array.isArray(json.content) ? json.content : [];
			return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
		}
		return json.choices?.[0]?.message?.content ?? "";
	}
}
