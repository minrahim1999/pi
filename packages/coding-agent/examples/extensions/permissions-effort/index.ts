/**
 * Permissions + Effort extension — access control for tool execution and a
 * compute dial for pi. Ported from Athena Agent.
 *
 * Permission modes:
 *   safe       (default) — read-only tools auto-allowed; sensitive tools ask.
 *   auto       — everything auto-allowed (trusted setups).
 *   restricted — everything asks except explicitly allowed tools.
 *
 * Per-tool rules override the mode: allow | ask | deny.
 *
 * Effort levels (low → xhigh): one dial that scales thinking level and
 * sampling. Fast mode forces low.
 *
 * Commands:
 *   /permissions [mode]        Show or set the permission mode
 *   /permissions rule <tool> <allow|ask|deny>
 *   /permissions unrule <tool>
 *   /effort <low|medium|high|xhigh|off>
 *   /fast on|off
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

type PermissionMode = "safe" | "auto" | "restricted";
type PermissionAction = "allow" | "ask" | "deny";
type EffortLevel = "low" | "medium" | "high" | "xhigh";

interface PermissionConfig {
	mode: PermissionMode;
	rules: Record<string, PermissionAction>;
}

interface EffortConfig {
	level: EffortLevel | null;
	fast: boolean;
}

// ============================================================================
// Persistence
// ============================================================================

const CONFIG_PATH = join(homedir(), ".pi", "agent", "permissions-effort.json");

async function loadConfig(): Promise<{ permissions: PermissionConfig; effort: EffortConfig }> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as { permissions?: PermissionConfig; effort?: EffortConfig };
		return {
			permissions: parsed.permissions ?? { mode: "safe", rules: {} },
			effort: parsed.effort ?? { level: null, fast: false },
		};
	} catch {
		return { permissions: { mode: "safe", rules: {} }, effort: { level: null, fast: false } };
	}
}

async function saveConfig(config: { permissions: PermissionConfig; effort: EffortConfig }): Promise<void> {
	await mkdir(join(CONFIG_PATH, ".."), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ============================================================================
// Sensitive tools (safe mode asks for these)
// ============================================================================

const SENSITIVE_TOOLS = new Set(["bash", "write", "edit"]);

/** Decide whether a tool call may run. */
function decide(config: PermissionConfig, toolName: string): PermissionAction {
	const rule = config.rules[toolName];
	if (rule) return rule;
	switch (config.mode) {
		case "auto":
			return "allow";
		case "restricted":
			return "ask";
		case "safe":
		default:
			return SENSITIVE_TOOLS.has(toolName) ? "ask" : "allow";
	}
}

// ============================================================================
// Effort → thinking level mapping
// ============================================================================

const EFFORT_THINKING: Record<EffortLevel, "off" | "low" | "medium" | "high"> = {
	low: "off",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

// ============================================================================
// Extension entry point
// ============================================================================

export default function permissionsEffortExtension(pi: ExtensionAPI): void {
	let config: { permissions: PermissionConfig; effort: EffortConfig } | null = null;
	let desiredEffort: EffortLevel | null = null;

	const getConfig = async () => {
		if (!config) config = await loadConfig();
		return config;
	};

	// Block tool calls based on permission mode.
	pi.on("tool_call", async (event) => {
		const cfg = await getConfig();
		const decision = decide(cfg.permissions, event.toolName);
		if (decision === "deny") {
			return { block: true, reason: `Tool ${event.toolName} is denied by permission rules.` };
		}
		if (decision === "ask") {
			// In a headless/extension context, fail-closed (no interactive approver).
			return { block: true, reason: `Tool ${event.toolName} requires approval (permission mode: ${cfg.permissions.mode}).` };
		}
		return undefined;
	});

	// Apply effort → thinking level on model select.
	pi.on("model_select", async (_event, ctx) => {
		const cfg = await getConfig();
		const level = cfg.effort.fast ? "low" : cfg.effort.level;
		if (level) {
			// setThinkingLevel is only on ExtensionCommandContext; store the
			// desired level here and apply it in the /effort command handler.
			desiredEffort = level;
		}
	});

	// /permissions command
	pi.registerCommand("permissions", {
		description: "Show or set the permission mode and per-tool rules",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const cfg = await getConfig();
			const trimmed = args.trim();

			if (!trimmed) {
				const rules = Object.entries(cfg.permissions.rules)
					.map(([t, a]) => `${t}: ${a}`)
					.join(", ");
				ctx.ui.notify(`Mode: ${cfg.permissions.mode}${rules ? ` | Rules: ${rules}` : ""}`, "info");
				return;
			}

			if (trimmed.startsWith("rule ")) {
				const parts = trimmed.slice(5).trim().split(/\s+/);
				const tool = parts[0];
				const action = parts[1] as PermissionAction | undefined;
				if (!tool || !action || !["allow", "ask", "deny"].includes(action)) {
					ctx.ui.notify("Usage: /permissions rule <tool> <allow|ask|deny>", "warning");
					return;
				}
				cfg.permissions.rules[tool] = action;
				await saveConfig(cfg);
				ctx.ui.notify(`Rule set: ${tool} → ${action}`, "info");
				return;
			}

			if (trimmed.startsWith("unrule ")) {
				const tool = trimmed.slice(7).trim();
				if (!tool) {
					ctx.ui.notify("Usage: /permissions unrule <tool>", "warning");
					return;
				}
				delete cfg.permissions.rules[tool];
				await saveConfig(cfg);
				ctx.ui.notify(`Rule removed: ${tool}`, "info");
				return;
			}

			if (["safe", "auto", "restricted"].includes(trimmed)) {
				cfg.permissions.mode = trimmed as PermissionMode;
				await saveConfig(cfg);
				ctx.ui.notify(`Permission mode set to ${trimmed}.`, "info");
				return;
			}

			ctx.ui.notify("Usage: /permissions [safe|auto|restricted] | rule <tool> <allow|ask|deny> | unrule <tool>", "warning");
		},
	});

	// /effort command
	pi.registerCommand("effort", {
		description: "Set the compute effort level (low|medium|high|xhigh|off)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const cfg = await getConfig();
			const level = args.trim() as EffortLevel | "off" | "";
			if (level === "off" || level === "") {
				cfg.effort.level = null;
				await saveConfig(cfg);
				ctx.ui.notify("Effort unset (default behavior).", "info");
				return;
			}
			if (["low", "medium", "high", "xhigh"].includes(level)) {
				cfg.effort.level = level as EffortLevel;
				await saveConfig(cfg);
				desiredEffort = level as EffortLevel;
				pi.setThinkingLevel(EFFORT_THINKING[level as EffortLevel]);
				ctx.ui.notify(`Effort set to ${level}.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /effort <low|medium|high|xhigh|off>", "warning");
		},
	});

	// /fast command
	pi.registerCommand("fast", {
		description: "Toggle fast mode (forces low effort)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const cfg = await getConfig();
			const on = args.trim().toLowerCase();
			if (on === "on" || on === "true" || on === "1") {
				cfg.effort.fast = true;
			} else if (on === "off" || on === "false" || on === "0") {
				cfg.effort.fast = false;
			} else {
				cfg.effort.fast = !cfg.effort.fast;
			}
			await saveConfig(cfg);
			ctx.ui.notify(`Fast mode ${cfg.effort.fast ? "ON" : "OFF"}.`, "info");
		},
	});
}
