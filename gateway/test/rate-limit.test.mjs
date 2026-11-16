import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/server.mjs';

test('activation limiter rejects repeated attempts until its window expires', () => {
  let current = 0;
  const limit = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => current });

  limit('203.0.113.7');
  limit('203.0.113.7');
  assert.throws(() => limit('203.0.113.7'), (error) => error?.status === 429 && error?.code === 'rate_limited');

  current = 60_001;
  assert.doesNotThrow(() => limit('203.0.113.7'));
});
