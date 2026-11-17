import { classifyFailure, pauseDelayMs, DEFAULT_PAUSE_POLICY, FAILURE_KINDS } from "./failure-policy.js";

const PROBE_TIMEOUT_MS = 30_000;

// Coordinates the durable, recoverable pause lifecycle for one feed at a time.
// All state lives in SQLite, so a process restart reuses the same pause and the
// same next-attempt time. Episode ids act as fencing tokens: a failure belonging
// to an older episode can never re-close a feed that was recovered meanwhile.
export class PauseService {
  constructor({ pauses, clock = () => new Date(), policy = DEFAULT_PAUSE_POLICY, probeTimeoutMs = PROBE_TIMEOUT_MS }) {
    this.pauses = pauses;
    this.clock = clock;
    // Accept either snake_case (failure-kind aligned) or camelCase budgets.
    this.policy = normalizePolicy(policy ?? DEFAULT_PAUSE_POLICY);
    this.probeTimeoutMs = probeTimeoutMs;
  }

  nowIso() {
    return this.clock().toISOString();
  }

  // Decides what a refresh call is allowed to do right now.
  //   { decision: "allow" }                 -> no active outage, fetch normally
  //   { decision: "claim", episode }        -> pause is due; caller owns one probe
  //   { decision: "skip", episode }         -> still paused or a probe is running
  admission(feedId) {
    const now = this.clock();
    const nowIso = now.toISOString();
    let episode = this.pauses.openEpisode(feedId);
    if (!episode) return { decision: "allow", episode: null };

    if (episode.state === "probing") {
      // Recover ownership when the previous process died mid-probe (deadline
      // passed) so an outage cannot wedge the feed forever after a restart.
      if (episode.probeDeadlineAt && episode.probeDeadlineAt <= nowIso) {
        episode = this.reclaimProbe(episode, nowIso);
        if (episode) return { decision: "claim", episode, reclaimed: true };
        episode = this.pauses.openEpisode(feedId);
        if (!episode) return { decision: "allow", episode: null };
      }
      return { decision: "skip", episode, reason: "probe_in_progress" };
    }

    // state === "paused"
    if (episode.nextAttemptAt && episode.nextAttemptAt <= nowIso) {
      return this.tryClaim(episode, nowIso);
    }
    return {
      decision: "skip",
      episode,
      reason: episode.nextAttemptAt ? "pause_active" : "manual_resume_required"
    };
  }

  tryClaim(episode, nowIso) {
    const probeDeadlineAt = new Date(this.clock().getTime() + this.probeTimeoutMs).toISOString();
    const claimed = this.pauses.claimProbe(episode.pauseId, {
      probeDeadlineAt, probeAttemptId: null, nowIso
    });
    if (!claimed) {
      // Lost the race to a concurrent caller (or another process): the row is
      // now probing/resolved, so read it back and act on the fresh state.
      const current = this.pauses.openEpisode(episode.feedId);
      return current
        ? { decision: "skip", episode: current, reason: "probe_in_progress" }
        : { decision: "allow", episode: null };
    }
    this.pauses.recordEvent({
      pauseId: claimed.pauseId, feedId: claimed.feedId, eventType: "probe_claimed",
      detail: `deadline=${probeDeadlineAt}`, occurredAt: nowIso
    });
    return { decision: "claim", episode: claimed };
  }

  reclaimProbe(episode, nowIso) {
    const probeDeadlineAt = new Date(this.clock().getTime() + this.probeTimeoutMs).toISOString();
    const reclaimed = this.pauses.reclaimStaleProbe(episode.pauseId, {
      probeDeadlineAt, probeAttemptId: null, nowIso
    });
    if (reclaimed) {
      this.pauses.recordEvent({
        pauseId: reclaimed.pauseId, feedId: reclaimed.feedId, eventType: "probe_abandoned",
        detail: `previous deadline ${episode.probeDeadlineAt} elapsed`, occurredAt: nowIso
      });
      this.pauses.recordEvent({
        pauseId: reclaimed.pauseId, feedId: reclaimed.feedId, eventType: "probe_claimed",
        detail: `deadline=${probeDeadlineAt}`, occurredAt: nowIso
      });
    }
    return reclaimed;
  }

  // Opens the first pause episode for a fresh outage, after the triggering
  // failure attempt has already been persisted.
  trip(feedId, error, sourceAttemptId) {
    const { kind, trippable } = classifyFailure(error);
    if (!trippable) return { tripped: false };
    const nowIso = this.nowIso();
    const nextAttemptAt = this.computeNextAttempt(kind, 1, error.retryAfterMs, nowIso);
    const pauseId = this.pauses.create({
      feedId,
      state: "paused",
      failureKind: kind,
      reasonCode: error.code ?? "refresh_failed",
      reasonMessage: typeof error.message === "string" ? error.message.slice(0, 500) : null,
      httpStatus: error.status ?? null,
      failureCount: 1,
      sourceAttemptId,
      trippedAt: nowIso,
      nextAttemptAt
    });
    const episode = this.pauses.byId(pauseId);
    this.pauses.recordEvent({
      pauseId, feedId, eventType: "tripped", attemptId: sourceAttemptId,
      detail: `${kind}:${episode.reasonCode}`, occurredAt: nowIso
    });
    return { tripped: true, episode };
  }

  // Called when a single probe finishes successfully.
  noteProbeSucceeded(episode) {
    const current = this.pauses.byId(episode.pauseId);
    if (!current || current.state === "resolved") return current;
    const nowIso = this.nowIso();
    const resolved = this.pauses.resolve(episode.pauseId, {
      resolvedAt: nowIso, resolution: "probe_succeeded"
    });
    this.pauses.recordEvent({
      pauseId: episode.pauseId, feedId: episode.feedId, eventType: "probe_succeeded",
      occurredAt: nowIso
    });
    return resolved;
  }

  // Called when a single probe fails. Returns { stale } when the episode was
  // already resolved (typically by a manual resume) so the late/old failure is
  // ignored instead of silently re-closing the source.
  noteProbeFailure(episode, error, attemptId) {
    const current = this.pauses.byId(episode.pauseId);
    if (!current || current.state === "resolved") return { stale: true, episode: current };
    const nowIso = this.nowIso();
    const { kind, trippable } = classifyFailure(error);
    if (!trippable) {
      // A local/non-source problem does not prove the outage is over, but it
      // also must not extend the back-off. End the episode so the next operator
      // refresh is a normal, fully retried fetch rather than a single probe.
      const resolved = this.pauses.resolve(episode.pauseId, {
        resolvedAt: nowIso, resolution: "probe_abandoned"
      });
      this.pauses.recordEvent({
        pauseId: episode.pauseId, feedId: episode.feedId, eventType: "probe_abandoned",
        attemptId, detail: error.code ?? "non_trippable", occurredAt: nowIso
      });
      return { stale: false, episode: resolved, trippable: false };
    }
    const failureCount = current.failureCount + 1;
    const nextAttemptAt = this.computeNextAttempt(kind, failureCount, error.retryAfterMs, nowIso);
    const reopened = this.pauses.reopenAfterFailedProbe(episode.pauseId, { failureCount, nextAttemptAt });
    this.pauses.recordEvent({
      pauseId: episode.pauseId, feedId: episode.feedId, eventType: "probe_failed",
      attemptId, detail: `${kind}:${error.code ?? "refresh_failed"}`, occurredAt: nowIso
    });
    this.pauses.recordEvent({
      pauseId: episode.pauseId, feedId: episode.feedId, eventType: "reopened",
      attemptId, detail: `failure_count=${failureCount}`, occurredAt: nowIso
    });
    return { stale: false, episode: reopened, trippable: true };
  }

  // Manual operator recovery. Records who acted and which episode (i.e. which
  // outage) they cleared. No-op semantics are reported back explicitly.
  resume(feedId, { operator, note = null }) {
    const actor = normalizeOperator(operator);
    const episode = this.pauses.openEpisode(feedId);
    if (!episode) return { resumed: false, reason: "no_active_pause", episode: null };
    const nowIso = this.nowIso();
    const resolved = this.pauses.manualResume(episode.pauseId, {
      resolvedAt: nowIso, resumedBy: actor, resumeNote: note
    });
    this.pauses.recordEvent({
      pauseId: episode.pauseId, feedId, eventType: "manual_resume", actor,
      detail: note ?? `cleared ${episode.failureKind} pause`, occurredAt: nowIso
    });
    return { resumed: true, episode: resolved };
  }

  describe(feedId) {
    const episode = this.pauses.latest(feedId);
    if (!episode) return null;
    let paused;
    let nextAttemptAt;
    if (episode.state === "resolved") {
      paused = false;
      nextAttemptAt = null;
    } else if (episode.state === "probing") {
      paused = true;
      nextAttemptAt = episode.probeDeadlineAt;
    } else {
      paused = true;
      nextAttemptAt = episode.nextAttemptAt;
    }
    return {
      pauseId: episode.pauseId,
      paused,
      state: episode.state,
      failureKind: episode.failureKind,
      reasonCode: episode.reasonCode,
      reasonMessage: episode.reasonMessage,
      httpStatus: episode.httpStatus,
      failureCount: episode.failureCount,
      trippedAt: episode.trippedAt,
      nextAttemptAt,
      requiresManualResume: paused && episode.state === "paused" &&
        episode.failureKind === FAILURE_KINDS.UNAVAILABLE,
      sourceAttemptId: episode.sourceAttemptId,
      probeAttemptId: episode.probeAttemptId,
      resolvedAt: episode.resolvedAt,
      resolution: episode.resolution,
      resumedBy: episode.resumedBy,
      resumeNote: episode.resumeNote
    };
  }

  events(feedId, limit) {
    return this.pauses.events(feedId, limit);
  }

  computeNextAttempt(kind, failureCount, retryAfterMs, nowIso) {
    const budget = this.policy[kind];
    if (!budget) throw new RangeError(`no pause budget configured for failure kind: ${kind}`);
    if (budget.requiresManual) return null;
    const delay = pauseDelayMs(kind, failureCount, this.policy, retryAfterMs);
    return new Date(Date.parse(nowIso) + delay).toISOString();
  }
}

function normalizePolicy(policy) {
  // Budgets are keyed by the snake_case failure kinds; tolerate camelCase too.
  return {
    [FAILURE_KINDS.RATE_LIMITED]: policy[FAILURE_KINDS.RATE_LIMITED] ?? policy.rateLimited,
    [FAILURE_KINDS.TRANSIENT]: policy[FAILURE_KINDS.TRANSIENT],
    [FAILURE_KINDS.UNAVAILABLE]: policy[FAILURE_KINDS.UNAVAILABLE]
  };
}

function normalizeOperator(operator) {
  if (typeof operator !== "string") throw new TypeError("operator must be text identifying the operator");
  const normalized = operator.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 128) throw new RangeError("operator must contain 1 to 128 characters");
  return normalized;
}
