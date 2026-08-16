/**
 * Messaging Gateway extension — connect pi to messaging platforms as a headless
 * bot. Ported from Athena Agent (OpenClaw-style control plane, minimal).
 *
 * Currently supports Telegram (long-polling, no server). The gateway creates a
 * headless AgentSession per chat, routes messages to it, and replies back.
 *
 * Commands:
 *   /gateway start <token>   Start the Telegram gateway with a bot token
 *   /gateway stop            Stop the gateway
 *
 * Config: token via env PI_TELEGRAM_TOKEN or the /gateway start argument.
 */
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, type AgentSession, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Telegram Bot API (long-polling, no server)
// ============================================================================

interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		chat: { id: number; type: string };
		text?: string;
		from?: { id: number; first_name?: string };
	};
}

class TelegramClient {
	private readonly token: string;
	private offset = 0;
	private readonly baseUrl: string;

	constructor(token: string) {
		this.token = token;
		this.baseUrl = `https://api.telegram.org/bot${token}`;
	}

	async getUpdates(timeout = 25): Promise<TelegramUpdate[]> {
		const url = `${this.baseUrl}/getUpdates?timeout=${timeout}&offset=${this.offset}`;
		const res = await fetch(url);
		const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
		if (!data.ok) throw new Error(`Telegram getUpdates failed: ${JSON.stringify(data)}`);
		const updates = data.result ?? [];
		if (updates.length > 0) {
			this.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
		}
		return updates;
	}

	async sendMessage(chatId: number, text: string): Promise<void> {
		const url = `${this.baseUrl}/sendMessage`;
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
		});
	}
}

// ============================================================================
// Gateway
// ============================================================================

interface ChatSession {
	session: AgentSession;
	history: string[];
}

class Gateway {
	private readonly client: TelegramClient;
	private readonly sessions = new Map<number, ChatSession>();
	private polling = false;
	private stopRequested = false;
	private readonly onLog: (msg: string) => void;

	constructor(token: string, onLog: (msg: string) => void) {
		this.client = new TelegramClient(token);
		this.onLog = onLog;
	}

	async start(): Promise<void> {
		this.polling = true;
		this.stopRequested = false;
		this.onLog("Gateway started. Polling Telegram…");
		// Run the poll loop in the background.
		void this.pollLoop();
	}

	stop(): void {
		this.stopRequested = true;
		this.polling = false;
		this.onLog("Gateway stopped.");
	}

	private async pollLoop(): Promise<void> {
		while (!this.stopRequested) {
			try {
				const updates = await this.client.getUpdates();
				for (const update of updates) {
					const msg = update.message;
					if (!msg?.text) continue;
					// Ignore bot's own messages (loop protection).
					if (msg.from && msg.chat.id === msg.from.id) continue;
					void this.handleMessage(msg.chat.id, msg.text);
				}
			} catch (err) {
				this.onLog(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}

	private async handleMessage(chatId: number, text: string): Promise<void> {
		try {
			let chat = this.sessions.get(chatId);
			if (!chat) {
				const { session } = await createAgentSession({});
				chat = { session, history: [] };
				this.sessions.set(chatId, chat);
			}

			// Capture the assistant's reply via message_end events.
			let reply = "";
			const unsubscribe = chat.session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const content = event.message.content;
					const text = content
						.filter((b) => b.type === "text")
						.map((b) => (b as { text: string }).text)
						.join("\n");
					if (text) reply = text;
				}
			});

			await chat.session.prompt(text);
			unsubscribe();

			if (reply) {
				await this.client.sendMessage(chatId, reply);
			}
		} catch (err) {
			await this.client.sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function gatewayExtension(pi: ExtensionAPI): void {
	let gateway: Gateway | null = null;

	pi.registerCommand("gateway", {
		description: "Start/stop the messaging gateway (Telegram)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed.startsWith("stop")) {
				if (gateway) {
					gateway.stop();
					gateway = null;
				} else {
					ctx.ui.notify("Gateway is not running.", "info");
				}
				return;
			}

			// start <token> or use PI_TELEGRAM_TOKEN env
			const token = trimmed.replace(/^start\s*/, "").trim() || process.env.PI_TELEGRAM_TOKEN;
			if (!token) {
				ctx.ui.notify("Usage: /gateway start <bot-token> (or set PI_TELEGRAM_TOKEN)", "warning");
				return;
			}

			if (gateway) {
				ctx.ui.notify("Gateway already running. Use /gateway stop first.", "warning");
				return;
			}

			gateway = new Gateway(token, (msg) => ctx.ui.notify(msg, "info"));
			await gateway.start();
		},
	});
}
