import Database from 'better-sqlite3';
import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLinkedInProxy } from './linkedin-proxy.js';
import { LinkedInRateLimiter } from './linkedin-rate-limiter.js';

function makeTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE linkedin_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, called_at TEXT NOT NULL);`,
  );
  return db;
}

function postJson(port: number, body: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('createLinkedInProxy', () => {
  let proxy: http.Server;
  const PORT = 18082;

  beforeEach(() => {
    const limiter = new LinkedInRateLimiter(makeTestDb(), 15);
    // upstreamPort 19999 is intentionally not running — blocked calls never reach it
    proxy = createLinkedInProxy({ limiter, upstreamPort: 19999, port: PORT });
    return new Promise<void>((resolve) => proxy.listen(PORT, resolve));
  });

  afterEach(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

  it('rejects send_message tool calls', async () => {
    const res = (await postJson(PORT, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'send_message',
        arguments: { recipient: 'x', message: 'y' },
      },
    })) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain('not permitted');
  });

  it('rejects connect_with_person tool calls', async () => {
    const res = (await postJson(PORT, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'connect_with_person', arguments: {} },
    })) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32601);
  });

  it('rejects calls when rate limit is exceeded', async () => {
    const limiter = new LinkedInRateLimiter(makeTestDb(), 0);
    const localProxy = createLinkedInProxy({
      limiter,
      upstreamPort: 19999,
      port: 18083,
    });
    await new Promise<void>((resolve) => localProxy.listen(18083, resolve));
    try {
      const res = (await postJson(18083, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_jobs', arguments: { keywords: 'PM' } },
      })) as { error: { code: number; message: string } };
      expect(res.error.code).toBe(-32000);
      expect(res.error.message).toContain('daily limit');
    } finally {
      await new Promise<void>((resolve) => localProxy.close(() => resolve()));
    }
  });

  it('returns 404 for non-MCP paths', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: PORT, path: '/other', method: 'GET' },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(res).toBe(404);
  });
});
