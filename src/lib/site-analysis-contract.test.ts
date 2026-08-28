import { describe, expect, it } from "vitest";

import { siteAnalysisErrorMessage, siteAnalysisErrorRetryable } from "./site-analysis-contract";

describe("site analysis public failure contract", () => {
  it("explains safe DNS, connection and TLS failures", () => {
    expect(siteAnalysisErrorMessage("ENOTFOUND")).toContain("DNS");
    expect(siteAnalysisErrorMessage("ECONNREFUSED")).toContain("отклонил");
    expect(siteAnalysisErrorMessage("tls_invalid")).toContain("TLS-сертификат");
  });

  it("offers retry only for transient failures", () => {
    expect(siteAnalysisErrorRetryable("ECONNRESET")).toBe(true);
    expect(siteAnalysisErrorRetryable("provider_timeout")).toBe(true);
    expect(siteAnalysisErrorRetryable("robots_denied")).toBe(false);
    expect(siteAnalysisErrorRetryable("private_address")).toBe(false);
    expect(siteAnalysisErrorRetryable("tls_invalid")).toBe(false);
  });
});
