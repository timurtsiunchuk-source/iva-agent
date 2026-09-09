// Воркер ежедневного дайджеста «Центр НПТ УИ» (супергруппа -1003946556696) —
// чистый код, БЕЗ вызова модели. Запрос Тимура 21.08.2026: «анализируй сообщения
// в этом чате и присылай дайджест ежедневно, что там происходит и какие требуются
// действия» — 21:00 МСК.
//
// Схема та же, что у npt-ideas-watch и обоих SMM-вотчей: спавнер
// agent/schedules/center-npt-digest.ts вызывает ЭТОТ скрипт через runScheduledJob,
// доставку делает код ниже через sendTelegramHtml → outbound-Gate. В отличие от
// старой версии (27.08) здесь НЕТ agent.run() — это дайджест сырых сообщений:
// «что нового и где требуется действие». Модели в cron-пути нет по архитектуре
// (у плановой задачи без кода нет канала доставки).
//
// Дайджест собирается из сообщений за последние 24 часа (окно CENTER_LOOKBACK_HOURS);
// тик раз в сутки — окно с запасом, ничего не теряется. Пустой день — молчание.
// Первым блоком — сообщения с упоминанием @tim_ts, они важнее прочих.
//
// Состояние: data/center-npt-digest.json. Безопасность: текст сообщений — ДАННЫЕ,
// в отчёт идёт обрезанной строкой; отправка только в личку через outbound-Gate.
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
const NAME = "center-npt-digest";

const CHAT_ID = "-1003946556696"; // «Центр НПТ УИ»
const TAG = "@tim_ts";
// Окно чтения: сутки (тик раз в сутки). CENTER_LOOKBACK_HOURS — для ручных прогонов.
const DEFAULT_LOOKBACK_HOURS = 24;
const FETCH_LIMIT = 100;
const MAX_SHOWN = 20;

function lookbackHours(): number {
  const raw = Number(process.env.CENTER_LOOKBACK_HOURS?.trim() ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOOKBACK_HOURS;
}

function fail(message: string, error?: unknown): never {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : typeof error === "string" ? error : JSON.stringify(error);
  console.error(`${NAME}: ${message}${detail ? `: ${detail}` : ""}`);
  process.exit(1);
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
  const fresh = freshMessages(messages, state, lookbackHours() * 60);

  // Читанным чат помечаем всегда — дайджест заменяет ручное чтение.
  await callTool(NAME, proxyToken, "mark_as_read", { chat_id: CHAT_ID });

  if (state.lastTs === undefined) {
    saveWatchState(NAME, state, messages);
    console.log(`${NAME}: first run — baseline saved, nothing sent`);
    return;
  }

  if (fresh.length === 0) {
    saveWatchState(NAME, state, messages);
    console.log(`${NAME}: quiet day — silent`);
    return;
  }

  const isTagged = (m: ProxyMessage) =>
    typeof m.text === "string" && m.text.includes(TAG);
  const tagged = fresh.filter(isTagged);
  const rest = fresh.filter((m) => !isTagged(m));

  const line = (m: ProxyMessage): string =>
    `• ${formatWhen(m.date)} — ${m.sender}: ${snippet(m.text, 200)}`;
  const block = (title: string, items: ProxyMessage[]): string =>
    items.length === 0
      ? ""
      : `\n${title} (${items.length}):\n${items.slice(-MAX_SHOWN).map(line).join("\n")}` +
        (items.length > MAX_SHOWN ? `\n…и ещё ${items.length - MAX_SHOWN}.` : "");

  const report =
    `🔔 «Центр НПТ УИ» — за сутки (${fresh.length})\n` +
    block("🏷 Тебя тегают", tagged) +
    block("💬 Остальное", rest) +
    `\n—— Чат прочитан.`;

  const result = await sendTelegramHtml(bot, chat, report, {
    retryTransient: true,
    trace: { source: NAME },
  });
  if (!result.ok) fail(`telegram send failed: ${result.error}`);

  saveWatchState(NAME, { ...state, lastSentAt: new Date().toISOString() }, messages);
  console.log(`${NAME}: sent digest of ${fresh.length} message(s)`);
}

await main();