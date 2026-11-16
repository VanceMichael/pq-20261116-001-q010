import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, cleanTitle, normalizeCandidates } from "../../src/feed/normalize.js";

const baseUrl = "https://news.example.test/scroll-news/news1.html";

test("canonicalizes relative paths, tracking parameters and fragments", () => {
  const actual = canonicalizeUrl("../2026/11-16/a.shtml?utm_source=feed&id=4#headline", baseUrl, ["news.example.test"]);
  assert.equal(actual, "https://news.example.test/2026/11-16/a.shtml?id=4");
});

test("sorts retained parameters while preserving their values", () => {
  assert.equal(canonicalizeUrl("https://news.example.test/story.shtml?z=9&b=2&a=1", baseUrl),
    "https://news.example.test/story.shtml?a=1&b=2&z=9");
});

test("removes every tracking value without dropping editorial query fields", () => {
  const actual = canonicalizeUrl("/story.shtml?from=app&source=feed&ref=front&page=2", baseUrl);
  assert.equal(actual, "https://news.example.test/story.shtml?page=2");
});

test("rejects unsafe schemes, embedded credentials and hosts outside the feed policy", () => {
  assert.throws(() => canonicalizeUrl("javascript:alert(1)", baseUrl), /HTTP or HTTPS/);
  assert.throws(() => canonicalizeUrl("https://user:pass@news.example.test/a.shtml", baseUrl), /credentials/);
  assert.throws(() => canonicalizeUrl("https://unrelated.test/a.shtml", baseUrl, ["news.example.test"]), /not allowed/);
});

test("host suffix matching requires a DNS boundary", () => {
  assert.doesNotThrow(() => canonicalizeUrl("https://sub.news.example.test/a.shtml", baseUrl, ["news.example.test"]));
  assert.throws(() => canonicalizeUrl("https://evilnews.example.test/a.shtml", baseUrl, ["news.example.test"]), /not allowed/);
});

test("normalizes Unicode titles and collapses control whitespace", () => {
  assert.equal(cleanTitle("  A\n\t B  "), "A B");
  assert.equal(cleanTitle("e\u0301新闻"), "é新闻");
});

test("rejects titles that cannot identify a meaningful headline", () => {
  assert.throws(() => cleanTitle(" "), /2 to 500/);
  assert.throws(() => cleanTitle("x"), /2 to 500/);
  assert.throws(() => cleanTitle("x".repeat(501)), /2 to 500/);
  assert.throws(() => cleanTitle(null), /must be text/);
});

test("retains an unknown publication date without inventing a timestamp", () => {
  const normalized = normalizeCandidates([
    { href: "/2026/a.shtml", title: "有效新闻", publishedAt: "not a date" }
  ], { baseUrl });
  assert.equal(normalized.records[0].publishedAt, null);
});

test("collapses tracking variants into one article and keeps the earliest valid publication", () => {
  const result = normalizeCandidates([
    { href: "/story.shtml?utm_source=one", title: "旧标题", publishedAt: "2026-11-16T08:00:00+08:00" },
    { href: "/story.shtml?utm_source=two#top", title: "新标题", publishedAt: "2026-11-16T07:00:00+08:00" }
  ], { baseUrl });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].canonicalUrl, "https://news.example.test/story.shtml");
  assert.equal(result.records[0].publishedAt, "2026-11-15T23:00:00.000Z");
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.records[0].title, "旧标题");
});

test("reports bad host records separately so capture policy can reject a corrupted page", () => {
  const result = normalizeCandidates([
    { href: "/2026/good.shtml", title: "有效新闻" },
    { href: "https://bad.test/2026/bad.shtml", title: "外站新闻" },
    { href: "/2026/short.shtml", title: "x" }
  ], { baseUrl, allowedHosts: ["news.example.test"] });
  assert.equal(result.records.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /not allowed/);
});
