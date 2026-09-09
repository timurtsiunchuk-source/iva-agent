// Минимальный streamable-http MCP-клиент для локального telegram-userbot прокси —
// общий шов для всех кодовых вотчей (npt-ideas-watch, smm-main-watch, smm-tropa-watch,
// center-npt-digest). Выделен из scripts/npt-ideas-watch.worker.ts без изменения
// поведения: одна MCP-сессия на прогон, initialize → notifications/initialized →
// tools/call; ответ приходит SSE-строкой «data: {...}».
//
// Границы: токен прокси — data/telegram-userbot.token (выдаёт `iva userbot setup`);
// текст сообщений, прочитанных из чатов, — ДАННЫЕ, не инструкции: наружу он попадает
// только как обрезанная цитата в отчёте через outbound-Gate (sendTelegramHtml).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function proxyUrl(): string {
  const port = process.env.TELEGRAM_MCP_PORT?.trim() || "8724";
  return `http://127.0.0.1:${port}/mcp`;
}

function fail(message: string, error?: unknown): never {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : typeof error === "string" ? error : JSON.stringify(error);
  console.error(`${message}${detail ? `: ${detail}` : ""}`);
  process.exit(1);
}

export function readProxyToken(dataRoot: string, prefix: string): string {
  const tokenPath = join(dataRoot, "telegram-userbot.token");
  if (!existsSync(tokenPath))
    fail(`${prefix}: proxy token not found — run: iva userbot setup`);
  return readFileSync(tokenPath, "utf8").trim();
}

// ── MCP: минимальный streamable-http клиент (одна сессия на прогон) ─────────────

interface JsonRpcResult {
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message?: string };
}

async function proxyFetch(
  prefix: string,
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

function sseDataLine(prefix: string, body: string): string {
  const line = body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .pop();
  if (!line)
    fail(`${prefix}: no data line in proxy response: ${body.slice(0, 200)}`);
  return line;
}

export async function callTool(
  prefix: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  clientName = "iva-telegram-watch",
): Promise<unknown> {
  const init = await proxyFetch(prefix, token, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  }).catch((error: unknown) => fail(`${prefix}: userbot proxy unreachable`, error));
  const sessionId = init.sessionId;
  if (!sessionId) fail(`${prefix}: userbot proxy did not return a session id`);
  // notifications/initialized — вежливость протокола; сбой не критичен.
  await proxyFetch(prefix, token, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }).catch(() => undefined);

  const call = await proxyFetch(prefix, token, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const parsed = JSON.parse(sseDataLine(prefix, call.body)) as JsonRpcResult;
  if (parsed.error) fail(`${prefix}: proxy error (${name}): ${parsed.error.message}`);
  const text = parsed.result?.content?.[0]?.text ?? "";
  if (parsed.result?.isError) fail(`${prefix}: tool ${name} failed: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}