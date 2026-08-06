import { NextResponse } from "next/server";
import { aiProviderHealthSnapshot } from "@/lib/ai-provider-health";
import {
  probeAiConfiguration,
  probeDatabaseAndSchema,
  probeMailDeliveryConfiguration,
  probeRedisAndPublicationWorker,
  probeUploadIngressConfiguration,
} from "@/lib/readiness-probes";
import { evaluateReadiness } from "@/lib/readiness";

export const runtime = "nodejs";

export async function GET() {
  const [database, queue] = await Promise.all([
    probeDatabaseAndSchema(),
    probeRedisAndPublicationWorker(),
  ]);
  const report = evaluateReadiness({
    database: database.database,
    schema: database.schema,
    redis: queue.redis,
    publicationWorker: queue.publicationWorker,
    aiProviders: aiProviderHealthSnapshot(),
    aiConfigured: probeAiConfiguration(),
    mailDelivery: probeMailDeliveryConfiguration(),
    uploadIngress: probeUploadIngressConfiguration(),
    tokenEncryption: database.tokenEncryption,
  });
  return NextResponse.json(report, {
    status: report.webReady ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
