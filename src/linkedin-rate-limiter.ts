import type Database from 'better-sqlite3';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export class LinkedInRateLimiter {
  private readonly db: InstanceType<typeof Database>;
  private readonly dailyCap: number;

  constructor(db: InstanceType<typeof Database>, dailyCap = 15) {
    this.db = db;
    this.dailyCap = dailyCap;
  }

  tryConsume(): RateLimitResult {
    const windowStart = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const { n: count } = this.db
      .prepare('SELECT COUNT(*) as n FROM linkedin_calls WHERE called_at > ?')
      .get(windowStart) as { n: number };

    if (count >= this.dailyCap) {
      return { allowed: false, remaining: 0 };
    }

    this.db
      .prepare('INSERT INTO linkedin_calls (called_at) VALUES (?)')
      .run(new Date().toISOString());

    return { allowed: true, remaining: this.dailyCap - count - 1 };
  }
}
