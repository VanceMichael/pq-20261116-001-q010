const REVIEW_STATES = new Set(["unreviewed", "confirmed", "withdrawn"]);

export class ReviewService {
  constructor({ feeds, reviews, clock = () => new Date() }) {
    this.feeds = feeds;
    this.reviews = reviews;
    this.clock = clock;
  }

  change(feedId, articleId, input) {
    if (!this.feeds.get(feedId)) return { status: 404, error: "feed_not_found" };
    if (!Number.isSafeInteger(articleId) || articleId < 1) throw new TypeError("articleId must be a positive integer");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("review request must be an object");
    if (!REVIEW_STATES.has(input.state)) throw new TypeError("state must be unreviewed, confirmed or withdrawn");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative integer");
    }
    const note = normalizeNote(input.note);
    const result = this.reviews.compareAndSet({
      feedId,
      articleId,
      expectedRevision: input.expectedRevision,
      state: input.state,
      note,
      changedAt: this.clock().toISOString()
    });
    if (result.reason === "not_found") return { status: 404, error: "article_not_found" };
    if (result.reason === "revision_conflict") return { status: 409, error: "revision_conflict", current: result.current };
    return { status: 200, article: result.article };
  }

  events(feedId, articleId, limit) {
    if (!this.feeds.get(feedId)) return null;
    const article = this.reviews.article(feedId, articleId);
    return article ? { article, events: this.reviews.events(articleId, limit) } : null;
  }
}

function normalizeNote(note) {
  if (note === undefined || note === null || note === "") return null;
  if (typeof note !== "string") throw new TypeError("note must be text");
  const normalized = note.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1000) throw new RangeError("note must contain 1 to 1000 characters");
  return normalized;
}
