import { describe, expect, it } from "vitest";
import { hasTrackerSiteProof } from "./tracking-site-proof";
import { verifyTrackerInstalledScript } from "./tracking-service";

const proof = { challenge: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG", publicKey: "tracker_public_key_1234567890", appOrigin: "https://aurora.example" };
const tag = `<script src="https://aurora.example/api/tracking/client.js" data-project-key="${proof.publicKey}" data-aurora-verification="${proof.challenge}"></script>`;

describe("site proof in installed script", () => {
  it("accepts only the current project's complete script in parsed HEAD markup", () => {
    expect(hasTrackerSiteProof(`<html><head>${tag}</head><body></body></html>`, proof)).toBe(true);
    expect(hasTrackerSiteProof(tag.replaceAll('"', "'"), proof)).toBe(true);
    expect(hasTrackerSiteProof(tag.replace("<script", "<SCRIPT"), proof)).toBe(true);
  });
  it.each([
    `<!-- ${tag} -->`, `<template>${tag}</template>`, `<script type="application/json">${JSON.stringify(tag)}</script>`,
    `<body>${tag}</body>`, `<textarea>${tag}</textarea>`, `<noscript>${tag}</noscript>`,
    tag.replace(proof.challenge, "another-project"), tag.replace(proof.publicKey, "another_public_key_1234567890"),
    tag.replace("https://aurora.example", "https://fake.example"), tag.replace("<script", '<script type="application/json"'),
    tag.replace("<script", "<script nomodule"), tag.replace("data-aurora-verification", "data-example"),
  ])("rejects inert, incomplete or another project's markup: %s", (html) => {
    expect(hasTrackerSiteProof(html, proof)).toBe(false);
  });
  it("fetches a bounded HTML page through pinned public addresses", async () => {
    let requests = 0;
    await expect(verifyTrackerInstalledScript({
      ...proof, siteOrigin: "https://site.example", resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchPinned: async (input) => {
        expect(input.maxBytes).toBe(2 * 1024 * 1024);
        expect(input.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
        requests += 1;
        return requests === 1 ? { status: 302, location: "/home", body: "" } : { status: 200, location: null, body: tag };
      },
    })).resolves.toBe(true);
    expect(requests).toBe(2);
  });
  it("does not follow another origin or fetch a private address", async () => {
    const input = { ...proof, siteOrigin: "https://site.example", resolve: async () => [{ address: "93.184.216.34", family: 4 as const }], fetchPinned: async () => ({ status: 302, location: "http://127.0.0.1/private", body: "" }) };
    await expect(verifyTrackerInstalledScript(input)).rejects.toMatchObject({ code: "verification_redirect" });
    await expect(verifyTrackerInstalledScript({ ...input, resolve: async () => [{ address: "127.0.0.1", family: 4 }] })).rejects.toMatchObject({ code: "verification_unavailable" });
  });
});
