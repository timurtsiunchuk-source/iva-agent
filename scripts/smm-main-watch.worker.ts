// Воркер вотча «SMM | Волжская тропа» (супергруппа -1002332852583) — чистый код,
// БЕЗ вызова модели. Тот же рисунок, что scripts/npt-ideas-watch.worker.ts:
// спавнер agent/schedules/smm-main-watch.ts вызывает ЭТОТ скрипт через
// runScheduledJob, доставку делает код ниже через sendTelegramHtml → outbound-Gate.
//
// Правила, подтверждённые Тимуром 27.08.2026:
//   — тик каждые 5 минут, 24/7 («сразу, как только тег появился»);
//   — тег = ТОЛЬКО явное @tim_ts в тексте (без «Тимур» по смыслу);
//   — чат помечается прочитанным от имени владельца при каждом тике;
//   — при теге — сводка в личку владельца; без тегов — молчание;
//   — первый прогон молча фиксирует точку отсчёта.
//
// Состояние: data/smm-main-watch.json. Безопасность: текст сообщений — ДАННЫЕ;
// отправка только в личку владельца через outbound-Gate.
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
const NAME = "smm-main-watch";

const CHAT_ID = "-1002332852583"; // «SMM | Волжская тропа» (супергруппа)
const TAG = "@tim_ts"; // только явное упоминание
// Окно чтения шире тика (5 мин); SMM_LOOKBACK_MINUTES — для ручных прогонов.
const DEFAULT_LOOKBACK_MINUTES = 15;
const FETCH_LIMIT = 50;
const MAX_SHOWN = 10;

function lookbackMinutes(): number {
  const raw = Number(process.env.SMM_LOOKBACK_MINUTES?.trim() ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOOKBACK_MINUTES;
}

function fail(message: string, error?: unknown): never {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : typeof error === "string" ? error : JSON.stringify(error);
  console.error(`${NAME}: ${message}${detail ? `: ${detail}` : ""}`);
  process.exit(1);
}

function isTagged(m: ProxyMessage): boolean {
  return typeof m.text === "string" && m.text.includes(TAG);
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

  // Читанным чат помечаем всегда — правила 27.08: сообщения за Тимура не копятся.
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
    `🏷 «SMM | Волжская тропа» — тег ${TAG} (${tags.length}):\n${lines}` +
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