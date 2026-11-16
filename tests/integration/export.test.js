import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { makeArchive, baseFeed, captureTime, page, standardItems } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk.toString("utf8"));
  return chunks.join("");
}

test("exports a consistent CSV header and all current article fields", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const output = new PassThrough();
  const content = collect(output);
  const result = await archive.exportCsv("daily-main", output);
  output.end();
  const csv = await content;
  assert.equal(result.found, true);
  assert.equal(result.rows, 4);
  assert.equal(result.truncated, false);
  assert.match(csv.split("\r\n")[0], /^article_id,title,canonical_url,published_at,first_seen_at,last_seen_at,seen_count,visibility,review_state$/);
  assert.match(csv, /"标题1","https:\/\/news\.example\.test\/2026\/11-16\/article-1\.shtml"/);
  assert.match(csv, /,"visible","unreviewed"\r\n/);
});

test("quotes commas, quotes and line-safe user content in CSV cells", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([
    { id: 1, title: '标题, 带"引号"' }, { id: 2 }, { id: 3 }
  ]), captureTime(1));
  const output = new PassThrough();
  const content = collect(output);
  await archive.exportCsv("daily-main", output);
  output.end();
  assert.match(await content, /"标题, 带""引号"""/);
});

test("neutralizes spreadsheet formula prefixes in titles before quoting cells", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([
    { id: 1, title: "=HYPERLINK(\"https://bad.test\")" }, { id: 2 }, { id: 3 }
  ]), captureTime(1));
  const output = new PassThrough();
  const content = collect(output);
  await archive.exportCsv("daily-main", output);
  output.end();
  assert.match(await content, /"'=HYPERLINK\(""https:\/\/bad\.test""\)"/);
});

test("filters quiet records and reports when an explicit row cap truncates output", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(5)), captureTime(1));
  const output = new PassThrough();
  const content = collect(output);
  const result = await archive.exportCsv("daily-main", output, { visibility: "visible", limit: 2 });
  output.end();
  assert.equal(result.rows, 2);
  assert.equal(result.truncated, true);
  assert.equal((await content).split("\r\n").filter(Boolean).length, 3);
});

test("does not label an exactly sized complete export as truncated", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const output = new PassThrough();
  const content = collect(output);
  const result = await archive.exportCsv("daily-main", output, { limit: 3 });
  output.end();
  await content;
  assert.equal(result.truncated, false);
});

test("validates visibility, feed existence and export bounds before writing records", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const missingOutput = new PassThrough();
  assert.deepEqual(await archive.exportCsv("missing", missingOutput), { found: false, rows: 0 });
  await assert.rejects(archive.exportCsv("daily-main", new PassThrough(), { visibility: "gone" }), /visibility/);
  await assert.rejects(archive.exportCsv("daily-main", new PassThrough(), { limit: 0 }), /positive integer/);
});

test("serves a downloadable CSV and a normal not-found response for unknown feeds", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds`;
  const download = await fetch(`${root}/daily-main/items.csv`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type"), /text\/csv/);
  assert.match(download.headers.get("content-disposition"), /daily-main-items.csv/);
  assert.equal((await download.text()).split("\r\n").filter(Boolean).length, 4);
  const missing = await fetch(`${root}/unknown/items.csv`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "not_found");
});
