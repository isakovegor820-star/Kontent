import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Локальный рантайм — часть контракта запуска.
 *
 * Повод: инцидент 2026-10-05. 22.09.2026 в коде появился обязательный
 * `AURORA_TRUSTED_PROXY_HOPS`, но launchd-сервис `ru.aurora.web` жил вне репозитория,
 * про переменную не знал и запускал `next start` мимо префлайта. Процесс поднял сокет,
 * отвечал 500 на каждый запрос и оставался «живым» для KeepAlive — сутки простоя.
 *
 * VPS-путь покрыт `deployment-shell-contract.test.mjs`. Здесь — локальный, чтобы
 * плисты, префлайт и пример конфигурации больше не расходились с рантаймом.
 */

const webPlist = await readFile(resolve("deploy/launchd/ru.aurora.web.plist"), "utf8");
const workerPlist = await readFile(resolve("deploy/launchd/ru.aurora.publication-worker.plist"), "utf8");
const healthPlist = await readFile(resolve("deploy/launchd/ru.aurora.health.plist"), "utf8");
const healthScript = await readFile(resolve("scripts/aurora-local-health.sh"), "utf8");
const launchdReadme = await readFile(resolve("deploy/launchd/README.md"), "utf8");
const envExample = await readFile(resolve(".env.example"), "utf8");
const instrumentation = await readFile(resolve("src/instrumentation.ts"), "utf8");
const preflight = await readFile(resolve("scripts/runtime-schema-preflight.mjs"), "utf8");
const startWeb = await readFile(resolve("scripts/start-web.mjs"), "utf8");
const startAll = await readFile(resolve("scripts/start.mjs"), "utf8");

/** Значение `<key>name</key><string>…</string>` из plist. Комментарии XML не мешают. */
function plistValue(source, key) {
  const match = source.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u"),
  );
  return match ? match[1] : null;
}

describe("локальный сервис ru.aurora.web", () => {
  it("несёт boot-контракт сам, а не надеется на .env.local", () => {
    expect(plistValue(webPlist, "AURORA_TRUSTED_PROXY_HOPS")).toBe("1");
    expect(plistValue(webPlist, "NODE_ENV")).toBe("production");
  });

  it("держит порт 3000 — это и есть «прод» на этом компьютере", () => {
    expect(webPlist).toContain("<string>3000</string>");
    expect(webPlist).toContain("<string>start</string>");
    expect(webPlist).toContain("<string>production</string>");
  });

  it("работает из каталога репозитория, иначе next start не найдёт .next", () => {
    const workingDirectory = plistValue(webPlist, "WorkingDirectory");
    expect(workingDirectory).toMatch(/platform$/u);
    expect(webPlist).toContain(`${workingDirectory}/node_modules/next/dist/bin/next`);
  });

  it("перезапускается после падения — на это опирается громкий отказ на старте", () => {
    expect(webPlist).toContain("<key>KeepAlive</key>");
    expect(webPlist).toContain("<true/>");
  });
});

describe("локальный воркер", () => {
  it("не ворует апдейты у бота прода", () => {
    // В журнале до 06.09.2026 копились строки «Telegram-команды получает другой
    // polling-процесс»: поллинг принадлежит боту на VPS, локальный воркер обязан молчать.
    expect(plistValue(workerPlist, "TG_POLLING_ENABLED")).toBe("0");
  });

  it("остаётся полным воркером, а не публикационным огрызком", () => {
    expect(plistValue(workerPlist, "AURORA_WORKER_MODE")).toBe("full");
  });
});

describe("сторож локального сервиса", () => {
  it("запускается по расписанию и проверяет health, а не только живость процесса", () => {
    expect(healthPlist).toContain("<key>StartInterval</key>");
    expect(healthPlist).toContain("scripts/aurora-local-health.sh");
    expect(healthScript).toContain("/api/health");
  });

  it("пишет сбой в журнал и возвращает ненулевой код", () => {
    expect(healthScript).toContain("Aurora-health.log");
    expect(healthScript).toContain("exit 1");
    expect(healthScript).toContain("exit 0");
  });
});

describe("контракт запуска не расходится с сервисом", () => {
  it("в примере конфигурации переменная задана, а не закомментирована", () => {
    // Закомментированная строка в .env.example + запуск мимо префлайта = сутки 500-х.
    expect(envExample).toMatch(/^AURORA_TRUSTED_PROXY_HOPS=1$/mu);
    expect(envExample).not.toMatch(/^#\s*AURORA_TRUSTED_PROXY_HOPS=/mu);
  });

  it("провал контракта завершает процесс, а не оставляет сокет отвечать 500", () => {
    expect(instrumentation).toContain("enforceBootContract");
    expect(instrumentation).not.toMatch(/^\s*assertTrustedProxyBootContract\(\);\s*$/mu);
  });

  it("production-точки входа отказываются стартовать без контракта", () => {
    expect(preflight).toContain("export function assertRuntimeBootContracts");
    expect(startWeb).toContain("assertRuntimeBootContracts()");
    expect(startAll).toContain("assertRuntimeBootContracts()");
  });

  it("dev-путь контракт не требует — иначе локальная разработка встанет", () => {
    const devBootstrap = readFile(resolve("scripts/dev-bootstrap.mjs"), "utf8");
    return devBootstrap.then((source) => {
      expect(source).not.toContain("assertRuntimeBootContracts");
    });
  });
});

describe("разделение портов задокументировано", () => {
  it("«прод» на 3000, разработка на 3100", () => {
    expect(launchdReadme).toContain("3100");
    expect(launchdReadme).toContain("npm run dev -- -p 3100");
  });

  it("пересборка .next описана только при остановленном сервисе", () => {
    expect(launchdReadme).toContain("bootout");
    expect(launchdReadme).toContain("npm run build");
    expect(launchdReadme.indexOf("bootout")).toBeLessThan(
      launchdReadme.indexOf("npm run build"),
    );
  });
});

describe("порт разработки не воюет с локальным «продом»", () => {
  const devBootstrap = () => import("../../scripts/dev-bootstrap.mjs");

  it("читает порт из -p/--port/PORT, по умолчанию 3000", async () => {
    const { resolveDevelopmentPort } = await devBootstrap();
    expect(resolveDevelopmentPort([], {})).toBe(3000);
    expect(resolveDevelopmentPort(["-p", "3100"], {})).toBe(3100);
    expect(resolveDevelopmentPort(["--port", "3111"], {})).toBe(3111);
    expect(resolveDevelopmentPort([], { PORT: "3122" })).toBe(3122);
    expect(resolveDevelopmentPort(["-p", "не-число"], {})).toBe(3000);
  });

  it("различает занятый и свободный порт", async () => {
    const { assertDevelopmentPortAvailable, DevelopmentPortBusyError } = await devBootstrap();
    const { createServer } = await import("node:net");

    // Эфемерный порт: тест не зависит от того, что запущено на машине.
    const holder = createServer();
    await new Promise((resolveListing) => holder.listen(0, resolveListing));
    const busyPort = holder.address().port;

    await expect(assertDevelopmentPortAvailable(busyPort)).rejects.toBeInstanceOf(
      DevelopmentPortBusyError,
    );

    await new Promise((resolveClosed) => holder.close(resolveClosed));
    await expect(assertDevelopmentPortAvailable(busyPort)).resolves.toBeUndefined();
  });
});

describe("префлайт boot-контрактов", () => {
  const preflightModule = () => import("../../scripts/runtime-schema-preflight.mjs");

  it("пропускает старт, когда контракт выполнен", async () => {
    const { assertRuntimeBootContracts } = await preflightModule();
    expect(() =>
      assertRuntimeBootContracts({ env: { AURORA_TRUSTED_PROXY_HOPS: "1" } }),
    ).not.toThrow();
  });

  it("отказывает с точным кодом, когда переменной нет", async () => {
    const { assertRuntimeBootContracts, safePreflightFailure } = await preflightModule();
    let failure = null;
    try {
      assertRuntimeBootContracts({ env: {} });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("trusted_proxy_hops_not_configured");
    // Код обязан попадать в журнал как есть: по нему ищут причину.
    expect(safePreflightFailure(failure)).toEqual({
      code: "trusted_proxy_hops_not_configured",
      reasons: ["boot_contract:trusted_proxy_hops_not_configured"],
    });
  });

  it("не мешает сборке: на этапе build контракт не применяется", async () => {
    const { assertRuntimeBootContracts } = await preflightModule();
    expect(() =>
      assertRuntimeBootContracts({ env: { NEXT_PHASE: "phase-production-build" } }),
    ).not.toThrow();
  });

  it("не пропускает мусор вместо числа", async () => {
    const { assertRuntimeBootContracts } = await preflightModule();
    for (const value of ["0", "11", "1.5", "один", ""]) {
      expect(() => assertRuntimeBootContracts({ env: { AURORA_TRUSTED_PROXY_HOPS: value } })).toThrow(
        "trusted_proxy_hops_not_configured",
      );
    }
  });
});

describe("установка локальных сервисов", () => {
  const installer = readFile(resolve("scripts/install-local-services.sh"), "utf8");

  it("ставит web и сторож, а воркер — только по явному флагу", async () => {
    // Воркер запускает публикации: включать его «заодно» нельзя.
    const source = await installer;
    expect(source).toContain("services=(web health)");
    expect(source).toContain("--with-worker) services=(web publication-worker health)");
  });

  it("дожидается выгрузки агента перед bootstrap", async () => {
    // bootout асинхронен: bootstrap сразу после него падает с «Input/output error»,
    // и сервис остаётся лежать. Поймано прогоном установщика 05.10.2026.
    const source = await installer;
    const bootout = source.indexOf("launchctl bootout");
    const wait = source.indexOf("launchctl print", bootout);
    const bootstrap = source.indexOf("launchctl bootstrap", wait);
    expect(bootout).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(bootout);
    expect(bootstrap).toBeGreaterThan(wait);
  });

  it("отказывается ставить плисты, ссылающиеся на другой каталог", async () => {
    // Пути в плистах абсолютные: после переезда репозитория сервис запустил бы чужой код.
    expect(await installer).toContain('grep -qF "$REPO_ROOT"');
  });

  it("не считает установку успешной без 200 от health", async () => {
    const source = await installer;
    expect(source).toContain("/api/health");
    expect(source).toMatch(/"\$code" = "200"/u);
  });

  it("все локальные сервисы работают из одного абсолютного каталога", () => {
    // Пути в плистах привязаны к машине оператора, поэтому сверять их с process.cwd()
    // нельзя: на раннере CI репозиторий лежит в другом месте. Проверяем то, что верно
    // на любой машине: каталог абсолютный и одинаковый у всех трёх сервисов.
    // Совпадение с конкретным репозиторием стережёт установщик (grep -qF "$REPO_ROOT").
    const directories = [webPlist, workerPlist, healthPlist].map((source) =>
      plistValue(source, "WorkingDirectory"),
    );
    expect(new Set(directories).size).toBe(1);
    expect(directories[0].startsWith("/")).toBe(true);
  });
});
