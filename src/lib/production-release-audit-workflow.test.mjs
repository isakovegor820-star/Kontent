import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(".github/workflows/production-release-audit.yml"),
  "utf8",
);

describe("production release audit workflow", () => {
  it("uses the protected pinned-identity SSH boundary", () => {
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("PRODUCTION_SSH_KNOWN_HOSTS");
    expect(workflow).toContain("PRODUCTION_SSH_HOST_FINGERPRINT");
    expect(workflow).toContain("scripts/verify-ssh-host-identity.sh");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("ssh-keyscan");
  });

  it("collects only current runtime and read-only ledger evidence", () => {
    expect(workflow).toContain("scripts/production-migration-ledger-audit.sql");
    expect(workflow).toContain("readlink -f /opt/aurora-current");
    expect(workflow).toContain("systemctl is-active aurora-web.service");
    expect(workflow).toContain("systemctl is-active aurora-worker.service");
    expect(workflow).toContain("http://127.0.0.1:3002/api/health");
    expect(workflow).toContain("psql \"$DATABASE_URL\" -X --no-psqlrc --set=ON_ERROR_STOP=1");
    expect(workflow).not.toMatch(/\b(?:migrate|restart|reload|rm\s+-|mv\s+|ln\s+-)\b/u);
  });
});
