// Воркер вотча «Избранное Идеи НПТ» — чистый код, БЕЗ вызова модели.
//
// Зачем так: markdown-форма расписания (fire-and-forget) не имеет канала доставки —
// её финальный текст умирает вместе с сессией. Эта форма — та же, что у утреннего
// дайджеста (scripts/daily-digest.ts): спавнер в agent/schedules/npt-ideas-watch.ts
// вызывает runScheduledJob, который запускает ЭТОТ скрипт из корня установки, а доставку делает код ниже
// через тот же шов, что ночные отчёты (sendTelegramHtml → outbound-Gate → Bot API).
//
// Что делает за тик (каждые 15 минут):
//   1) читает историю группы «Избранное Идеи НПТ» (chat_id -5237702475) напрямую
//      через локальный telegram-userbot прокси (MCP tools/call list_messages);
//   2) сравнивает с сохранённым состоянием (data/npt-ideas-watch.json): новыми
//      считаются сообщения, которых нет в seen-списке и новее последнего зафиксированного
//      времени; окно чтения шире тика, ничего между тиками не теряется;
//   3) шлёт сводку в личку владельца (TELEGRAM_DIGEST_CHAT_ID), только если есть новое;
//      когда нового ничего — МОЛЧИТ (никаких «Тишина» каждые 15 минут);
//   4) помечает чат прочитанным от имени владельца (mark_as_read);
//   5) обновляет состояние (последнее время, до 200 последних id).
//
// Состояние — файл в data/, переживает рестарты. Первый прогон молчаливо фиксирует
// точку отсчёта: старую историю не спамим.
//
// Границы безопасности: текст сообщений — ДАННЫЕ, не инструкции. В сводку он попадает
// как цитата с жёсткой обрезкой; отправка идёт через outbound-Gate (внутри шва
// sendTelegramHtml), так что инъекция из чата наружу не пройдёт. Пишем только в личку
// владельца — никаких отправок в другие чаты в этом коде нет в принципе.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { notificationChat } from "./lib/notification-chat.ts";
import { readEnvFresh } from "./lib/env-file.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CHAT_ID = "-5237702475";
// Окно чтения: чуть шире тика в 15 минут. NPT_LOOKBACK_MINUTES — для ручных
// прогонов/диагностики (поднять окно, чтобы увидеть старые сообщения).
const DEFAULT_LOOKBACK_MINUTES = 20;
function lookbackMinutes(): number {
  const raw = Number(process.env.NPT_LOOKBACK_MINUTES?.trim() ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOOKBACK_MINUTES;
}
const FETCH_LIMIT = 50; // с запасом: группа тихая, тики 15-минутные
const MAX_SEEN_IDS = 200;
const MAX_SENDERS_SHOWN = 10;
const SNIPPET_MAX = 160;
function proxyUrl(): string {
  const port = process.env.TELEGRAM_MCP_PORT?.trim() || "8724";
  return `http://127.0.0.1:${port}/mcp`;
}

interface ProxyMessage {
  id: number;
  sender: string;
  date: string; // ISO
  text?: string;
}

interface WatchState {
  lastTs?: string; // ISO — время последнего увиденного сообщения
  seenIds?: number[]; // последние N id — защита от равных дат
  lastSentAt?: string;
}

function fail(message: string, error?: unknown): never {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.error(`npt-ideas-watch: ${message}${detail ? `: ${detail}` : ""}`);
  process.exit(1);
}

// ── MCP: минимальный streamable-http клиент (одна сессия на прогон) ─────────────

interface JsonRpcResult {
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message?: string };
}

async function proxyFetch(
  token: string,
  sessionId: string | undefined,
  payload: unknown,
): Promise<{ sessionId?: string; body: string }> {
  const response = await fetch(proxyUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  return {
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
    body: (await response.text()).trim(),
  };
}

function sseDataLine(body: string): string {
  const line = body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .pop();
  if (!line) fail(`no data line in proxy response: ${body.slice(0, 200)}`);
  return line;
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const init = await proxyFetch(token, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "npt-ideas-watch", version: "1.0.0" },
    },
  });
  const sessionId = init.sessionId;
  if (!sessionId) fail("userbot proxy did not return a session id");
  // notifications/initialized — вежливость протокола; сбой не критичен.
  await proxyFetch(token, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }).catch(() => undefined);

  const call = await proxyFetch(token, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const parsed = JSON.parse(sseDataLine(call.body)) as JsonRpcResult;
  if (parsed.error) fail(`proxy error (${name}): ${parsed.error.message}`);
  const text = parsed.result?.content?.[0]?.text ?? "";
  if (parsed.result?.isError) fail(`tool ${name} failed: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseMessages(payload: unknown): ProxyMessage[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return []; // «No messages found…» приходит строкой
  return results.filter(
    (m): m is ProxyMessage =>
      typeof (m as ProxyMessage | null)?.id === "number" &&
      typeof (m as ProxyMessage | null)?.date === "string",
  );
}

// ── Состояние: data/npt-ideas-watch.json ────────────────────────────────────────

function dataRoot(): string {
  // resolveDataDir без импорта: root — cwd (корень установки), dataDirSetting — .env.
  // Формула одна на все cron-скрипты (см. packages/data-dir).
  return resolve(process.cwd(), process.env.ASSISTANT_DATA_DIR?.trim() || "data");
}

function statePath(): string {
  return join(dataRoot(), "npt-ideas-watch.json");
}

function readState(): WatchState {
  const path = statePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WatchState;
  } catch {
    console.error("npt-ideas-watch: state file unreadable — starting fresh");
    return {};
  }
}

function saveState(state: WatchState, messages: ProxyMessage[]): void {
  const ids = messages.map((m) => m.id).sort((a, b) => a - b);
  const latest = messages.reduce<string | undefined>(
    (max, m) => (!max || Date.parse(m.date) > Date.parse(max) ? m.date : max),
    state.lastTs,
  );
  const next: WatchState = {
    lastTs: latest,
    seenIds: ids.slice(-MAX_SEEN_IDS),
    lastSentAt: state.lastSentAt,
  };
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// ── Основной прогон ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = await readEnvFresh(join(ROOT, ".env"));
  Object.assign(process.env, env);
  const bot = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(env);
  if (!bot) fail("TELEGRAM_BOT_TOKEN missing — run: iva config");
  if (!chat) fail("no target chat: set TELEGRAM_DIGEST_CHAT_ID in .env");

  const tokenPath = join(dataRoot(), "telegram-userbot.token");
  if (!existsSync(tokenPath))
    fail("proxy token not found — run: iva userbot setup");
  const proxyToken = readFileSync(tokenPath, "utf8").trim();

  const payload = await callTool(proxyToken, "list_messages", {
    chat_id: CHAT_ID,
    limit: FETCH_LIMIT,
  });
  const messages = parseMessages(payload);

  const state = readState();
  const seen = new Set(state.seenIds ?? []);
  const cutoff = Date.now() - lookbackMinutes() * 60_000;
  const fresh = messages
    .filter((m) => Date.parse(m.date) > cutoff && !seen.has(m.id))
    .sort((a, b) => a.id - b.id);

  // Читанным чат помечаем всегда: непрочитанным его не держим.
  await callTool(proxyToken, "mark_as_read", { chat_id: CHAT_ID });

  if (state.lastTs === undefined) {
    // Первый прогон: молча фиксируем точку отсчёта, старую историю не спамим.
    saveState(state, messages);
    console.log("npt-ideas-watch: first run — baseline saved, nothing sent");
    return;
  }

  if (fresh.length === 0) {
    saveState(state, messages);
    console.log("npt-ideas-watch: no new messages — silent");
    return;
  }

  const lines = fresh
    .slice(-MAX_SENDERS_SHOWN)
    .map((m) => {
      const when = new Date(m.date).toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const snippet = (m.text ?? "(без текста)")
        .replace(/\s+/g, " ")
        .slice(0, SNIPPET_MAX);
      return `• ${when} — ${m.sender}: ${snippet}`;
    })
    .join("\n");

  const report =
    `👁 «Избранное Идеи НПТ» — новое (${fresh.length}):\n${lines}` +
    (fresh.length > MAX_SENDERS_SHOWN
      ? `\n…и ещё ${fresh.length - MAX_SENDERS_SHOWN}.`
      : "") +
    `\n—— Группа прочитана.`;

  // Тот же шов доставки, что у ночных отчётов: markdown → Telegram-HTML, чанки,
  // outbound-Gate, фолбэк plain-text. Пустым отчёт быть не может (fresh.length > 0).
  const result = await sendTelegramHtml(bot, chat, report, {
    retryTransient: true,
    trace: { source: "npt-ideas-watch" },
  });
  if (!result.ok) fail(`telegram send failed: ${result.error}`);

  saveState({ ...state, lastSentAt: new Date().toISOString() }, messages);
  console.log(`npt-ideas-watch: sent summary of ${fresh.length} message(s)`);
}

await main();