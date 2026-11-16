import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed, captureTime, page, standardItems } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

async function seeded(t) {
  const { archive } = await makeArchive(t, { clock: () => new Date("2026-11-16T02:00:10.000Z") });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const article = archive.listItems("daily-main").items.find((item) => item.canonicalUrl.endsWith("article-1.shtml"));
  return { archive, article };
}

test("records a reviewer decision and increments its revision atomically", async (t) => {
  const { archive, article } = await seeded(t);
  const result = archive.reviewArticle("daily-main", article.articleId, {
    state: "confirmed", note: "  已核对\n来源  ", expectedRevision: 0
  });
  assert.equal(result.status, 200);
  assert.equal(result.article.reviewState, "confirmed");
  assert.equal(result.article.reviewNote, "已核对 来源");
  assert.equal(result.article.reviewRevision, 1);
  const history = archive.reviewEvents("daily-main", article.articleId);
  assert.deepEqual(history.events.map((event) => [event.priorState, event.nextState, event.revision]), [
    ["unreviewed", "confirmed", 1]
  ]);
});

test("rejects stale revisions without overwriting the current review decision", async (t) => {
  const { archive, article } = await seeded(t);
  archive.reviewArticle("daily-main", article.articleId, { state: "confirmed", expectedRevision: 0 });
  const conflict = archive.reviewArticle("daily-main", article.articleId, { state: "withdrawn", expectedRevision: 0 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.current.reviewState, "confirmed");
  assert.equal(conflict.current.reviewRevision, 1);
  assert.equal(archive.reviewEvents("daily-main", article.articleId).events.length, 1);
});

test("uses a persistent event log for state transitions, including returning to unreviewed", async (t) => {
  const { archive, article } = await seeded(t);
  archive.reviewArticle("daily-main", article.articleId, { state: "confirmed", expectedRevision: 0 });
  archive.reviewArticle("daily-main", article.articleId, { state: "withdrawn", expectedRevision: 1, note: "页面已更正" });
  archive.reviewArticle("daily-main", article.articleId, { state: "unreviewed", expectedRevision: 2 });
  const history = archive.reviewEvents("daily-main", article.articleId).events;
  assert.deepEqual(history.map((event) => event.nextState), ["unreviewed", "withdrawn", "confirmed"]);
  assert.deepEqual(history.map((event) => event.revision), [3, 2, 1]);
  assert.equal(history[1].note, "页面已更正");
});

test("keeps manual review state separate from rolling-list visibility transitions", async (t) => {
  const { archive, article } = await seeded(t);
  archive.reviewArticle("daily-main", article.articleId, { state: "confirmed", expectedRevision: 0 });
  const smaller = page(standardItems(3, 2));
  for (const second of [2, 3, 4]) archive.importSnapshot("daily-main", `${smaller}<!-- ${second} -->`, captureTime(second));
  const reviewed = archive.reviewEvents("daily-main", article.articleId).article;
  assert.equal(reviewed.reviewState, "confirmed");
  assert.equal(reviewed.visibility, "quiet");
  assert.equal(reviewed.reviewRevision, 1);
});

test("validates review state, revision and note length before changing the database", async (t) => {
  const { archive, article } = await seeded(t);
  for (const input of [
    { state: "other", expectedRevision: 0 },
    { state: "confirmed", expectedRevision: -1 },
    { state: "confirmed", expectedRevision: 0.5 },
    { state: "confirmed", expectedRevision: 0, note: "x".repeat(1001) },
    { state: "confirmed", expectedRevision: 0, note: 44 }
  ]) {
    assert.throws(() => archive.reviewArticle("daily-main", article.articleId, input));
  }
  assert.equal(archive.reviewEvents("daily-main", article.articleId).events.length, 0);
});

test("returns meaningful missing-feed and missing-article outcomes", async (t) => {
  const { archive, article } = await seeded(t);
  assert.deepEqual(archive.reviewArticle("absent", article.articleId, { state: "confirmed", expectedRevision: 0 }), {
    status: 404, error: "feed_not_found"
  });
  assert.deepEqual(archive.reviewArticle("daily-main", 999, { state: "confirmed", expectedRevision: 0 }), {
    status: 404, error: "article_not_found"
  });
  assert.equal(archive.reviewEvents("daily-main", 999), null);
});

test("serves review changes and audit history through the HTTP contract", async (t) => {
  const { archive, article } = await seeded(t);
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${address.port}/v1/feeds/daily-main/items/${article.articleId}/review`;
  const changed = await fetch(url, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "withdrawn", expectedRevision: 0, note: "更正稿已发布" })
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).article.reviewState, "withdrawn");
  const history = await fetch(url);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).events.length, 1);
  const conflict = await fetch(url, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "confirmed", expectedRevision: 0 })
  });
  assert.equal(conflict.status, 409);
});

test("does not create review rows when JSON input is malformed", async (t) => {
  const { archive, article } = await seeded(t);
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/feeds/daily-main/items/${article.articleId}/review`, {
    method: "PATCH", body: "{not-json"
  });
  assert.equal(response.status, 400);
  assert.equal(archive.reviewEvents("daily-main", article.articleId).events.length, 0);
});
