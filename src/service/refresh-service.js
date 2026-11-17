const SKIP_REASON_MESSAGES = Object.freeze({
  pause_active: "source is paused after repeated failures; waiting for the back-off window",
  manual_resume_required: "source is marked unavailable and requires a manual resume",
  probe_in_progress: "a single recovery probe is already in progress"
});

export class RefreshService {
  constructor({ feeds, fetches, fetcher, imports, pauses, clock = () => new Date() }) {
    this.feeds = feeds;
    this.fetches = fetches;
    this.fetcher = fetcher;
    this.imports = imports;
    this.pauses = pauses;
    this.clock = clock;
    this.inFlight = new Map();
  }

  refresh(feedId) {
    const active = this.inFlight.get(feedId);
    if (active) return active;
    const task = this.perform(feedId).finally(() => {
      if (this.inFlight.get(feedId) === task) this.inFlight.delete(feedId);
    });
    this.inFlight.set(feedId, task);
    return task;
  }

  async perform(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);

    const admission = this.pauses.admission(feedId);
    if (admission.decision === "skip") {
      return this.recordSkipped(feed, admission);
    }
    if (admission.decision === "claim") {
      return this.runProbe(feed, admission.episode);
    }
    return this.runNormal(feed);
  }

  async runNormal(feed) {
    const feedId = feed.feedId;
    const startedAt = this.clock().toISOString();
    try {
      const fetched = await this.fetcher.fetchFeed(feed);
      return this.handleFetched(feed, fetched, startedAt, null);
    } catch (error) {
      return this.handleFailure(feed, error, startedAt, null);
    }
  }

  async runProbe(feed, episode) {
    const feedId = feed.feedId;
    const startedAt = this.clock().toISOString();
    try {
      const fetched = await this.fetcher.fetchFeed(feed);
      return this.handleFetched(feed, fetched, startedAt, episode);
    } catch (error) {
      return this.handleFailure(feed, error, startedAt, episode);
    }
  }

  handleFetched(feed, fetched, startedAt, episode) {
    const feedId = feed.feedId;
    const finishedAt = this.clock().toISOString();
    if (fetched.status === 304) {
      const attemptId = this.fetches.record({
        feedId, startedAt, finishedAt, outcome: "not_modified", httpStatus: 304,
        attemptCount: fetched.attemptCount, requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl, captureId: null, errorCode: null, errorMessage: null,
        pauseId: episode?.pauseId ?? null
      });
      if (episode) this.pauses.noteProbeSucceeded(episode);
      return { attemptId, feedId, outcome: "not_modified", httpStatus: 304, capture: null };
    }
    const capture = this.imports.importHtml(feedId, fetched.html, finishedAt);
    const attemptId = this.fetches.record({
      feedId, startedAt, finishedAt, outcome: capture.accepted ? "accepted" : "rejected",
      httpStatus: fetched.status, attemptCount: fetched.attemptCount,
      requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl,
      captureId: capture.captureId ?? null, errorCode: capture.accepted ? null : "capture_rejected",
      errorMessage: capture.reason, pauseId: episode?.pauseId ?? null
    });
    // Only a genuine source response proves recovery; a content-quality rejection
    // still means the source answered, so the pause is cleared.
    if (episode) this.pauses.noteProbeSucceeded(episode);
    return { attemptId, feedId, outcome: capture.accepted ? "accepted" : "rejected",
      httpStatus: fetched.status, capture };
  }

  handleFailure(feed, error, startedAt, episode) {
    const feedId = feed.feedId;
    const finishedAt = this.clock().toISOString();
    const attemptId = this.fetches.record({
      feedId, startedAt, finishedAt, outcome: "failed", httpStatus: error.status ?? null,
      attemptCount: error.attemptCount ?? 1, requestedUrl: feed.baseUrl, finalUrl: null,
      captureId: null, errorCode: error.code ?? "refresh_failed",
      errorMessage: error.message.slice(0, 500), pauseId: episode?.pauseId ?? null
    });

    let pause = null;
    let stale = false;
    if (episode) {
      const result = this.pauses.noteProbeFailure(episode, error, attemptId);
      stale = result.stale;
      pause = this.pauses.describe(feedId);
    } else {
      const tripped = this.pauses.trip(feedId, error, attemptId);
      if (tripped.tripped) pause = this.pauses.describe(feedId);
    }

    // Fencing: when the episode was already resolved (manual resume, or another
    // probe outcome) before this failure landed, the late/old failure must not
    // re-close the source. Surface that fact on the thrown error.
    throw Object.assign(error, {
      attemptId,
      statusCode: error.statusCode ?? 502,
      pause,
      stalePauseResult: stale
    });
  }

  // A skipped refresh never contacts the source. It is recorded as its own
  // outcome so network failures and back-off skips stay clearly separated and
  // the success-rate denominator is not diluted.
  recordSkipped(feed, admission) {
    const feedId = feed.feedId;
    const episode = admission.episode;
    const nowIso = this.clock().toISOString();
    const reasonCode = admission.reason;
    const attemptId = this.fetches.record({
      feedId, startedAt: nowIso, finishedAt: nowIso, outcome: "skipped",
      httpStatus: null, attemptCount: 0, requestedUrl: feed.baseUrl, finalUrl: null,
      captureId: null, errorCode: `paused:${reasonCode}`,
      errorMessage: SKIP_REASON_MESSAGES[reasonCode] ?? "refresh skipped while source is paused",
      pauseId: episode.pauseId
    });
    // While probing, the wait boundary is the probe deadline; otherwise it is
    // the back-off window's next-attempt time.
    const waitBoundary = episode.state === "probing" ? episode.probeDeadlineAt : episode.nextAttemptAt;
    const retryAfterMs = waitBoundary
      ? Math.max(0, Date.parse(waitBoundary) - this.clock().getTime())
      : null;
    return {
      attemptId,
      feedId,
      outcome: "skipped",
      skipReason: reasonCode,
      httpStatus: null,
      capture: null,
      pause: this.pauses.describe(feedId),
      retryAfterMs
    };
  }

  recent(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    return this.fetches.recent(feedId, limit);
  }

  pending(feedId) {
    return this.inFlight.has(feedId);
  }
}
