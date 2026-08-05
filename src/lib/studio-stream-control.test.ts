import { describe, expect, it } from "vitest";
import {
  abortStudioStream,
  beginStudioStream,
  clearStudioStream,
  ownsStudioStream,
  type StudioStreamBox,
} from "./studio-stream-control";

describe("Studio stream ownership", () => {
  it("does not let request A clear request B after stop/start overlap", () => {
    const box: StudioStreamBox = { current: null };
    const requestA = beginStudioStream(box);
    expect(abortStudioStream(box)).toBe(requestA);
    const requestB = beginStudioStream(box);

    expect(ownsStudioStream(box, requestA)).toBe(false);
    expect(ownsStudioStream(box, requestB)).toBe(true);
    expect(clearStudioStream(box, requestA)).toBe(false);
    expect(box.current).toBe(requestB);
    expect(requestB.controller.signal.aborted).toBe(false);
    expect(clearStudioStream(box, requestB)).toBe(true);
    expect(box.current).toBeNull();
  });
});
