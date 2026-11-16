import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed, captureTime, page, standardItems } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

test("returns an article's accepted capture observations in newest-first order", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.importSnapshot("daily-main", page(standardItems(4, 2)), captureTime(2));
  archive.importSnapshot("daily-main", `${page(standardItems(4, 2))}\n<!-- refresh -->`, captureTime(3));
  const article = archive.listItems("daily-main").items.find((item) => item.canonicalUrl.endsWith("article-2.shtml"));
  const history = archive.articleTimeline("daily-main", article.articleId);
  assert.equal(history.observationCount, 3);
  assert.equal(history.mostRecentlyObservedAt, captureTime(3));
  assert.equal(history.firstObservedAt, captureTime(1));
  assert.deepEqual(history.observations.map((entry) => entry.sourceIndex), [0, 0, 1]);
  assert.equal(history.observations[1].untilNextObservationSeconds, 1);
});

test("does not include rejected captures in article presence history", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const article = archive.listItems("daily-main").items[0];
  archive.importSnapshot("daily-main", page(standardItems(2, 10)), captureTime(2));
  const history = archive.articleTimeline("daily-main", article.articleId);
  assert.equal(history.observationCount, 1);
  assert.equal(history.observations[0].captureId, 1);
});

test("bounds timeline result size and reports no observations for an archived item only after seen", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const article = archive.listItems("daily-main").items[0];
  const empty = archive.articleTimeline("daily-main", article.articleId, 0);
  assert.equal(empty.observationCount, 1);
  assert.equal(archive.articleTimeline("daily-main", 999), null);
  assert.equal(archive.articleTimeline("unknown", article.articleId), null);
});

test("serves article observation history at the API boundary", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const article = archive.listItems("daily-main").items[0];
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main/items/${article.articleId}/history`;
  const response = await fetch(root);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).observationCount, 1);
  const absent = await fetch(`http://127.0.0.1:${address.port}/v1/feeds/daily-main/items/999/history`);
  assert.equal(absent.status, 404);
});
