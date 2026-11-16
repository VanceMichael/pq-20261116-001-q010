import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, standardItems, baseFeed, captureTime } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

test("rolls back capture, articles and feed watermark when a write fails mid-transaction", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.database.exec(`CREATE TRIGGER fail_capture_link BEFORE INSERT ON capture_items
    BEGIN SELECT RAISE(ABORT, 'simulated storage fault'); END;`);
  assert.throws(() => archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1)), /simulated storage fault/);
  assert.equal(archive.listCaptures("daily-main").length, 0);
  assert.equal(archive.articles.stats("daily-main").total, 0);
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, null);
  archive.database.exec("DROP TRIGGER fail_capture_link");
  const retried = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  assert.equal(retried.accepted, true);
  assert.equal(retried.stats.total, 4);
});

test("serializes concurrent identical HTTP submissions into one capture and one observation", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const endpoint = `http://127.0.0.1:${address.port}/v1/feeds/daily-main/snapshots`;
  const html = page(standardItems(8));
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(endpoint, { method: "POST", body: html })));
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(responses.filter((response) => response.status === 202).length, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 7);
  assert.equal(new Set(bodies.map((body) => body.captureId)).size, 1);
  assert.equal(archive.listCaptures("daily-main").length, 1);
  assert.equal(archive.articles.stats("daily-main").total, 8);
  assert.ok(archive.listItems("daily-main").items.every((item) => item.seenCount === 1));
});

test("does not partially update one article if a later normalized record cannot be persisted", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.database.exec(`CREATE TRIGGER fail_specific_article BEFORE INSERT ON articles
    WHEN NEW.canonical_url LIKE '%article-99.shtml'
    BEGIN SELECT RAISE(ABORT, 'simulated article write fault'); END;`);
  const changed = page([{ id: 1, title: "改名" }, { id: 2 }, { id: 3 }, { id: 99 }]);
  assert.throws(() => archive.importSnapshot("daily-main", changed, captureTime(2)), /simulated article write fault/);
  assert.equal(archive.listCaptures("daily-main").length, 1);
  assert.equal(archive.articles.stats("daily-main").total, 4);
  assert.equal(archive.articles.get("daily-main", "https://news.example.test/2026/11-16/article-1.shtml").title, "标题1");
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, captureTime(1));
});

test("keeps capture evidence for an accepted but repeated content sequence with a later capture time", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const content = page(standardItems(3));
  const first = archive.importSnapshot("daily-main", content, captureTime(1));
  const second = archive.importSnapshot("daily-main", `${content}\n<!-- recaptured -->`, captureTime(2));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(second.replay, false);
  assert.equal(archive.listCaptures("daily-main").length, 2);
  assert.ok(archive.listItems("daily-main").items.every((item) => item.seenCount === 2));
});

test("retains quiet articles in unfiltered archive pages instead of deleting them", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const current = page(standardItems(3, 2));
  for (const second of [2, 3, 4]) archive.importSnapshot("daily-main", `${current}<!--${second}-->`, captureTime(second));
  const allItems = archive.listItems("daily-main");
  assert.equal(allItems.items.length, 4);
  assert.equal(allItems.statistics.total, 4);
  assert.equal(allItems.statistics.quiet, 1);
  assert.equal(allItems.items.find((item) => item.visibility === "quiet").title, "标题1");
});

test("limits page sizes and offsets at repository boundary for stable bounded reads", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed({ ...baseFeed, minimumItems: 1 });
  archive.importSnapshot("daily-main", page(standardItems(12)), captureTime(1));
  const first = archive.listItems("daily-main", { limit: 500 });
  const second = archive.listItems("daily-main", { limit: 3, offset: 3 });
  assert.equal(first.items.length, 12);
  assert.equal(second.items.length, 3);
  assert.notEqual(first.items[0].articleId, second.items[0].articleId);
  assert.equal(archive.listItems("daily-main", { offset: -10 }).items.length, 12);
});
