/** Restore/incident environments must not start any worker consumers. */
export function assertWorkerOutboundAllowed(env = process.env) {
  if (env.AURORA_OUTBOUND_DISABLED === "1") {
    throw Object.assign(new Error("worker_outbound_disabled: restore/incident hold is active; consumers were not started"), { code: "worker_outbound_disabled" });
  }
}
assertWorkerOutboundAllowed();
