/**
 * Memory + Skills extension — Hermes-style persistent memory and auto-generated
 * skills for pi. Ported from Athena Agent.
 *
 * Features:
 *   - MEMORY.md persistent facts (loaded into the system prompt each turn)
 *   - memory_read / memory_write / memory_search tools (LLM-callable)
 *   - skill_create tool (auto-generate a reusable SKILL.md from a workflow)
 *   - /memory command to view facts
 *
 * Memory file: ~/.pi/agent/memory/MEMORY.md
 * Generated skills: ~/.pi/agent/skills/generated/<name>/SKILL.md
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Memory store (Hermes-style MEMORY.md)
// ============================================================================

const MEMORY_FILE = "MEMORY.md";

function memoryPath(): string {
	return join(homedir(), ".pi", "agent", "memory", MEMORY_FILE);
}

function skillsGeneratedDir(): string {
	return join(homedir(), ".pi", "agent", "skills", "generated");
}

async function readMemory(): Promise<string> {
	try {
		return await readFile(memoryPath(), "utf8");
	} catch {
		return "";
	}
}

async function readFacts(): Promise<string[]> {
	const doc = await readMemory();
	return doc
		.split("\n")
		.filter((l) => l.startsWith("- "))
		.map((l) => l.slice(2).trim())
		.filter(Boolean);
}

async function appendFact(fact: string, source?: string): Promise<void> {
	const existing = await readMemory();
	const date = new Date().toISOString().slice(0, 10);
	const line = `- ${fact.trim()}${source ? ` (from: ${source})` : ""} [${date}]`;
	const doc = existing
		? `${existing.replace(/\n*$/, "")}\n${line}\n`
		: `# Pi Memory\n\nPersistent facts about the user, preferences, and decisions.\n\n${line}\n`;
	await mkdir(join(memoryPath(), ".."), { recursive: true });
	await writeFile(memoryPath(), doc, "utf8");
}

/** Build the system-prompt injection block. */
async function promptBlock(): Promise<string> {
	const facts = await readFacts();
	if (facts.length === 0) return "";
	return `[memory]\nPersistent facts about the user:\n${facts.map((f) => `- ${f}`).join("\n")}\n[/memory]`;
}

// ============================================================================
// Memory search (zero-dependency term scoring)
// ============================================================================

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2);
}

function scoreText(queryTokens: string[], text: string): number {
	const tokens = tokenize(text);
	if (tokens.length === 0) return 0;
	let hits = 0;
	for (const q of queryTokens) {
		if (tokens.includes(q)) hits++;
	}
	return hits / queryTokens.length;
}

async function searchMemory(query: string, maxResults = 5): Promise<Array<{ text: string; score: number }>> {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];
	const facts = await readFacts();
	const hits: Array<{ text: string; score: number }> = [];
	for (const fact of facts) {
		const score = scoreText(queryTokens, fact);
		if (score > 0) hits.push({ text: fact, score });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, maxResults);
}

// ============================================================================
// Tools
// ============================================================================

const memoryReadTool = defineTool({
	name: "memory_read",
	label: "Memory Read",
	description: "Read persistent facts about the user from MEMORY.md.",
	parameters: Type.Object({}),
	async execute() {
		const facts = await readFacts();
		return {
			content: [{ type: "text", text: facts.length ? facts.join("\n") : "(no facts stored)" }],
			details: { count: facts.length },
		};
	},
});

const memoryWriteTool = defineTool({
	name: "memory_write",
	label: "Memory Write",
	description: "Append a persistent fact about the user to MEMORY.md (e.g. preferences, decisions, important context).",
	parameters: Type.Object({
		fact: Type.String({ description: "The fact to remember" }),
	}),
	async execute(_id, params) {
		const fact = params.fact.trim();
		if (!fact) throw new Error("fact is required");
		if (fact.length > 1000) throw new Error("fact too long (max 1000 chars)");
		await appendFact(fact);
		return {
			content: [{ type: "text", text: `Remembered: ${fact}` }],
			details: { ok: true, fact },
		};
	},
});

const memorySearchTool = defineTool({
	name: "memory_search",
	label: "Memory Search",
	description: "Search persistent memory for a topic. Returns matching facts.",
	parameters: Type.Object({
		query: Type.String({ description: "Topic to search for" }),
	}),
	async execute(_id, params) {
		const query = params.query.trim();
		if (!query) throw new Error("query is required");
		const hits = await searchMemory(query);
		return {
			content: [
				{
					type: "text",
					text: hits.length ? hits.map((h) => `- ${h.text}`).join("\n") : "(no matching facts)",
				},
			],
			details: { query, count: hits.length },
		};
	},
});

const skillCreateTool = defineTool({
	name: "skill_create",
	label: "Skill Create",
	description: "Create a reusable skill (SKILL.md) from a workflow the user wants to repeat. The skill becomes available in future sessions.",
	parameters: Type.Object({
		name: Type.String({ description: "Skill name (lowercase, hyphens)" }),
		description: Type.String({ description: "One-line description" }),
		steps: Type.String({ description: "Step-by-step procedure the agent should follow" }),
	}),
	async execute(_id, params) {
		const name = params.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
		const description = params.description.trim();
		const steps = params.steps.trim();
		if (!/^[a-z0-9-]{2,40}$/.test(name)) throw new Error("name must be 2-40 chars of lowercase letters, digits, hyphens");
		if (!description) throw new Error("description is required");
		if (!steps) throw new Error("steps are required");

		const doc = `---
name: ${name}
description: ${description}
version: 1.0.0
tags: [generated]
---

# ${name}

${description}

## When to Use
Use this skill when the user asks for: ${description}

## Procedure
${steps
	.split("\n")
	.map((s) => s.trim())
	.filter(Boolean)
	.map((s, i) => `${i + 1}. ${s}`)
	.join("\n")}

## Verification
Confirm the workflow completed successfully before reporting done.
`;
		const dir = join(skillsGeneratedDir(), name);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), doc, "utf8");
		return {
			content: [{ type: "text", text: `Created skill ${name} at ${join(dir, "SKILL.md")}` }],
			details: { ok: true, name, path: join(dir, "SKILL.md") },
		};
	},
});

// ============================================================================
// Extension entry point
// ============================================================================

export default function memorySkillsExtension(pi: ExtensionAPI): void {
	// Register tools
	pi.registerTool(memoryReadTool);
	pi.registerTool(memoryWriteTool);
	pi.registerTool(memorySearchTool);
	pi.registerTool(skillCreateTool);

	// Inject memory into the system prompt each turn
	pi.on("before_agent_start", async (_event) => {
		const block = await promptBlock();
		if (!block) return undefined;
		return { systemPrompt: block };
	});

	// /memory command to view facts
	pi.registerCommand("memory", {
		description: "Show persistent memory facts",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const facts = await readFacts();
			if (facts.length === 0) {
				ctx.ui.notify("No memory facts stored.", "info");
				return;
			}
			ctx.ui.notify(facts.join("\n"), "info");
		},
	});
}
