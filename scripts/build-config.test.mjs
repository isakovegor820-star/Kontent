import { describe, expect, it } from "vitest";

import { buildNodeOptions, resolveBuildHeapMb } from "./build-config.mjs";

describe("production build memory configuration", () => {
  it("uses a bounded 4 GiB heap by default", () => {
    expect(resolveBuildHeapMb()).toBe(4_096);
    expect(resolveBuildHeapMb("2048")).toBe(2_048);
    expect(resolveBuildHeapMb("8192")).toBe(8_192);
    expect(() => resolveBuildHeapMb("1024")).toThrowError(
      "AURORA_BUILD_MAX_OLD_SPACE_SIZE_MB must be an integer between 2048 and 8192",
    );
    expect(() => resolveBuildHeapMb("unbounded")).toThrowError(
      "AURORA_BUILD_MAX_OLD_SPACE_SIZE_MB must be an integer between 2048 and 8192",
    );
  });

  it("preserves other Node options and replaces prior heap flags", () => {
    expect(buildNodeOptions("--trace-warnings --max-old-space-size=2048", 4096)).toBe(
      "--trace-warnings --max-old-space-size=4096",
    );
    expect(buildNodeOptions("--max_old_space_size 3072 --import=file:///tmp/e2e.mjs", 4096)).toBe(
      "--import=file:///tmp/e2e.mjs --max-old-space-size=4096",
    );
  });
});
