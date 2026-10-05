import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { buildNodeOptions, resolveBuildHeapMb } from "./build-config.mjs";
import { acquireBuildLock } from "./build-lock.mjs";
import {
  ALLOW_BUILD_WHILE_SERVING,
  assertBuildTargetNotServed,
  readRunningServiceLabels,
  readServicePlists,
} from "./build-target-guard.mjs";

// Сборка в общий `.next` под работающим сервисом подменяет BUILD_ID и хэши чанков
// у живого процесса: страницы, которые уже отдавались, начинают падать. Порядок
// «остановить → собрать → поднять» описан в deploy/launchd/README.md.
try {
  assertBuildTargetNotServed({
    plists: readServicePlists(),
    runningLabels: readRunningServiceLabels(),
  });
} catch (error) {
  if (error?.code !== "build_target_served") throw error;
  console.error(`[build] ${error.message}`);
  console.error("[build] Порядок из deploy/launchd/README.md:");
  console.error("[build]   launchctl bootout gui/$(id -u)/ru.aurora.web");
  console.error("[build]   npm run build");
  console.error("[build]   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ru.aurora.web.plist");
  console.error("[build] Либо собери в стороне, не трогая .next:");
  console.error("[build]   AURORA_NEXT_DIST_DIR=.next-check npm run build");
  console.error(`[build] Осознанный обход (на свой риск): ${ALLOW_BUILD_WHILE_SERVING}=1`);
  globalThis.process.exit(1);
}

const heapMb = resolveBuildHeapMb(process.env.AURORA_BUILD_MAX_OLD_SPACE_SIZE_MB);
const releaseBuildLock = acquireBuildLock({
  token: globalThis.process.env.AURORA_BUILD_LOCK_TOKEN,
});
let result;
try {
  result = spawnSync(
    globalThis.process.execPath,
    [resolve("node_modules/next/dist/bin/next"), "build", "--webpack"],
    {
      cwd: globalThis.process.cwd(),
      env: {
        ...globalThis.process.env,
        NODE_OPTIONS: buildNodeOptions(globalThis.process.env.NODE_OPTIONS, heapMb),
      },
      stdio: "inherit",
    },
  );
} finally {
  releaseBuildLock();
}

if (result.error) throw result.error;
globalThis.process.exitCode = Number.isInteger(result.status) ? result.status : 1;
