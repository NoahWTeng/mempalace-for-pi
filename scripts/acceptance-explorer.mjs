#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const ASSET_ROOT = fileURLToPath(new URL('integration/explorer/assets/', ROOT));
const PROJECT = 'explorer-acceptance';

const STUDY_REQUIREMENTS = {
  participants: 10,
  attemptsPerParticipant: 3,
  attempts: 30,
  completeThreshold: 27,
  journeySeconds: 30,
};

const CORPUS_MEMORIES = 10_000;
const CORPUS_ROOM_SIZE = 50;
const CORPUS_TOPICS = 500;
const COLD_STARTS = 20;
const WARM_SEARCHES = 20;
const COLD_BUDGET_MS = 2_000;
const WARM_BUDGET_MS = 500;
const FIRST_WARM_TOPIC = 100;
const READY_TIMEOUT_MS = 30_000;
const ATTACH_TIMEOUT_MS = 20_000;

const CHROME_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--remote-allow-origins=*',
  '--remote-debugging-port=0',
];

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
}

function parseArguments() {
  for (let index = 2; index < process.argv.length; index++) {
    const value = process.argv[index];
    assert(value === '--study' || value === '--browser', `unknown argument: ${value}`);
    index++;
  }
  assert(
    process.argv.includes('--study') || process.argv.includes('--browser'),
    'use --study <evidence.json> or --browser <path to Google Chrome>',
  );
  return { study: argument('--study'), browser: argument('--browser') };
}

function needsAttention(reason) {
  process.stderr.write(`needs-attention: ${reason}\n`);
  process.exit(1);
}

function topicOf(index) {
  return `topic-${String(index % CORPUS_TOPICS).padStart(3, '0')}`;
}

function corpusRows() {
  const rows = [];
  for (let index = 0; index < CORPUS_MEMORIES; index++) {
    const room = `room-${String(Math.floor(index / CORPUS_ROOM_SIZE) + 1).padStart(3, '0')}`;
    const minute = String(index % 60).padStart(2, '0');
    const hour = String(Math.floor(index / 60) % 24).padStart(2, '0');
    const day = String((Math.floor(index / 1440) % 28) + 1).padStart(2, '0');
    const filedAt = `2026-01-${day}T${hour}:${minute}:${String(index % 60).padStart(2, '0')}Z`;
    rows.push({
      drawer_id: `drawer_${String(index).padStart(5, '0')}`,
      wing: PROJECT,
      room,
      content: `Memory ${index} about ${topicOf(index)}\nRecorded context for ${topicOf(index)} in ${room}.`,
      source_file: `docs/notes/${room}/entry-${index}.md`,
      filed_at: filedAt,
      authored_at: filedAt,
    });
  }
  return rows;
}

function metadataOf(row) {
  return {
    wing: row.wing,
    room: row.room,
    source_file: basename(row.source_file),
    filed_at: row.filed_at,
    authored_at: row.authored_at,
  };
}

function corpusClient(rows) {
  const byId = new Map(rows.map((row) => [row.drawer_id, row]));
  const byRoom = new Map();
  for (const row of rows) {
    const roomRows = byRoom.get(row.room) ?? [];
    roomRows.push(row);
    byRoom.set(row.room, roomRows);
  }

  function listDrawers(args) {
    const matched = args.room ? byRoom.get(args.room) ?? [] : rows;
    const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 100));
    const page = matched.slice(0, limit).map((row) => ({
      drawer_id: row.drawer_id,
      wing: row.wing,
      room: row.room,
      content_preview: row.content.slice(0, 200),
      metadata: metadataOf(row),
    }));
    return { drawers: page, total: matched.length, count: page.length, offset: 0, limit };
  }

  function getDrawer(args) {
    const row = byId.get(args.drawer_id);
    if (!row) return { error: `Drawer not found: ${args.drawer_id}` };
    return {
      drawer_id: row.drawer_id,
      content: row.content,
      wing: row.wing,
      room: row.room,
      metadata: metadataOf(row),
    };
  }

  function search(args) {
    const query = String(args.query ?? '').toLowerCase();
    const limit = Math.max(1, Math.min(Number(args.limit ?? 5), 100));
    const matched = rows.filter((row) => row.content.toLowerCase().includes(query));
    const results = matched.slice(0, limit).map((row, rank) => ({
      text: row.content,
      wing: row.wing,
      room: row.room,
      source_file: basename(row.source_file),
      source_path: row.source_file,
      created_at: row.filed_at,
      authored_at: row.authored_at,
      similarity: Number((0.9 - rank * 0.001).toFixed(4)),
    }));
    return { query: args.query, total_before_filter: matched.length, results };
  }

  return {
    callReadTool(name, args = {}) {
      if (name === 'mempalace_list_drawers') return Promise.resolve(listDrawers(args));
      if (name === 'mempalace_get_drawer') return Promise.resolve(getDrawer(args));
      if (name === 'mempalace_search') return Promise.resolve(search(args));
      return Promise.reject(new Error(`unsupported read tool: ${name}`));
    },
    callWriteTool(name) {
      return Promise.reject(new Error(`the explorer attempted a write: ${name}`));
    },
    shutdown: () => Promise.resolve(),
    isAlive: () => true,
  };
}

function nearestRankP95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function validateStudy(path) {
  if (!existsSync(path)) needsAttention(`no study evidence at ${path}`);
  let study;
  try {
    study = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    needsAttention(`study evidence is not readable JSON: ${error.message}`);
  }

  const problems = [];
  const declared = study.requirements ?? {};
  for (const [key, required] of Object.entries(STUDY_REQUIREMENTS)) {
    if (declared[key] !== required) {
      problems.push(`declared threshold ${key} is ${JSON.stringify(declared[key])}, required ${required}`);
    }
  }

  const attempts = Array.isArray(study.attempts) ? study.attempts : [];
  if (attempts.length !== STUDY_REQUIREMENTS.attempts) {
    problems.push(`expected exactly ${STUDY_REQUIREMENTS.attempts} attempts, found ${attempts.length}`);
  }

  const byParticipant = new Map();
  for (const attempt of attempts) {
    const participant = typeof attempt.participant === 'string' ? attempt.participant.trim() : '';
    if (participant === '') {
      problems.push('an attempt names no participant');
      continue;
    }
    if (typeof attempt.seconds !== 'number' || !Number.isFinite(attempt.seconds) || attempt.seconds <= 0) {
      problems.push(`${participant} recorded an invalid journey duration`);
    }
    byParticipant.set(participant, (byParticipant.get(participant) ?? 0) + 1);
  }
  if (byParticipant.size !== STUDY_REQUIREMENTS.participants) {
    problems.push(
      `expected ${STUDY_REQUIREMENTS.participants} developers, found ${byParticipant.size}`,
    );
  }
  for (const [participant, count] of byParticipant) {
    if (count !== STUDY_REQUIREMENTS.attemptsPerParticipant) {
      problems.push(
        `${participant} recorded ${count} attempts, required ${STUDY_REQUIREMENTS.attemptsPerParticipant}`,
      );
    }
  }

  const complete = attempts.filter((attempt) => (
    attempt.completed === true
    && typeof attempt.seconds === 'number'
    && Number.isFinite(attempt.seconds)
    && attempt.seconds > 0
    && attempt.seconds < STUDY_REQUIREMENTS.journeySeconds
  ));
  if (complete.length < STUDY_REQUIREMENTS.completeThreshold) {
    problems.push(
      `expected at least ${STUDY_REQUIREMENTS.completeThreshold} complete journeys under `
      + `${STUDY_REQUIREMENTS.journeySeconds} seconds, found ${complete.length}`,
    );
  }

  const evidence = study.evidence;
  if (evidence !== 'synthetic-reference' && evidence !== 'recorded') {
    problems.push(`evidence must be declared as "recorded" or "synthetic-reference", found ${JSON.stringify(evidence)}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`explorer study rejected: ${problem}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `Explorer study: ${attempts.length} attempts from ${byParticipant.size} developers, `
    + `${complete.length} complete journeys under ${STUDY_REQUIREMENTS.journeySeconds} seconds `
    + `(threshold ${STUDY_REQUIREMENTS.completeThreshold})\n`,
  );
  if (evidence === 'synthetic-reference') {
    process.stdout.write(
      'needs-attention: SC-001 is not claimed from this file. It is synthetic reference data that '
      + 'proves the validator, and real 10-developer evidence remains runtime-verification work.\n',
    );
    return;
  }
  process.stdout.write('Explorer study: PASS (recorded evidence)\n');
}

function devToolsPort(profile) {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  return new Promise((resolved, failed) => {
    const poll = async () => {
      try {
        const [port] = (await readFile(portFile, 'utf8')).split('\n');
        if (port && Number(port) > 0) return resolved(Number(port));
      } catch {
        void 0;
      }
      if (Date.now() > deadline) return failed(new Error('the browser never published a debugging port'));
      setTimeout(poll, 10);
    };
    void poll();
  });
}

function pageTarget(port, origin) {
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  return new Promise((resolved, failed) => {
    const poll = async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find((target) => target.type === 'page' && target.url.startsWith(origin));
        if (page?.webSocketDebuggerUrl) return resolved(page);
      } catch {
        void 0;
      }
      if (Date.now() > deadline) return failed(new Error('the browser never opened the explorer page'));
      setTimeout(poll, 20);
    };
    void poll();
  });
}

function connectSession(webSocketDebuggerUrl) {
  return new Promise((resolved, failed) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    const rejectPending = (error) => {
      for (const waiter of pending.values()) waiter.failed(error);
      pending.clear();
    };
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        rejectPending(new Error('the browser sent an invalid DevTools response'));
        socket.close();
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.failed(new Error(message.error.message));
      else waiter.resolved(message.result);
    });
    socket.addEventListener('error', () => {
      const error = new Error('could not attach to the browser');
      rejectPending(error);
      failed(error);
    });
    socket.addEventListener('close', () => rejectPending(new Error('the browser connection closed')));
    socket.addEventListener('open', () => resolved({
      send(method, params) {
        const id = ++nextId;
        return new Promise((sent, rejected) => {
          pending.set(id, { resolved: sent, failed: rejected });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => socket.close(),
    }));
  });
}

async function evaluate(session, expression) {
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  for (;;) {
    try {
      const answer = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (answer.exceptionDetails) {
        throw new Error(answer.exceptionDetails.exception?.description ?? 'the explorer page raised an error');
      }
      return answer.result.value;
    } catch (error) {
      if (!/execution context/iu.test(error.message) || Date.now() > deadline) throw error;
      await new Promise((waited) => setTimeout(waited, 20));
    }
  }
}

const READY_EXPRESSION = `new Promise((resolve, reject) => {
  const deadline = Date.now() + ${READY_TIMEOUT_MS};
  const settle = () => {
    const list = document.querySelector('#memory-list');
    if (!list || list.children.length === 0) return false;
    const loaded = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/recent'));
    if (loaded.length === 0) return false;
    resolve({
      renderedAt: performance.timeOrigin + Math.max(...loaded.map((entry) => entry.responseEnd)),
      rows: list.children.length,
    });
    return true;
  };
  if (settle()) return;
  const timer = setInterval(() => {
    if (settle()) return clearInterval(timer);
    if (Date.now() > deadline) {
      clearInterval(timer);
      reject(new Error('the explorer never rendered recent memories'));
    }
  }, 10);
})`;

function searchExpression(query) {
  return `new Promise((resolve, reject) => {
  const token = ${JSON.stringify(query)};
  const list = document.querySelector('#memory-list');
  const started = performance.now();
  const deadline = started + ${READY_TIMEOUT_MS};
  const settle = () => {
    if (!list.textContent.includes(token)) return false;
    resolve({
      ms: performance.now() - started,
      rows: list.children.length,
      status: document.querySelector('#status').textContent,
    });
    return true;
  };
  const timer = setInterval(() => {
    if (settle()) return clearInterval(timer);
    if (performance.now() > deadline) {
      clearInterval(timer);
      reject(new Error('the explorer never rendered results for ' + token));
    }
  }, 5);
  document.querySelector('#search').value = token;
  document.querySelector('#search-form').requestSubmit();
})`;
}

function launchBrowser(browser, url) {
  const profile = mkdtempSync(join(tmpdir(), 'mempalace-explorer-profile-'));
  const startedAt = Date.now();
  const child = spawn(browser, [...CHROME_FLAGS, `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
  return {
    profile,
    child,
    startedAt,
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise((exited) => child.once('exit', exited));
        child.kill('SIGKILL');
        await stopped;
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

async function attach(browser, url, origin) {
  const launched = launchBrowser(browser, url);
  try {
    const port = await devToolsPort(launched.profile);
    const target = await pageTarget(port, origin);
    const session = await connectSession(target.webSocketDebuggerUrl);
    await session.send('Runtime.enable', {});
    return { ...launched, session };
  } catch (error) {
    await launched.dispose();
    throw error;
  }
}

async function coldStarts(browser, url, origin) {
  const samples = [];
  for (let run = 0; run < COLD_STARTS; run++) {
    const attached = await attach(browser, url, origin);
    try {
      const ready = await evaluate(attached.session, READY_EXPRESSION);
      assert(ready.rows > 0, 'the explorer rendered no recent memories');
      samples.push(ready.renderedAt - attached.startedAt);
    } finally {
      attached.session.close();
      await attached.dispose();
    }
  }
  return samples;
}

async function warmSearches(browser, url, origin) {
  const attached = await attach(browser, url, origin);
  try {
    await evaluate(attached.session, READY_EXPRESSION);
    const samples = [];
    for (let run = 0; run < WARM_SEARCHES; run++) {
      const query = `topic-${String(FIRST_WARM_TOPIC + run).padStart(3, '0')}`;
      const measured = await evaluate(attached.session, searchExpression(query));
      assert(measured.rows > 0, `the explorer rendered no results for ${query}`);
      samples.push(measured.ms);
    }
    return samples;
  } finally {
    attached.session.close();
    await attached.dispose();
  }
}

async function measurePerformance(browser) {
  try {
    await access(browser, constants.X_OK);
  } catch {
    needsAttention(`the explorer browser is not executable: ${browser}`);
  }

  const { createExplorerAdapter } = await import(new URL('integration/explorer/adapter.ts', ROOT).href);
  const { startExplorerServer } = await import(new URL('integration/explorer/server.ts', ROOT).href);
  const adapter = createExplorerAdapter(corpusClient(corpusRows()), { project: PROJECT });
  const server = await startExplorerServer({ adapter, assetRoot: ASSET_ROOT });

  let cold;
  let warm;
  try {
    cold = await coldStarts(browser, server.url, server.origin);
    warm = await warmSearches(browser, server.url, server.origin);
  } catch (error) {
    await server.close();
    needsAttention(`the browser harness could not record explorer evidence: ${error.message}`);
    return;
  }
  await server.close();

  const coldP95 = nearestRankP95(cold);
  const warmP95 = nearestRankP95(warm);
  process.stdout.write(
    `Explorer performance: ${cold.length} cold starts p95 ${round(coldP95)}ms `
    + `(budget ${COLD_BUDGET_MS}ms), ${warm.length} warm searches p95 ${round(warmP95)}ms `
    + `(budget ${WARM_BUDGET_MS}ms) over ${CORPUS_MEMORIES} memories\n`,
  );

  const exceeded = [];
  if (coldP95 > COLD_BUDGET_MS) exceeded.push(`cold-start p95 ${round(coldP95)}ms exceeds ${COLD_BUDGET_MS}ms`);
  if (warmP95 > WARM_BUDGET_MS) exceeded.push(`warm-search p95 ${round(warmP95)}ms exceeds ${WARM_BUDGET_MS}ms`);
  if (exceeded.length > 0) {
    for (const failure of exceeded) process.stderr.write(`explorer performance rejected: ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`Explorer performance measurement: within budgets (${basename(browser)})\n`);
  process.stderr.write('needs-attention: SC-002 remains unclaimed until the Apple M1, 8 GB, 1920x1080, Chrome 151 environment is independently verified.\n');
}

const options = parseArguments();
if (options.study) validateStudy(options.study);
if (options.browser) await measurePerformance(options.browser);
