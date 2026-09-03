export type AuroraReleaseMetadata = Readonly<{
  release: string | null;
  commitSha: string | null;
  deployedAt: string | null;
}>;

export function auroraReleaseMetadata(
  env?: Record<string, string | undefined>,
): AuroraReleaseMetadata;
