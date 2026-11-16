import test from "node:test";
import assert from "node:assert/strict";
import { PageFetcher, assertAllowed, readBoundedText } from "../../src/acquisition/page-fetcher.js";

const feed = { baseUrl: "https://news.example.test/list.html", allowedHosts: ["news.example.test"] };
const htmlResponse = (html, options = {}) => new Response(html, {
  status: options.status ?? 200,
  headers: { "content-type": "text/html; charset=utf-8", ...(options.headers ?? {}) }
});

test("fetches an allowlisted HTML page using a bounded request configuration", async () => {
  const requests = [];
  const fetcher = new PageFetcher({
    fetchImpl: async (url, options) => { requests.push({ url, options }); return htmlResponse("<main>saved</main>"); },
    now: () => Date.parse("2026-11-16T02:00:00Z")
  });
  const result = await fetcher.fetchFeed(feed);
  assert.equal(result.status, 200);
  assert.equal(result.html, "<main>saved</main>");
  assert.equal(result.requestedUrl, feed.baseUrl);
  assert.equal(result.finalUrl, feed.baseUrl);
  assert.equal(result.attemptCount, 1);
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.redirect, "manual");
  assert.match(requests[0].options.headers.accept, /text\/html/);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test("follows a relative redirect only while it stays within the feed host allowlist", async () => {
  const requested = [];
  const fetcher = new PageFetcher({
    fetchImpl: async (url) => {
      requested.push(url);
      return requested.length === 1
        ? new Response(null, { status: 302, headers: { location: "/latest.html" } })
        : htmlResponse("<main>latest</main>");
    }
  });
  const result = await fetcher.fetchFeed(feed);
  assert.equal(result.html, "<main>latest</main>");
  assert.equal(result.attemptCount, 2);
  assert.equal(result.finalUrl, "https://news.example.test/latest.html");
});

test("blocks redirects to hosts outside the configured feed policy before another request", async () => {
  let calls = 0;
  const fetcher = new PageFetcher({
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "https://attacker.test/" } }); }
  });
  await assert.rejects(fetcher.fetchFeed(feed), { code: "host_not_allowed" });
  assert.equal(calls, 1);
});

test("stops a repeated redirect loop and enforces the configured hop limit", async () => {
  const loop = new PageFetcher({
    fetchImpl: async (url) => new Response(null, { status: 302, headers: { location: url } })
  });
  await assert.rejects(loop.fetchFeed(feed), { code: "redirect_loop" });
  const tooMany = new PageFetcher({
    maxRedirects: 1,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/next.html" } })
  });
  await assert.rejects(tooMany.fetchFeed(feed), { code: "redirect_limit" });
});

test("retries transient service responses and honors a bounded Retry-After value", async () => {
  let calls = 0;
  const waits = [];
  const fetcher = new PageFetcher({
    fetchImpl: async () => ++calls === 1
      ? new Response("busy", { status: 503, headers: { "retry-after": "2" } })
      : htmlResponse("<main>recovered</main>"),
    sleep: async (duration) => waits.push(duration),
    backoffBaseMs: 10
  });
  const result = await fetcher.fetchFeed(feed);
  assert.equal(result.html, "<main>recovered</main>");
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(waits, [2000]);
});

test("uses exponential backoff when the server does not provide Retry-After", async () => {
  let calls = 0;
  const waits = [];
  const fetcher = new PageFetcher({
    fetchImpl: async () => ++calls < 3 ? new Response("busy", { status: 503 }) : htmlResponse("ready"),
    sleep: async (duration) => waits.push(duration),
    backoffBaseMs: 15
  });
  const result = await fetcher.fetchFeed(feed);
  assert.equal(result.attemptCount, 3);
  assert.deepEqual(waits, [15, 30]);
});

test("does not retry permanent HTTP errors and preserves status diagnostics", async () => {
  let calls = 0;
  const fetcher = new PageFetcher({ fetchImpl: async () => { calls += 1; return new Response("missing", { status: 404 }); } });
  await assert.rejects(fetcher.fetchFeed(feed), { code: "http_status", status: 404, attemptCount: 1 });
  assert.equal(calls, 1);
});

test("rejects non-HTML responses and bodies exceeding the configured cap", async () => {
  const nonHtml = new PageFetcher({ fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } }) });
  await assert.rejects(nonHtml.fetchFeed(feed), { code: "content_type" });
  const tooLarge = new PageFetcher({ maxBytes: 1024, fetchImpl: async () => htmlResponse("x".repeat(1025)) });
  await assert.rejects(tooLarge.fetchFeed(feed), { code: "response_too_large" });
});

test("uses streamed size checks when a source omits Content-Length", async () => {
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("a".repeat(600))); controller.close(); }
  }));
  await assert.rejects(readBoundedText(response, 512), { code: "response_too_large" });
});

test("validates source protocols, credentials, allowlist boundaries and local targets", () => {
  assert.doesNotThrow(() => assertAllowed(new URL(feed.baseUrl), feed.allowedHosts));
  assert.throws(() => assertAllowed(new URL("file:///etc/passwd"), feed.allowedHosts), { code: "unsafe_protocol" });
  assert.throws(() => assertAllowed(new URL("https://u:p@news.example.test/a"), feed.allowedHosts), { code: "unsafe_credentials" });
  assert.throws(() => assertAllowed(new URL("https://news.example.test.evil.test/a"), feed.allowedHosts), { code: "host_not_allowed" });
  assert.throws(() => assertAllowed(new URL("http://127.0.0.1/a"), ["127.0.0.1"]), { code: "unsafe_host" });
  assert.throws(() => assertAllowed(new URL("http://[::1]/a"), ["::1"]), { code: "unsafe_host" });
});

test("rejects invalid constructor budgets instead of silently disabling limits", () => {
  assert.throws(() => new PageFetcher({ timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => new PageFetcher({ maxBytes: 6_000_000 }), /maxBytes/);
  assert.throws(() => new PageFetcher({ maxRedirects: 11 }), /maxRedirects/);
  assert.throws(() => new PageFetcher({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => new PageFetcher({ backoffBaseMs: -1 }), /backoffBaseMs/);
});
