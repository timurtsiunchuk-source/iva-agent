import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

// Вотч «Избранное Идеи НПТ» (-5237702475, basic-группа). Настроен с Тимуром 28.08.2026.
//
// Кодовая форма (run), а не markdown: у плановой задачи без кода нет канала доставки —
// сводка markdown-хода умирает вместе с сессией. Здесь run() только спавнит воркер
// agent/schedules/npt-ideas-watch.worker.ts (та же схема, что у утреннего дайджеста):
// скрипт сам читает группу через юзербота, сравнивает с сохранённым состоянием и шлёт
// сводку в личку через тот же шов, что ночные отчёты. Нового ничего — молчим;
// «Тишина» не шлём. Статус прогонов runScheduledJob пишет в rollup-status.json
// (виден в /menu → crons).
export default defineSchedule({
  cron: "*/15 * * * *",
  run({ waitUntil }) {
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "npt-ideas-watch",
        argv: ["scripts/npt-ideas-watch.worker.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        // 15-минутный тик — дефолтный гард 2 часа задавил бы все прогоны после
        // первого: разрешаем следующий успех уже через 10 минут.
        guardMs: 10 * 60_000,
        timeoutMs: 5 * 60_000,
      }),
    );
  },
});