import { basename } from "node:path";

/** Every complete journey retains evidence for all three independent contexts. */
export function assertE2eTraceSet(paths) {
  const expected = ["editor-safety-trace.zip", "main-trace.zip", "reviewer-trace.zip"];
  const actual = paths.map((path) => basename(path)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected main, reviewer and editor safety traces, found ${JSON.stringify(actual)}`);
  }
}
