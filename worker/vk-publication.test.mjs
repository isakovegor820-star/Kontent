import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_OUTCOMES,
  publishVkWithRequest,
  reconcileVkWithRequest,
  vkProviderOperationIdentity,
} from "./vk-publication.mjs";

describe("VK ambiguous delivery", () => {
  it("uses a stable revision-scoped provider identity", () => {
    expect(vkProviderOperationIdentity({ postId: 9, revision: 2 })).toBe(
      vkProviderOperationIdentity({ postId: 9, revision: 2 }),
    );
    expect(vkProviderOperationIdentity({ postId: 9, revision: 3 })).not.toBe(
      vkProviderOperationIdentity({ postId: 9, revision: 2 }),
    );
  });

  it("accepts and drops a response without issuing a second wall.post", async () => {
    const external = [];
    const startedAt = new Date("2026-08-06T09:00:00.000Z");
    const request = vi.fn(async (method, params) => {
      if (method === "wall.post") {
        external.push({ id: 501, text: params.message, date: Math.floor(startedAt.getTime() / 1000) });
        throw Object.assign(new Error("socket reset after write"), { name: "TypeError" });
      }
      return { response: { items: external } };
    });
    const providerOperationId = vkProviderOperationIdentity({ postId: 12, revision: 1 });
    const published = await publishVkWithRequest({
      request,
      token: "test-token",
      groupId: 77,
      message: "Immutable text",
      providerOperationId,
    });
    expect(published).toMatchObject({
      ok: false,
      outcome: PROVIDER_OUTCOMES.DELIVERY_UNKNOWN,
      deliveryUnknown: true,
      providerOperationId,
    });
    expect(external).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wall.post")).toHaveLength(1);

    const reconciled = await reconcileVkWithRequest({
      request,
      token: "test-token",
      groupId: 77,
      message: "Immutable text",
      providerStartedAt: startedAt,
    });
    expect(reconciled).toEqual({ outcome: PROVIDER_OUTCOMES.SUCCESS, state: "confirmed", postId: 501 });
    expect(request.mock.calls.filter(([method]) => method === "wall.post")).toHaveLength(1);
  });

  it("classifies rate limit and auth failures without exposing the token", async () => {
    await expect(publishVkWithRequest({
      request: async () => ({ error: { error_code: 6, error_msg: "too many" } }),
      token: "secret",
      groupId: 1,
      message: "text",
      providerOperationId: "stable",
    })).resolves.toMatchObject({ outcome: PROVIDER_OUTCOMES.RATE_LIMITED, code: "vk_rate_limited_6" });
    await expect(publishVkWithRequest({
      request: async () => ({ error: { error_code: 5, error_msg: "denied" } }),
      token: "secret",
      groupId: 1,
      message: "text",
      providerOperationId: "stable",
    })).resolves.toMatchObject({ outcome: PROVIDER_OUTCOMES.AUTH_FAILED, code: "vk_auth_5" });
  });
});
