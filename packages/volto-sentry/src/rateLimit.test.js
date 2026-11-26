import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIMITS,
  MAX_TRACKED_ERRORS,
  createEventRateLimiter,
  readLimits,
  withEventLimits,
} from './rateLimit';

const clock = () => {
  let now = 1000000;
  const fn = () => now;
  fn.advance = (seconds) => {
    now += seconds * 1000;
  };
  return fn;
};

const error = ({ type = 'TypeError', lineno = 10, message } = {}) =>
  message !== undefined
    ? { message }
    : {
        exception: {
          values: [
            {
              type,
              stacktrace: {
                frames: [{ filename: 'app.js', function: 'render', lineno }],
              },
            },
          ],
        },
      };

const sent = (limiter, events) => events.filter((e) => limiter(e)).length;
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

describe('createEventRateLimiter', () => {
  it('allows a burst, then the hourly rate', () => {
    const now = clock();
    const limiter = createEventRateLimiter(
      { maxPerHour: 60, burst: 5, maxPerError: 0 },
      now,
    );
    const events = many(10, (i) => error({ lineno: i }));
    expect(sent(limiter, events)).toBe(5);
    // 60 an hour is one a minute.
    now.advance(60);
    expect(sent(limiter, events)).toBe(1);
    now.advance(3600);
    expect(sent(limiter, events)).toBe(5);
  });

  it('caps the same error separately', () => {
    const limiter = createEventRateLimiter(
      { maxPerHour: 60, burst: 20, maxPerError: 3 },
      clock(),
    );
    expect(
      sent(
        limiter,
        many(10, () => error()),
      ),
    ).toBe(3);
    expect(
      sent(
        limiter,
        many(10, () => error({ type: 'RangeError' })),
      ),
    ).toBe(3);
    expect(limiter.dropped).toBe(14);
  });

  it('keys messages by their text', () => {
    const limiter = createEventRateLimiter(
      { maxPerHour: 0, burst: 0, maxPerError: 2 },
      clock(),
    );
    expect(
      sent(
        limiter,
        many(5, () => error({ message: 'SSR error' })),
      ),
    ).toBe(2);
    expect(sent(limiter, [error({ message: 'other' })])).toBe(1);
  });

  it('does not use an overall token for a dropped event', () => {
    const limiter = createEventRateLimiter(
      { maxPerHour: 60, burst: 5, maxPerError: 1 },
      clock(),
    );
    sent(
      limiter,
      many(10, () => error()),
    );
    expect(
      sent(
        limiter,
        many(10, (i) => error({ lineno: 100 + i })),
      ),
    ).toBe(4);
  });

  it('never limits transactions', () => {
    const limiter = createEventRateLimiter(
      { maxPerHour: 60, burst: 1, maxPerError: 1 },
      clock(),
    );
    expect(
      sent(
        limiter,
        many(10, () => ({ type: 'transaction' })),
      ),
    ).toBe(10);
  });

  it('keeps the tracked errors bounded', () => {
    const limiter = createEventRateLimiter(
      { maxPerHour: 0, burst: 0, maxPerError: 1 },
      clock(),
    );
    sent(
      limiter,
      many(3000, (i) => error({ lineno: i })),
    );
    expect(limiter.errors.size).toBeLessThanOrEqual(MAX_TRACKED_ERRORS);
  });

  it('is off when both limits are 0', () => {
    expect(
      createEventRateLimiter({ maxPerHour: 0, burst: 0, maxPerError: 0 }),
    ).toBeNull();
  });
});

describe('readLimits', () => {
  it('uses the defaults', () => {
    expect(readLimits({})).toEqual(DEFAULT_LIMITS);
  });

  it('reads the environment variables', () => {
    expect(
      readLimits({
        RAZZLE_SENTRY_MAX_EVENTS_PER_HOUR: '30',
        RAZZLE_SENTRY_MAX_EVENTS_BURST: '5',
        RAZZLE_SENTRY_MAX_EVENTS_PER_ERROR: '0',
      }),
    ).toEqual({ maxPerHour: 30, burst: 5, maxPerError: 0 });
  });

  it('falls back to the default on a malformed value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      readLimits({ RAZZLE_SENTRY_MAX_EVENTS_PER_ERROR: 'many' }).maxPerError,
    ).toBe(DEFAULT_LIMITS.maxPerError);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('withEventLimits', () => {
  const limits = { maxPerHour: 60, burst: 20, maxPerError: 2 };

  it('drops events beyond the limits', () => {
    const beforeSend = withEventLimits(undefined, limits, clock());
    const results = many(5, () => beforeSend(error(), {}));
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it("runs the deployer's beforeSend first", () => {
    let drop = true;
    const own = vi.fn((event) => (drop ? null : event));
    const beforeSend = withEventLimits(own, limits, clock());
    many(5, () => beforeSend(error(), {}));
    expect(own).toHaveBeenCalledTimes(5);
    // Nothing the deployer dropped used a token.
    drop = false;
    const results = many(5, () => beforeSend(error(), {}));
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it('handles a beforeSend that returns a promise', async () => {
    const beforeSend = withEventLimits(async (event) => event, limits, clock());
    const results = await Promise.all(many(5, () => beforeSend(error(), {})));
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it("returns the deployer's beforeSend unchanged when limits are off", () => {
    const own = (event) => event;
    expect(
      withEventLimits(own, { maxPerHour: 0, burst: 0, maxPerError: 0 }),
    ).toBe(own);
  });
});
