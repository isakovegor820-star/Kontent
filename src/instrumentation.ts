import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // Admin alerts live in the web process on purpose: it is the runtime that keeps
    // serving when Redis or the BullMQ worker is down and therefore can report it.
    const { startAdminAlertsScheduler } = await import("./lib/admin-alerts-scheduler");
    startAdminAlertsScheduler();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
