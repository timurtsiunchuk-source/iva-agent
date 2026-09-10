import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

// Вотч «эшлибез 📬» (-5195487732, супергруппа). Задача блока ЭШ: Ива мониторит
// теги @ivatimtsbot / @tim_ts и отвечает в группе от себя (ivatimtsbot) или
// подсвечивает Тимуру. Тик каждые 5 минут, 09:00–22:59 МСК; ночью молчим.
// Тот же рисунок, что у smm-main-watch: спавнит scripts/ashlibez-watch.worker.ts.
export default defineSchedule({
  cron: "*/5 9-22 * * *",
  run({ waitUntil }) {
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "ashlibez-watch",
        argv: ["scripts/ashlibez-watch.worker.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        guardMs: 5 * 60_000,
        timeoutMs: 8 * 60_000, // до 3 тегов × ход агента; guard < timeout
      }),
    );
  },
});
