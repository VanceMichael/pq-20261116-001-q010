import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NewsArchive } from "../src/service/archive.js";

export const fixturePath = fileURLToPath(new URL("../fixtures/rolling-feed.html", import.meta.url));

export async function makeArchive(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-test-"));
  const filename = join(directory, "archive.sqlite");
  const archive = new NewsArchive(filename, options);
  t.after(() => {
    archive.close();
    return rm(directory, { recursive: true, force: true });
  });
  return { archive, directory, filename };
}

export async function fixtureHtml() {
  return readFile(fixturePath, "utf8");
}

export function page(items, { wrapper = "main", titlePrefix = "标题" } = {}) {
  const entries = items.map((item, index) => {
    const url = item.url ?? `/2026/11-16/article-${item.id}.shtml`;
    const title = item.title ?? `${titlePrefix}${item.id}`;
    const time = item.time ?? `2026-11-16T10:${String(index).padStart(2, "0")}:00+08:00`;
    return `<article><time datetime="${time}">${index}</time><a href="${url}">${title}</a></article>`;
  }).join("\n");
  return `<!doctype html><html><body><${wrapper} id="news-list">${entries}</${wrapper}></body></html>`;
}

export function standardItems(count = 4, start = 1) {
  return Array.from({ length: count }, (_, offset) => ({ id: start + offset }));
}

export const baseFeed = {
  feedId: "daily-main",
  baseUrl: "https://news.example.test/scroll-news/news1.html",
  allowedHosts: ["news.example.test"],
  minimumItems: 3,
  missingThreshold: 3
};

export function captureTime(second) {
  return `2026-11-16T02:00:${String(second).padStart(2, "0")}.000Z`;
}

// Deterministic, externally advanced clock for pause/back-off tests. Time only
// moves when a test advances it, so restart, probe-expiry and late-result
// scenarios are reproducible without real timers.
export class ManualClock {
  constructor(initial = "2026-11-16T02:00:00.000Z") {
    this.current = new Date(initial);
  }

  now() {
    return new Date(this.current.getTime());
  }

  advance(ms) {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }
}

// Short, deterministic pause budgets so tests never wait on real wall time.
export const fastPausePolicy = Object.freeze({
  rate_limited: { baseMs: 1_000, maxMs: 8_000, factor: 2, requiresManual: false },
  transient: { baseMs: 500, maxMs: 4_000, factor: 2, requiresManual: false },
  unavailable: { baseMs: 60_000, maxMs: 60_000, factor: 1, requiresManual: true }
});
