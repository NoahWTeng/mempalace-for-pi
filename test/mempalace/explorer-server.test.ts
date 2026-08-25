import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import type {
  ExplorerAdapter,
  ExplorerDetails,
  ExplorerMemory,
  ExplorerNeighborhood,
  ExplorerPage,
  ExplorerSearchPage,
} from '../../integration/explorer/adapter.ts';
import { createExplorerHost, EXPLORER_COMMAND_NAME } from '../../integration/explorer/command.ts';
import { startExplorerServer, type ExplorerServer } from '../../integration/explorer/server.ts';

const HOSTILE_TEXT = '</script><img src=x onerror="alert(1)"> & \u2028 \u2029 done';
const SECRET_OUTSIDE_ROOT = 'top secret outside the asset root';
const INDEX_HTML = '<!doctype html><title>explorer</title>';
const APP_JS = 'export const explorer = true;';

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

const scratch: string[] = [];
const openServers: ExplorerServer[] = [];
after(async () => {
  for (const server of openServers) await server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function assetRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), 'mempalace-explorer-'));
  scratch.push(parent);
  const root = join(parent, 'assets');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), INDEX_HTML);
  writeFileSync(join(root, 'app.js'), APP_JS);
  writeFileSync(join(root, 'styles.css'), 'body { color: black; }');
  writeFileSync(join(parent, 'outside.txt'), SECRET_OUTSIDE_ROOT);
  return root;
}

function memory(id: string, title: string): ExplorerMemory {
  return {
    id,
    room: 'decisions',
    title,
    preview: title,
    source: { scope: 'project', label: 'docs/notes.md' },
    recordedAt: '2026-08-01T00:00:00Z',
    authoredAt: null,
    chunks: 2,
    evidence: 1,
  };
}

const RECENT: ExplorerPage = {
  memories: [memory('handle-1', HOSTILE_TEXT)],
  available: 3,
  displayed: 1,
  omitted: 2,
};
const SEARCH: ExplorerSearchPage = {
  query: 'needle',
  hits: [{ ...memory('handle-1', HOSTILE_TEXT), resolved: true }],
  available: 1,
  displayed: 1,
  omitted: 0,
  unresolved: 0,
};
const DETAILS: ExplorerDetails = { ...memory('handle-1', HOSTILE_TEXT), content: HOSTILE_TEXT };
const NEIGHBORHOOD: ExplorerNeighborhood = {
  seed: memory('handle-1', HOSTILE_TEXT),
  relationships: [],
  available: 0,
  displayed: 0,
  omitted: 0,
  knowledgeGraph: 'unavailable',
};

function recordingAdapter(calls: Call[]): ExplorerAdapter {
  return {
    async recent() {
      calls.push({ name: 'recent', args: [] });
      return RECENT;
    },
    async search(query, options) {
      calls.push({ name: 'search', args: options === undefined ? [query] : [query, options] });
      return SEARCH;
    },
    async details(id) {
      calls.push({ name: 'details', args: [id] });
      return id === 'handle-1' ? DETAILS : null;
    },
    async neighborhood(id, options) {
      calls.push({ name: 'neighborhood', args: [id, options ?? {}] });
      return id === 'handle-1' ? NEIGHBORHOOD : null;
    },
  };
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function ask(
  origin: string,
  rawPath: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const target = new URL(origin);
  return new Promise((settle, fail) => {
    const call = request(
      {
        agent: false,
        host: target.hostname,
        port: target.port,
        method: options.method ?? 'GET',
        path: rawPath,
        headers: options.headers ?? {},
      },
      (answer) => {
        let body = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk: string) => {
          body += chunk;
        });
        answer.on('end', () => settle({ status: answer.statusCode ?? 0, headers: answer.headers, body }));
      },
    );
    call.on('error', fail);
    call.end();
  });
}

function header(answer: Answer, name: string): string {
  const value = answer.headers[name];
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

function tokenOf(url: string): string {
  const marker = '#token=';
  const at = url.indexOf(marker);
  assert.notEqual(at, -1, `the URL carries no token fragment: ${url}`);
  return url.slice(at + marker.length);
}

function bearer(url: string): Record<string, string> {
  return { authorization: `Bearer ${tokenOf(url)}` };
}

interface Harness {
  readonly server: ExplorerServer;
  readonly calls: Call[];
}

async function harness(): Promise<Harness> {
  const calls: Call[] = [];
  const server = await startExplorerServer({ adapter: recordingAdapter(calls), assetRoot: assetRoot() });
  openServers.push(server);
  return { server, calls };
}

test('the explorer binds loopback only and hands its token through the URL fragment', async () => {
  const { server } = await harness();
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}$/u);
  assert.equal(tokenOf(server.url).length, 64, 'the token must carry 256 bits of randomness');
  assert.equal(new URL(server.origin).hostname, '127.0.0.1');
  assert.notEqual(new URL(server.origin).port, '0', 'the host must publish its assigned ephemeral port');
  const beforeFragment = server.url.slice(0, server.url.indexOf('#'));
  assert.equal(beforeFragment.includes(tokenOf(server.url)), false, 'the token must never leave the fragment');
  assert.equal(new URL(beforeFragment).search, '', 'the token must never travel as a query parameter');

  const second = await startExplorerServer({ adapter: recordingAdapter([]), assetRoot: assetRoot() });
  openServers.push(second);
  assert.notEqual(tokenOf(second.url), tokenOf(server.url), 'each host must mint its own token');
});

test('a valid bearer token unlocks exactly the coordinated read contract', async () => {
  const { server, calls } = await harness();
  const headers = bearer(server.url);

  const recent = await ask(server.origin, '/api/recent', { headers });
  assert.equal(recent.status, 200);
  assert.match(header(recent, 'content-type'), /^application\/json/u);
  assert.deepEqual(JSON.parse(recent.body), RECENT);

  const search = await ask(server.origin, '/api/search?query=needle', { headers });
  assert.equal(search.status, 200);
  assert.deepEqual(JSON.parse(search.body), SEARCH);

  const details = await ask(server.origin, '/api/details?id=handle-1', { headers });
  assert.equal(details.status, 200);
  assert.deepEqual(JSON.parse(details.body), DETAILS);

  const neighborhood = await ask(server.origin, '/api/neighborhood?id=handle-1&visible=7', { headers });
  assert.equal(neighborhood.status, 200);
  assert.deepEqual(JSON.parse(neighborhood.body), NEIGHBORHOOD);

  assert.deepEqual(calls, [
    { name: 'recent', args: [] },
    { name: 'search', args: ['needle'] },
    { name: 'details', args: ['handle-1'] },
    { name: 'neighborhood', args: ['handle-1', { visible: 7 }] },
  ]);

  const unknown = await ask(server.origin, '/api/details?id=absent', { headers });
  assert.equal(unknown.status, 404);
  const missing = await ask(server.origin, '/api/neighborhood', { headers });
  assert.equal(missing.status, 400);
  const undeclared = await ask(server.origin, '/api/everything', { headers });
  assert.equal(undeclared.status, 404);
});

test('an explicit visible limit must be a canonical positive integer', async () => {
  const { server, calls } = await harness();
  const headers = bearer(server.url);

  for (const visible of ['', '0', '-1', '1.5', '7junk', '9007199254740992']) {
    const answer = await ask(server.origin, `/api/neighborhood?id=handle-1&visible=${visible}`, { headers });
    assert.equal(answer.status, 400, `visible=${visible} answered ${answer.status}`);
  }
  assert.deepEqual(calls, [], 'an invalid limit must never reach the memory adapter');
});

test('memory data never leaves the host without a valid bearer token', async () => {
  const { server, calls } = await harness();
  const token = tokenOf(server.url);
  const attempts: Array<{ path: string; headers: Record<string, string> }> = [
    { path: '/api/recent', headers: {} },
    { path: '/api/recent', headers: { authorization: 'Bearer wrong-token' } },
    { path: '/api/recent', headers: { authorization: `Bearer ${token.slice(0, 63)}` } },
    { path: '/api/recent', headers: { authorization: `Bearer ${token}extra` } },
    { path: '/api/recent', headers: { authorization: `Basic ${token}` } },
    { path: '/api/recent', headers: { authorization: token } },
    { path: `/api/recent?token=${token}`, headers: {} },
    { path: '/api/details?id=handle-1', headers: {} },
    { path: '/api/search?query=needle', headers: {} },
    { path: '/api/neighborhood?id=handle-1', headers: {} },
  ];

  for (const attempt of attempts) {
    const answer = await ask(server.origin, attempt.path, { headers: attempt.headers });
    assert.equal(answer.status, 401, `unauthorized attempt answered ${answer.status}: ${attempt.path}`);
    assert.equal(answer.body.includes('handle-1'), false, `an unauthorized answer disclosed memory: ${attempt.path}`);
    assert.equal(answer.body.includes('decisions'), false);
    assert.match(header(answer, 'www-authenticate'), /^Bearer/u);
  }
  assert.deepEqual(calls, [], 'an unauthorized request must never reach the memory adapter');
});

test('a foreign Host or Origin returns no memory data', async () => {
  const { server, calls } = await harness();
  const headers = bearer(server.url);
  const port = new URL(server.origin).port;
  const rejected: Array<Record<string, string>> = [
    { ...headers, host: 'evil.example' },
    { ...headers, host: `evil.example:${port}` },
    { ...headers, host: `127.0.0.1:${Number(port) + 1}` },
    { ...headers, host: '127.0.0.1' },
    { ...headers, origin: 'http://evil.example' },
    { ...headers, origin: 'null' },
    { ...headers, origin: `https://127.0.0.1:${port}` },
  ];

  for (const attempt of rejected) {
    const answer = await ask(server.origin, '/api/recent', { headers: attempt });
    assert.equal(answer.status, 403, `foreign request answered ${answer.status}: ${JSON.stringify(attempt)}`);
    assert.equal(answer.body.includes('handle-1'), false);
  }
  assert.deepEqual(calls, [], 'a foreign Host or Origin must never reach the memory adapter');

  const sameOrigin = await ask(server.origin, '/api/recent', { headers: { ...headers, origin: server.origin } });
  assert.equal(sameOrigin.status, 200, 'the origin of the served page must remain allowed');
});

test('the explorer exposes no write route and refuses every non-GET method', async () => {
  const { server, calls } = await harness();
  const headers = bearer(server.url);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']) {
    for (const path of ['/api/recent', '/api/details?id=handle-1', '/', '/app.js']) {
      const answer = await ask(server.origin, path, { method, headers });
      assert.equal(answer.status, 405, `${method} ${path} answered ${answer.status}`);
      assert.equal(answer.headers.allow, 'GET');
      assert.equal(answer.body.includes('handle-1'), false);
      assert.equal(answer.body.includes('explorer'), false);
    }
  }
  assert.deepEqual(calls, [], 'no method other than GET may reach the memory adapter');
});

test('every answer carries restrictive, uncacheable, same-origin security headers', async () => {
  const { server } = await harness();
  const answers = [
    await ask(server.origin, '/', { headers: bearer(server.url) }),
    await ask(server.origin, '/app.js', {}),
    await ask(server.origin, '/api/recent', { headers: bearer(server.url) }),
    await ask(server.origin, '/api/recent', {}),
    await ask(server.origin, '/absent.js', {}),
  ];

  for (const answer of answers) {
    const policy = header(answer, 'content-security-policy');
    assert.match(policy, /default-src 'none'/u);
    assert.match(policy, /connect-src 'self'/u);
    assert.match(policy, /script-src 'self'/u);
    assert.match(policy, /frame-ancestors 'none'/u);
    assert.match(policy, /base-uri 'none'/u);
    assert.match(policy, /form-action 'none'/u);
    assert.equal(policy.includes('unsafe-inline'), false);
    assert.equal(policy.includes('unsafe-eval'), false);
    assert.equal(answer.headers['x-content-type-options'], 'nosniff');
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.equal(answer.headers['referrer-policy'], 'no-referrer');
    assert.equal(answer.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(answer.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(answer.headers['access-control-allow-origin'], undefined, 'no cross-origin sharing is allowed');
  }
});

test('JSON answers serialize hostile memory text inertly', async () => {
  const { server } = await harness();
  const answer = await ask(server.origin, '/api/recent', { headers: bearer(server.url) });

  assert.equal(answer.body.includes('<'), false, 'a raw < must never reach the browser');
  assert.equal(answer.body.includes('>'), false, 'a raw > must never reach the browser');
  assert.equal(answer.body.includes('\u2028'), false, 'a raw line separator must never reach the browser');
  assert.equal(answer.body.includes('\u2029'), false, 'a raw paragraph separator must never reach the browser');
  assert.ok(answer.body.includes('\\u003c'), 'markup characters must be escaped, not stripped');
  assert.equal(JSON.parse(answer.body).memories[0].title, HOSTILE_TEXT, 'escaping must preserve the stored text');
});

test('static assets come only from the injected asset root', async () => {
  const { server } = await harness();

  const index = await ask(server.origin, '/', {});
  assert.equal(index.status, 200);
  assert.equal(index.body, INDEX_HTML);
  assert.match(header(index, 'content-type'), /^text\/html/u);

  const script = await ask(server.origin, '/app.js', {});
  assert.equal(script.status, 200);
  assert.equal(script.body, APP_JS);
  assert.match(header(script, 'content-type'), /^text\/javascript/u);

  const styles = await ask(server.origin, '/styles.css', {});
  assert.equal(styles.status, 200);
  assert.match(header(styles, 'content-type'), /^text\/css/u);

  for (const escape of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/assets/../../outside.txt']) {
    const answer = await ask(server.origin, escape, {});
    assert.equal(answer.status, 404, `traversal answered ${answer.status}: ${escape}`);
    assert.equal(answer.body.includes(SECRET_OUTSIDE_ROOT), false, `traversal escaped the asset root: ${escape}`);
  }

  const absent = await ask(server.origin, '/absent.js', {});
  assert.equal(absent.status, 404);
});

test('closing the explorer is idempotent and stops every answer', async () => {
  const { server } = await harness();
  const origin = server.origin;
  await server.close();
  await server.close();
  await assert.rejects(() => ask(origin, '/api/recent', { headers: bearer(server.url) }));
});

test('the command opens exactly one server per session and reuses its URL', async () => {
  const opened: string[] = [];
  const notices: string[] = [];
  let started = 0;
  let adapters = 0;
  const host = createExplorerHost({
    createAdapter: () => {
      adapters += 1;
      return recordingAdapter([]);
    },
    assetRoot: assetRoot(),
    openBrowser: async (url: string) => {
      opened.push(url);
    },
    startServer: async (options) => {
      started += 1;
      const server = await startExplorerServer(options);
      openServers.push(server);
      return server;
    },
  });

  assert.equal(EXPLORER_COMMAND_NAME, 'palace-explore');
  assert.equal(started, 0, 'registering the command must not start a server');
  assert.equal(adapters, 0, 'registering the command must not read memory');

  const context = { ui: { notify: (message: string) => notices.push(message) } };
  await host.command.handler('', context as never);
  await host.command.handler('', context as never);

  assert.equal(started, 1, 'a session must host exactly one explorer server');
  assert.equal(adapters, 1);
  assert.equal(opened.length, 2);
  assert.equal(opened[0], opened[1]);
  assert.match(opened[0] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}$/u);
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.ok(notice.includes(new URL(opened[0]!).origin), `the notice hides the local origin: ${notice}`);
    assert.equal(notice.includes(tokenOf(opened[0]!)), false, 'a successful browser launch must not repeat the token');
  }

  await host.close();
  await host.close();
  await assert.rejects(() => ask(opened[0]!.split('#')[0]!, '/api/recent', {}));
});

test('a failed browser launch still exposes the local URL', async () => {
  const notices: string[] = [];
  const host = createExplorerHost({
    createAdapter: () => recordingAdapter([]),
    assetRoot: assetRoot(),
    openBrowser: async () => {
      throw new Error('no browser on this machine');
    },
    startServer: async (options) => {
      const server = await startExplorerServer(options);
      openServers.push(server);
      return server;
    },
  });

  const context = { ui: { notify: (message: string) => notices.push(message) } };
  await host.command.handler('', context as never);

  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? '', /http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}/u);
  assert.equal(notices[0]?.includes('no browser on this machine'), false, 'a launch failure must stay bounded');
  await host.close();
});
