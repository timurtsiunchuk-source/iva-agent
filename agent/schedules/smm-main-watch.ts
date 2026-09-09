import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

// Вотч «SMM | Волжская тропа» (-1002332852583, супергруппа). Правила подтверждены
// Тимуром 27.08.2026: проверять часто («сразу, как только тег появился»), тег =
// только явное @tim_ts, чат помечать прочитанным за Тимура.
//
// Кодовая форма (run), а не markdown: у плановой задачи без кода нет канала доставки —
// сводка markdown-хода умирает вместе с сессией (27.08 обе старые SMM-версии умерли
// именно так: написаны под несуществующий schedule API и выпали при обновлении).
// run() только спавнит воркер scripts/smm-main-watch.worker.ts — та же схема, что у
// утреннего дайджеста и npt-ideas-watch: скрипт сам читает чат через юзербот-прокси,
// фильтрует теги @tim_ts, шлёт сводку в личку через sendTelegramHtml → outbound-Gate,
// помечает чат прочитанным. Без тегов — молчание. Статус прогонов — в
// rollup-status.json (виден в /menu → crons).
export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "smm-main-watch",
        argv: ["scripts/smm-main-watch.worker.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        // Тик 5 минут — дефолтный гард 2 часа задавил бы все прогоны после первого:
        // разрешаем следующий успех уже через 4 минуты.
        guardMs: 4 * 60_000,
        timeoutMs: 5 * 60_000,
      }),
    );
  },
});