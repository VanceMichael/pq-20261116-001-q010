import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, pauseDelayMs, FAILURE_KINDS, DEFAULT_PAUSE_POLICY } from "../../src/service/failure-policy.js";

function httpError(status, extra = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { code: "http_status", status, ...extra });
}

test("classifies rate limiting, explicit unavailability and transient service errors differently", () => {
  assert.deepEqual(classifyFailure(httpError(429)), { kind: FAILURE_KINDS.RATE_LIMITED, trippable: true });
  assert.deepEqual(classifyFailure(httpError(404)), { kind: FAILURE_KINDS.UNAVAILABLE, trippable: true });
  assert.deepEqual(classifyFailure(httpError(410)), { kind: FAILURE_KINDS.UNAVAILABLE, trippable: true });
  assert.deepEqual(classifyFailure(httpError(503)), { kind: FAILURE_KINDS.TRANSIENT, trippable: true });
  assert.deepEqual(classifyFailure(httpError(500)), { kind: FAILURE_KINDS.TRANSIENT, trippable: true });
});

test("treats network/timeout failures as transient source trouble", () => {
  assert.deepEqual(
    classifyFailure(Object.assign(new Error("socket hang up"), { code: "fetch_failed", attemptCount: 3 })),
    { kind: FAILURE_KINDS.TRANSIENT, trippable: true }
  );
});

test("does not trip a pause for local policy and non-outage HTTP client errors", () => {
  assert.equal(classifyFailure(httpError(403)).trippable, false);
  assert.equal(classifyFailure(httpError(400)).trippable, false);
  for (const code of ["host_not_allowed", "unsafe_protocol", "redirect_loop", "content_type", "response_too_large"]) {
    const result = classifyFailure(Object.assign(new Error(code), { code }));
    assert.equal(result.trippable, false, code);
    assert.equal(result.kind, null, code);
  }
});

test("escalates transient back-off with each consecutive failure up to the cap", () => {
  assert.equal(pauseDelayMs(FAILURE_KINDS.TRANSIENT, 1), 30_000);
  assert.equal(pauseDelayMs(FAILURE_KINDS.TRANSIENT, 2), 60_000);
  assert.equal(pauseDelayMs(FAILURE_KINDS.TRANSIENT, 3), 120_000);
  assert.equal(pauseDelayMs(FAILURE_KINDS.TRANSIENT, 20), 5 * 60_000);
});

test("escalates rate-limit pauses but honors a Retry-After hint inside the window", () => {
  assert.equal(pauseDelayMs(FAILURE_KINDS.RATE_LIMITED, 1), 60_000);
  assert.equal(pauseDelayMs(FAILURE_KINDS.RATE_LIMITED, 2), 120_000);
  assert.equal(pauseDelayMs(FAILURE_KINDS.RATE_LIMITED, 1, DEFAULT_PAUSE_POLICY, 90_000), 90_000);
  // Hint is clamped to the configured maximum.
  assert.equal(pauseDelayMs(FAILURE_KINDS.RATE_LIMITED, 1, DEFAULT_PAUSE_POLICY, 999_999_999), 15 * 60_000);
  // A hint below the base still respects the minimum floor.
  assert.equal(pauseDelayMs(FAILURE_KINDS.RATE_LIMITED, 1, DEFAULT_PAUSE_POLICY, 1_000), 60_000);
});

test("keeps explicit unavailability on a fixed long window", () => {
  assert.equal(pauseDelayMs(FAILURE_KINDS.UNAVAILABLE, 1), 30 * 60_000);
  assert.equal(pauseDelayMs(FAILURE_KINDS.UNAVAILABLE, 5), 30 * 60_000);
});

test("rejects unknown failure kinds instead of producing NaN delays", () => {
  assert.throws(() => pauseDelayMs("mystery", 1), /unknown failure kind/);
});
