/** Poll a condition within one elapsed-time budget, including slow or stuck checks. */
export async function waitForE2e(check, message, timeoutMs = 20_000) {
  let last;
  let stopped = false;
  let deadlineTimer;
  let pollTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      stopped = true;
      reject(new Error(`${message}${last ? `: ${last.message}` : ""}`));
    }, timeoutMs);
  });
  const poll = async () => {
    while (!stopped) {
      try {
        const value = await check();
        if (stopped) return;
        if (value) return value;
      } catch (error) {
        last = error;
      }
      if (!stopped) await new Promise(resolve => { pollTimer = setTimeout(resolve, 150); });
    }
  };
  try {
    return await Promise.race([poll(), deadline]);
  } finally {
    stopped = true;
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
  }
}
