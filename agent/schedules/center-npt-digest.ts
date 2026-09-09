import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

// Ежедневный дайджест «Центр НПТ УИ» (-1003946556696, супергруппа) в 21:00 МСК.
// Запрос Тимура 21.08.2026: «анализируй сообщения в этом чате и присылай дайджест
// ежедневно, что там происходит и какие требуются действия».
//
// Кодовая форма (run), а не markdown: у плановой задачи без кода нет канала доставки —
// сводка markdown-хода умирает вместе с сессией (первая версия 27.08 выпала при
// обновлении именно поэтому). run() только спавнит воркер
// scripts/center-npt-digest.worker.ts — та же схема, что у npt-ideas-watch: скрипт
// читает чат через юзербот-прокси, собирает сообщения за сутки (упоминания @tim_ts —
// первым блоком), шлёт дайджест в личку через sendTelegramHtml → outbound-Gate и
// помечает чат прочитанным. Пустой день — молчание. Статус прогонов — в
// rollup-status.json (виден в /menu → crons).
export default defineSchedule({
  cron: "0 21 * * *",
  run({ waitUntil }) {
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "center-npt-digest",
        argv: ["scripts/center-npt-digest.worker.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        guardMs: 20 * 60 * 60_000, // сутки минус запас: не душим перенесённые прогоны
        timeoutMs: 10 * 60_000, // окно сутки, сообщений может быть много
      }),
    );
  },
});