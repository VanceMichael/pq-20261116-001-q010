export class ReviewRepository {
  constructor(database) {
    this.database = database;
    this.findArticle = database.prepare(`SELECT article_id, feed_id, canonical_url, title, visibility,
      review_state, review_note, review_revision FROM articles WHERE feed_id=? AND article_id=?`);
    this.updateArticle = database.prepare(`UPDATE articles SET review_state=?, review_note=?,
      review_revision=review_revision+1 WHERE feed_id=? AND article_id=? AND review_revision=?`);
    this.insertEvent = database.prepare(`INSERT INTO review_events
      (article_id, prior_state, next_state, note, revision, changed_at) VALUES (?, ?, ?, ?, ?, ?)`);
    this.listEvents = database.prepare(`SELECT event_id, prior_state, next_state, note, revision, changed_at
      FROM review_events WHERE article_id=? ORDER BY event_id DESC LIMIT ?`);
  }

  article(feedId, articleId) {
    const row = this.findArticle.get(feedId, articleId);
    return row ? mapReviewedArticle(row) : null;
  }

  compareAndSet({ feedId, articleId, expectedRevision, state, note, changedAt }) {
    const current = this.article(feedId, articleId);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.reviewRevision !== expectedRevision) {
      return { ok: false, reason: "revision_conflict", current };
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const locked = this.article(feedId, articleId);
      if (!locked) {
        this.database.exec("ROLLBACK");
        return { ok: false, reason: "not_found" };
      }
      if (locked.reviewRevision !== expectedRevision) {
        this.database.exec("ROLLBACK");
        return { ok: false, reason: "revision_conflict", current: locked };
      }
      const result = this.updateArticle.run(state, note, feedId, articleId, expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("review compare-and-set lost its locked row");
      const revision = expectedRevision + 1;
      this.insertEvent.run(articleId, locked.reviewState, state, note, revision, changedAt);
      this.database.exec("COMMIT");
      return { ok: true, article: this.article(feedId, articleId) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  events(articleId, limit = 50) {
    return this.listEvents.all(articleId, Math.max(1, Math.min(100, Number(limit) || 50))).map((row) => ({
      eventId: row.event_id,
      priorState: row.prior_state,
      nextState: row.next_state,
      note: row.note,
      revision: row.revision,
      changedAt: row.changed_at
    }));
  }
}

function mapReviewedArticle(row) {
  return {
    articleId: row.article_id,
    feedId: row.feed_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    visibility: row.visibility,
    reviewState: row.review_state,
    reviewNote: row.review_note,
    reviewRevision: row.review_revision
  };
}
