/**
 * Messaging Gateway extension — connect Aegis to messaging platforms as a headless
 * bot. Ported from Athena Agent (OpenClaw-style control plane, minimal).
 *
 * Supported channels:
 *   - Telegram  (long-polling, no server)
 *   - Discord   (gateway websocket + REST)
 *   - Slack     (Socket Mode, no public endpoint)
 *   - WhatsApp  (Meta Cloud API webhook)
 *   - Matrix    (client-server sync loop)
 *
 * The gateway creates a headless AgentSession per chat, routes messages to it,
 * and replies back. Loop protection ignores the bot's own messages.
 *
 * Commands:
 *   /gateway start <channel> [<token>]   Start a channel
 *   /gateway stop [<channel>]            Stop a channel (or all)
 *   /gateway status                      Show running channels
 *
 * Config via env vars (or the /gateway start argument):
 *   PI_TELEGRAM_TOKEN, PI_DISCORD_TOKEN, PI_SLACK_APP_TOKEN + PI_SLACK_BOT_TOKEN,
 *   PI_WHATSAPP_PHONE_ID + PI_WHATSAPP_TOKEN + PI_WHATSAPP_VERIFY,
 *   PI_MATRIX_HOMESERVER + PI_MATRIX_TOKEN + PI_MATRIX_USER
 */
import { createServer, type Server } from "node:http";
import { createAgentSession, type AgentSession, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Channel adapter interface
// ============================================================================

interface Envelope {
	channel: string;
	chatId: string;
	senderId: string;
	text: string;
}

interface ChannelAdapter {
	readonly name: string;
	connect(onMessage: (env: Envelope) => void): Promise<void>;
	send(target: string, text: string): Promise<void>;
	disconnect(): Promise<void>;
}

// ============================================================================
// Telegram (long-polling, no server)
// ============================================================================

interface TelegramUpdate {
	update_id: number;
	message?: {
		chat: { id: number; type: string };
		text?: string;
		from?: { id: number };
	};
}

class TelegramAdapter implements ChannelAdapter {
	readonly name = "telegram";
	private readonly token: string;
	private offset = 0;
	private running = false;
	private onMessage: ((env: Envelope) => void) | null = null;
	private readonly baseUrl: string;

	constructor(token: string) {
		this.token = token;
		this.baseUrl = `https://api.telegram.org/bot${token}`;
	}

	async connect(onMessage: (env: Envelope) => void): Promise<void> {
		this.onMessage = onMessage;
		this.running = true;
		void this.pollLoop();
	}

	async send(target: string, text: string): Promise<void> {
		await fetch(`${this.baseUrl}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: Number(target), text }),
		});
	}

	async disconnect(): Promise<void> {
		this.running = false;
	}

	private async pollLoop(): Promise<void> {
		while (this.running) {
			try {
				const url = `${this.baseUrl}/getUpdates?timeout=25&offset=${this.offset}`;
				const res = await fetch(url);
				const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
				if (!data.ok) throw new Error(`Telegram getUpdates failed: ${JSON.stringify(data)}`);
				const updates = data.result ?? [];
				if (updates.length > 0) {
					this.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
				}
				for (const update of updates) {
					const msg = update.message;
					if (!msg?.text) continue;
					// Loop protection: ignore the bot's own messages.
					if (msg.from && msg.chat.id === msg.from.id) continue;
					this.onMessage?.({
						channel: "telegram",
						chatId: String(msg.chat.id),
						senderId: String(msg.from?.id ?? "unknown"),
						text: msg.text,
					});
				}
			} catch {
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}
}

// ============================================================================
// Discord (gateway websocket + REST)
// ============================================================================

interface DiscordGatewayEvent {
	op: number;
	d?: unknown;
	s?: number | null;
	t?: string;
}

class DiscordAdapter implements ChannelAdapter {
	readonly name = "discord";
	private readonly token: string;
	private ws: WebSocket | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private sequence: number | null = null;
	private onMessage: ((env: Envelope) => void) | null = null;
	private running = false;
	private readonly apiBaseUrl = "https://discord.com/api/v10";

	constructor(token: string) {
		this.token = token;
	}

	async connect(onMessage: (env: Envelope) => void): Promise<void> {
		this.onMessage = onMessage;
		this.running = true;
		await this.openSocket();
	}

	async send(target: string, text: string): Promise<void> {
		const res = await fetch(`${this.apiBaseUrl}/channels/${target}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bot ${this.token}` },
			body: JSON.stringify({ content: text }),
		});
		if (!res.ok) throw new Error(`Discord send failed: HTTP ${res.status}`);
	}

	async disconnect(): Promise<void> {
		this.running = false;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.ws?.close();
	}

	private openSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
			this.ws = ws;
			const timeout = setTimeout(() => reject(new Error("Discord gateway connect timeout")), 15000);

			ws.onopen = () => {
				ws.send(
					JSON.stringify({
						op: 2,
						d: { token: this.token, intents: 1 << 0, properties: { os: "darwin", browser: "pi", device: "pi" } },
					}),
				);
			};

			ws.onmessage = (event) => {
				const data = JSON.parse(String(event.data)) as DiscordGatewayEvent;
				if (data.s !== null && data.s !== undefined) this.sequence = data.s;
				switch (data.op) {
					case 10: {
						const interval = (data.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41250;
						this.heartbeatTimer = setInterval(() => {
							if (this.ws?.readyState === WebSocket.OPEN) {
								this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
							}
						}, interval);
						clearTimeout(timeout);
						resolve();
						break;
					}
					case 0: {
						const d = data.d as { t?: string; d?: unknown };
						if (d.t === "MESSAGE_CREATE") {
							const m = d.d as { channel_id: string; content?: string; author?: { id?: string; bot?: boolean } };
							if (m.author?.bot) break; // loop protection
							if (m.content) {
								this.onMessage?.({
									channel: "discord",
									chatId: m.channel_id,
									senderId: m.author?.id ?? "unknown",
									text: m.content,
								});
							}
						}
						break;
					}
				}
			};

			ws.onerror = (err) => {
				clearTimeout(timeout);
				reject(err instanceof Error ? err : new Error("Discord websocket error"));
			};

			ws.onclose = () => {
				if (this.running) setTimeout(() => void this.openSocket().catch(() => {}), 5000);
			};
		});
	}
}

// ============================================================================
// Slack (Socket Mode)
// ============================================================================

class SlackAdapter implements ChannelAdapter {
	readonly name = "slack";
	private readonly appToken: string;
	private readonly botToken: string;
	private ws: WebSocket | null = null;
	private onMessage: ((env: Envelope) => void) | null = null;
	private running = false;
	private readonly apiBaseUrl = "https://slack.com/api";

	constructor(appToken: string, botToken: string) {
		this.appToken = appToken;
		this.botToken = botToken;
	}

	async connect(onMessage: (env: Envelope) => void): Promise<void> {
		this.onMessage = onMessage;
		this.running = true;
		await this.openSocket();
	}

	async send(target: string, text: string): Promise<void> {
		const res = await fetch(`${this.apiBaseUrl}/chat.postMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.botToken}` },
			body: JSON.stringify({ channel: target, text }),
		});
		const data = (await res.json()) as { ok?: boolean; error?: string };
		if (!data.ok) throw new Error(`Slack send failed: ${data.error ?? `HTTP ${res.status}`}`);
	}

	async disconnect(): Promise<void> {
		this.running = false;
		this.ws?.close();
	}

	private async openSocket(): Promise<void> {
		const res = await fetch(`${this.apiBaseUrl}/apps.connections.open`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.appToken}` },
		});
		const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
		if (!data.ok || !data.url) throw new Error(`Slack apps.connections.open failed: ${data.error ?? "no url"}`);

		const ws = new WebSocket(data.url);
		this.ws = ws;
		ws.onmessage = (event) => {
			const payload = JSON.parse(String(event.data)) as { type?: string; payload?: { event?: { type?: string; subtype?: string; text?: string; channel?: string; user?: string } } };
			if (payload.type !== "events_api") return;
			const ev = payload.payload?.event;
			if (!ev) return;
			if (ev.type === "message" && ev.subtype === "bot_message") return; // loop protection
			if (ev.type === "message" && ev.text) {
				this.onMessage?.({
					channel: "slack",
					chatId: ev.channel ?? "unknown",
					senderId: ev.user ?? "unknown",
					text: ev.text,
				});
			}
		};
		ws.onclose = () => {
			if (this.running) setTimeout(() => void this.openSocket().catch(() => {}), 5000);
		};
	}
}

// ============================================================================
// WhatsApp (Meta Cloud API webhook)
// ============================================================================

class WhatsAppAdapter implements ChannelAdapter {
	readonly name = "whatsapp";
	private readonly phoneNumberId: string;
	private readonly accessToken: string;
	private readonly verifyToken: string;
	private server: Server | null = null;
	private onMessage: ((env: Envelope) => void) | null = null;
	private readonly apiBaseUrl = "https://graph.facebook.com/v19.0";

	constructor(phoneNumberId: string, accessToken: string, verifyToken: string) {
		this.phoneNumberId = phoneNumberId;
		this.accessToken = accessToken;
		this.verifyToken = verifyToken;
	}

	async connect(onMessage: (env: Envelope) => void): Promise<void> {
		this.onMessage = onMessage;
		const port = Number(process.env.PI_WHATSAPP_PORT ?? 8080);
		this.server = createServer((req, res) => {
			if (req.method === "GET" && req.url?.startsWith("/webhook")) {
				const url = new URL(req.url, "http://localhost");
				if (url.searchParams.get("hub.verify_token") === this.verifyToken) {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end(url.searchParams.get("hub.challenge") ?? "");
				} else {
					res.writeHead(403);
					res.end("verify token mismatch");
				}
				return;
			}
			if (req.method === "POST" && req.url?.startsWith("/webhook")) {
				let body = "";
				req.on("data", (c: Buffer) => (body += c.toString()));
				req.on("end", () => {
					res.writeHead(200);
					res.end("OK");
					this.handleWebhook(body);
				});
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => this.server!.listen(port, resolve));
	}

	async send(target: string, text: string): Promise<void> {
		const res = await fetch(`${this.apiBaseUrl}/${this.phoneNumberId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
			body: JSON.stringify({ messaging_product: "whatsapp", to: target, type: "text", text: { body: text } }),
		});
		if (!res.ok) throw new Error(`WhatsApp send failed: HTTP ${res.status}`);
	}

	async disconnect(): Promise<void> {
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		this.server = null;
	}

	private handleWebhook(body: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return;
		}
		const entry = (parsed as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from: string; type?: string; text?: { body?: string } }> } }> }> })?.entry?.[0];
		const messages = entry?.changes?.[0]?.value?.messages;
		if (!messages) return;
		for (const msg of messages) {
			if (msg.type !== "text" || !msg.text?.body) continue;
			this.onMessage?.({
				channel: "whatsapp",
				chatId: msg.from,
				senderId: msg.from,
				text: msg.text.body,
			});
		}
	}
}

// ============================================================================
// Matrix (client-server sync loop)
// ============================================================================

class MatrixAdapter implements ChannelAdapter {
	readonly name = "matrix";
	private readonly homeserver: string;
	private readonly accessToken: string;
	private readonly userId: string;
	private nextBatch = "";
	private running = false;
	private onMessage: ((env: Envelope) => void) | null = null;

	constructor(homeserver: string, accessToken: string, userId: string) {
		this.homeserver = homeserver.replace(/\/+$/, "");
		this.accessToken = accessToken;
		this.userId = userId;
	}

	async connect(onMessage: (env: Envelope) => void): Promise<void> {
		this.onMessage = onMessage;
		this.running = true;
		void this.syncLoop();
	}

	async send(target: string, text: string): Promise<void> {
		const txnId = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const res = await fetch(
			`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(target)}/send/m.room.message/${txnId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
				body: JSON.stringify({ msgtype: "m.text", body: text }),
			},
		);
		if (!res.ok) throw new Error(`Matrix send failed: HTTP ${res.status}`);
	}

	async disconnect(): Promise<void> {
		this.running = false;
	}

	private async syncLoop(): Promise<void> {
		while (this.running) {
			try {
				const url = `${this.homeserver}/_matrix/client/v3/sync?timeout=20000${this.nextBatch ? `&since=${encodeURIComponent(this.nextBatch)}` : ""}`;
				const res = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
				if (!res.ok) throw new Error(`Matrix sync failed: HTTP ${res.status}`);
				const data = (await res.json()) as {
					next_batch?: string;
					rooms?: { timeline?: Record<string, { events?: Array<{ type?: string; sender?: string; content?: { msgtype?: string; body?: string } }> }> };
				};
				this.nextBatch = data.next_batch ?? this.nextBatch;
				for (const [roomId, room] of Object.entries(data.rooms?.timeline ?? {})) {
					for (const event of room.events ?? []) {
						if (event.type !== "m.room.message") continue;
						if (event.sender === this.userId) continue; // loop protection
						const content = event.content;
						if (content?.msgtype !== "m.text" || !content.body) continue;
						this.onMessage?.({
							channel: "matrix",
							chatId: roomId,
							senderId: event.sender ?? "unknown",
							text: content.body,
						});
					}
				}
			} catch {
				// transient — keep polling
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

// ============================================================================
// Gateway
// ============================================================================

interface ChatSession {
	session: AgentSession;
}

class Gateway {
	private readonly adapters = new Map<string, ChannelAdapter>();
	private readonly sessions = new Map<string, ChatSession>();
	private readonly onLog: (msg: string) => void;

	constructor(onLog: (msg: string) => void) {
		this.onLog = onLog;
	}

	async startChannel(adapter: ChannelAdapter): Promise<void> {
		if (this.adapters.has(adapter.name)) {
			this.onLog(`Channel ${adapter.name} already running.`);
			return;
		}
		await adapter.connect((env) => void this.handleMessage(env));
		this.adapters.set(adapter.name, adapter);
		this.onLog(`Channel ${adapter.name} started.`);
	}

	async stopChannel(name: string): Promise<void> {
		const adapter = this.adapters.get(name);
		if (adapter) {
			await adapter.disconnect();
			this.adapters.delete(name);
			this.onLog(`Channel ${name} stopped.`);
		}
	}

	async stopAll(): Promise<void> {
		for (const [name, adapter] of this.adapters) {
			await adapter.disconnect();
			this.onLog(`Channel ${name} stopped.`);
		}
		this.adapters.clear();
	}

	status(): string[] {
		return [...this.adapters.keys()];
	}

	private async handleMessage(env: Envelope): Promise<void> {
		try {
			const key = `${env.channel}:${env.chatId}`;
			let chat = this.sessions.get(key);
			if (!chat) {
				const { session } = await createAgentSession({});
				chat = { session };
				this.sessions.set(key, chat);
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

			await chat.session.prompt(env.text);
			unsubscribe();

			if (reply) {
				const adapter = this.adapters.get(env.channel);
				if (adapter) await adapter.send(env.chatId, reply);
			}
		} catch (err) {
			const adapter = this.adapters.get(env.channel);
			if (adapter) {
				await adapter.send(env.chatId, `Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
			}
		}
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function gatewayExtension(pi: ExtensionAPI): void {
	let gateway: Gateway | null = null;

	pi.registerCommand("gateway", {
		description: "Start/stop the messaging gateway (telegram|discord|slack|whatsapp|matrix)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/);
			const action = parts[0] ?? "";
			const channel = parts[1] ?? "";

			if (action === "stop") {
				if (!gateway) {
					ctx.ui.notify("Gateway is not running.", "info");
					return;
				}
				if (channel) {
					await gateway.stopChannel(channel);
				} else {
					await gateway.stopAll();
					gateway = null;
				}
				return;
			}

			if (action === "status") {
				if (!gateway) {
					ctx.ui.notify("Gateway is not running.", "info");
					return;
				}
				const running = gateway.status();
				ctx.ui.notify(running.length ? `Running: ${running.join(", ")}` : "No channels running.", "info");
				return;
			}

			if (action !== "start" || !channel) {
				ctx.ui.notify("Usage: /gateway start <telegram|discord|slack|whatsapp|matrix> | stop [channel] | status", "warning");
				return;
			}

			if (!gateway) gateway = new Gateway((msg) => ctx.ui.notify(msg, "info"));

			try {
				switch (channel) {
					case "telegram": {
						const token = parts[2] || process.env.PI_TELEGRAM_TOKEN;
						if (!token) throw new Error("Telegram token required (PI_TELEGRAM_TOKEN)");
						await gateway.startChannel(new TelegramAdapter(token));
						break;
					}
					case "discord": {
						const token = parts[2] || process.env.PI_DISCORD_TOKEN;
						if (!token) throw new Error("Discord token required (PI_DISCORD_TOKEN)");
						await gateway.startChannel(new DiscordAdapter(token));
						break;
					}
					case "slack": {
						const appToken = parts[2] || process.env.PI_SLACK_APP_TOKEN;
						const botToken = parts[3] || process.env.PI_SLACK_BOT_TOKEN;
						if (!appToken || !botToken) throw new Error("Slack app + bot tokens required (PI_SLACK_APP_TOKEN, PI_SLACK_BOT_TOKEN)");
						await gateway.startChannel(new SlackAdapter(appToken, botToken));
						break;
					}
					case "whatsapp": {
						const phoneId = parts[2] || process.env.PI_WHATSAPP_PHONE_ID;
						const token = parts[3] || process.env.PI_WHATSAPP_TOKEN;
						const verify = parts[4] || process.env.PI_WHATSAPP_VERIFY;
						if (!phoneId || !token || !verify) throw new Error("WhatsApp phone id + token + verify required");
						await gateway.startChannel(new WhatsAppAdapter(phoneId, token, verify));
						break;
					}
					case "matrix": {
						const homeserver = parts[2] || process.env.PI_MATRIX_HOMESERVER;
						const token = parts[3] || process.env.PI_MATRIX_TOKEN;
						const user = parts[4] || process.env.PI_MATRIX_USER;
						if (!homeserver || !token || !user) throw new Error("Matrix homeserver + token + user required");
						await gateway.startChannel(new MatrixAdapter(homeserver, token, user));
						break;
					}
					default:
						throw new Error(`Unknown channel: ${channel}`);
				}
			} catch (err) {
				ctx.ui.notify(`Gateway error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
