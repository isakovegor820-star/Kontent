import { describe, expect, it } from "vitest";
import {
  competitorPostUrl,
  competitorProfileUrl,
  handleErrorText,
  isCompetitorNetwork,
  parseCompetitorSource,
  parseHandle,
  parseInstagramHandle,
  sourceErrorText,
} from "./competitors";

describe("competitor source parsing", () => {
  it("parses public Telegram links", () => {
    expect(parseHandle("https://t.me/s/Durov?before=4")).toEqual({ handle: "durov" });
    expect(parseCompetitorSource("tg", "@durov")).toEqual({ handle: "durov" });
  });

  it("rejects private Telegram links", () => {
    expect(parseHandle("https://t.me/+private-token")).toEqual({ error: "private" });
  });

  it("parses Instagram profile links and account names", () => {
    expect(parseInstagramHandle("https://www.instagram.com/NASA/?hl=en")).toEqual({ handle: "nasa" });
    expect(parseInstagramHandle("@open_ai")).toEqual({ handle: "open_ai" });
    expect(parseCompetitorSource("instagram", "instagram.com/nat.geo")).toEqual({ handle: "nat.geo" });
  });

  it("rejects Instagram content links and malformed usernames", () => {
    expect(parseInstagramHandle("https://instagram.com/p/ABC123")).toEqual({ error: "bad" });
    expect(parseInstagramHandle("bad..name")).toEqual({ error: "bad" });
  });

  it("builds safe provider links", () => {
    expect(competitorProfileUrl("instagram", "nasa")).toBe("https://www.instagram.com/nasa/");
    expect(competitorPostUrl("tg", "durov", 42)).toBe("https://t.me/durov/42");
    expect(competitorPostUrl("instagram", "nasa", "ignored", "https://www.instagram.com/p/ABC/")).toBe(
      "https://www.instagram.com/p/ABC/",
    );
  });

  it("recognizes only implemented networks and returns specific guidance", () => {
    expect(isCompetitorNetwork("instagram")).toBe(true);
    expect(isCompetitorNetwork("youtube")).toBe(false);
    expect(sourceErrorText("instagram", "empty")).toContain("Instagram");
    expect(sourceErrorText("tg", "private")).toBe(handleErrorText("private"));
  });
});
