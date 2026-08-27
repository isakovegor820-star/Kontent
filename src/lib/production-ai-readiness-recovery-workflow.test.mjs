import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(".github/workflows/production-ai-readiness-recovery.yml"),
  "utf8",
);

describe("production AI readiness recovery workflow", () => {
  it("recovers and verifies both production processes before readiness smoke", () => {
    const restart = workflow.indexOf(
      "systemctl restart aurora-worker.service aurora-web.service",
    );
    const verifyWorker = workflow.indexOf(
      "systemctl is-active --quiet aurora-worker.service",
      restart,
    );
    const verifyWeb = workflow.indexOf(
      "systemctl is-active --quiet aurora-web.service",
      restart,
    );
    const smoke = workflow.indexOf("npm run test:deployment-smoke");

    expect(restart).toBeGreaterThan(0);
    expect(verifyWorker).toBeGreaterThan(restart);
    expect(verifyWeb).toBeGreaterThan(verifyWorker);
    expect(smoke).toBeGreaterThan(verifyWeb);
    expect(workflow).toContain(
      "journalctl -u aurora-worker.service -u aurora-web.service",
    );
  });

  it("keeps the protected pinned-identity SSH boundary", () => {
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("PRODUCTION_SSH_KNOWN_HOSTS");
    expect(workflow).toContain("PRODUCTION_SSH_HOST_FINGERPRINT");
    expect(workflow).toContain("scripts/verify-ssh-host-identity.sh");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("ssh-keyscan");
  });
});
