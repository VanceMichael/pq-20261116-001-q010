import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed, captureTime, page, standardItems } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

test("compares two accepted captures and reports additions separately from omissions", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.importSnapshot("daily-main", page([{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]), captureTime(2));
  const report = archive.feedChanges("daily-main");
  assert.equal(report.ready, true);
  assert.deepEqual(report.counts, { added: 1, omitted: 1, current: 4, previous: 4 });
  assert.equal(report.added[0].canonicalUrl, "https://news.example.test/2026/11-16/article-5.shtml");
  assert.equal(report.omitted[0].canonicalUrl, "https://news.example.test/2026/11-16/article-1.shtml");
  assert.match(report.note, /not that the publisher deleted/);
});

test("does not let a rejected sparse capture replace the comparison baseline", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const rejected = archive.importSnapshot("daily-main", page(standardItems(2, 20)), captureTime(2));
  assert.equal(rejected.accepted, false);
  assert.equal(archive.feedChanges("daily-main").ready, false);
  archive.importSnapshot("daily-main", page(standardItems(4, 10)), captureTime(3));
  const report = archive.feedChanges("daily-main");
  assert.equal(report.ready, true);
  assert.equal(report.added.length, 4);
  assert.equal(report.omitted.length, 4);
  assert.equal(report.previousCapture.capturedAt, captureTime(1));
});

test("tracks the capture source order instead of sorting the diff by title", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([{ id: 1 }, { id: 2 }, { id: 3 }]), captureTime(1));
  archive.importSnapshot("daily-main", page([{ id: 9 }, { id: 2 }, { id: 3 }]), captureTime(2));
  const report = archive.feedChanges("daily-main");
  assert.equal(report.added[0].sourceIndex, 0);
  assert.equal(report.added[0].title, "标题9");
});

test("returns a clear not-ready report until two accepted pages exist", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const report = archive.feedChanges("daily-main");
  assert.equal(report.ready, false);
  assert.equal(report.latestCapture.normalizedCount, 3);
  assert.equal(report.previousCapture, null);
  assert.deepEqual(report.counts, { added: 0, omitted: 0, current: 3, previous: 0 });
});

test("serves the comparison through the API and distinguishes an unknown feed", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds`;
  const notReady = await fetch(`${root}/daily-main/changes`);
  assert.equal(notReady.status, 409);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  archive.importSnapshot("daily-main", page(standardItems(3, 10)), captureTime(2));
  const ready = await fetch(`${root}/daily-main/changes`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).added.length, 3);
  const missing = await fetch(`${root}/absent/changes`);
  assert.equal(missing.status, 404);
});
