// Failure classification and back-off policy for the persistent source pause
// mechanism. Three distinct failure kinds get three distinct next steps:
//
//   - "rate_limited": the source asked us to slow down (HTTP 429). Honor its
//     Retry-After hint inside a bounded, escalating window.
//   - "transient": short-lived service/network trouble that should self-heal;
//     pause briefly with escalating back-off, then allow a single probe.
//   - "unavailable": the source is explicitly gone (HTTP 404/410). Pause for a
//     long, fixed window and require a manual resume.
//
// Local configuration/validation problems are not source outages, so they are
// classified as non-trippable and never pause a feed.

export const FAILURE_KINDS = Object.freeze({
  RATE_LIMITED: "rate_limited",
  TRANSIENT: "transient",
  UNAVAILABLE: "unavailable"
});

const RATE_LIMITED_STATUS = new Set([429]);
const UNAVAILABLE_STATUS = new Set([404, 410]);

// Defaults are expressed in milliseconds. They are deliberately long for real
// operations; tests inject much shorter budgets. Keys match FAILURE_KINDS.
export const DEFAULT_PAUSE_POLICY = Object.freeze({
  [FAILURE_KINDS.RATE_LIMITED]: { baseMs: 60_000, maxMs: 15 * 60_000, factor: 2, requiresManual: false },
  [FAILURE_KINDS.TRANSIENT]: { baseMs: 30_000, maxMs: 5 * 60_000, factor: 2, requiresManual: false },
  [FAILURE_KINDS.UNAVAILABLE]: { baseMs: 30 * 60_000, maxMs: 30 * 60_000, factor: 1, requiresManual: true }
});

export function classifyFailure(error) {
  if (!error || typeof error !== "object") {
    return { kind: FAILURE_KINDS.TRANSIENT, trippable: true };
  }
  const status = error.status ?? null;
  if (status !== null) {
    if (RATE_LIMITED_STATUS.has(status)) return { kind: FAILURE_KINDS.RATE_LIMITED, trippable: true };
    if (UNAVAILABLE_STATUS.has(status)) return { kind: FAILURE_KINDS.UNAVAILABLE, trippable: true };
    // Other explicit HTTP client errors (400/401/403...) are request/policy
    // problems rather than a source outage; do not pause the feed.
    if (status >= 400 && status < 500) return { kind: null, trippable: false };
    // 5xx and other statuses are treated as transient service trouble.
    return { kind: FAILURE_KINDS.TRANSIENT, trippable: true };
  }
  // Network/timeout failures surfaced by the fetcher without an HTTP status.
  if (error.code === "fetch_failed" || error.code === undefined) {
    return { kind: FAILURE_KINDS.TRANSIENT, trippable: true };
  }
  // Local policy/configuration errors (allowlist, protocol, redirects, etc.)
  // are operator-side problems and must not look like a source outage.
  return { kind: null, trippable: false };
}

// Computes the pause duration for the nth consecutive failure of a given kind.
// `failureCount` is 1-based. A Retry-After hint (only meaningful for rate
// limiting) is honored but clamped to the policy window.
export function pauseDelayMs(kind, failureCount, policy = DEFAULT_PAUSE_POLICY, retryAfterMs = null) {
  const budget = policy[kind];
  if (!budget) throw new RangeError(`unknown failure kind: ${kind}`);
  const steps = Math.max(0, Number(failureCount) - 1);
  const escalated = budget.baseMs * budget.factor ** steps;
  const bounded = Math.min(budget.maxMs, Number.isFinite(escalated) ? escalated : budget.maxMs);
  if (kind === FAILURE_KINDS.RATE_LIMITED && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(budget.maxMs, Math.max(budget.baseMs, retryAfterMs));
  }
  return bounded;
}
