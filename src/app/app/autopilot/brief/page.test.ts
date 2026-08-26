import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("autopilot brief navigation", () => {
  it("renders the back action as one link-sized control instead of nesting a button", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/app/autopilot/brief/page.tsx"), "utf8");

    expect(source).toContain('href="/app/autopilot" className={buttonClassName');
    expect(source).not.toContain('<Link href="/app/autopilot">\n          <Button');
  });
});
