export type AuroraReleaseMetadata = Readonly<{
  release: string | null;
  commitSha: string | null;
  deployedAt: string | null;
}>;

const SAFE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_COMMIT = /^[0-9a-f]{7,64}$/u;

function releaseValue(value: string | undefined): string | null {
  const normalized = String(value || "").trim();
  return SAFE_RELEASE.test(normalized) ? normalized : null;
}

function commitValue(value: string | undefined): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  return SAFE_COMMIT.test(normalized) ? normalized : null;
}

function deployedAtValue(value: string | undefined): string | null {
  const normalized = String(value || "").trim();
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) return null;
  const iso = new Date(timestamp).toISOString();
  return iso === normalized ? iso : null;
}

/** Safe runtime release identity. It never exposes host, repository URL or environment. */
export function auroraReleaseMetadata(
  env: Record<string, string | undefined> = process.env,
): AuroraReleaseMetadata {
  const commitSha = commitValue(
    env.AURORA_RELEASE_SHA || env.AURORA_DEPLOY_SHA || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA,
  );
  return Object.freeze({
    release: releaseValue(env.AURORA_RELEASE) ?? commitSha,
    commitSha,
    deployedAt: deployedAtValue(env.AURORA_DEPLOYED_AT),
  });
}
