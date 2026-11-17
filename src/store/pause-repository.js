const PAUSE_COLUMNS = `pause_id, feed_id, state, failure_kind, reason_code, reason_message, http_status,
  failure_count, source_attempt_id, tripped_at, next_attempt_at, probe_deadline_at, probe_attempt_id,
  resolved_at, resolution, resumed_by, resume_note`;

export class PauseRepository {
  constructor(database) {
    this.database = database;
    this.insert = database.prepare(`INSERT INTO feed_pauses
      (feed_id, state, failure_kind, reason_code, reason_message, http_status, failure_count,
       source_attempt_id, tripped_at, next_attempt_at, probe_deadline_at, probe_attempt_id,
       resolved_at, resolution, resumed_by, resume_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`);
    this.latestQuery = database.prepare(`SELECT ${PAUSE_COLUMNS} FROM feed_pauses
      WHERE feed_id=? ORDER BY pause_id DESC LIMIT 1`);
    this.byIdQuery = database.prepare(`SELECT ${PAUSE_COLUMNS} FROM feed_pauses WHERE pause_id=?`);
    this.openQuery = database.prepare(`SELECT ${PAUSE_COLUMNS} FROM feed_pauses
      WHERE feed_id=? AND state != 'resolved' ORDER BY pause_id DESC LIMIT 1`);
    this.staleProbeQuery = database.prepare(`SELECT ${PAUSE_COLUMNS} FROM feed_pauses
      WHERE feed_id=? AND state='probing' AND probe_deadline_at IS NOT NULL
      AND probe_deadline_at <= ? ORDER BY pause_id DESC LIMIT 1`);
    this.claimUpdate = database.prepare(`UPDATE feed_pauses
      SET state='probing', probe_deadline_at=?, probe_attempt_id=?
      WHERE pause_id=? AND state='paused' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`);
    this.reclaimUpdate = database.prepare(`UPDATE feed_pauses
      SET state='probing', probe_deadline_at=?, probe_attempt_id=?
      WHERE pause_id=? AND state='probing' AND probe_deadline_at IS NOT NULL AND probe_deadline_at <= ?`);
    this.reopenUpdate = database.prepare(`UPDATE feed_pauses
      SET state='paused', failure_count=?, next_attempt_at=?, probe_deadline_at=NULL, probe_attempt_id=NULL
      WHERE pause_id=? AND state='probing'`);
    this.resolveUpdate = database.prepare(`UPDATE feed_pauses
      SET state='resolved', resolved_at=?, resolution=?, probe_deadline_at=NULL
      WHERE pause_id=? AND state != 'resolved'`);
    this.manualResumeUpdate = database.prepare(`UPDATE feed_pauses
      SET state='resolved', resolved_at=?, resolution='manual_resume', resumed_by=?, resume_note=?,
      next_attempt_at=NULL, probe_deadline_at=NULL
      WHERE pause_id=? AND state != 'resolved'`);
    this.eventInsert = database.prepare(`INSERT INTO feed_pause_events
      (pause_id, feed_id, event_type, actor, detail, attempt_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.eventsQuery = database.prepare(`SELECT event_id, pause_id, feed_id, event_type, actor, detail,
      attempt_id, occurred_at FROM feed_pause_events WHERE feed_id=? ORDER BY event_id DESC LIMIT ?`);
  }

  create(episode) {
    const result = this.insert.run(
      episode.feedId, episode.state, episode.failureKind, episode.reasonCode,
      episode.reasonMessage ?? null, episode.httpStatus ?? null, episode.failureCount ?? 1,
      episode.sourceAttemptId ?? null, episode.trippedAt, episode.nextAttemptAt ?? null,
      episode.probeDeadlineAt ?? null, episode.probeAttemptId ?? null
    );
    return Number(result.lastInsertRowid);
  }

  latest(feedId) {
    const row = this.latestQuery.get(feedId);
    return row ? mapPause(row) : null;
  }

  byId(pauseId) {
    const row = this.byIdQuery.get(pauseId);
    return row ? mapPause(row) : null;
  }

  openEpisode(feedId) {
    const row = this.openQuery.get(feedId);
    return row ? mapPause(row) : null;
  }

  staleProbe(feedId, nowIso) {
    const row = this.staleProbeQuery.get(feedId, nowIso);
    return row ? mapPause(row) : null;
  }

  // Atomically transitions an open, due pause into the probing state. Returns
  // the updated episode, or null when another caller won the race or the pause
  // was resolved in the meantime.
  claimProbe(pauseId, { probeDeadlineAt, probeAttemptId, nowIso }) {
    const result = this.claimUpdate.run(probeDeadlineAt, probeAttemptId, pauseId, nowIso);
    return result.changes ? this.byId(pauseId) : null;
  }

  // Re-takes ownership of a probe whose owner died (deadline elapsed). This is
  // the restart recovery path and therefore matches the probing state.
  reclaimStaleProbe(pauseId, { probeDeadlineAt, probeAttemptId, nowIso }) {
    const result = this.reclaimUpdate.run(probeDeadlineAt, probeAttemptId, pauseId, nowIso);
    return result.changes ? this.byId(pauseId) : null;
  }

  reopenAfterFailedProbe(pauseId, { failureCount, nextAttemptAt }) {
    const result = this.reopenUpdate.run(failureCount, nextAttemptAt, pauseId);
    return result.changes ? this.byId(pauseId) : null;
  }

  resolve(pauseId, { resolvedAt, resolution }) {
    const result = this.resolveUpdate.run(resolvedAt, resolution, pauseId);
    return result.changes ? this.byId(pauseId) : null;
  }

  manualResume(pauseId, { resolvedAt, resumedBy, resumeNote }) {
    const result = this.manualResumeUpdate.run(resolvedAt, resumedBy, resumeNote, pauseId);
    return result.changes ? this.byId(pauseId) : null;
  }

  recordEvent(event) {
    const result = this.eventInsert.run(
      event.pauseId, event.feedId, event.eventType, event.actor ?? null,
      event.detail ?? null, event.attemptId ?? null, event.occurredAt
    );
    return Number(result.lastInsertRowid);
  }

  events(feedId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.eventsQuery.all(feedId, safeLimit).map(mapEvent);
  }
}

function mapPause(row) {
  return {
    pauseId: row.pause_id,
    feedId: row.feed_id,
    state: row.state,
    failureKind: row.failure_kind,
    reasonCode: row.reason_code,
    reasonMessage: row.reason_message,
    httpStatus: row.http_status,
    failureCount: row.failure_count,
    sourceAttemptId: row.source_attempt_id,
    trippedAt: row.tripped_at,
    nextAttemptAt: row.next_attempt_at,
    probeDeadlineAt: row.probe_deadline_at,
    probeAttemptId: row.probe_attempt_id,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    resumedBy: row.resumed_by,
    resumeNote: row.resume_note
  };
}

function mapEvent(row) {
  return {
    eventId: row.event_id,
    pauseId: row.pause_id,
    feedId: row.feed_id,
    eventType: row.event_type,
    actor: row.actor,
    detail: row.detail,
    attemptId: row.attempt_id,
    occurredAt: row.occurred_at
  };
}
