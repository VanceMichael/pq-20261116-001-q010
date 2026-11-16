import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, standardItems, baseFeed, captureTime } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

async function start(t, archive) {
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());
  return { app, base };
}

test("health route exposes service readiness without creating feed state", async (t) => {
  const { archive } = await makeArchive(t);
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "rolling-news-archive" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(archive.feeds.all(), []);
});

test("creates a feed, accepts a saved page and serves its article records", async (t) => {
  const { archive } = await makeArchive(t);
  const { base } = await start(t, archive);
  const created = await fetch(`${base}/v1/feeds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...baseFeed })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).feed.feedId, "daily-main");
  const savedPage = page(standardItems(4));
  const imported = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "text/html", "X-Captured-At": captureTime(1) },
    body: savedPage
  });
  assert.equal(imported.status, 202);
  const receipt = await imported.json();
  assert.equal(receipt.accepted, true);
  assert.match(imported.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  const listed = await fetch(`${base}/v1/feeds/daily-main/items?visibility=visible&limit=2`);
  assert.equal(listed.status, 200);
  const result = await listed.json();
  assert.equal(result.items.length, 2);
  assert.equal(result.statistics.total, 4);
  const status = await fetch(`${base}/v1/feeds/daily-main`);
  assert.equal((await status.json()).health, "healthy");
});

test("returns an idempotent success status for the same captured HTML", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const { base } = await start(t, archive);
  const html = page(standardItems(3));
  const post = () => fetch(`${base}/v1/feeds/daily-main/snapshots`, { method: "POST", body: html });
  assert.equal((await post()).status, 202);
  const replay = await post();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
});

test("exposes a rejected partial snapshot without changing visible archive content", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(6)), captureTime(1));
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST", body: page(standardItems(2, 20)), headers: { "X-Captured-At": captureTime(2) }
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).reason, /too_few/);
  const items = await (await fetch(`${base}/v1/feeds/daily-main/items?visibility=visible`)).json();
  assert.equal(items.items.length, 6);
});

test("validates feed ids, visibility filters and missing routes as structured errors", async (t) => {
  const { archive } = await makeArchive(t);
  const { base } = await start(t, archive);
  const invalid = await fetch(`${base}/v1/feeds/bad%2Fid`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "invalid_request");
  const unknown = await fetch(`${base}/v1/feeds/not-registered`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "not_found");
  const unknownFilter = await fetch(`${base}/v1/feeds/not-registered/items?visibility=archived`);
  assert.equal(unknownFilter.status, 400);
  const unsupported = await fetch(`${base}/v1/feeds`);
  assert.equal(unsupported.status, 404);
});

test("returns recent run summaries with a bounded limit", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  archive.importSnapshot("daily-main", page(standardItems(2, 10)), captureTime(2));
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/daily-main/runs?limit=1`);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].accepted, false);
});

test("accepts repeated feed registration only when a valid complete policy is provided", async (t) => {
  const { archive } = await makeArchive(t);
  const { base } = await start(t, archive);
  const create = (value) => fetch(`${base}/v1/feeds`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value)
  });
  assert.equal((await create(baseFeed)).status, 201);
  const invalid = await create({ ...baseFeed, missingThreshold: 1 });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).message, /missingThreshold/);
  const validUpdate = await create({ ...baseFeed, minimumItems: 4 });
  assert.equal(validUpdate.status, 201);
  assert.equal(archive.feedStatus("daily-main").minimumItems, 4);
});

test("rejects future capture times at the request boundary", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const { base } = await start(t, archive);
  const response = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST", body: page(standardItems(3)), headers: { "X-Captured-At": "2099-01-01T00:00:00Z" }
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /future/);
  assert.equal(archive.listCaptures("daily-main").length, 0);
});
