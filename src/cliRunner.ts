import type { AiSettings, Provider } from "./settings";
import type { ChatMessage } from "./ai";
import { plainPrompt } from "./ai";

/**
 * Desktop only: ask the AI through a subscription app the person is already signed in to
 * (Claude Code for Claude Pro/Max, Codex for ChatGPT Plus/Pro, Gemini CLI for a Google account).
 * Obsidian desktop has Node built in, so we start the app's command line and read its answer.
 */
export interface CliCommand {
	bin: string;
	args: string[];
	stdin: string;
	/** Read the answer from this file instead of the printed output (Codex). */
	answerFile?: string;
}

export const CLI_BINARIES: Partial<Record<Provider, string>> = {
	"claude-sub": "claude",
	"chatgpt-sub": "codex",
	"gemini-sub": "gemini",
};

export function buildCliCommand(s: AiSettings, system: string, messages: ChatMessage[], tmpFile: string): CliCommand {
	const bin = s.cliPath?.trim() || CLI_BINARIES[s.provider] || "claude";
	const model = s.model?.trim();
	if (s.provider === "claude-sub") {
		const convo = messages.length === 1 ? messages[0].content : plainPrompt("", messages);
		const args = ["-p", "--output-format", "text", "--system-prompt", system, "--tools", "", "--no-session-persistence", "--strict-mcp-config"];
		if (model) args.push("--model", model);
		return { bin, args, stdin: convo };
	}
	if (s.provider === "chatgpt-sub") {
		const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", tmpFile];
		if (model) args.push("--model", model);
		args.push("-");
		return { bin, args, stdin: plainPrompt(system, messages), answerFile: tmpFile };
	}
	// gemini-sub
	const args = ["-o", "text", "-p", "Answer the request above."];
	if (model) args.push("-m", model);
	return { bin, args, stdin: plainPrompt(system, messages) };
}

/** Folders where these apps usually live; Obsidian started from the Dock doesn't see the shell's PATH. */
function extraPath(home: string): string[] {
	return [`${home}/.local/bin`, `${home}/.claude/local`, `${home}/.npm-global/bin`, `${home}/.bun/bin`, `${home}/.volta/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home}/AppData/Roaming/npm`];
}

export function desktopCliAvailable(): boolean {
	const req = (globalThis as any).require ?? (globalThis as any).window?.require;
	try {
		return !!req && !!req("child_process");
	} catch {
		return false;
	}
}

export async function runCli(s: AiSettings, system: string, messages: ChatMessage[]): Promise<string> {
	const req = (globalThis as any).require ?? (globalThis as any).window?.require;
	const cp = req("child_process");
	const os = req("os");
	const fs = req("fs");
	const path = req("path");
	const tmp = path.join(os.tmpdir(), `book-companion-${Date.now()}.txt`);
	const cmd = buildCliCommand(s, system, messages, tmp);
	const home = os.homedir();
	const sep = process.platform === "win32" ? ";" : ":";
	// Gemini CLI refuses to run headless outside a "trusted" folder unless told to.
	const env = { ...process.env, PATH: [...extraPath(home), process.env.PATH ?? ""].join(sep), GEMINI_CLI_TRUST_WORKSPACE: "true" };
	return await new Promise<string>((resolve, reject) => {
		const child = cp.spawn(cmd.bin, cmd.args, { cwd: os.tmpdir(), env, shell: process.platform === "win32" });
		let out = "", err = "";
		const timer = setTimeout(() => { child.kill(); reject(new Error("The subscription app took too long to answer (2 minutes).")); }, 120000);
		child.stdout.on("data", (d: any) => (out += d.toString()));
		child.stderr.on("data", (d: any) => (err += d.toString()));
		child.on("error", (e: any) => {
			clearTimeout(timer);
			reject(new Error(e?.code === "ENOENT"
				? `Couldn't find "${cmd.bin}". Install it and sign in once in a terminal, or set its full path in the plugin settings.`
				: String(e?.message ?? e)));
		});
		child.on("close", (code: number) => {
			clearTimeout(timer);
			let answer = out;
			if (cmd.answerFile) {
				try { answer = fs.readFileSync(cmd.answerFile, "utf8"); fs.unlinkSync(cmd.answerFile); } catch { /* fall back to printed output */ }
			}
			if (code !== 0 && !answer.trim()) {
				const hint = /IneligibleTier|no longer supported/i.test(err)
					? " Your Google account's plan can't be used from this app any more; pick another AI service or \"My chat app\"."
					: /log ?in|auth|sign in|credential/i.test(err) ? " Open a terminal and sign in to it once." : "";
				reject(new Error(`The subscription app stopped with an error.${hint} ${err.trim().slice(-300)}`));
			} else resolve(answer.trim());
		});
		child.stdin.write(cmd.stdin);
		child.stdin.end();
	});
}
