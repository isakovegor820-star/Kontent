import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALLOW_BUILD_WHILE_SERVING,
  BuildTargetServedError,
  DEFAULT_DIST_DIR,
  assertBuildTargetNotServed,
  nextServerLabels,
  parseServicePlist,
  readServicePlists,
  resolveBuildDistDir,
} from "./build-target-guard.mjs";

const WEB_LABEL = "ru.aurora.web";

/** Реальные определения сервисов: тест ловит расхождение стража с deploy/launchd. */
const servicePlists = readServicePlists();

// Пути в плистах абсолютные и привязаны к машине оператора, поэтому каталог берём
// ИЗ САМОГО ПЛИСТА, а не из process.cwd(): на раннере CI репозиторий лежит в другом
// месте, и тест, сравнивающий с cwd, падал бы там всегда.
const WEB_WORKING_DIRECTORY = parseServicePlist(
  servicePlists.find((source) => source.includes(`<string>${WEB_LABEL}</string>`)) ?? "",
).workingDirectory;
const FOREIGN_DIRECTORY = `${WEB_WORKING_DIRECTORY}/elsewhere`;

describe("resolveBuildDistDir", () => {
  it("по умолчанию собирает в общий .next", () => {
    expect(resolveBuildDistDir({})).toBe(DEFAULT_DIST_DIR);
  });

  it("принимает изолированный каталог — он не конфликтует с живым сервисом", () => {
    expect(resolveBuildDistDir({ AURORA_NEXT_DIST_DIR: ".next-check" })).toBe(".next-check");
    expect(resolveBuildDistDir({ AURORA_NEXT_DIST_DIR: ".next-e2e-real" })).toBe(".next-e2e-real");
  });

  it("не даёт увести сборку за пределы репозитория", () => {
    // Значение уходит в distDir Next, поэтому чужие пути не принимаем.
    for (const value of ["../evil", "/tmp/evil", ".next/../..", "next-check"]) {
      expect(resolveBuildDistDir({ AURORA_NEXT_DIST_DIR: value })).toBe(DEFAULT_DIST_DIR);
    }
  });
});

describe("parseServicePlist", () => {
  it("читает метку, рабочий каталог и аргументы", () => {
    const job = parseServicePlist(
      `<?xml version="1.0"?><plist version="1.0"><dict>
	<key>Label</key><string>ru.example.svc</string>
	<key>ProgramArguments</key><array>
		<string>/usr/bin/node</string>
		<string>/srv/app/node_modules/next/dist/bin/next</string>
		<string>start</string>
	</array>
	<key>WorkingDirectory</key><string>/srv/app</string>
</dict></plist>`,
    );

    expect(job.label).toBe("ru.example.svc");
    expect(job.workingDirectory).toBe("/srv/app");
    expect(job.arguments).toEqual([
      "/usr/bin/node",
      "/srv/app/node_modules/next/dist/bin/next",
      "start",
    ]);
  });
});

describe("nextServerLabels", () => {
  it("видит сервер сборки в реальном определении и не путает его с воркером и сторожем", () => {
    // Воркер и сторож работают в том же каталоге, но `.next` не отдают:
    // блокировать из-за них сборку было бы ложным срабатыванием.
    const labels = nextServerLabels(servicePlists, WEB_WORKING_DIRECTORY);
    expect(labels).toEqual([WEB_LABEL]);
  });

  it("игнорирует сервисы из чужого каталога", () => {
    expect(nextServerLabels(servicePlists, FOREIGN_DIRECTORY)).toEqual([]);
  });
});

describe("assertBuildTargetNotServed", () => {
  const base = { cwd: WEB_WORKING_DIRECTORY, plists: servicePlists, env: {} };

  it("пропускает сборку, когда сервис не запущен", () => {
    expect(() => assertBuildTargetNotServed({ ...base, runningLabels: [] })).not.toThrow();
  });

  it("останавливает сборку, когда .next отдаёт живой сервис", () => {
    // Ровно этот случай 04.10.2026: сборка подменила каталог у процесса,
    // запущенного за 1.5 часа до неё.
    let failure = null;
    try {
      assertBuildTargetNotServed({ ...base, runningLabels: [WEB_LABEL] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BuildTargetServedError);
    expect(failure.code).toBe("build_target_served");
    expect(failure.labels).toEqual([WEB_LABEL]);
  });

  it("не пугается запущенного воркера", () => {
    expect(() =>
      assertBuildTargetNotServed({ ...base, runningLabels: ["ru.aurora.publication-worker"] }),
    ).not.toThrow();
  });

  it("разрешает изолированную сборку при живом сервисе", () => {
    expect(() =>
      assertBuildTargetNotServed({
        ...base,
        runningLabels: [WEB_LABEL],
        distDir: ".next-check",
      }),
    ).not.toThrow();
  });

  it("оставляет осознанный обход", () => {
    expect(() =>
      assertBuildTargetNotServed({
        ...base,
        runningLabels: [WEB_LABEL],
        env: { [ALLOW_BUILD_WHILE_SERVING]: "1" },
      }),
    ).not.toThrow();
  });

  it("не считает обходом любое непустое значение", () => {
    expect(() =>
      assertBuildTargetNotServed({
        ...base,
        runningLabels: [WEB_LABEL],
        env: { [ALLOW_BUILD_WHILE_SERVING]: "true" },
      }),
    ).toThrow(BuildTargetServedError);
  });
});

describe("страховка от расхождения с deploy/launchd", () => {
  it("в каталоге сервисов действительно лежит определение web", () => {
    const web = readFileSync(resolve("deploy/launchd", `${WEB_LABEL}.plist`), "utf8");
    expect(web).toContain(`<string>${WEB_LABEL}</string>`);
    expect(web).toContain("<string>start</string>");
  });
});
