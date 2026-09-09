// Воркер вотча «эшлибез 📬» (-5195487732) — чистый код, без вызова модели.
// Схема smm-main-watch.worker.ts: читает чат через юзербот-прокси, ловит теги
// @ivatimtsbot / @tim_ts, шлёт сводку Тимуру в личку, чат помечает прочитанным.
// Состояние: data/ashlibez-watch.json.
import { readEnvFresh } from "./lib/env-file.ts";
import { notificationChat } from "./lib/notification-chat.ts";
import { callTool, readProxyToken } from "./lib/userbot-proxy.ts";
import {
  dataRoot,
  formatWhen,
  freshMessages,
  parseMessages,
  readWatchState,
  saveWatchState,
  snippet,
  type ProxyMessage,
} from "./lib/watch-state.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "ashlibez-watch";

const CHAT_ID = "-5195487732"; // «эшлибез 📬»
const TAGS = ["@ivatimtsbot", "@tim_ts"];
const DEFAULT_LOOKBACK_MINUTES = 7; // тик 5 минут — окно с запасом
const FETCH_LIMIT = 50;
const MAX_SHOWN = 10;

function lookbackMinutes(): number {
  const val = Number(process.env.ASHLIBEZ_LOOKBACK_MINUTES?.trim() ?? "");
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_LOOKBACK_MINUTES;
}

function fail(message: string, error?: unknown): never {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.error(`${NAME}: ${message}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

function isTagged(m: ProxyMessage): boolean {
  const text = (m.text ?? "").toLowerCase();
  return TAGS.some((t) => text.includes(t));
}

async function main(): Promise<void> {
  const env = await readEnvFresh(join(ROOT, ".env"));
  const bot = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(env);
  if (!bot) fail("TELEGRAM_BOT_TOKEN missing — run: iva config");
  if (!chat) fail("no target chat: set TELEGRAM_DIGEST_CHAT_ID in .env");
  const proxyToken = readProxyToken(dataRoot(), NAME);

  const payload = await callTool(NAME, proxyToken, "list_messages", {
    chat_id: CHAT_ID,
    limit: FETCH_LIMIT,
  });
  const messages = parseMessages(payload);

  const state = readWatchState(NAME);
  const fresh = freshMessages(messages, state, lookbackMinutes());

  await callTool(NAME, proxyToken, "mark_as_read", { chat_id: CHAT_ID });

  if (state.lastTs === undefined) {
    saveWatchState(NAME, state, messages);
    console.log(`${NAME}: first run — baseline saved, nothing sent`);
    return;
  }

  const tags = fresh.filter(isTagged);
  if (tags.length === 0) {
    saveWatchState(NAME, state, messages);
    console.log(`${NAME}: ${fresh.length} new, no tags — silent`);
    return;
  }

  const lines = tags
    .slice(-MAX_SHOWN)
    .map(
      (m) => `• ${formatWhen(m.date)} — ${m.sender}: ${snippet(m.text, 200)}`,
    )
    .join("\n");
  const report =
    `🏷 «эшлибез 📬» — тег (${tags.length}):\n${lines}` +
    (tags.length > MAX_SHOWN ? `\n…и ещё ${tags.length - MAX_SHOWN}.` : "") +
    `\n—— Чат прочитан.`;

  const result = await sendTelegramHtml(bot, chat, report, {
    retryTransient: true,
    trace: { source: NAME },
  });
  if (!result.ok) fail(`telegram send failed: ${result.error}`);

  saveWatchState(NAME, { ...state, lastSentAt: new Date().toISOString() }, messages);
  console.log(`${NAME}: sent ${tags.length} tag(s)`);
}

await main();
