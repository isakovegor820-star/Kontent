export function resolveBuildHeapMb(value) {
  const raw = String(value || "4096").trim();
  const heapMb = Number(raw);
  if (!Number.isSafeInteger(heapMb) || heapMb < 2_048 || heapMb > 8_192) {
    throw new Error("AURORA_BUILD_MAX_OLD_SPACE_SIZE_MB must be an integer between 2048 and 8192");
  }
  return heapMb;
}

export function buildNodeOptions(existing, heapMb) {
  const normalizedHeapMb = resolveBuildHeapMb(heapMb);
  const withoutHeapLimit = String(existing || "")
    .replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/giu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return [withoutHeapLimit, `--max-old-space-size=${normalizedHeapMb}`].filter(Boolean).join(" ");
}
