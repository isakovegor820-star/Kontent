import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyTrackerChallengeFile, verifyTrackerInstalledScript } from "@/lib/tracking-service";

const challenge = "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG";
const publicKey = "tracker_public_key_1234567890";
const tag = `<script src="https://aurora.example/api/tracking/client.js" data-project-key="${publicKey}" data-aurora-verification="${challenge}"></script>`;
let html = "";
let file = "";
let origin: string;
const requested: string[] = [];
const server = http.createServer((req, res) => {
  requested.push(req.url!);
  res.writeHead(200, { "content-type": req.url === "/" ? "text/html" : "text/plain" });
  res.end(req.url === "/" ? html : file);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

function input() { return { siteOrigin: origin, challenge, publicKey, appOrigin: "https://aurora.example", allowedLocalOrigins: new Set([origin]) }; }

describe("real HTTP verification (no mocked fetch)", () => {
  it("downloads the site HTML and confirms the installed script", async () => {
    html = `<html><head>${tag}</head><body>Test site</body></html>`;
    await expect(verifyTrackerInstalledScript(input())).resolves.toBe(true);
    expect(requested).toContain("/");
  });
  it("rejects another project and a script hidden in a comment", async () => {
    html = `<head>${tag.replace(challenge, "wrong-challenge")}</head>`;
    await expect(verifyTrackerInstalledScript(input())).rejects.toMatchObject({ code: "verification_script_missing" });
    html = `<head><!-- ${tag} --></head>`;
    await expect(verifyTrackerInstalledScript(input())).rejects.toMatchObject({ code: "verification_script_missing" });
  });
  it("keeps file verification working and requires exact downloaded bytes", async () => {
    file = challenge;
    await expect(verifyTrackerChallengeFile(input())).resolves.toBe(true);
    file = `${challenge}\n`;
    await expect(verifyTrackerChallengeFile(input())).rejects.toMatchObject({ code: "verification_content_mismatch" });
    expect(requested).toContain("/.well-known/aurora-tracker-verification.txt");
  });
  it("rejects oversized responses without hanging or unhandled stream errors", async () => {
    html = `${tag}${"x".repeat(2 * 1024 * 1024)}`;
    await expect(verifyTrackerInstalledScript(input())).rejects.toMatchObject({ code: "verification_unavailable" });
  });
});
