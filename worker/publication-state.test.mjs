import { describe, expect, it } from "vitest";
import { confirmedExternalId, publicationSuccessState } from "./publication-state.mjs";

describe("publicationSuccessState", () => {
  it("accepts a Telegram success only with a valid external message id", () => {
    expect(publicationSuccessState("tg", { ok: true, externalId: 42 })).toMatchObject({
      ok: true,
      externalMessageId: "42",
      verificationState: "verified",
    });
    expect(confirmedExternalId("tg", { ok: true })).toBeNull();
    expect(publicationSuccessState("tg", { ok: true })).toMatchObject({ ok: false });
  });

  it("keeps provider failures as failures", () => {
    expect(publicationSuccessState("tg", { ok: false, reason: "timeout" })).toEqual({
      ok: false,
      reason: "timeout",
    });
  });
});
