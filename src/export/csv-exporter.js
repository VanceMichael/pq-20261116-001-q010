import { once } from "node:events";

const HEADER = ["article_id", "title", "canonical_url", "published_at", "first_seen_at", "last_seen_at", "seen_count", "visibility", "review_state"];
const MAX_EXPORT_ROWS = 50_000;

export class CsvExporter {
  constructor({ database, feeds, articles }) {
    this.database = database;
    this.feeds = feeds;
    this.articles = articles;
  }

  async write(feedId, writable, { visibility = null, limit = MAX_EXPORT_ROWS } = {}) {
    if (!this.feeds.get(feedId)) return { found: false, rows: 0 };
    if (visibility !== null && !new Set(["visible", "quiet"]).has(visibility)) {
      throw new TypeError("visibility must be visible or quiet");
    }
    const rowLimit = parseLimit(limit);
    let rows = 0;
    this.database.exec("BEGIN");
    try {
      await writeChunk(writable, `${HEADER.join(",")}\r\n`);
      while (rows < rowLimit) {
        const pageSize = Math.min(200, rowLimit - rows);
        const page = this.articles.list(feedId, { visibility, limit: pageSize, offset: rows });
        if (!page.length) break;
        for (const article of page) {
          await writeChunk(writable, serializeArticle(article));
          rows += 1;
        }
        if (page.length < pageSize) break;
      }
      const truncated = rows === rowLimit && this.articles.list(feedId, { visibility, limit: 1, offset: rows }).length > 0;
      this.database.exec("COMMIT");
      return { found: true, rows, truncated };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function serializeArticle(article) {
  const values = [
    article.articleId,
    article.title,
    article.canonicalUrl,
    article.publishedAt,
    article.firstSeenAt,
    article.lastSeenAt,
    article.seenCount,
    article.visibility,
    article.reviewState ?? "unreviewed"
  ];
  return `${values.map(csvCell).join(",")}\r\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new RangeError("export limit must be a positive integer");
  return Math.min(parsed, MAX_EXPORT_ROWS);
}

async function writeChunk(writable, chunk) {
  if (writable.destroyed || writable.writableEnded) throw new Error("export destination is no longer writable");
  if (!writable.write(chunk)) await once(writable, "drain");
}
