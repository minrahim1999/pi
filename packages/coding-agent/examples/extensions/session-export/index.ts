/**
 * Session Export/Import extension — export and import Aegis sessions.
 * Ported from Athena Agent (with optional AES-256-GCM encryption).
 *
 * Aegis stores sessions as append-only JSONL files in ~/.aegis/agent/sessions/.
 * This extension reads the current session's JSONL and exports it (optionally
 * encrypted with a passphrase), and imports by writing a JSONL file into the
 * sessions directory.
 *
 * Commands:
 *   /session export [--encrypt] [<path>]   Export the current session
 *   /session import <path> [--decrypt]     Import a session file
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// AES-256-GCM encryption (node:crypto, zero deps)
// ============================================================================

interface EncryptedPayload {
	v: 1;
	salt: string;
	iv: string;
	tag: string;
	data: string;
}

function deriveKey(passphrase: string, salt: string): Buffer {
	let key = createHash("sha256").update(`${salt}:${passphrase}`).digest();
	for (let i = 0; i < 1000; i++) {
		key = createHash("sha256").update(key).digest();
	}
	return key;
}

function encryptString(plaintext: string, passphrase: string): EncryptedPayload {
	const salt = randomBytes(16).toString("hex");
	const key = deriveKey(passphrase, salt);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return {
		v: 1,
		salt,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: encrypted.toString("base64"),
	};
}

function decryptString(payload: EncryptedPayload, passphrase: string): string {
	const key = deriveKey(passphrase, payload.salt);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
	decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
	const decrypted = Buffer.concat([decipher.update(payload.data, "base64"), decipher.final()]);
	return decrypted.toString("utf8");
}

// ============================================================================
// Session helpers
// ============================================================================

function sessionsDir(): string {
	return join(homedir(), ".aegis", "agent", "sessions");
}

/** Read the current session's JSONL file (all entries). */
async function readCurrentSession(ctx: ExtensionCommandContext): Promise<string[]> {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) throw new Error("No active session file.");
	const raw = await readFile(file, "utf8");
	return raw.split("\n").filter((l) => l.trim().length > 0);
}

/** List session files in the sessions dir. */
async function listSessionFiles(): Promise<string[]> {
	try {
		const files = await readdir(sessionsDir());
		return files.filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function sessionExportExtension(pi: ExtensionAPI): void {
	pi.registerCommand("session", {
		description: "Export/import the current session (optionally encrypted)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			if (trimmed.startsWith("export")) {
				const rest = trimmed.slice(6).trim();
				const encrypt = rest.includes("--encrypt");
				const pathArg = rest.replace(/--encrypt\s*/, "").trim();
				const outPath = pathArg ? resolve(pathArg) : join(homedir(), "session-export.jsonl");

				try {
					const entries = await readCurrentSession(ctx);
					let content = entries.join("\n");
					if (encrypt) {
						const passphrase = process.env.PI_SESSION_PASSPHRASE;
						if (!passphrase) {
							ctx.ui.notify("Set PI_SESSION_PASSPHRASE to encrypt.", "warning");
							return;
						}
						content = JSON.stringify(encryptString(content, passphrase));
					}
					await mkdir(join(outPath, ".."), { recursive: true });
					await writeFile(outPath, content, "utf8");
					ctx.ui.notify(`Session exported to ${outPath}${encrypt ? " (encrypted)" : ""}.`, "info");
				} catch (err) {
					ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (trimmed.startsWith("import")) {
				const rest = trimmed.slice(6).trim();
				const decrypt = rest.includes("--decrypt");
				const pathArg = rest.replace(/--decrypt\s*/, "").trim();
				if (!pathArg) {
					ctx.ui.notify("Usage: /session import <path> [--decrypt]", "warning");
					return;
				}
				const inPath = resolve(pathArg);

				try {
					let content = await readFile(inPath, "utf8");
					if (decrypt) {
						const passphrase = process.env.PI_SESSION_PASSPHRASE;
						if (!passphrase) {
							ctx.ui.notify("Set PI_SESSION_PASSPHRASE to decrypt.", "warning");
							return;
						}
						const payload = JSON.parse(content) as EncryptedPayload;
						content = decryptString(payload, passphrase);
					}
					// Write into the sessions dir as a new JSONL file.
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					const dest = join(sessionsDir(), `${stamp}_imported.jsonl`);
					await mkdir(sessionsDir(), { recursive: true });
					await writeFile(dest, content, "utf8");
					ctx.ui.notify(`Session imported to ${dest}.`, "info");
				} catch (err) {
					ctx.ui.notify(`Import failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			// No subcommand: list session files.
			const files = await listSessionFiles();
			ctx.ui.notify(files.length ? `Sessions:\n${files.join("\n")}` : "No session files found.", "info");
		},
	});
}
