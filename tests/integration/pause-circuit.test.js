import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NewsArchive } from "../../src/service/archive.js";
import { createHttpServer } from "../../src/http/server.js";
import { ManualClock, fastPausePolicy, page, standardItems, baseFeed } from "../helpers.js";
function httpFailure(status, message = `HTTP ${status}`, extra = {}) {
  return Object.assign(new Error(message), { code: "http_status", status, attemptCount: 1, ...extra });
}

function networkFailure() {
  return Object.assign(new Error("upstream timeout"), { code: "fetch_failed", attemptCount: 3 });
}

function goodFeed() {
  return { status: 200, html: page(standardItems(5)) };
}

async function openArchive(t, { clock, fetcher, probeTimeoutMs = 30_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "news-pause-"));
  const filename = join(directory, "archive.sqlite");
  const archive = new NewsArchive(filename, { clock, fetcher, pausePolicy: fastPausePolicy, probeTimeoutMs });
  archive.registerFeed(baseFeed);
  t.after(() => {
    archive.close();
    return rm(directory, { recursive: true, force: true });
  });
  return { archive, directory, filename };
}

test("rate limiting opens a pause with the retry hint reason and a visible next-attempt time", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    count: 0,
    async fetchFeed() {
      fetcher.count += 1;
      throw httpFailure(429, "rate limited", { retryAfterMs: 2_000 });
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });

  await assert.rejects(archive.refreshFeed("daily-main"), { status: 429 });
  assert.equal(fetcher.count, 1);

  const pause = archive.feedPause("daily-main");
  assert.equal(pause.paused, true);
  assert.equal(pause.state, "paused");
  assert.equal(pause.failureKind, "rate_limited");
  assert.equal(pause.reasonCode, "http_status");
  assert.equal(pause.httpStatus, 429);
  assert.equal(pause.failureCount, 1);
  assert.equal(pause.requiresManualResume, false);
  assert.equal(pause.nextAttemptAt, new Date(clock.now().getTime() + 2_000).toISOString());

  // Before the window elapses, refreshes are skipped without any network call.
  clock.advance(1_999);
  const skipped = await archive.refreshFeed("daily-main");
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.skipReason, "pause_active");
  assert.equal(fetcher.count, 1);
  assert.equal(skipped.pause.pauseId, pause.pauseId);

  const [attempt] = archive.listFetchAttempts("daily-main");
  assert.equal(attempt.outcome, "skipped");
  assert.equal(attempt.attemptCount, 0);
  assert.equal(attempt.errorCode, "paused:pause_active");
  assert.equal(attempt.pauseId, pause.pauseId);
});

test("transient service failures use escalating back-off and reopen with a single probe", async (t) => {
  const clock = new ManualClock();
  const script = [networkFailure(), networkFailure(), goodFeed()];
  const fetcher = {
    index: 0,
    calls: 0,
    async fetchFeed(feed) {
      fetcher.calls += 1;
      const step = script[fetcher.index++];
      if (step instanceof Error) throw step;
      return { ...step, requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });

  await assert.rejects(archive.refreshFeed("daily-main"), { code: "fetch_failed" });
  let pause = archive.feedPause("daily-main");
  assert.equal(pause.failureKind, "transient");
  const firstNext = pause.nextAttemptAt;
  assert.equal(Date.parse(firstNext) - clock.now().getTime(), 500);

  // Still within the first window: skip, no fetch.
  await assert.equal((await archive.refreshFeed("daily-main")).outcome, "skipped");
  assert.equal(fetcher.calls, 1);

  // Window elapses: exactly one probe is allowed and it fails again, escalating.
  clock.advance(500);
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "fetch_failed" });
  assert.equal(fetcher.calls, 2);
  pause = archive.feedPause("daily-main");
  assert.equal(pause.state, "paused");
  assert.equal(pause.failureCount, 2);
  assert.equal(Date.parse(pause.nextAttemptAt) - clock.now().getTime(), 1_000);

  // Second probe succeeds: the episode resolves and normal refresh resumes.
  clock.advance(1_000);
  const recovered = await archive.refreshFeed("daily-main");
  assert.equal(recovered.outcome, "accepted");
  assert.equal(fetcher.calls, 3);
  pause = archive.feedPause("daily-main");
  assert.equal(pause.paused, false);
  assert.equal(pause.state, "resolved");
  assert.equal(pause.resolution, "probe_succeeded");

  // A subsequent refresh is a normal, non-probe fetch.
  script.push(goodFeed());
  const again = await archive.refreshFeed("daily-main");
  assert.equal(again.outcome, "accepted");
  assert.equal(fetcher.calls, 4);
});

test("explicit unavailability requires a manual resume and stays paused at the deadline", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed() {
      fetcher.calls += 1;
      throw httpFailure(404, "not found");
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });

  await assert.rejects(archive.refreshFeed("daily-main"), { status: 404 });
  const pause = archive.feedPause("daily-main");
  assert.equal(pause.failureKind, "unavailable");
  assert.equal(pause.requiresManualResume, true);
  assert.equal(pause.state, "paused");
  assert.equal(pause.nextAttemptAt, null);

  // No matter how much time passes, the source is not retried automatically.
  clock.advance(120_000);
  const skipped = await archive.refreshFeed("daily-main");
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.skipReason, "manual_resume_required");
  assert.equal(skipped.retryAfterMs, null);
  assert.equal(fetcher.calls, 1);

  const health = archive.feedHealth("daily-main");
  assert.equal(health.status, "paused");
  const issue = health.issues.find((item) => item.code === "source_paused");
  assert.equal(issue.severity, "critical");
  assert.equal(issue.requiresManualResume, true);

  // Manual resume records who acted and against which outage episode.
  const resumed = archive.resumeFeed("daily-main", { operator: "ops:lin", note: "source migrated, verified" });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.pause.paused, false);
  assert.equal(resumed.pause.resolution, "manual_resume");
  assert.equal(resumed.pause.resumedBy, "ops:lin");
  assert.equal(resumed.pause.resumeNote, "source migrated, verified");
  assert.equal(resumed.event.actor, "ops:lin");
  assert.equal(resumed.event.eventType, "manual_resume");
});

test("a late failure from an older episode cannot re-close a manually recovered source", async (t) => {
  const clock = new ManualClock();
  let rejectFirst;
  const firstCall = new Promise((resolve, reject) => { rejectFirst = reject; });
  const fetcher = {
    index: 0,
    calls: 0,
    async fetchFeed(feed) {
      fetcher.calls += 1;
      if (fetcher.calls === 1) return firstCall;
      return { ...goodFeed(), requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher, probeTimeoutMs: 5_000 });

  // First refresh is in flight, then its failure returns and trips the pause.
  const pending = archive.refreshFeed("daily-main");
  assert.equal(fetcher.calls, 1);
  rejectFirst(httpFailure(503));
  await assert.rejects(pending, { status: 503 });
  const episodeBefore = archive.feedPause("daily-main");
  assert.equal(episodeBefore.paused, true);

  // Operator manually resumes while nothing is in flight.
  const resumed = archive.resumeFeed("daily-main", { operator: "ops:zhao" });
  assert.equal(resumed.status, 200);
  assert.equal(archive.feedPause("daily-main").paused, false);

  // Simulate a stale/late failure belonging to the old episode arriving after
  // the manual recovery. It must be fenced out and leave the source open.
  const staleOutcome = archive.pauseService.noteProbeFailure(
    { pauseId: episodeBefore.pauseId, feedId: "daily-main" },
    httpFailure(503),
    999
  );
  assert.equal(staleOutcome.stale, true);
  assert.equal(archive.feedPause("daily-main").paused, false);

  // The next real refresh fetches normally and succeeds.
  const ok = await archive.refreshFeed("daily-main");
  assert.equal(ok.outcome, "accepted");
  assert.equal(fetcher.calls, 2);
});

test("an in-flight probe failure landing after a manual resume is fenced end-to-end", async (t) => {
  const clock = new ManualClock();
  let rejectProbe;
  const fetcher = {
    calls: 0,
    async fetchFeed(feed) {
      fetcher.calls += 1;
      if (fetcher.calls === 1) throw httpFailure(503);
      if (fetcher.calls === 2) return new Promise((_, reject) => { rejectProbe = reject; });
      return { ...goodFeed(), requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher, probeTimeoutMs: 5_000 });

  // Trip the pause, then advance the window and launch the single recovery probe.
  await assert.rejects(archive.refreshFeed("daily-main"), { status: 503 });
  clock.advance(500);
  const probeInFlight = archive.refreshFeed("daily-main");
  assert.equal(archive.feedPause("daily-main").state, "probing");
  assert.equal(fetcher.calls, 2);

  // While that probe is still awaiting its response, the operator manually
  // recovers the source.
  const resumed = archive.resumeFeed("daily-main", { operator: "ops:late", note: "verified out of band" });
  assert.equal(resumed.status, 200);
  assert.equal(archive.feedPause("daily-main").paused, false);

  // The old probe's failure now returns late. It must not re-close the source.
  rejectProbe(httpFailure(503));
  let lateError;
  try {
    await probeInFlight;
  } catch (error) {
    lateError = error;
  }
  assert.equal(lateError.statusCode, 502);
  assert.equal(lateError.stalePauseResult, true);
  assert.equal(archive.feedPause("daily-main").paused, false);
  assert.equal(archive.feedPause("daily-main").resolution, "manual_resume");

  // The very next refresh goes out as a normal request and succeeds.
  const recovered = await archive.refreshFeed("daily-main");
  assert.equal(recovered.outcome, "accepted");
  assert.equal(fetcher.calls, 3);
});

test("two callers racing at pause expiry produce a single probe; the other is skipped", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed(feed) {
      fetcher.calls += 1;
      if (fetcher.calls === 1) throw httpFailure(503);
      return { ...goodFeed(), requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });
  await assert.rejects(archive.refreshFeed("daily-main"), { status: 503 });
  clock.advance(500);

  // Two admission decisions at the same expiry instant emulate two callers
  // (e.g. two processes sharing the database) racing for the single probe.
  const admissions = [archive.pauseService.admission("daily-main"), archive.pauseService.admission("daily-main")];
  const decisions = admissions.map((item) => item.decision);
  assert.ok(decisions.includes("claim"));
  assert.ok(decisions.includes("skip"));
  assert.equal(decisions.filter((d) => d === "claim").length, 1);
  assert.equal(fetcher.calls, 1);

  // While the probe is owned, further refreshes skip without fetching.
  const during = await archive.refreshFeed("daily-main");
  assert.equal(during.outcome, "skipped");
  assert.equal(during.skipReason, "probe_in_progress");
  assert.equal(during.retryAfterMs, 30_000);
  assert.equal(fetcher.calls, 1);

  // The winning probe completes successfully and clears the outage.
  const won = admissions.find((item) => item.decision === "claim");
  const result = await archive.refreshes.runProbe(archive.feeds.get("daily-main"), won.episode);
  assert.equal(result.outcome, "accepted");
  assert.equal(fetcher.calls, 2);
  assert.equal(archive.feedPause("daily-main").state, "resolved");
});

test("persists the pause across a restart and reuses the same next-attempt time", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed() {
      fetcher.calls += 1;
      throw httpFailure(503);
    }
  };
  const directory = await mkdtemp(join(tmpdir(), "news-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "archive.sqlite");

  const first = new NewsArchive(filename, { clock: () => clock.now(), fetcher, pausePolicy: fastPausePolicy });
  first.registerFeed(baseFeed);
  await assert.rejects(first.refreshFeed("daily-main"), { status: 503 });
  const before = first.feedPause("daily-main");
  first.close();

  // A brand-new process opens the same database: the outage is still active.
  const second = new NewsArchive(filename, { clock: () => clock.now(), fetcher, pausePolicy: fastPausePolicy });
  t.after(() => second.close());
  const after = second.feedPause("daily-main");
  assert.equal(after.pauseId, before.pauseId);
  assert.equal(after.paused, true);
  assert.equal(after.nextAttemptAt, before.nextAttemptAt);
  assert.equal(after.failureCount, 1);

  const skipped = await second.refreshFeed("daily-main");
  assert.equal(skipped.outcome, "skipped");
  assert.equal(fetcher.calls, 1);

  // After the back-off, the restarted process runs the single recovery probe.
  clock.advance(500);
  fetcher.fetchFeed = async (feed) => ({ ...goodFeed(), requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 });
  const recovered = await second.refreshFeed("daily-main");
  assert.equal(recovered.outcome, "accepted");
  assert.equal(second.feedPause("daily-main").resolution, "probe_succeeded");
});

test("a probe whose owner died is reclaimed once its deadline passes after restart", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed() {
      fetcher.calls += 1;
      if (fetcher.calls <= 1) throw httpFailure(503);
      return { ...goodFeed(), requestedUrl: "https://news.example.test/x", finalUrl: "https://news.example.test/x", attemptCount: 1 };
    }
  };
  const directory = await mkdtemp(join(tmpdir(), "news-reclaim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "archive.sqlite");

  const first = new NewsArchive(filename, {
    clock: () => clock.now(), fetcher, pausePolicy: fastPausePolicy, probeTimeoutMs: 5_000
  });
  first.registerFeed(baseFeed);
  await assert.rejects(first.refreshFeed("daily-main"), { status: 503 });
  clock.advance(500);
  // Claim a probe, then the process dies before recording any outcome.
  const claim = first.pauseService.admission("daily-main");
  assert.equal(claim.decision, "claim");
  assert.equal(first.feedPause("daily-main").state, "probing");
  first.close();

  // Before the probe deadline, a restart still sees the probe as in progress.
  clock.advance(4_999);
  let second = new NewsArchive(filename, {
    clock: () => clock.now(), fetcher, pausePolicy: fastPausePolicy, probeTimeoutMs: 5_000
  });
  t.after(() => second.close());
  let admission = second.pauseService.admission("daily-main");
  assert.equal(admission.decision, "skip");
  assert.equal(admission.reason, "probe_in_progress");

  // Once the deadline elapses the stale probe is reclaimed and a new one runs.
  clock.advance(1);
  admission = second.pauseService.admission("daily-main");
  assert.equal(admission.decision, "claim");
  assert.equal(admission.reclaimed, true);
  const events = second.pauseEvents("daily-main", 10);
  assert.ok(events.some((event) => event.eventType === "probe_abandoned"));

  // The reclaimed probe succeeds in the restarted process and clears the outage.
  const recovered = await second.refreshes.runProbe(second.feeds.get("daily-main"), admission.episode);
  assert.equal(recovered.outcome, "accepted");
  assert.equal(second.feedPause("daily-main").resolution, "probe_succeeded");
});

test("skipped attempts are counted separately and never dilute the success rate", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed(feed) {
      fetcher.calls += 1;
      if (fetcher.calls === 1) throw httpFailure(503);
      return { ...goodFeed(), requestedUrl: feed.baseUrl, finalUrl: feed.baseUrl, attemptCount: 1 };
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });

  await assert.rejects(archive.refreshFeed("daily-main"), { status: 503 });
  // Two skips while paused (no requests sent).
  await archive.refreshFeed("daily-main");
  await archive.refreshFeed("daily-main");
  assert.equal(fetcher.calls, 1);

  let health = archive.feedHealth("daily-main");
  assert.equal(health.totals.attempts, 3);
  assert.equal(health.totals.failed, 1);
  assert.equal(health.totals.skipped, 2);
  // Only the one real (failed) attempt is in the denominator: rate is 0, not
  // diluted toward 0.33 by skips.
  assert.equal(health.successRate, 0);

  clock.advance(500);
  await archive.refreshFeed("daily-main");
  health = archive.feedHealth("daily-main");
  assert.equal(health.totals.skipped, 2);
  // One accepted out of two real network attempts; skips stay excluded.
  assert.equal(health.successRate, 0.5);
  assert.ok(health.issues.some((issue) => issue.code === "refresh_skips" && issue.count === 2));
});

test("non-trippable local policy errors do not pause the source", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed() {
      fetcher.calls += 1;
      throw Object.assign(new Error("host outside allowlist"), { code: "host_not_allowed" });
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "host_not_allowed" });
  assert.equal(archive.feedPause("daily-main"), null);
  // The very next refresh is allowed to make a real request again.
  await assert.rejects(archive.refreshFeed("daily-main"), { code: "host_not_allowed" });
  assert.equal(fetcher.calls, 2);
  const health = archive.feedHealth("daily-main");
  assert.notEqual(health.status, "paused");
});

test("exposes pause reason and next-attempt time through the HTTP API with Retry-After", async (t) => {
  const clock = new ManualClock();
  const fetcher = {
    calls: 0,
    async fetchFeed() {
      fetcher.calls += 1;
      throw httpFailure(503);
    }
  };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main`;

  const failed = await fetch(`${root}/refresh`, { method: "POST" });
  assert.equal(failed.status, 502);

  const skippedResponse = await fetch(`${root}/refresh`, { method: "POST" });
  assert.equal(skippedResponse.status, 503);
  assert.equal(skippedResponse.headers.get("retry-after"), "1");
  const skippedBody = await skippedResponse.json();
  assert.equal(skippedBody.outcome, "skipped");
  assert.equal(skippedBody.pause.failureKind, "transient");
  assert.ok(skippedBody.pause.nextAttemptAt);

  const pauseResponse = await fetch(`${root}/pause`);
  assert.equal(pauseResponse.status, 200);
  const pauseBody = await pauseResponse.json();
  assert.equal(pauseBody.pause.reasonCode, "http_status");
  assert.equal(pauseBody.pause.httpStatus, 503);

  const resumeResponse = await fetch(`${root}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operator: "ops:manual", note: "retry now" })
  });
  assert.equal(resumeResponse.status, 200);
  const resumeBody = await resumeResponse.json();
  assert.equal(resumeBody.pause.resumedBy, "ops:manual");

  const eventsResponse = await fetch(`${root}/pause-events`);
  const eventsBody = await eventsResponse.json();
  assert.ok(eventsBody.events.some((event) => event.eventType === "manual_resume" && event.actor === "ops:manual"));
  assert.ok(eventsBody.events.some((event) => event.eventType === "tripped"));

  // Resuming when there is no active pause is a conflict, not an error.
  const again = await fetch(`${root}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operator: "ops:manual" })
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "no_active_pause");

  // Unknown feed pause routes still 404.
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/feeds/nope/pause`)).status, 404);
});

test("rejects a manual resume without an identifiable operator", async (t) => {
  const clock = new ManualClock();
  const fetcher = { async fetchFeed() { throw httpFailure(503); } };
  const { archive } = await openArchive(t, { clock: () => clock.now(), fetcher });
  await assert.rejects(archive.refreshFeed("daily-main"), { status: 503 });
  assert.throws(() => archive.resumeFeed("daily-main", { operator: "   " }), /operator/);
  assert.throws(() => archive.resumeFeed("daily-main", {}), /operator/);
  assert.equal(archive.feedPause("daily-main").paused, true);
});
