const CLIENT_STATES = new WeakMap();

function queryCommand(input) {
  const text = typeof input === "string"
    ? input
    : input && typeof input === "object" && typeof input.text === "string"
      ? input.text
      : "";
  const normalized = text.trimStart();
  if (/^(?:begin\b|start\s+transaction\b)/iu.test(normalized)) return "begin";
  if (/^(?:commit\b|end\b)/iu.test(normalized)) return "commit";
  if (/^rollback\b/iu.test(normalized)) return "rollback";
  return "query";
}

function finishOpenTransaction(state, outcome) {
  if (state.transactionStartedAt === null) return;
  state.monitor.recordTransaction(
    state.now() - state.transactionStartedAt,
    outcome,
  );
  state.transactionStartedAt = null;
}

function finishQuery(state, command, startedAt, error) {
  state.monitor.recordQuery(
    state.now() - startedAt,
    error,
    state.slowQueryThresholdMillis,
  );
  if (command === "begin") {
    if (!error && state.transactionStartedAt === null) {
      state.transactionStartedAt = startedAt;
      state.monitor.recordTransactionStarted();
    }
    return;
  }
  if (command === "commit") {
    finishOpenTransaction(state, error ? "failed" : "committed");
  } else if (command === "rollback") {
    finishOpenTransaction(state, error ? "failed" : "rolled_back");
  }
}

function observedQuery(client, originalQuery, state, args) {
  const command = queryCommand(args[0]);
  const startedAt = state.now();
  let finished = false;
  const complete = (error) => {
    if (finished) return;
    finished = true;
    finishQuery(state, command, startedAt, error);
  };
  const lastIndex = args.length - 1;
  const callback = typeof args[lastIndex] === "function" ? args[lastIndex] : null;
  if (callback) {
    args[lastIndex] = function monitoredQueryCallback(error, ...callbackArgs) {
      complete(error);
      return Reflect.apply(callback, this, [error, ...callbackArgs]);
    };
  }
  try {
    const result = Reflect.apply(originalQuery, client, args);
    if (callback) return result;
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          complete(undefined);
          return value;
        },
        (error) => {
          complete(error);
          throw error;
        },
      );
    }
    complete(undefined);
    return result;
  } catch (error) {
    complete(error);
    throw error;
  }
}

export function finalizeDatabaseClient(client) {
  const state = CLIENT_STATES.get(client);
  if (state) finishOpenTransaction(state, "abandoned");
}

function wrapRelease(client, state) {
  const currentRelease = client.release;
  if (typeof currentRelease !== "function" || currentRelease === state.releaseWrapper) return;
  const releaseWrapper = function monitoredClientRelease(...args) {
    finishOpenTransaction(state, "abandoned");
    return Reflect.apply(currentRelease, this, args);
  };
  state.releaseWrapper = releaseWrapper;
  client.release = releaseWrapper;
}

export function instrumentDatabaseClient(client, monitor, options = {}) {
  if (!client || typeof client.query !== "function") return client;
  let state = CLIENT_STATES.get(client);
  if (!state) {
    state = {
      monitor,
      now: options.now || (() => performance.now()),
      slowQueryThresholdMillis: options.slowQueryThresholdMillis,
      transactionStartedAt: null,
      releaseWrapper: null,
    };
    const originalQuery = client.query;
    client.query = function monitoredClientQuery(...args) {
      return observedQuery(this, originalQuery, state, args);
    };
    CLIENT_STATES.set(client, state);
  } else {
    state.monitor = monitor;
    state.now = options.now || state.now;
    state.slowQueryThresholdMillis = options.slowQueryThresholdMillis;
  }
  wrapRelease(client, state);
  return client;
}
