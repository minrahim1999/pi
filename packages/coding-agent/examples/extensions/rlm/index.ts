/**
 * RLM extension — Recursive Language Models (arXiv:2512.24601) for Aegis.
 *
 * Ported from Athena Agent. The prompt lives as a variable `P` in a sandboxed
 * REPL (node:vm); the model writes code to probe/decompose it and recursively
 * call itself over snippets. Only constant-size metadata + truncated stdout
 * enter the context, so prompts far beyond the context window work.
 *
 * Commands:
 *   /rlm <question>          Run plain RLM (Algorithm 1)
 *   /rlm --srlm <question>   Self-reflective program search (2603.15653)
 *   /rlm --chained <n> <q>   Fresh-context roots + blackboard handoff (2608.05124)
 */
import vm from "node:vm";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Context, Message, Model } from "@earendil-works/pi-ai";

// ============================================================================
// RLM system prompt + code extraction (paper Appendix C style)
// ============================================================================

const RLM_SYSTEM_PROMPT = `You are a Recursive Language Model (RLM). The user's prompt is stored in a Python-like REPL environment as the variable P (a string). You do NOT see the prompt directly — only metadata about it.

Your job: write JavaScript code that examines P, decomposes it, and builds the final answer.

CRITICAL: Respond with JavaScript code ONLY. Do NOT use <tool_call> tags, do NOT emit JSON, do NOT describe what you would do — write actual executable code.

Environment:
- P: the full prompt string (may be very long — do not print it all)
- sub_rlm(prompt): recursively invoke a language model on a snippet; returns its answer as a string. Use it inside loops to process chunks of P.
- print(x): append to stdout (truncated; keep output small)
- Final: assign the final answer to this variable to finish.

Rules:
1. First probe P: print(P.length) and P.slice(0, 200) to understand the task.
2. Decompose: use sub_rlm on slices of P (e.g., inside a for loop) for long or information-dense prompts. Each sub_rlm call gets a fresh model with a short context.
3. Build the answer incrementally in variables; print small progress notes.
4. When done, set Final = <your answer> (a string). The loop stops and Final is returned.
5. Keep each code block short and correct. If a block errors, the error is shown and you can retry.
6. Never print the entire P. Never call sub_rlm more than needed.

Example:
\`\`\`
print(P.length);
const chunk = P.slice(0, 1000);
const summary = await sub_rlm("Summarize this text:\\n" + chunk);
print("chunk done");
Final = summary;
\`\`\``;

/** Extract JavaScript code from a model response (strip fences, tolerate prose). */
function extractCode(text: string): string {
	const fence = text.match(/```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/i);
	if (fence?.[1]) return fence[1].trim();
	if (/^(const|let|var|print\(|Final\s*=|for\s*\(|while\s*\(|await\s+sub_rlm)/m.test(text.trim())) {
		return text.trim();
	}
	return "";
}

/** Build the metadata block shown to the model about the current REPL state. */
function metadataBlock(prompt: string, stdout: string, iteration: number): string {
	return [
		"[REPL state]",
		`P.length = ${prompt.length}`,
		`P.prefix = ${JSON.stringify(prompt.slice(0, 200))}`,
		`iteration = ${iteration}`,
		stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
	].join("\n");
}

// ============================================================================
// Sandboxed REPL (node:vm)
// ============================================================================

interface ReplOptions {
	prompt: string;
	subRlm: (prompt: string) => Promise<string>;
	subRlmAll?: (prompts: string[]) => Promise<string[]>;
	timeoutMs: number;
	maxSubCalls: number;
	maxStdoutChars: number;
}

interface ReplResult {
	stdout: string;
	finished: boolean;
	finalValue: string;
	subCalls: number;
	error?: string;
}

class RlmRepl {
	private readonly options: ReplOptions;
	private readonly context: vm.Context;
	private readonly stdout: string[] = [];
	private subCalls = 0;
	private readonly sandbox: {
		P: string;
		print: (x: unknown) => void;
		sub_rlm: (p: string) => Promise<string>;
		sub_rlm_all: (prompts: unknown) => Promise<string[]>;
		Final: unknown;
	};

	constructor(options: ReplOptions) {
		this.options = options;
		this.sandbox = {
			P: this.options.prompt,
			print: (x: unknown) => {
				this.stdout.push(typeof x === "string" ? x : JSON.stringify(x));
			},
			sub_rlm: async (p: string) => {
				if (this.subCalls >= this.options.maxSubCalls) {
					throw new Error(`sub_rlm call limit (${this.options.maxSubCalls}) exceeded`);
				}
				this.subCalls++;
				return this.options.subRlm(String(p));
			},
			sub_rlm_all: async (prompts: unknown) => {
				const list = Array.isArray(prompts) ? prompts.map(String) : [];
				if (this.subCalls + list.length > this.options.maxSubCalls) {
					throw new Error(`sub_rlm call limit (${this.options.maxSubCalls}) exceeded`);
				}
				if (!this.options.subRlmAll) {
					this.subCalls += list.length;
					const out: string[] = [];
					for (const p of list) out.push(await this.options.subRlm(p));
					return out;
				}
				this.subCalls += list.length;
				return this.options.subRlmAll(list);
			},
			Final: undefined,
		};
		this.context = vm.createContext(this.sandbox);
	}

	async run(code: string): Promise<ReplResult> {
		const stdoutBefore = this.stdout.length;
		const subCallsBefore = this.subCalls;
		let finalValue = "";
		let finished = false;

		try {
			const wrapped = `(async () => {\n${code}\n})()`;
			const result = await vm.runInContext(wrapped, this.context, {
				timeout: this.options.timeoutMs,
				filename: "rlm-repl.js",
			});
			if (this.sandbox.Final !== undefined) {
				finished = true;
				finalValue = typeof this.sandbox.Final === "string" ? this.sandbox.Final : JSON.stringify(this.sandbox.Final);
			} else if (result !== undefined) {
				finished = true;
				finalValue = typeof result === "string" ? result : JSON.stringify(result);
			}
		} catch (err) {
			return {
				stdout: this.truncate(this.stdout.slice(stdoutBefore).join("\n")),
				finished: false,
				finalValue: "",
				subCalls: this.subCalls - subCallsBefore,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		return {
			stdout: this.truncate(this.stdout.slice(stdoutBefore).join("\n")),
			finished,
			finalValue,
			subCalls: this.subCalls - subCallsBefore,
		};
	}

	private truncate(s: string): string {
		if (s.length <= this.options.maxStdoutChars) return s;
		return `${s.slice(0, this.options.maxStdoutChars)}\n...[truncated ${s.length - this.options.maxStdoutChars} chars]`;
	}
}

// ============================================================================
// LLM adapter — wraps pi's modelRegistry.complete into Athena's chat() shape
// ============================================================================

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** Convert a simple {role, content} message to pi's Message type. */
function toPiMessage(m: ChatMessage): Message {
	const now = Date.now();
	if (m.role === "assistant") {
		return {
			role: "assistant",
			content: [{ type: "text", text: m.content }],
			api: "chat",
			provider: "unknown",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		};
	}
	return { role: "user", content: m.content, timestamp: now };
}

/** Make a single LLM call via pi's model registry. */
async function chat(
	ctx: ExtensionCommandContext,
	model: Model<any>,
	messages: ChatMessage[],
): Promise<string> {
	const context: Context = {
		systemPrompt: messages.find((m) => m.role === "system")?.content,
		messages: messages.filter((m) => m.role !== "system").map(toPiMessage),
	};
	const result = await ctx.modelRegistry.complete(model, context);
	const text = result.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n");
	return text;
}

// ============================================================================
// RLM loop (Algorithm 1)
// ============================================================================

interface RlmOptions {
	model: Model<any>;
	maxDepth: number;
	maxIterations: number;
	timeoutMs: number;
	maxStdoutChars: number;
	maxSubCalls: number;
	onIteration?: (info: { depth: number; code: string; stdout: string; error?: string }) => void;
}

interface RlmResult {
	answer: string;
	iterations: number;
	subCalls: number;
	depth: number;
}

class Rlm {
	private readonly options: RlmOptions;

	constructor(options: RlmOptions) {
		this.options = options;
	}

	async run(ctx: ExtensionCommandContext, prompt: string, depth = 0): Promise<RlmResult> {
		const { model, maxIterations } = this.options;
		const messages: ChatMessage[] = [{ role: "system", content: RLM_SYSTEM_PROMPT }];
		let subCalls = 0;
		let iterations = 0;
		const repl = new RlmRepl({
			prompt,
			timeoutMs: this.options.timeoutMs,
			maxStdoutChars: this.options.maxStdoutChars,
			maxSubCalls: this.options.maxSubCalls,
			subRlm: async (snippet: string) => {
				subCalls++;
				if (depth >= this.options.maxDepth) {
					return chat(ctx, model, [{ role: "user", content: snippet }]);
				}
				const sub = await this.run(ctx, snippet, depth + 1);
				return sub.answer;
			},
			subRlmAll: async (prompts: string[]) => {
				if (depth >= this.options.maxDepth) {
					return Promise.all(prompts.map((p) => chat(ctx, model, [{ role: "user", content: p }])));
				}
				return Promise.all(prompts.map((p) => this.run(ctx, p, depth + 1).then((r) => r.answer)));
			},
		});

		while (iterations < maxIterations) {
			iterations++;
			messages.push({ role: "user", content: metadataBlock(prompt, replStdout(messages), iterations) });
			const response = await chat(ctx, model, messages);
			const code = extractCode(response);
			if (!code) {
				return { answer: response.trim(), iterations, subCalls, depth };
			}
			const result = await repl.run(code);
			this.options.onIteration?.({ depth, code, stdout: result.stdout, error: result.error });
			messages.push({ role: "assistant", content: code });
			messages.push({ role: "user", content: `[executed]\n${result.error ? `ERROR: ${result.error}` : result.stdout}` });
			if (result.finished) {
				return { answer: result.finalValue, iterations, subCalls, depth };
			}
		}

		return { answer: "Reached maximum RLM iterations without setting Final.", iterations, subCalls, depth };
	}
}

function replStdout(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "user" && m.content.startsWith("[executed]")) {
			return m.content.replace(/^\[executed\]\n/, "");
		}
	}
	return "";
}

// ============================================================================
// SRLM — Self-Reflective program search (arXiv:2603.15653)
// ============================================================================

interface SrlmOptions {
	model: Model<any>;
	numCandidates: number;
	maxIterations: number;
	timeoutMs: number;
	maxStdoutChars: number;
	maxSubCalls: number;
}

const SRLM_PROMPT_SUFFIX = `\n\nIMPORTANT: Provide ${"${N}"} DIFFERENT candidate programs, numbered 1..N, each in its own code fence. After each program, add a comment line with your confidence: // confidence: 0.0-1.0`;

async function runSrlm(ctx: ExtensionCommandContext, options: SrlmOptions, prompt: string): Promise<string> {
	const { model, numCandidates, maxIterations } = options;
	const messages: ChatMessage[] = [
		{ role: "system", content: RLM_SYSTEM_PROMPT + SRLM_PROMPT_SUFFIX.replace("${N}", String(numCandidates)) },
	];

	const repl = new RlmRepl({
		prompt,
		timeoutMs: options.timeoutMs,
		maxStdoutChars: options.maxStdoutChars,
		maxSubCalls: options.maxSubCalls,
		subRlm: async (snippet: string) => chat(ctx, model, [{ role: "user", content: snippet }]),
	});

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		messages.push({ role: "user", content: metadataBlock(prompt, lastStdout(messages), iteration) });
		const response = await chat(ctx, model, messages);
		const candidates = parseCandidates(response);
		if (candidates.length === 0) {
			return response.trim();
		}

		const results = await Promise.all(
			candidates.map(async (c) => {
				const r = await repl.run(c.code);
				return { ...c, result: r };
			}),
		);

		const consensus = consensusAnswer(results.filter((r) => r.result.finished).map((r) => r.result.finalValue));
		const scored = results.map((r) => ({ ...r, score: score(r, consensus) }));
		scored.sort((a, b) => b.score - a.score);
		const best = scored[0]!;

		if (best.result.finished) {
			return best.result.finalValue;
		}
		messages.push({ role: "assistant", content: best.code });
		messages.push({ role: "user", content: `[executed]\n${best.result.error ? `ERROR: ${best.result.error}` : best.result.stdout}` });
	}

	return "Reached maximum SRLM iterations without a final answer.";
}

function parseCandidates(text: string): Array<{ code: string; confidence: number }> {
	const fences = [...text.matchAll(/```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/gi)];
	if (fences.length === 0) {
		const code = extractCode(text);
		return code ? [{ code, confidence: 0.5 }] : [];
	}
	return fences.map((f) => {
		const code = f[1]!.trim();
		const confMatch = code.match(/\/\/\s*confidence:\s*([0-9.]+)/i);
		const confidence = confMatch?.[1] ? Math.min(1, Math.max(0, Number(confMatch[1]))) : 0.5;
		return { code, confidence };
	});
}

function score(
	c: { confidence: number; result: { finished: boolean; error?: string; finalValue: string } },
	consensus: string | null,
): number {
	let s = 0;
	if (c.result.finished) s += 1;
	else if (c.result.error) s -= 0.5;
	s += c.confidence * 0.5;
	if (consensus && c.result.finished && c.result.finalValue.trim().toLowerCase() === consensus) {
		s += 0.5;
	}
	return s;
}

function lastStdout(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "user" && m.content.startsWith("[executed]")) {
			return m.content.replace(/^\[executed\]\n/, "");
		}
	}
	return "";
}

function consensusAnswer(answers: string[]): string | null {
	if (answers.length === 0) return null;
	const counts = new Map<string, number>();
	for (const a of answers) {
		const key = a.trim().toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let best = "";
	let bestCount = 0;
	for (const [key, count] of counts) {
		if (count > bestCount) {
			bestCount = count;
			best = key;
		}
	}
	return best || null;
}

// ============================================================================
// Chained-RLM (arXiv:2608.05124)
// ============================================================================

interface ChainedOptions {
	model: Model<any>;
	numRoots: number;
	maxIterations: number;
	timeoutMs: number;
	maxStdoutChars: number;
	maxSubCalls: number;
	maxBlackboardChars: number;
}

const CHAINED_SYSTEM = `${RLM_SYSTEM_PROMPT}

You are root {ROOT} of {TOTAL} in a chain. You have a FRESH context — you do not see previous roots' reasoning, only the blackboard below. Use it to continue the work. When done, set Final.`;

async function runChained(ctx: ExtensionCommandContext, options: ChainedOptions, prompt: string): Promise<string> {
	const { model, numRoots, maxIterations } = options;
	const rootAnswers: string[] = [];
	let blackboard = "";

	for (let root = 1; root <= numRoots; root++) {
		const system = CHAINED_SYSTEM.replace("{ROOT}", String(root)).replace("{TOTAL}", String(numRoots));
		const messages: ChatMessage[] = [{ role: "system", content: system }];
		if (blackboard) {
			messages.push({ role: "user", content: `[blackboard from previous roots]\n${blackboard}` });
		}

		const repl = new RlmRepl({
			prompt,
			timeoutMs: options.timeoutMs,
			maxStdoutChars: options.maxStdoutChars,
			maxSubCalls: options.maxSubCalls,
			subRlm: async (snippet: string) => chat(ctx, model, [{ role: "user", content: snippet }]),
		});

		let answer = "";
		const artifactLines: string[] = [];
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			messages.push({ role: "user", content: metadataBlock(prompt, lastStdout(messages), iteration) });
			const response = await chat(ctx, model, messages);
			const code = extractCode(response);
			if (!code) {
				answer = response.trim();
				break;
			}
			const result = await repl.run(code);
			messages.push({ role: "assistant", content: code });
			messages.push({ role: "user", content: `[executed]\n${result.error ? `ERROR: ${result.error}` : result.stdout}` });
			for (const line of result.stdout.split("\n")) {
				const t = line.trim();
				if (t && t.length > 3) artifactLines.push(t);
			}
			if (result.finished) {
				answer = result.finalValue;
				break;
			}
		}
		if (!answer) answer = `(root ${root} did not finish)`;

		rootAnswers.push(answer);
		const artifacts = artifactLines.slice(0, 10).join(" | ").slice(0, 500);
		const note = `Root ${root} answer: ${answer.slice(0, 500)}${artifacts ? `\nRoot ${root} artifacts: ${artifacts}` : ""}`;
		blackboard = (blackboard ? `${blackboard}\n` : "") + note;
		if (blackboard.length > options.maxBlackboardChars) {
			blackboard = blackboard.slice(-options.maxBlackboardChars);
		}
	}

	return majorityVote(rootAnswers);
}

function majorityVote(answers: string[]): string {
	if (answers.length === 0) return "";
	const counts = new Map<string, number>();
	for (const a of answers) {
		const key = a.trim().toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let best = answers[0]!;
	let bestCount = 0;
	for (const [key, count] of counts) {
		if (count > bestCount) {
			bestCount = count;
			best = answers.find((a) => a.trim().toLowerCase() === key) ?? best;
		}
	}
	return best;
}

// ============================================================================
// Extension entry point
// ============================================================================

const DEFAULTS = {
	maxDepth: 1,
	maxIterations: 20,
	timeoutMs: 30000,
	maxStdoutChars: 2000,
	maxSubCalls: 20,
	srlmCandidates: 3,
	chainedRoots: 3,
	chainedBlackboardChars: 2000,
};

export default function rlmExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rlm", {
		description: "Run a Recursive Language Model (RLM/SRLM/Chained-RLM) on a prompt",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected. Use /model to pick one.", "warning");
				return;
			}

			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /rlm <question> | /rlm --srlm <q> | /rlm --chained <n> <q>", "warning");
				return;
			}

			ctx.ui.setStatus("rlm", ctx.ui.theme.fg("accent", "⟳ RLM running…"));
			try {
				if (trimmed.startsWith("--srlm")) {
					const question = trimmed.replace(/^--srlm\s*/, "").trim();
					const answer = await runSrlm(
						ctx,
						{ model, numCandidates: DEFAULTS.srlmCandidates, maxIterations: DEFAULTS.maxIterations, timeoutMs: DEFAULTS.timeoutMs, maxStdoutChars: DEFAULTS.maxStdoutChars, maxSubCalls: DEFAULTS.maxSubCalls },
						question,
					);
					ctx.ui.setStatus("rlm", undefined);
					ctx.ui.notify(`SRLM: ${answer}`, "info");
					return;
				}

				if (trimmed.startsWith("--chained")) {
					const rest = trimmed.replace(/^--chained\s*/, "").trim();
					const nMatch = rest.match(/^(\d+)\s+(.*)$/s);
					const numRoots = nMatch ? Math.max(1, Math.min(10, Number(nMatch[1]))) : DEFAULTS.chainedRoots;
					const question = nMatch ? nMatch[2]!.trim() : rest;
					const answer = await runChained(
						ctx,
						{ model, numRoots, maxIterations: DEFAULTS.maxIterations, timeoutMs: DEFAULTS.timeoutMs, maxStdoutChars: DEFAULTS.maxStdoutChars, maxSubCalls: DEFAULTS.maxSubCalls, maxBlackboardChars: DEFAULTS.chainedBlackboardChars },
						question,
					);
					ctx.ui.setStatus("rlm", undefined);
					ctx.ui.notify(`Chained-RLM: ${answer}`, "info");
					return;
				}

				const rlm = new Rlm({
					model,
					maxDepth: DEFAULTS.maxDepth,
					maxIterations: DEFAULTS.maxIterations,
					timeoutMs: DEFAULTS.timeoutMs,
					maxStdoutChars: DEFAULTS.maxStdoutChars,
					maxSubCalls: DEFAULTS.maxSubCalls,
				});
				const result = await rlm.run(ctx, trimmed);
				ctx.ui.setStatus("rlm", undefined);
				ctx.ui.notify(`RLM: ${result.answer}`, "info");
			} catch (err) {
				ctx.ui.setStatus("rlm", undefined);
				ctx.ui.notify(`RLM error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
