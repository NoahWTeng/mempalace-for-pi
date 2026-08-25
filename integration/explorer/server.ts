import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import type { ExplorerAdapter } from './adapter.ts';

const TOKEN_BYTES = 32;
const LOOPBACK = '127.0.0.1';
const BEARER_PREFIX = 'Bearer ';
const AUTHENTICATION_CHALLENGE = 'Bearer realm="MemPalace explorer"';
const JSON_MEDIA_TYPE = 'application/json; charset=utf-8';
const INDEX_ASSET = 'index.html';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const ASSET_MEDIA_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

const JSON_UNSAFE = /[<>&\u2028\u2029]/gu;

export interface ExplorerServerOptions {
  readonly adapter: ExplorerAdapter;
  readonly assetRoot: string;
}

export interface ExplorerServer {
  readonly url: string;
  readonly origin: string;
  close(): Promise<void>;
}

function inertJson(value: unknown): string {
  return JSON.stringify(value).replace(
    JSON_UNSAFE,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function tokenAccepted(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return false;
  const offered = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

function boundedVisible(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function startExplorerServer(options: ExplorerServerOptions): Promise<ExplorerServer> {
  const adapter = options.adapter;
  const assetRoot = resolve(options.assetRoot);
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  let authority = '';
  let origin = '';

  function send(
    response: ServerResponse,
    status: number,
    mediaType: string,
    body: string | Buffer,
    extra: Record<string, string> = {},
  ): void {
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      ...extra,
      'content-type': mediaType,
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  function sendJson(response: ServerResponse, status: number, value: unknown): void {
    send(response, status, JSON_MEDIA_TYPE, inertJson(value));
  }

  function refuse(
    response: ServerResponse,
    status: number,
    error: string,
    extra: Record<string, string> = {},
  ): void {
    send(response, status, JSON_MEDIA_TYPE, inertJson({ error }), extra);
  }

  function assetFile(pathname: string): { path: string; mediaType: string } | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const requested = decoded === '/' ? INDEX_ASSET : decoded.replace(/^\/+/u, '');
    const path = resolve(assetRoot, requested);
    if (path !== assetRoot && !path.startsWith(assetRoot + sep)) return null;
    const mediaType = ASSET_MEDIA_TYPES.get(extname(path).toLowerCase());
    return mediaType === undefined ? null : { path, mediaType };
  }

  async function serveAsset(response: ServerResponse, pathname: string): Promise<void> {
    const asset = assetFile(pathname);
    if (asset === null) return refuse(response, 404, 'not found');
    let body: Buffer;
    try {
      body = await readFile(asset.path);
    } catch {
      return refuse(response, 404, 'not found');
    }
    send(response, 200, asset.mediaType, body);
  }

  async function serveMemory(response: ServerResponse, target: URL): Promise<void> {
    switch (target.pathname) {
      case '/api/recent':
        return sendJson(response, 200, await adapter.recent());
      case '/api/search':
        return sendJson(response, 200, await adapter.search(target.searchParams.get('query') ?? ''));
      case '/api/details': {
        const id = target.searchParams.get('id');
        if (id === null || id === '') return refuse(response, 400, 'invalid request');
        const details = await adapter.details(id);
        return details === null
          ? refuse(response, 404, 'not found')
          : sendJson(response, 200, details);
      }
      case '/api/neighborhood': {
        const id = target.searchParams.get('id');
        if (id === null || id === '') return refuse(response, 400, 'invalid request');
        const rawVisible = target.searchParams.get('visible');
        const visible = boundedVisible(rawVisible);
        if (rawVisible !== null && visible === undefined) return refuse(response, 400, 'invalid request');
        const neighborhood = visible === undefined
          ? await adapter.neighborhood(id)
          : await adapter.neighborhood(id, { visible });
        return neighborhood === null
          ? refuse(response, 404, 'not found')
          : sendJson(response, 200, neighborhood);
      }
      default:
        return refuse(response, 404, 'not found');
    }
  }

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET') return refuse(response, 405, 'method not allowed', { allow: 'GET' });
    if (request.headers.host !== authority) return refuse(response, 403, 'forbidden');
    const declaredOrigin = request.headers.origin;
    if (declaredOrigin !== undefined && declaredOrigin !== origin) {
      return refuse(response, 403, 'forbidden');
    }

    const target = new URL(request.url ?? '/', origin);
    if (!target.pathname.startsWith('/api/')) return serveAsset(response, target.pathname);
    if (!tokenAccepted(request.headers.authorization, token)) {
      return refuse(response, 401, 'unauthorized', { 'www-authenticate': AUTHENTICATION_CHALLENGE });
    }
    try {
      return await serveMemory(response, target);
    } catch {
      return refuse(response, 500, 'unavailable');
    }
  }

  const server = createServer((request, response) => {
    request.resume();
    void answer(request, response).catch(() => {
      if (response.headersSent) response.end(); else refuse(response, 500, 'unavailable');
    });
  });

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((closed) => {
      server.closeAllConnections();
      server.close(() => closed());
    });
    return closing;
  }

  return new Promise<ExplorerServer>((started, failed) => {
    server.once('error', failed);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      authority = `${LOOPBACK}:${port}`;
      origin = `http://${authority}`;
      server.removeListener('error', failed);
      started({ url: `${origin}/#token=${token}`, origin, close });
    });
  });
}
