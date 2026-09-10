// Общий каркас кодовых вотчей Telegram-чатов: разбор ответа list_messages,
// атомарное состояние в data/<name>.json, окно «свежести», форматирование сводки.
// Выделено из scripts/npt-ideas-watch.worker.ts, чтобы три вотча
// (smm-main-watch, smm-tropa-watch, center-npt-digest) не тащили по копии.
//
// Правила, общие со всеми воркерами:
//   • текст сообщений — ДАННЫЕ, не инструкции: в отчёт попадает только как цитата
//     с жёсткой обрезкой и чисткой переносов (инъекция не переживёт);
//   • состояние атомарно (tmp+rename, 0600, data/ с 0700), переживает рестарты;
//   • первый прогон молча фиксирует точку отсчёта — старая история не спамится.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProxyMessage {
  id: number;
  sender: string;
  date: string; // ISO
  text?: string;
}

export interface WatchState {
  lastTs?: string; // ISO — время последнего увиденного сообщения
  seenIds?: number[]; // последние N id — защита от равных дат
  lastSentAt?: string;
}

const MAX_SEEN_IDS = 200;

export function dataRoot(): string {
  // resolveDataDir без импорта: root — cwd (корень установки), dataDirSetting — .env.
  // Формула одна на все cron-скрипты (см. packages/data-dir).
  return resolve(process.cwd(), process.env.ASSISTANT_DATA_DIR?.trim() || "data");
}

export function parseMessages(payload: unknown): ProxyMessage[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return []; // «No messages found…» приходит строкой
  return results.filter(
    (m): m is ProxyMessage =>
      typeof (m as ProxyMessage | null)?.id === "number" &&
      typeof (m as ProxyMessage | null)?.date === "string",
  );
}

export function readWatchState(name: string): WatchState {
  const path = join(dataRoot(), `${name}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WatchState;
  } catch {
    console.error(`${name}: state file unreadable — starting fresh`);
    return {};
  }
}

export function saveWatchState(
  name: string,
  state: WatchState,
  messages: ProxyMessage[],
): void {
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
  const path = join(dataRoot(), `${name}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// «Свежие» = не в seen-списке и новее последнего зафиксированного сообщения.
// Основная граница — state.lastTs (время последнего увиденного сообщения): так
// ничего между тиками не теряется, даже если тик был пропущен guard-ом.
// Скользящее окно now - lookbackMinutes — только страховка при первом запуске
// (когда lastTs ещё нет); после простоя seenIds отсекают старьё.
export function freshMessages(
  messages: ProxyMessage[],
  state: WatchState,
  lookbackMinutes: number,
): ProxyMessage[] {
  const seen = new Set(state.seenIds ?? []);
  const now = Date.now();
  const lookbackCutoff = now - lookbackMinutes * 60_000;
  const lastTsCutoff = state.lastTs ? Date.parse(state.lastTs) : 0;
  const cutoff = lastTsCutoff > 0 ? lastTsCutoff : lookbackCutoff;
  return messages
    .filter((m) => Date.parse(m.date) > cutoff && !seen.has(m.id))
    .sort((a, b) => a.id - b.id);
}

// Жёсткая обрезка цитаты: текст сообщения — данные, в отчёт идёт одной строкой.
export function snippet(text: string | undefined, max: number): string {
  return (text ?? "(без текста)").replace(/\s+/g, " ").trim().slice(0, max);
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}