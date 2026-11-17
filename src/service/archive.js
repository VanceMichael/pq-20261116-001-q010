import { openDatabase, closeDatabase } from "../store/database.js";
import { FeedRepository } from "../store/feed-repository.js";
import { CaptureRepository } from "../store/capture-repository.js";
import { ArticleRepository } from "../store/article-repository.js";
import { FetchRepository } from "../store/fetch-repository.js";
import { PauseRepository } from "../store/pause-repository.js";
import { ImportService } from "../ingest/import-service.js";
import { PageFetcher } from "../acquisition/page-fetcher.js";
import { RefreshService } from "./refresh-service.js";
import { ChangeReportService } from "./change-report.js";
import { HealthReportService } from "./health-report.js";
import { PauseService } from "./pause-service.js";
import { ReviewRepository } from "../store/review-repository.js";
import { ReviewService } from "./review-service.js";
import { CsvExporter } from "../export/csv-exporter.js";
import { ArticleTimelineService } from "./article-timeline.js";
import { IntegrityAuditService } from "./integrity-audit.js";

export class NewsArchive {
  constructor(filename, options = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.database = openDatabase(filename);
    this.feeds = new FeedRepository(this.database);
    this.captures = new CaptureRepository(this.database);
    this.articles = new ArticleRepository(this.database);
    this.fetches = new FetchRepository(this.database);
    this.pauseStore = new PauseRepository(this.database);
    this.reviews = new ReviewRepository(this.database);
    this.imports = new ImportService({
      database: this.database,
      feeds: this.feeds,
      captures: this.captures,
      articles: this.articles,
      clock: this.clock
    });
    this.pauseService = new PauseService({
      pauses: this.pauseStore,
      clock: this.clock,
      policy: options.pausePolicy,
      probeTimeoutMs: options.probeTimeoutMs
    });
    this.refreshes = new RefreshService({
      feeds: this.feeds,
      fetches: this.fetches,
      fetcher: options.fetcher ?? new PageFetcher(),
      imports: this.imports,
      pauses: this.pauseService,
      clock: this.clock
    });
    this.changes = new ChangeReportService({ feeds: this.feeds, captures: this.captures, articles: this.articles });
    this.health = new HealthReportService({
      feeds: this.feeds, fetches: this.fetches, pauses: this.pauseService, clock: this.clock
    });
    this.reviewService = new ReviewService({ feeds: this.feeds, reviews: this.reviews, clock: this.clock });
    this.csvExporter = new CsvExporter({ database: this.database, feeds: this.feeds, articles: this.articles });
    this.timelines = new ArticleTimelineService({ feeds: this.feeds, reviews: this.reviews, articles: this.articles });
    this.integrityAudit = new IntegrityAuditService(this.database);
  }

  registerFeed(input) {
    return this.feeds.register(input, this.now());
  }

  importSnapshot(feedId, html, capturedAt) {
    return this.imports.importHtml(feedId, html, capturedAt);
  }

  refreshFeed(feedId) {
    return this.refreshes.refresh(feedId);
  }

  feedStatus(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const latest = this.captures.recent(feedId, 1)[0] ?? null;
    return {
      ...feed,
      health: latest ? latest.accepted ? "healthy" : "degraded" : "awaiting_capture",
      latestAttempt: latest,
      pause: this.pauseService.describe(feedId),
      statistics: this.articles.stats(feedId),
      collectionHealth: this.health.report(feedId)
    };
  }

  listItems(feedId, options) {
    if (!this.feeds.get(feedId)) return null;
    return { items: this.articles.list(feedId, options), statistics: this.articles.stats(feedId) };
  }

  listCaptures(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    return this.captures.recent(feedId, limit);
  }

  listFetchAttempts(feedId, limit) {
    return this.refreshes.recent(feedId, limit);
  }

  feedChanges(feedId) {
    return this.changes.report(feedId);
  }

  feedHealth(feedId) {
    return this.health.report(feedId);
  }

  feedPause(feedId) {
    if (!this.feeds.get(feedId)) return null;
    return this.pauseService.describe(feedId);
  }

  pauseEvents(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    return this.pauseService.events(feedId, limit);
  }

  resumeFeed(feedId, input) {
    if (!this.feeds.get(feedId)) return { status: 404, error: "feed_not_found" };
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("resume request must be an object");
    }
    const note = normalizeResumeNote(input.note);
    const result = this.pauseService.resume(feedId, { operator: input.operator, note });
    if (!result.resumed) return { status: 409, error: result.reason };
    return { status: 200, pause: this.pauseService.describe(feedId), event: this.pauseStore.events(feedId, 1)[0] };
  }

  reviewArticle(feedId, articleId, input) {
    return this.reviewService.change(feedId, articleId, input);
  }

  reviewEvents(feedId, articleId, limit) {
    return this.reviewService.events(feedId, articleId, limit);
  }

  exportCsv(feedId, writable, options) {
    return this.csvExporter.write(feedId, writable, options);
  }

  articleTimeline(feedId, articleId, limit) {
    return this.timelines.report(feedId, articleId, limit);
  }

  auditIntegrity() {
    return this.integrityAudit.run();
  }

  close() {
    closeDatabase(this.database);
  }

  now() {
    return this.clock().toISOString();
  }
}

function normalizeResumeNote(note) {
  if (note === undefined || note === null || note === "") return null;
  if (typeof note !== "string") throw new TypeError("note must be text");
  const normalized = note.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1000) throw new RangeError("note must contain 1 to 1000 characters");
  return normalized;
}
