// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitAuroraProductEvent } from "@/lib/aurora-product-telemetry";
import { setClientProjectId } from "@/lib/project-fetch";
import { AuroraProductTelemetry } from "./aurora-product-telemetry";

vi.mock("next/navigation", () => ({ usePathname: () => "/fixture" }));

const send = vi.fn<typeof fetch>();
const eventA = "11111111-1111-4111-8111-111111111111";
const eventB = "22222222-2222-4222-8222-222222222222";

function emit(eventId: string) {
  expect(emitAuroraProductEvent({ eventId, sectionId: "composer", featureId: "draft",
    action: "saved", stage: "completed", outcome: "success", durationMs: null,
    errorCode: null, requestId: null, operationId: null, sessionId: null, safeContext: { source: "ui" },
  })).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  send.mockImplementation(async () => new Response('{"ok":true,"accepted":1}', {
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", send);
  setClientProjectId(101);
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  setClientProjectId(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("product telemetry project ownership", () => {
  it("does not attribute queued events to a subsequently selected project", async () => {
    render(createElement(AuroraProductTelemetry));
    emit(eventA);
    setClientProjectId(202);
    emit(eventB);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe("/api/product-events");
    expect(new Headers(init?.headers).get("x-aurora-project-id")).toBe("202");
    expect(JSON.parse(String(init?.body)).events.map((event: { eventId: string }) => event.eventId)).toEqual([eventB]);
  });

  it("does not flush the previous project's queue during teardown after a switch", async () => {
    const view = render(createElement(AuroraProductTelemetry));
    emit(eventA);
    setClientProjectId(202);
    await act(async () => { view.unmount(); });
    expect(send).not.toHaveBeenCalled();
  });

  it("still flushes the selected project's queue on its normal deadline", async () => {
    render(createElement(AuroraProductTelemetry));
    emit(eventA);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(send).toHaveBeenCalledTimes(1);
    const [, init] = send.mock.calls[0];
    expect(new Headers(init?.headers).get("x-aurora-project-id")).toBe("101");
    expect(JSON.parse(String(init?.body)).events[0].eventId).toBe(eventA);
    expect(init?.keepalive).toBe(true);
  });

  it("does not infer a later project for an event created without a selected project", async () => {
    setClientProjectId(null);
    render(createElement(AuroraProductTelemetry));
    emit(eventA);
    setClientProjectId(202);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(send).not.toHaveBeenCalled();
  });

  it("still flushes owned events during normal teardown", async () => {
    const view = render(createElement(AuroraProductTelemetry));
    emit(eventA);
    await act(async () => { view.unmount(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(new Headers(send.mock.calls[0][1]?.headers).get("x-aurora-project-id")).toBe("101");
  });
});
