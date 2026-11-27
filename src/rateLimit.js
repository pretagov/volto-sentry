/**
 * Cap how many error events one process (the SSR server) or one page (the
 * browser) sends to Sentry.
 *
 * A fault that repeats on every request or render, or in a loop, can send
 * thousands of events a minute and use up a month's Sentry quota in one go.
 * Two token buckets apply, both refilled continuously over an hour:
 *
 * - one overall: `RAZZLE_SENTRY_MAX_EVENTS_PER_HOUR` events an hour, with up
 *   to `RAZZLE_SENTRY_MAX_EVENTS_BURST` at once;
 * - one per error (exception type and the line that threw it, or the
 *   message): `RAZZLE_SENTRY_MAX_EVENTS_PER_ERROR` events an hour, all of
 *   which may come at once.
 *
 * An event is sent only if both buckets have a token. A value of 0 turns that
 * bucket off. Transactions and other non-error events are never limited.
 */

export const DEFAULT_LIMITS = {
  maxPerHour: 60,
  burst: 20,
  maxPerError: 10,
};

// Error buckets kept before idle (full) ones are pruned.
export const MAX_TRACKED_ERRORS = 1000;
// How often, at most, the SSR server warns that it is dropping events.
const WARN_INTERVAL = 600 * 1000;

const ENV_NAMES = {
  maxPerHour: 'RAZZLE_SENTRY_MAX_EVENTS_PER_HOUR',
  burst: 'RAZZLE_SENTRY_MAX_EVENTS_BURST',
  maxPerError: 'RAZZLE_SENTRY_MAX_EVENTS_PER_ERROR',
};

const createBucket = (capacity, perHour, now) => ({
  capacity,
  rate: perHour / 3600 / 1000, // tokens per millisecond
  tokens: capacity,
  updated: now,
});

const refill = (bucket, now) => {
  const elapsed = Math.max(0, now - bucket.updated);
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + elapsed * bucket.rate,
  );
  bucket.updated = now;
};

/**
 * What counts as "the same error" for the per-error cap.
 * @param {Object} event A Sentry event.
 * @returns {string} The key.
 */
export const errorKey = (event) => {
  const values = event?.exception?.values || [];
  if (values.length) {
    // Sentry lists chained exceptions oldest first: the last one is the
    // exception that was thrown.
    const exception = values[values.length - 1];
    const frames = exception?.stacktrace?.frames || [];
    const frame = frames[frames.length - 1] || {};
    return JSON.stringify([
      exception.type,
      frame.module || frame.filename,
      frame.function,
      frame.lineno,
    ]);
  }
  return JSON.stringify([
    'message',
    event?.logentry?.message || event?.message,
  ]);
};

/**
 * Read the limits from environment variables. A missing or malformed value
 * falls back to the default: a typo must not break the page or the server.
 * @param {Object} env `process.env` on the server, `window.env` in the browser.
 * @returns {Object} The limits.
 */
export const readLimits = (env = {}) => {
  const limits = { ...DEFAULT_LIMITS };
  Object.entries(ENV_NAMES).forEach(([option, name]) => {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return;
    }
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0) {
      limits[option] = value;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `${name} must be a whole number, 0 to turn it off; got ${raw}. Using ${limits[option]}.`,
      );
    }
  });
  if (limits.maxPerHour && !limits.burst) {
    limits.burst = 1;
  }
  return limits;
};

/**
 * @param {Object} limits From `readLimits`.
 * @param {Function} now Clock in milliseconds, for tests.
 * @returns {Function|null} `(event) => boolean`, or null when both limits are off.
 */
export const createEventRateLimiter = (
  { maxPerHour, burst, maxPerError } = DEFAULT_LIMITS,
  now = () => Date.now(),
) => {
  if (!maxPerHour && !maxPerError) {
    return null;
  }
  const total = maxPerHour ? createBucket(burst, maxPerHour, now()) : null;
  const errors = new Map();
  let lastWarning = null;

  const prune = (time) => {
    errors.forEach((bucket, key) => {
      refill(bucket, time);
      if (bucket.tokens >= bucket.capacity) {
        errors.delete(key);
      }
    });
    if (errors.size >= MAX_TRACKED_ERRORS) {
      // Everything is busy: start the per-error counts afresh rather than
      // grow without bound.
      errors.clear();
    }
  };

  const limiter = (event) => {
    if (event?.type && event.type !== 'error') {
      return true;
    }
    const time = now();
    const buckets = [];
    if (total) {
      refill(total, time);
      buckets.push(total);
    }
    if (maxPerError) {
      const key = errorKey(event);
      let bucket = errors.get(key);
      if (!bucket) {
        if (errors.size >= MAX_TRACKED_ERRORS) {
          prune(time);
        }
        bucket = createBucket(maxPerError, maxPerError, time);
        errors.set(key, bucket);
      } else {
        refill(bucket, time);
      }
      buckets.push(bucket);
    }
    if (buckets.every((bucket) => bucket.tokens >= 1)) {
      buckets.forEach((bucket) => {
        bucket.tokens -= 1;
      });
      return true;
    }
    limiter.dropped += 1;
    const onServer = typeof __SERVER__ !== 'undefined' && __SERVER__;
    if (
      onServer &&
      (lastWarning === null || time - lastWarning >= WARN_INTERVAL)
    ) {
      lastWarning = time;
      // A warning, not an error: volto-sentry reports console.error calls.
      // eslint-disable-next-line no-console
      console.warn(
        `Sentry event limit reached: ${limiter.dropped} events dropped so far (${Object.values(ENV_NAMES).join(', ')})`,
      );
    }
    return false;
  };
  limiter.dropped = 0;
  limiter.errors = errors;
  return limiter;
};

/**
 * Wrap a `beforeSend` so that events beyond the limits are dropped. The
 * deployer's own `beforeSend` runs first, so events it drops use no tokens.
 * @param {Function} beforeSend The deployer's `beforeSend`, if any.
 * @param {Object} limits From `readLimits`.
 * @param {Function} now Clock in milliseconds, for tests.
 * @returns {Function|undefined} The `beforeSend` to pass to `Sentry.init`.
 */
export const withEventLimits = (beforeSend, limits, now) => {
  const limiter = createEventRateLimiter(limits, now);
  if (!limiter) {
    return beforeSend;
  }
  const limit = (event) => (event && limiter(event) ? event : null);
  return (event, hint) => {
    const result = beforeSend ? beforeSend(event, hint) : event;
    if (result && typeof result.then === 'function') {
      return result.then(limit);
    }
    return limit(result);
  };
};
