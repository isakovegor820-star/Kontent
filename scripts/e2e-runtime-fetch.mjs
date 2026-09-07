/** The disposable runtime may reach only local services and explicit fake boundaries. */
export function createE2eRuntimeFetch(fakeBase, upstreamFetch) {
  const fixture = new URL(fakeBase);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(fixture.hostname)) throw new Error("loopback fake provider required");
  const forward = (target, input, init) => input instanceof Request
    ? upstreamFetch(new Request(target, input), init)
    : upstreamFetch(target, init);
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.vk.com" && url.pathname.startsWith("/method/")) {
      return forward(new URL(`/vk${url.pathname}${url.search}`, fixture), input, init);
    }
    if (url.origin === "https://api.resend.com" && url.pathname === "/emails") {
      return forward(new URL("/resend/emails", fixture), input, init);
    }
    if (url.origin === "https://api.telegram.org") {
      if (!url.pathname.startsWith("/bot9000000000:e2e-fake-token-not-live/")) throw new Error("E2E Telegram fixture credential mismatch");
      return forward(new URL(url.pathname + url.search, fixture), input, init);
    }
    if (url.origin === "https://t.me" && /^\/(?:s\/)?(?:qa_competitor_[ab]|aurora_legal_qa|aurora_isolated_b|aurora_critical_qa)(?:\/\d+)?$/u.test(url.pathname)) {
      return forward(new URL("/telegram-public-fixture" + url.pathname + url.search, fixture), input, init);
    }
    if (["search.brave.com", "search.yahoo.com", "www.bing.com", "html.duckduckgo.com"].includes(url.hostname)) {
      return forward(new URL("/discovery-empty?format=" + (url.searchParams.get("format") === "rss" ? "rss" : "html"), fixture), input, init);
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol !== "data:") {
      throw new Error("E2E external fetch blocked: " + url.hostname);
    }
    return upstreamFetch(input, init);
  };
}
