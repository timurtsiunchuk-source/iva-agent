import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

// Вотч «Волжская Тропа Chat» (-1001782696497, супергруппа). Правила согласованы
// 27.08.2026: читаем за Тимура (отмечаем прочитанным), чтобы сообщения не копились;
// если его тегают (@tim_ts или «Тимур» по смыслу) — подсвечиваем необходимость
// ответить. Ночные часы (23:00–08:59) не будим.
//
// Кодовая форма (run), а не markdown: у плановой задачи без кода нет канала доставки.
// run() только спавнит воркер scripts/smm-tropa-watch.worker.ts — та же схема, что у
// npt-ideas-watch: скрипт читает чат через юзербот-прокси, ловит @tim_ts/«Тимур»,
// шлёт сводку в личку через sendTelegramHtml → outbound-Gate, помечает чат
// прочитанным. Без упоминаний — молчание. Статус прогонов — в rollup-status.json
// (виден в /menu → crons).
export default defineSchedule({
  cron: "0 9-22 * * *",
  run({ waitUntil }) {
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "smm-tropa-watch",
        argv: ["scripts/smm-tropa-watch.worker.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        guardMs: 45 * 60_000, // тик часовой — гард не должен съедать следующий
        timeoutMs: 5 * 60_000,
      }),
    );
  },
});