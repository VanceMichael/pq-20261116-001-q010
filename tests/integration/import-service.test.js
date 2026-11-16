import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, standardItems, baseFeed, captureTime, fixtureHtml } from "../helpers.js";

test("registers feed policy and imports a rolling page into normalized archive records", async (t) => {
  const { archive } = await makeArchive(t);
  const registered = archive.registerFeed(baseFeed);
  assert.equal(registered.feedId, "daily-main");
  const result = archive.importSnapshot("daily-main", await fixtureHtml(), captureTime(1));
  assert.equal(result.accepted, true);
  assert.equal(result.candidateCount, 6);
  assert.equal(result.normalizedCount, 6);
  assert.deepEqual(result.stats, { total: 6, visible: 6, quiet: 0 });
  assert.equal(archive.feedStatus("daily-main").health, "healthy");
  const list = archive.listItems("daily-main", { visibility: "visible" });
  assert.equal(list.items.length, 6);
  assert.equal(list.items[0].canonicalUrl, "https://news.example.test/2026/11-16/story-1001.shtml");
  assert.equal(list.items[0].title, "城市公共交通服务调整");
});

test("makes identical page replay idempotent without increasing article observations", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const html = page(standardItems(4));
  const first = archive.importSnapshot("daily-main", html, captureTime(1));
  const replay = archive.importSnapshot("daily-main", html, captureTime(2));
  assert.equal(replay.replay, true);
  assert.equal(replay.captureId, first.captureId);
  assert.equal(replay.stats.total, 4);
  assert.equal(archive.listItems("daily-main").items[0].seenCount, 1);
  assert.equal(archive.listCaptures("daily-main").length, 1);
});

test("records an incomplete capture as degraded but preserves the last accepted item state", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const baseline = archive.importSnapshot("daily-main", page(standardItems(8)), captureTime(1));
  const rejected = archive.importSnapshot("daily-main", page(standardItems(2, 20)), captureTime(2));
  assert.equal(baseline.accepted, true);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /too_few_usable_items/);
  assert.deepEqual(rejected.stats, { total: 8, visible: 8, quiet: 0 });
  assert.equal(archive.feedStatus("daily-main").health, "degraded");
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, captureTime(1));
  assert.equal(archive.listCaptures("daily-main").length, 2);
});

test("uses several complete captures before quieting an omitted item", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const reducedWindow = page(standardItems(3, 2));
  archive.importSnapshot("daily-main", reducedWindow, captureTime(2));
  assert.equal(archive.articles.get("daily-main", "https://news.example.test/2026/11-16/article-1.shtml").visibility, "visible");
  archive.importSnapshot("daily-main", `${reducedWindow}\n<!-- recaptured -->`, captureTime(3));
  const third = page([{ id: 2 }, { id: 3, title: "更新标题" }, { id: 4 }]);
  archive.importSnapshot("daily-main", third, captureTime(4));
  const quiet = archive.articles.get("daily-main", "https://news.example.test/2026/11-16/article-1.shtml");
  assert.equal(quiet.visibility, "quiet");
  assert.equal(quiet.missingStreak, 3);
  assert.equal(archive.listItems("daily-main", { visibility: "visible" }).items.length, 3);
  assert.equal(archive.listItems("daily-main", { visibility: "quiet" }).items.length, 1);
});

test("restores a quiet article when a later accepted capture includes it again", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const withoutFirst = page(standardItems(3, 2));
  for (const second of [2, 3, 4]) archive.importSnapshot("daily-main", withoutFirst + `<!-- ${second} -->`, captureTime(second));
  const before = archive.articles.get("daily-main", "https://news.example.test/2026/11-16/article-1.shtml");
  assert.equal(before.visibility, "quiet");
  const restored = archive.importSnapshot("daily-main", `${page(standardItems(4))}\n<!-- restored -->`, captureTime(5));
  assert.equal(restored.accepted, true);
  const after = archive.articles.get("daily-main", "https://news.example.test/2026/11-16/article-1.shtml");
  assert.equal(after.visibility, "visible");
  assert.equal(after.missingStreak, 0);
  assert.equal(after.seenCount, 2);
});

test("rejects out-of-order captures without rewinding visibility or feed watermark", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(5));
  const delayed = archive.importSnapshot("daily-main", page(standardItems(4, 10)), captureTime(4));
  assert.equal(delayed.accepted, false);
  assert.equal(delayed.reason, "stale_capture_timestamp");
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, captureTime(5));
  assert.equal(archive.listItems("daily-main").items.length, 4);
});

test("rejects malformed input before creating any capture record", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  assert.throws(() => archive.importSnapshot("daily-main", "<html>", "bad-date"), /valid date-time/);
  assert.equal(archive.listCaptures("daily-main").length, 0);
  assert.throws(() => archive.importSnapshot("missing-feed", "<html>"), /unknown feed/);
});

test("keeps accepted capture history separate from article current visibility", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  archive.importSnapshot("daily-main", page(standardItems(2, 10)), captureTime(2));
  const runs = archive.listCaptures("daily-main", 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].accepted, false);
  assert.equal(archive.listItems("daily-main").statistics.visible, 3);
});

test("records normalized duplicate counts but only stores one canonical article", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const duplicatePage = page([
    { id: 1, url: "/2026/item.shtml?utm_source=first", title: "同一稿件" },
    { id: 2, url: "/2026/item.shtml?utm_source=second", title: "同一稿件" },
    { id: 3 }, { id: 4 }
  ]);
  const result = archive.importSnapshot("daily-main", duplicatePage, captureTime(1));
  assert.equal(result.candidateCount, 4);
  assert.equal(result.normalizedCount, 3);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.stats.total, 3);
});

test("reports unknown feeds without silently creating them during reads", async (t) => {
  const { archive } = await makeArchive(t);
  assert.equal(archive.feedStatus("absent"), null);
  assert.equal(archive.listItems("absent"), null);
  assert.equal(archive.listCaptures("absent"), null);
  assert.deepEqual(archive.feeds.all(), []);
});
