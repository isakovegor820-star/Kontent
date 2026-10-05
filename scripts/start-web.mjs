// Production web entrypoint (systemd aurora-web.service → npm run start:web).
// До поднятия `next start` выполняются read-only префлайты: boot-контракты рантайма
// (доверенный ingress) и совместимость схемы. Нарушенный контракт или несовместимая
// схема останавливают процесс на старте, и deploy wait_for_health не увидит
// «зелёный, но глухой» web. Миграции preflight не запускает — это отдельный
// авторизованный deploy-step. Локальный dev этот путь не использует.
import { spawn } from "node:child_process";
import {
  assertRuntimeBootContracts,
  assertRuntimeSchemaReady,
  safePreflightFailure,
} from "./runtime-schema-preflight.mjs";

try {
  assertRuntimeBootContracts();
  await assertRuntimeSchemaReady();
} catch (error) {
  console.error("[start-web] runtime preflight failed:", safePreflightFailure(error));
  process.exit(1);
}

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start"], {
  stdio: "inherit",
  env: { ...process.env, AURORA_RUNTIME_ROLE: "web" },
});

const forward = (signal) => {
  if (child.exitCode === null) child.kill(signal);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
