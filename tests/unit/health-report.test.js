import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed } from "../helpers.js";

function fetchResult(feed, outcome, finishedAt, errorCode = null) {
  return {
    feedId: feed.feedId,
    startedAt: finishedAt,
    finishedAt,
    outcome,
    httpStatus: outcome === "failed" ? 503 : 200,
    attemptCount: 1,
    requestedUrl: feed.baseUrl,
    finalUrl: feed.baseUrl,
    captureId: null,
    errorCode,
    errorMessage: errorCode
  };
}

test("reports an untouched feed as awaiting capture with a first-action warning", async (t) => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  const { archive } = await makeArchive(t, { clock: () => now });
  archive.registerFeed(baseFeed);
  const health = archive.feedHealth("daily-main");
  assert.equal(health.status, "awaiting_capture");
  assert.equal(health.freshness, "unknown");
  assert.equal(health.successRate, null);
  assert.deepEqual(health.issues, [{ code: "no_recent_attempts", severity: "warning" }]);
});

test("calculates accepted attempt rate and fresh status using the injected clock", async (t) => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  const { archive } = await makeArchive(t, { clock: () => now });
  archive.registerFeed(baseFeed);
  for (const offset of [1, 2, 3, 4]) {
    const time = new Date(now.getTime() - offset * 60_000).toISOString();
    archive.fetches.record(fetchResult(baseFeed, "accepted", time));
  }
  archive.fetches.record(fetchResult(baseFeed, "not_modified", new Date(now.getTime() - 5000).toISOString()));
  const report = archive.feedHealth("daily-main");
  assert.equal(report.status, "healthy");
  assert.equal(report.freshness, "fresh");
  assert.equal(report.successRate, 0.8);
  assert.deepEqual(report.totals, { attempts: 5, accepted: 4, rejected: 0, failed: 0, notModified: 1 });
  assert.deepEqual(report.issues, []);
});

test("raises stale and failed-source issues when the latest success is old", async (t) => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  const { archive } = await makeArchive(t, { clock: () => now });
  archive.registerFeed(baseFeed);
  const older = new Date(now.getTime() - 9 * 60 * 60 * 1000).toISOString();
  archive.fetches.record(fetchResult(baseFeed, "accepted", older));
  archive.fetches.record(fetchResult(baseFeed, "failed", new Date(now.getTime() - 10_000).toISOString(), "timeout"));
  const report = archive.feedHealth("daily-main");
  assert.equal(report.status, "attention");
  assert.equal(report.freshness, "stale");
  assert.ok(report.issues.some((issue) => issue.code === "stale_source" && issue.severity === "critical"));
  assert.ok(report.issues.some((issue) => issue.code === "source_failures" && issue.count === 1));
});

test("warns on rejected snapshots even if an earlier accepted snapshot remains fresh", async (t) => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  const { archive } = await makeArchive(t, { clock: () => now });
  archive.registerFeed(baseFeed);
  const success = new Date(now.getTime() - 60_000).toISOString();
  archive.fetches.record(fetchResult(baseFeed, "accepted", success));
  archive.fetches.record(fetchResult(baseFeed, "rejected", new Date(now.getTime() - 30_000).toISOString(), "capture_rejected"));
  const report = archive.feedHealth("daily-main");
  assert.equal(report.freshness, "fresh");
  assert.ok(report.issues.some((issue) => issue.code === "capture_rejections"));
});

test("flags a repeated low acceptance rate while allowing a single transient failure", async (t) => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  const { archive } = await makeArchive(t, { clock: () => now });
  archive.registerFeed(baseFeed);
  for (const [index, outcome] of ["failed", "rejected", "failed", "accepted"].entries()) {
    const time = new Date(now.getTime() - (4 - index) * 1000).toISOString();
    archive.fetches.record(fetchResult(baseFeed, outcome, time));
  }
  const report = archive.feedHealth("daily-main");
  assert.equal(report.successRate, 0.25);
  assert.ok(report.issues.some((issue) => issue.code === "low_acceptance_rate" && issue.rate === 0.25));
});

test("ignores fetch attempts outside the current rolling health window", async (t) => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  const { archive } = await makeArchive(t, { clock: () => now });
  archive.registerFeed(baseFeed);
  const outside = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  archive.fetches.record(fetchResult(baseFeed, "accepted", outside));
  const report = archive.feedHealth("daily-main");
  assert.equal(report.status, "awaiting_capture");
  assert.equal(report.totals.attempts, 0);
  assert.equal(report.lastSuccessAt, null);
});

test("returns no health report for an unknown feed rather than creating one", async (t) => {
  const { archive } = await makeArchive(t);
  assert.equal(archive.feedHealth("unconfigured"), null);
});
