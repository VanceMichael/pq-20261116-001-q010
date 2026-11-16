import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class PageFetcher {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = 12_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 3,
    maxAttempts = 3,
    backoffBaseMs = 200,
    sleep = delay,
    now = () => Date.now()
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("a Fetch-compatible implementation is required");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = boundedInteger(timeoutMs, 100, 120_000, "timeoutMs");
    this.maxBytes = boundedInteger(maxBytes, 1024, 5 * 1024 * 1024, "maxBytes");
    this.maxRedirects = boundedInteger(maxRedirects, 0, 10, "maxRedirects");
    this.maxAttempts = boundedInteger(maxAttempts, 1, 6, "maxAttempts");
    this.backoffBaseMs = boundedInteger(backoffBaseMs, 0, 10_000, "backoffBaseMs");
    this.sleep = sleep;
    this.now = now;
  }

  async fetchFeed(feed) {
    const initial = new URL(feed.baseUrl);
    const allowedHosts = feed.allowedHosts ?? [];
    assertAllowed(initial, allowedHosts);
    const startedAt = new Date(this.now()).toISOString();
    const result = await this.requestWithRedirects(initial, allowedHosts);
    return { ...result, requestedUrl: initial.href, startedAt };
  }

  async requestWithRedirects(initialUrl, allowedHosts) {
    let currentUrl = initialUrl;
    const visited = new Set();
    let attemptCount = 0;
    let lastStatus = null;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      assertAllowed(currentUrl, allowedHosts);
      if (visited.has(currentUrl.href)) throw fetchError("redirect_loop", "source returned a redirect loop");
      visited.add(currentUrl.href);
      const response = await this.requestWithRetry(currentUrl);
      attemptCount += response.attemptCount;
      lastStatus = response.status;
      if (response.status === 304) {
        return { status: 304, html: null, finalUrl: currentUrl.href, attemptCount, headers: response.headers };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw fetchError("redirect_without_location", "redirect response has no Location header", response.status);
        if (redirectCount === this.maxRedirects) throw fetchError("redirect_limit", "source exceeded redirect limit", response.status);
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (!response.ok) {
        throw Object.assign(fetchError("http_status", `source returned HTTP ${response.status}`, response.status), {
          attemptCount: response.attemptCount
        });
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
        throw fetchError("content_type", `source returned unsupported content type: ${contentType}`, response.status);
      }
      const html = await readBoundedText(response, this.maxBytes);
      return { status: response.status, html, finalUrl: currentUrl.href, attemptCount, headers: response.headers };
    }
    throw fetchError("redirect_limit", "source exceeded redirect limit", lastStatus);
  }

  async requestWithRetry(url) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url.href, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "text/html,application/xhtml+xml;q=0.9", "user-agent": "RollingNewsArchive/1.0" },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts) {
          return { status: response.status, headers: response.headers, ok: response.ok,
            body: response.body, attemptCount: attempt };
        }
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
        await response.body?.cancel();
        await this.sleep(retryAfter ?? this.backoffBaseMs * 2 ** (attempt - 1));
      } catch (error) {
        lastError = error;
        if (error.code && error.code !== "fetch_failed") throw error;
        if (attempt === this.maxAttempts) break;
        await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    throw Object.assign(fetchError("fetch_failed", lastError?.message ?? "source request failed"), {
      attemptCount: this.maxAttempts
    });
  }
}

export async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw fetchError("response_too_large", `source response exceeds ${maxBytes} bytes`, response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw fetchError("response_too_large", `source response exceeds ${maxBytes} bytes`, response.status);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function assertAllowed(url, allowedHosts) {
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw fetchError("unsafe_protocol", "source URL must use HTTP or HTTPS");
  if (url.username || url.password) throw fetchError("unsafe_credentials", "source URL cannot contain credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname)) {
    throw fetchError("unsafe_host", "source must use a DNS name, not a local or literal IP host");
  }
  if (!allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw fetchError("host_not_allowed", `source host is outside the feed allowlist: ${url.hostname}`);
  }
}

function parseRetryAfter(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  const delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delayMs) && delayMs >= 0 ? Math.min(delayMs, 30_000) : null;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function fetchError(code, message, status = null) {
  return Object.assign(new Error(message), { code, status });
}
