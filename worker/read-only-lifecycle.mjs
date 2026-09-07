// This scope belongs only to restartable provider reads. Publication transports and
// paid AI calls must drain under their own receipt/spend contracts.
export function createReadOnlyLifecycle() {
  const controller = new AbortController();
  const reason = Object.assign(new Error("Worker read cancelled for shutdown"), {
    code: "worker_read_shutdown",
  });
  function throwIfStopped() {
    if (controller.signal.aborted) throw reason;
  }
  return {
    signal: controller.signal,
    stop() { controller.abort(reason); },
    isCancellation(error) { return error === reason; },
    throwIfStopped,
    async fetch(input, init = {}) {
      throwIfStopped();
      const signal = init.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal;
      try {
        const response = await fetch(input, { ...init, signal });
        throwIfStopped();
        return response;
      } catch (error) {
        throwIfStopped();
        throw error;
      }
    },
    wait(ms) {
      throwIfStopped();
      return new Promise((resolve, reject) => {
        const done = () => {
          controller.signal.removeEventListener("abort", cancel);
          resolve();
        };
        const timer = setTimeout(done, ms);
        const cancel = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", cancel);
          reject(reason);
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
}
