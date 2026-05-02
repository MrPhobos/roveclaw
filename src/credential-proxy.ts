/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request (read from .env).
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Token lifecycle: on startup and periodically, the proxy checks whether
 * the OAuth access token in ~/.claude/.credentials.json is expired (or
 * about to expire) and uses the refresh token to obtain a new one. This
 * keeps the credentials file fresh for both proxied requests and for
 * containers that read the file directly.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (() => {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 30 * 60 * 1000; // refresh 30 minutes before expiry
const REFRESH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // check every 30 minutes
const BACKOFF_BASE_MS = 5 * 60 * 1000; // initial backoff: 5 minutes
const BACKOFF_MAX_MS = 60 * 60 * 1000; // max backoff: 1 hour

// Serializes concurrent refresh attempts so only one runs at a time
let refreshInFlight: Promise<string | null> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshBackoffUntil = 0; // timestamp - skip refresh attempts until this time
let consecutiveFailures = 0; // tracks failures for exponential backoff

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

function readCredentialsFile(): { claudeAiOauth?: OAuthCredentials } | null {
  try {
    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    logger.warn(
      { err, path: CREDENTIALS_PATH },
      'Failed to read credentials file',
    );
    return null;
  }
}

function writeCredentialsFile(data: Record<string, unknown>): void {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function isTokenExpired(oauth: OAuthCredentials): boolean {
  return Date.now() >= oauth.expiresAt - REFRESH_MARGIN_MS;
}

/**
 * Refresh the OAuth access token using the refresh token.
 */
function doRefresh(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  return new Promise((resolve) => {
    const postBody = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    });

    const req = httpsRequest(
      {
        hostname: 'platform.claude.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(postBody),
          'user-agent': `claude-code/${PKG_VERSION}`,
        },
        timeout: 15000,
      },
      (res) => {
        // Follow redirects (e.g. Cloudflare 302)
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          logger.warn(
            { statusCode: res.statusCode, location: res.headers.location },
            'OAuth refresh redirected, following',
          );
          const redirectUrl = new URL(res.headers.location);
          const redirectReq = httpsRequest(
            {
              hostname: redirectUrl.hostname,
              port: 443,
              path: redirectUrl.pathname + redirectUrl.search,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(postBody),
                'user-agent': `claude-code/${PKG_VERSION}`,
              },
              timeout: 15000,
            },
            (redirectRes) => {
              const rChunks: Buffer[] = [];
              redirectRes.on('data', (c) => rChunks.push(c));
              redirectRes.on('end', () => {
                if (redirectRes.statusCode !== 200) {
                  logger.error(
                    { statusCode: redirectRes.statusCode },
                    'OAuth refresh failed after redirect',
                  );
                  consecutiveFailures++;
                  resolve(null);
                  return;
                }
                try {
                  const data = JSON.parse(Buffer.concat(rChunks).toString());
                  consecutiveFailures = 0;
                  resolve({
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    expiresIn: data.expires_in,
                  });
                } catch (err) {
                  logger.error(
                    { err },
                    'Failed to parse redirect refresh response',
                  );
                  resolve(null);
                }
              });
            },
          );
          redirectReq.on('error', (err) => {
            logger.error({ err }, 'Redirect request error');
            resolve(null);
          });
          redirectReq.on('timeout', () => {
            redirectReq.destroy();
            logger.error('Redirect request timed out');
            resolve(null);
          });
          redirectReq.write(postBody);
          redirectReq.end();
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const respBody = Buffer.concat(chunks).toString();
            if (res.statusCode === 429) {
              consecutiveFailures++;
              const backoffMs = Math.min(
                BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1),
                BACKOFF_MAX_MS,
              );
              refreshBackoffUntil = Date.now() + backoffMs;
              logger.warn(
                { backoffMs, consecutiveFailures },
                `OAuth refresh rate limited, backing off ${Math.round(backoffMs / 60000)} minutes`,
              );
            } else {
              consecutiveFailures++;
            }
            logger.error(
              { statusCode: res.statusCode, body: respBody },
              'OAuth token refresh failed',
            );
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresIn: data.expires_in,
            });
          } catch (err) {
            logger.error({ err }, 'Failed to parse refresh response');
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth refresh request error');
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      logger.error('OAuth refresh request timed out');
      resolve(null);
    });

    req.write(postBody);
    req.end();
  });
}

/**
 * Ensure the credentials file has a valid (non-expired) token.
 * If expired, refresh and write back. Concurrent callers share one in-flight refresh.
 * Returns the valid access token, or null on failure.
 */
async function ensureValidToken(): Promise<string | null> {
  const creds = readCredentialsFile();
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null;

  if (!isTokenExpired(oauth)) {
    return oauth.accessToken;
  }

  if (!oauth.refreshToken) {
    logger.error('Token expired and no refresh token available');
    return null;
  }

  // Back off after rate limit errors
  if (Date.now() < refreshBackoffUntil) {
    return null;
  }

  // Serialize: if a refresh is already running, wait for it
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    logger.info('OAuth token expired, refreshing...');
    const result = await doRefresh(oauth.refreshToken);
    if (!result) {
      logger.error(
        'Token refresh failed - agents will get 401s until credentials are manually updated',
      );
      return null;
    }

    // Re-read the file in case something else wrote to it
    const freshCreds = readCredentialsFile() || {};
    const freshOauth = (freshCreds as Record<string, unknown>).claudeAiOauth as
      | OAuthCredentials
      | undefined;

    consecutiveFailures = 0;
    const updatedOauth: OAuthCredentials = {
      ...(freshOauth || oauth),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
    };

    writeCredentialsFile({ ...freshCreds, claudeAiOauth: updatedOauth });
    logger.info(
      { expiresAt: new Date(updatedOauth.expiresAt).toISOString() },
      'OAuth token refreshed successfully',
    );
    return result.accessToken;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * Start a background timer that proactively refreshes the token before expiry.
 * This ensures the credentials file always has a valid token, even if no
 * proxied requests trigger a refresh.
 */
function startRefreshTimer(): void {
  // Refresh immediately on startup if needed
  ensureValidToken().catch((err) => {
    logger.error({ err }, 'Initial token refresh check failed');
  });

  refreshTimer = setInterval(() => {
    ensureValidToken().catch((err) => {
      logger.error({ err }, 'Periodic token refresh check failed');
    });
  }, REFRESH_CHECK_INTERVAL_MS);
}

function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Read the current OAuth access token from ~/.claude/.credentials.json.
 * Returns null if the file does not exist or cannot be parsed.
 */
function readOAuthTokenFromCredentials(): string | null {
  const creds = readCredentialsFile();
  return creds?.claudeAiOauth?.accessToken || null;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  // Start proactive token refresh for OAuth mode
  if (authMode === 'oauth') {
    startRefreshTimer();
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            const oauthToken = readOAuthTokenFromCredentials();
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.on('close', () => {
      stopRefreshTimer();
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
