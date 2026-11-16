import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, standardItems, baseFeed } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

function cannedFetcher(result) {
  let calls = 0;
  return {
    async fetchFeed(feed) {
      calls += 1;
      if (typeof result === "function") return result(feed, calls);
      return { ...result, requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
    },
    count: () => calls
  };
}

test("fetches the configured feed, imports it and stores one linked fetch audit", async (t) => {
  let tick = 1;
  const html = page(standardItems(4));
  const fetcher = cannedFetcher({ status: 200, html });
  const { archive } = await makeArchive(t, { fetcher, clock: () => new Date(`2026-11-16T02:00:0${tick++}.000Z`) });
  archive.registerFeed(baseFeed);
  const result = await archive.refreshFeed("daily-main");
  assert.equal(result.outcome, "accepted");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.capture.accepted, true);
  assert.equal(result.capture.stats.total, 4);
  const attempts = archive.listFetchAttempts("daily-main");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, "accepted");
  assert.equal(attempts[0].captureId, result.capture.captureId);
  assert.equal(attempts[0].requestedUrl, baseFeed.baseUrl);
});

test("coalesces simultaneous refresh requests so only one remote fetch changes state", async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const fetcher = cannedFetcher(async (feed) => {
    await wait;
    return { status: 200, html: page(standardItems(5)), requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
  });
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const first = archive.refreshFeed("daily-main");
  const second = archive.refreshFeed("daily-main");
  assert.equal(archive.refreshes.pending("daily-main"), true);
  assert.equal(fetcher.count(), 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.attemptId, right.attemptId);
  assert.equal(fetcher.count(), 1);
  assert.equal(archive.listFetchAttempts("daily-main").length, 1);
});

test("records an upstream fetch failure before returning a failure to the caller", async (t) => {
  let calls = 0;
  const fetcher = cannedFetcher(() => {
    calls += 1;
    throw Object.assign(new Error("upstream timeout"), { code: "fetch_failed", attemptCount: 3 });
  });
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "fetch_failed", attemptCount: 3 });
  const [attempt] = archive.listFetchAttempts("daily-main");
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.errorCode, "fetch_failed");
  assert.equal(attempt.errorMessage, "upstream timeout");
  assert.equal(attempt.attemptCount, 3);
  assert.equal(archive.listCaptures("daily-main").length, 0);
});

test("records an upstream 304 as a no-change result without running the parser", async (t) => {
  const fetcher = cannedFetcher({ status: 304, html: null, attemptCount: 1 });
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const result = await archive.refreshFeed("daily-main");
  assert.equal(result.outcome, "not_modified");
  assert.equal(result.capture, null);
  assert.equal(archive.listFetchAttempts("daily-main")[0].httpStatus, 304);
  assert.equal(archive.listCaptures("daily-main").length, 0);
});

test("persists a source fetch whose page was captured but rejected by archive quality rules", async (t) => {
  const fetcher = cannedFetcher({ status: 200, html: page(standardItems(2)) });
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const result = await archive.refreshFeed("daily-main");
  assert.equal(result.outcome, "rejected");
  assert.equal(result.capture.accepted, false);
  const [attempt] = archive.listFetchAttempts("daily-main");
  assert.equal(attempt.outcome, "rejected");
  assert.equal(attempt.errorCode, "capture_rejected");
  assert.equal(attempt.captureId, result.capture.captureId);
});

test("exposes a refresh trigger and fetch failures through the service API", async (t) => {
  const fetcher = cannedFetcher(Object.assign(new Error("feed unavailable"), { code: "http_status", status: 503 }));
  fetcher.fetchFeed = async (feed) => {
    throw Object.assign(new Error("feed unavailable"), { code: "http_status", status: 503 });
  };
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main`;
  const refreshed = await fetch(`${root}/refresh`, { method: "POST" });
  assert.equal(refreshed.status, 502);
  assert.equal((await refreshed.json()).error, "internal_error");
  const listed = await fetch(`${root}/attempts`);
  const payload = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(payload.attempts[0].errorCode, "http_status");
});

test("feed attempt reads return null rather than an empty history for unknown feeds", async (t) => {
  const { archive } = await makeArchive(t);
  assert.equal(archive.listFetchAttempts("unknown"), null);
});
