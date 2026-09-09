// Воркер вотча «Волжская Тропа Chat» (супергруппа -1001782696497) — чистый код,
// БЕЗ вызова модели. Схема та же, что у smm-main-watch и npt-ideas-watch:
// спавнер agent/schedules/smm-tropa-watch.ts вызывает ЭТОТ скрипт через
// runScheduledJob, доставку делает sendTelegramHtml → outbound-Gate.
//
// Правила (согласованы 27.08.2026):
//   — тик ежечасно, 09:00–22:00 МСК (cron в спавнере);
//   — подсветка, если Тимура тегают: @tim_ts или «Тимур» (без падежей не
//     различаем — ловим подстроку без учёта регистра);
//   — чат помечается прочитанным при каждом тике;
//   — без упоминаний — молчание; первый прогон — тихая точка отсчёта.
//
// Состояние: data/smm-tropa-watch.json.
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
const NAME = "smm-tropa-watch";

const CHAT_ID = "-1001782696497"; // «Волжская Тропа Chat»
const TAG = "@tim_ts";
const NAME_MENTION = "тимур"; // по смыслу тоже подсвечиваем (в отличие от SMM-чата)
// Окно чтения: час (тик ежечасный); TROPA_LOOKBACK_MINUTES — для ручных прогонов.
const DEFAULT_LOOKBACK_MINUTES = 75;
const FETCH_LIMIT = 50;
const MAX_SHOWN = 10;

function lookbackMinutes(): number {
  const raw = Number(process.env.TROPA_LOOKBACK_MINUTES?.trim() ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOOKBACK_MINUTES;
}

function fail(message: string, error?: unknown): never {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : typeof error === "string" ? error : JSON.stringify(error);
  console.error(`${NAME}: ${message}${detail ? `: ${detail}` : ""}`);
  process.exit(1);
}

function isMention(m: ProxyMessage): boolean {
  if (typeof m.text !== "string") return false;
  const lower = m.text.toLowerCase();
  return lower.includes("@tim_ts") || lower.includes(TAG.toLowerCase()) || lower.includes(NAME_MENTION);
}

async function main(): Promise<void> {
  const env = await readEnvFresh(join(ROOT, ".env"));
  Object.assign(process.env, env);
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

  // Читанным чат помечаем всегда: сообщения не копятся непрочитанными.
  await callTool(NAME, proxyToken, "mark_as_read", { chat_id: CHAT_ID });

  if (state.lastTs === undefined) {
    saveWatchState(NAME, state, messages);
    console.log(`${NAME}: first run — baseline saved, nothing sent`);
    return;
  }

  const mentions = fresh.filter(isMention);
  if (mentions.length === 0) {
    saveWatchState(NAME, state, messages);
    console.log(`${NAME}: ${fresh.length} new, no mentions — silent`);
    return;
  }

  const lines = mentions
    .slice(-MAX_SHOWN)
    .map(
      (m) => `• ${formatWhen(m.date)} — ${m.sender}: ${snippet(m.text, 200)}`,
    )
    .join("\n");
  const report =
    `💬 «Волжская Тропа Chat» — тебя упоминают (${mentions.length}):\n${lines}` +
    (mentions.length > MAX_SHOWN
      ? `\n…и ещё ${mentions.length - MAX_SHOWN}.`
      : "") +
    `\n—— Чат прочитан. Стоит ответить.`;

  const result = await sendTelegramHtml(bot, chat, report, {
    retryTransient: true,
    trace: { source: NAME },
  });
  if (!result.ok) fail(`telegram send failed: ${result.error}`);

  saveWatchState(NAME, { ...state, lastSentAt: new Date().toISOString() }, messages);
  console.log(`${NAME}: sent ${mentions.length} mention(s)`);
}

await main();