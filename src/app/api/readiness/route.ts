import { createHash, timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { aiProviderHealthSnapshot } from "@/lib/ai-provider-health";
import {
  probeAiConfiguration,
  probeDatabaseAndSchema,
  probeMailDeliveryConfiguration,
  probeRedisAndPublicationWorker,
  probeTrackingSecretsConfiguration,
  probeUploadIngressConfiguration,
} from "@/lib/readiness-probes";
import { evaluateReadiness } from "@/lib/readiness";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function validOperatorBearer(req: NextRequest): boolean {
  const configured = String(process.env.AURORA_READINESS_TOKEN || "");
  const supplied = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1] || "";
  if (configured.length < 32 || supplied.length < 32) return false;
  return timingSafeEqual(
    createHash("sha256").update(configured, "utf8").digest(),
    createHash("sha256").update(supplied, "utf8").digest(),
  );
}

function capabilityReport(report: ReturnType<typeof evaluateReadiness>) {
  return {
    status: report.status,
    webReady: report.webReady,
    publicationReady: report.publicationReady,
    telegramBotReady: report.telegramBotReady,
    aiReady: report.aiReady,
    mailDeliveryReady: report.mailDeliveryReady,
    uploadReady: report.uploadReady,
    passwordRecoveryReady: report.passwordRecoveryReady,
    checkedAt: report.checkedAt,
  };
}

export async function GET(req: NextRequest) {
  let privileged = validOperatorBearer(req);
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  if (!privileged) {
    try {
      user = await getSessionUser(req);
    } catch {
      // Do not turn a database outage into an unauthenticated dependency oracle.
    }
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    privileged = hasAuroraAdminAccess(user);
  }

  const [database, queue] = await Promise.all([
    probeDatabaseAndSchema(),
    probeRedisAndPublicationWorker(),
  ]);
  const report = evaluateReadiness({
    database: database.database,
    schema: database.schema,
    redis: queue.redis,
    publicationWorker: queue.publicationWorker,
    telegramPolling: queue.telegramPolling,
    aiProviders: aiProviderHealthSnapshot(),
    aiConfigured: probeAiConfiguration(),
    mailDelivery: probeMailDeliveryConfiguration(),
    uploadIngress: probeUploadIngressConfiguration(),
    tokenEncryption: database.tokenEncryption,
    trackingSecrets: probeTrackingSecretsConfiguration(),
  });
  return NextResponse.json(privileged ? report : capabilityReport(report), {
    status: report.webReady ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
