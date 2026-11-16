import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks, pageFingerprint } from "../../src/feed/html.js";

test("extracts nested headline text and associated time without swallowing neighbors", () => {
  const html = `<main><article><time datetime="2026-11-16T08:30:00+08:00">08:30</time>
    <a href="/2026/11-16/a.shtml"><b>海边</b>城市&amp;交通</a></article>
    <article><a href="/2026/11-16/b.shtml">新展览</a></article></main>`;
  assert.deepEqual(extractLinks(html, "https://news.example.test/scroll-news/news1.html"), [
    { href: "https://news.example.test/2026/11-16/a.shtml", title: "海边城市&交通", publishedAt: "2026-11-16T08:30:00+08:00" },
    { href: "https://news.example.test/2026/11-16/b.shtml", title: "新展览", publishedAt: "2026-11-16T08:30:00+08:00" }
  ]);
});

test("handles quoted attributes in any order and decodes numeric entities", () => {
  const html = `<a data-kind='lead' title="hello" href='/news1075109.shtml?x=1&amp;y=2'>
    <span>&#x5317;&#20140;</span><em> updates</em></a>`;
  const [record] = extractLinks(html, "https://news.example.test/");
  assert.equal(record.href, "https://news.example.test/news1075109.shtml?x=1&y=2");
  assert.equal(record.title, "北京 updates");
  assert.equal(record.publishedAt, null);
});

test("ignores comments, script markup and links that are not articles", () => {
  const html = `<!-- <a href='/2026/comment.shtml'>comment</a> -->
    <script>const sample = "<a href='/2026/script.shtml'>fake</a>";</script>
    <a href="/about">About</a><a href="mailto:desk@example.test">Contact</a>
    <a href="/2026/11-16/good.shtml">Headline</a>`;
  assert.deepEqual(extractLinks(html, "https://news.example.test/"), [
    { href: "https://news.example.test/2026/11-16/good.shtml", title: "Headline", publishedAt: null }
  ]);
});

test("keeps article identity candidates in source order even when markup closes loosely", () => {
  const html = `<div><a href='/2026/one.shtml'> First <br> item
    <a href='/2026/two.shtml'>second</a></div>`;
  const records = extractLinks(html, "https://news.example.test/");
  assert.equal(records.length, 1);
  assert.equal(records[0].href, "https://news.example.test/2026/two.shtml");
  assert.equal(records[0].title, "second");
});

test("rejects empty, non-text and oversized captures before parsing", () => {
  assert.throws(() => extractLinks("", "https://news.example.test/"), /non-empty/);
  assert.throws(() => extractLinks(null, "https://news.example.test/"), /non-empty/);
  assert.throws(() => extractLinks("x".repeat(5_000_001), "https://news.example.test/"), /5 MB/);
});

test("fingerprint is deterministic and changes with exact page bytes", () => {
  assert.equal(pageFingerprint("<main>新闻</main>"), pageFingerprint("<main>新闻</main>"));
  assert.notEqual(pageFingerprint("<main>新闻</main>"), pageFingerprint("<main>新闻</main>\n"));
  assert.match(pageFingerprint("capture"), /^[a-f0-9]{64}$/);
});

test("does not treat markup attributes as text or include hidden tag bodies", () => {
  const records = extractLinks(`<a href="/2026/safe.shtml" onclick="track()">安全
    <style>.hidden { display:none }</style><script>not a title</script></a>`, "https://news.example.test/");
  assert.equal(records[0].title, "安全");
});

test("keeps entities that are unknown to the small decoder visible", () => {
  const [record] = extractLinks(`<a href='/2026/story.shtml'>A &unknown; B</a>`, "https://news.example.test/");
  assert.equal(record.title, "A &unknown; B");
});

test("accepts the source listing convention for numeric news article identifiers", () => {
  const [record] = extractLinks(`<a href='/2026/11-16/news1075109.shtml'>深圳观察</a>`, "https://news.example.test/");
  assert.equal(record.title, "深圳观察");
});
