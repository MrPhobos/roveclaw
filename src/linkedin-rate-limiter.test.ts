import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDatabase } from './db.js';
import { LinkedInRateLimiter } from './linkedin-rate-limiter.js';

describe('LinkedInRateLimiter', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('allows calls under the daily cap', () => {
    const db = getDatabase();
    const limiter = new LinkedInRateLimiter(db, 15);
    const result = limiter.tryConsume();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(14);
  });

  it('blocks calls at the daily cap', () => {
    const db = getDatabase();
    const limiter = new LinkedInRateLimiter(db, 3);
    limiter.tryConsume();
    limiter.tryConsume();
    limiter.tryConsume();
    const result = limiter.tryConsume();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('does not count calls older than 24 hours', () => {
    const db = getDatabase();
    const limiter = new LinkedInRateLimiter(db, 2);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO linkedin_calls (called_at) VALUES (?)').run(
      oldTime,
    );
    const result = limiter.tryConsume();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('does not insert a record when blocked', () => {
    const db = getDatabase();
    const limiter = new LinkedInRateLimiter(db, 1);
    limiter.tryConsume(); // allowed, count = 1
    limiter.tryConsume(); // blocked, count stays 1
    const row = db
      .prepare('SELECT COUNT(*) as n FROM linkedin_calls')
      .get() as { n: number };
    expect(row.n).toBe(1);
  });
});
