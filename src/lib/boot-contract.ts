/**
 * Громкий отказ на старте рантайма.
 *
 * Инцидент 2026-10-05: `instrumentation.register()` бросал исключение при провале
 * boot-контракта (`trusted_proxy_hops_not_configured`), но HTTP-сокет к этому моменту
 * уже был открыт. Next печатал «Failed to prepare server» и продолжал принимать
 * соединения, отвечая `500 Internal Server Error` на каждый запрос. Процесс при этом
 * оставался живым, поэтому launchd с `KeepAlive` не перезапускал его, а супервизор не
 * видел проблемы. Так «прод» на localhost:3000 простоял сутки.
 *
 * Молчаливый отказ хуже громкой смерти: супервизор обязан видеть падение, чтобы
 * перезапустить процесс или позвать человека.
 */

export type ProcessExiter = (code: number) => void;
export type BootContractFailureReporter = (message: string, error: unknown) => void;

export const BOOT_CONTRACT_FAILURE_MESSAGE =
  "[instrumentation] boot-контракт не выполнен: завершаю процесс, чтобы супервизор (launchd/systemd) перезапустил его, а не оставлял сокет, отвечающий 500";

/**
 * Выполняет проверку контракта и завершает процесс при её провале.
 *
 * Побочные эффекты вынесены в параметры, чтобы инвариант «провал => выход с кодом 1»
 * проверялся тестом, а не чтением кода.
 */
export function enforceBootContract(
  check: () => void,
  options: { exit?: ProcessExiter; report?: BootContractFailureReporter } = {},
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const report = options.report ?? ((message: string, error: unknown) => console.error(message, error));

  try {
    check();
  } catch (error) {
    report(BOOT_CONTRACT_FAILURE_MESSAGE, error);
    exit(1);
  }
}
