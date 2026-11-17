const WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export class HealthReportService {
  constructor({ feeds, fetches, pauses, clock = () => new Date() }) {
    this.feeds = feeds;
    this.fetches = fetches;
    this.pauses = pauses;
    this.clock = clock;
  }

  report(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const now = this.clock();
    const summary = this.fetches.summarySince(feedId, new Date(now.getTime() - WINDOW_MS).toISOString());
    const lastSuccess = summary.lastSuccessAt ? Date.parse(summary.lastSuccessAt) : null;
    const ageMs = lastSuccess === null ? null : Math.max(0, now.getTime() - lastSuccess);
    const pause = this.pauses.describe(feedId);
    const issues = diagnose(summary, ageMs, pause);
    const contactable = summary.total - summary.skipped;
    const status = summary.total === 0
      ? "awaiting_capture"
      : pause?.paused
        ? "paused"
        : issues.length ? "attention" : "healthy";
    return {
      feedId,
      status,
      checkedAt: now.toISOString(),
      windowHours: 24,
      lastSuccessAt: summary.lastSuccessAt ?? null,
      lastAttemptAt: summary.lastAttemptAt ?? null,
      freshness: ageMs === null ? "unknown" : ageMs > STALE_AFTER_MS ? "stale" : "fresh",
      // Skips never sent a request, so they are excluded from the success-rate
      // denominator; only real network attempts measure source reliability.
      successRate: contactable > 0 ? Number((summary.accepted / contactable).toFixed(3)) : null,
      totals: {
        attempts: summary.total,
        accepted: summary.accepted,
        rejected: summary.rejected,
        failed: summary.failed,
        notModified: summary.notModified,
        skipped: summary.skipped
      },
      pause: pause && (pause.paused || pause.resolvedAt) ? {
        pauseId: pause.pauseId,
        paused: pause.paused,
        state: pause.state,
        failureKind: pause.failureKind,
        reasonCode: pause.reasonCode,
        nextAttemptAt: pause.nextAttemptAt,
        requiresManualResume: pause.requiresManualResume,
        trippedAt: pause.trippedAt,
        resolvedAt: pause.resolvedAt,
        resolution: pause.resolution,
        resumedBy: pause.resumedBy
      } : null,
      issues
    };
  }
}

function diagnose(summary, ageMs, pause) {
  const issues = [];
  if (!summary.total) issues.push({ code: "no_recent_attempts", severity: "warning" });
  if (summary.failed > 0) issues.push({ code: "source_failures", severity: "warning", count: summary.failed });
  if (summary.rejected > 0) issues.push({ code: "capture_rejections", severity: "warning", count: summary.rejected });
  if (summary.skipped > 0) issues.push({ code: "refresh_skips", severity: "warning", count: summary.skipped });
  if (ageMs === null && summary.total > 0) issues.push({ code: "no_successful_capture", severity: "critical" });
  if (ageMs !== null && ageMs > STALE_AFTER_MS) {
    issues.push({ code: "stale_source", severity: "critical", ageHours: Number((ageMs / 3_600_000).toFixed(1)) });
  }
  const contactable = summary.total - summary.skipped;
  if (contactable >= 4 && summary.accepted / contactable < 0.5) {
    issues.push({ code: "low_acceptance_rate", severity: "critical", rate: Number((summary.accepted / contactable).toFixed(3)) });
  }
  if (pause?.paused) {
    issues.push({
      code: "source_paused",
      severity: pause.requiresManualResume ? "critical" : "warning",
      pauseId: pause.pauseId,
      failureKind: pause.failureKind,
      reasonCode: pause.reasonCode,
      nextAttemptAt: pause.nextAttemptAt,
      requiresManualResume: pause.requiresManualResume
    });
  }
  return issues;
}
