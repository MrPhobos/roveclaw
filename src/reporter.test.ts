import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WatchtowerReporter } from './reporter.js';

describe('WatchtowerReporter', () => {
  let mockServer: http.Server;
  let receivedEvents: unknown[];
  let receivedHeartbeats: unknown[];
  const PORT = 18450;

  beforeAll(async () => {
    receivedEvents = [];
    receivedHeartbeats = [];
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (req.url === '/api/events') receivedEvents.push(parsed);
        if (req.url === '/api/heartbeat') receivedHeartbeats.push(parsed);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(JSON.stringify({ ids: [1], ok: true }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(PORT, resolve));
  });

  afterAll(async () => {
    mockServer.closeAllConnections();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('sends an event to Watchtower', async () => {
    const reporter = new WatchtowerReporter({
      url: `http://localhost:${PORT}`,
      auth: 'admin:test',
      agentId: 'rove',
      agentName: 'Rove',
      device: 'imac',
    });

    await reporter.send({
      event_type: 'session_start',
      summary: 'Rove started',
    });

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as Record<string, unknown>;
    expect(event.agent_id).toBe('rove');
    expect(event.agent_name).toBe('Rove');
    expect(event.device).toBe('imac');
    expect(event.event_type).toBe('session_start');
    expect(event.summary).toBe('Rove started');
    expect(event.timestamp).toBeDefined();
  });

  it('sends a heartbeat', async () => {
    const reporter = new WatchtowerReporter({
      url: `http://localhost:${PORT}`,
      auth: 'admin:test',
      agentId: 'rove',
      agentName: 'Rove',
      device: 'imac',
    });

    await reporter.heartbeat('active');

    expect(receivedHeartbeats).toHaveLength(1);
    const hb = receivedHeartbeats[0] as Record<string, unknown>;
    expect(hb.agent_id).toBe('rove');
    expect(hb.status).toBe('active');
  });

  it('includes parent_agent_id for sub-agents', async () => {
    const reporter = new WatchtowerReporter({
      url: `http://localhost:${PORT}`,
      auth: 'admin:test',
      agentId: 'rove-review-1',
      agentName: 'Rove Review Agent',
      device: 'imac',
      parentAgentId: 'rove',
    });

    await reporter.send({
      event_type: 'session_start',
      summary: 'Review agent spawned',
    });

    const event = receivedEvents[receivedEvents.length - 1] as Record<
      string,
      unknown
    >;
    expect(event.parent_agent_id).toBe('rove');
  });

  it('includes entities when provided', async () => {
    const reporter = new WatchtowerReporter({
      url: `http://localhost:${PORT}`,
      auth: 'admin:test',
      agentId: 'rove',
      agentName: 'Rove',
      device: 'imac',
    });

    await reporter.send({
      event_type: 'memory_write',
      summary: 'Updated learned-rules.md',
      entities: [{ type: 'file', id: 'learned-rules.md' }],
    });

    const event = receivedEvents[receivedEvents.length - 1] as Record<
      string,
      unknown
    >;
    expect(event.entities).toEqual([{ type: 'file', id: 'learned-rules.md' }]);
  });

  it('does not throw when Watchtower is unreachable', async () => {
    const reporter = new WatchtowerReporter({
      url: 'http://localhost:19999',
      auth: 'admin:test',
      agentId: 'rove',
      agentName: 'Rove',
      device: 'imac',
    });

    await expect(
      reporter.send({
        event_type: 'tool_use',
        summary: 'This should not throw',
      }),
    ).resolves.not.toThrow();
  });
});
