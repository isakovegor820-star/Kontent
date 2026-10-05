import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { buildNodeOptions, resolveBuildHeapMb } from "./build-config.mjs";
import { acquireBuildLock } from "./build-lock.mjs";

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
