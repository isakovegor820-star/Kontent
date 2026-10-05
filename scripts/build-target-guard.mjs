import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Защита от сборки в `.next`, который прямо сейчас отдаёт живой сервис.
 *
 * `next build` заменяет `.next/BUILD_ID` и хэши чанков, а уже запущенный `next start`
 * держит манифесты в памяти и подгружает серверные чанки лениво — после подмены
 * каталога он начинает отдавать ошибки на страницы, которые до этого работали.
 * Ровно это и произошло 04.10.2026: каталог пересобрали в 14:43 при процессе,
 * запущенном в 13:09.
 *
 * Сборка в изолированный каталог (`.next-*`, см. `AURORA_NEXT_DIST_DIR`) общий `.next`
 * не трогает и остаётся разрешённой.
 */

export const ISOLATED_DIST_DIR_PATTERN = /^\.next-[a-z0-9_-]+$/u;
export const DEFAULT_DIST_DIR = ".next";
export const ALLOW_BUILD_WHILE_SERVING = "AURORA_ALLOW_BUILD_WHILE_SERVING";
export const SERVICE_DEFINITION_DIRECTORY = "deploy/launchd";

export class BuildTargetServedError extends Error {
  constructor(labels) {
    super(`сборка в ${DEFAULT_DIST_DIR} остановлена: его отдаёт живой сервис ${labels.join(", ")}`);
    this.name = "BuildTargetServedError";
    this.code = "build_target_served";
    this.labels = [...labels];
  }
}

/** Куда собирать. Изолированный каталог не конфликтует с живым сервисом. */
export function resolveBuildDistDir(env = process.env) {
  const requested = String(env.AURORA_NEXT_DIST_DIR ?? "").trim();
  return ISOLATED_DIST_DIR_PATTERN.test(requested) ? requested : DEFAULT_DIST_DIR;
}

function plistString(source, key) {
  const match = source.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u"));
  return match ? match[1] : null;
}

/** Разбирает определение сервиса: метка, рабочий каталог и аргументы запуска. */
export function parseServicePlist(source) {
  const block = source.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)?.[1] ?? "";
  return {
    label: plistString(source, "Label"),
    workingDirectory: plistString(source, "WorkingDirectory"),
    arguments: [...block.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) => match[1]),
  };
}

/**
 * Метки сервисов, которые отдают собранный `.next` именно этого каталога.
 *
 * Воркер и сторож работают в том же каталоге, но сборку не обслуживают: сервером
 * считается только задание, запускающее `next start`.
 */
export function nextServerLabels(plists, cwd = process.cwd()) {
  const target = resolve(cwd);
  return plists
    .map(parseServicePlist)
    .filter((job) => job.label && job.workingDirectory && resolve(job.workingDirectory) === target)
    .filter((job) => job.arguments.includes("start") && job.arguments.some((arg) => /next$/u.test(arg)))
    .map((job) => job.label);
}

/** Читает определения сервисов из репозитория; отсутствие каталога — не ошибка. */
export function readServicePlists(directory = resolve(SERVICE_DEFINITION_DIRECTORY)) {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".plist"))
      .map((name) => readFileSync(resolve(directory, name), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Метки реально запущенных заданий launchd. Вне macOS (CI) возвращает пустое
 * множество — там сборке ничего не мешает.
 */
export function readRunningServiceLabels(platform = process.platform, uid = process.getuid?.()) {
  if (platform !== "darwin" || uid == null) return [];
  try {
    const output = execFileSync("launchctl", ["list"], { encoding: "utf8" });
    return output
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"))
      .filter((columns) => columns.length >= 3 && /^\d+$/u.test(columns[0].trim()))
      .map((columns) => columns[2].trim());
  } catch {
    return [];
  }
}

/** Бросает, если сборка идёт в общий `.next`, который обслуживает живой сервис. */
export function assertBuildTargetNotServed({
  cwd = process.cwd(),
  env = process.env,
  plists = [],
  runningLabels = [],
  distDir = resolveBuildDistDir(env),
} = {}) {
  if (distDir !== DEFAULT_DIST_DIR) return;
  if (String(env[ALLOW_BUILD_WHILE_SERVING] ?? "").trim() === "1") return;
  const running = new Set(runningLabels);
  const blocked = nextServerLabels(plists, cwd).filter((label) => running.has(label));
  if (blocked.length > 0) throw new BuildTargetServedError(blocked);
}
