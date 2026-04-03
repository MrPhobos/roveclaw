import http from 'http';
import { LinkedInRateLimiter } from './linkedin-rate-limiter.js';
import { logger } from './logger.js';

const ALLOWED_TOOLS = new Set([
  'search_jobs',
  'get_job_details',
  'get_company_profile',
  'search_people',
  'get_person_profile',
  'close_session',
]);

interface ProxyConfig {
  limiter: LinkedInRateLimiter;
  upstreamPort: number;
  port: number;
  onEvent?: (event: {
    type: string;
    toolName: string;
    remaining?: number;
    blocked?: boolean;
  }) => void;
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

export function createLinkedInProxy(config: ProxyConfig): http.Server {
  const { limiter, upstreamPort } = config;

  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    let bodyBytes = 0;
    const MAX_BODY_BYTES = 1_048_576; // 1 MB
    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413);
          res.end();
        }
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      let parsed: {
        jsonrpc: string;
        id: unknown;
        method: string;
        params?: { name?: string };
      };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonRpcError(null, -32700, 'Parse error'));
        return;
      }

      if (parsed.method === 'tools/call') {
        const toolName = parsed.params?.name ?? '';

        if (!ALLOWED_TOOLS.has(toolName)) {
          logger.warn({ toolName }, 'LinkedIn proxy: blocked disallowed tool');
          config.onEvent?.({
            type: 'blocked_tool',
            toolName,
            blocked: true,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            jsonRpcError(
              parsed.id,
              -32601,
              `Tool '${toolName}' is not permitted`,
            ),
          );
          return;
        }

        const rateResult = limiter.tryConsume();
        if (!rateResult.allowed) {
          logger.warn('LinkedIn proxy: daily limit reached');
          config.onEvent?.({
            type: 'rate_limited',
            toolName,
            blocked: true,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            jsonRpcError(
              parsed.id,
              -32000,
              'LinkedIn daily limit reached. Use web search instead.',
            ),
          );
          return;
        }

        logger.debug(
          { toolName, remaining: rateResult.remaining },
          'LinkedIn proxy: forwarding',
        );

        config.onEvent?.({
          type: 'forwarded',
          toolName,
          remaining: rateResult.remaining,
        });
      }

      const upstreamReq = http.request(
        {
          hostname: 'localhost',
          port: upstreamPort,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstreamReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            jsonRpcError(parsed.id, -32603, 'LinkedIn MCP server unavailable'),
          );
        } else {
          res.destroy();
        }
      });
      upstreamReq.write(body);
      upstreamReq.end();
    });
  });
}
