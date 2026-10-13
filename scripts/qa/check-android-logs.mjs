#!/usr/bin/env node
// End-to-end check of Android native logs against a real app on a real emulator or device.
// Needs a Flutter app running on Android and visible through DTD (scripts/qa/android-sample-app.sh up).
// Starts its own daemon on a free port with a throwaway project folder, attaches to the
// Android app, checks the logs, stops the daemon and confirms logcat went with it.
// Prints a PASS/FAIL table and exits non-zero on any failure. The token is never printed.
// Usage: node scripts/qa/check-android-logs.mjs
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const { fetch } = globalThis;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON = join(ROOT, 'packages', 'daemon', 'dist', 'main.js');
const APPS_TIMEOUT_MS = 60_000;
const NATIVE_TIMEOUT_MS = 20_000;
const FRESH_MS = 120_000;
const EXIT_TIMEOUT_MS = 3_000;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  return pass;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined || Date.now() >= deadline) return value;
    await sleep(everyMs);
  }
}

function pgrepLogcat() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-fl', 'logcat -v threadtime'], (err, stdout) => {
      // pgrep exits 1 when nothing matches.
      resolve(err?.code === 1 ? [] : stdout.trim().split('\n').filter(Boolean));
    });
  });
}

const project = await mkdtemp(join(tmpdir(), 'deck-qa-android-'));
let daemon;
let token = '';
// The token and auth codes in VM service / DTD URIs both grant access.
const mask = (text) =>
  (token === '' ? text : text.replaceAll(token, '***')).replace(
    /\b((?:ws|wss|http|https):\/\/[^/\s]+)\/\S*/g,
    '$1/…',
  );
const daemonOutput = [];

try {
  // 1. Start the daemon.
  const port = await freePort();
  daemon = spawn(process.execPath, [DAEMON, '--project', project, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) =>
    daemon.once('exit', (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => daemonOutput.push(chunk));
  }
  const runtime = await waitFor(async () => {
    const raw = await readFile(join(project, '.flutterdeck', 'runtime.json'), 'utf8');
    return JSON.parse(raw);
  }, 10_000);
  if (
    !record(
      'daemon starts',
      runtime !== undefined,
      runtime ? `port ${runtime.port}` : 'no runtime.json',
    )
  )
    throw new Error('daemon did not start');
  token = runtime.token;
  const base = `http://127.0.0.1:${runtime.port}`;
  async function api(path, method = 'GET') {
    const res = await fetch(base + path, { method, headers: { 'x-deck-token': token } });
    const body = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${body.error ?? ''}`);
    return body;
  }

  // 2. Attach to the Android app. Other apps (e.g. an iOS one) may be listed too.
  const notIos = (apps) => apps.filter((a) => a.device?.platform !== 'ios');
  const apps = await waitFor(async () => {
    const list = await api('/api/apps');
    return notIos(list).length > 0 ? list : undefined;
  }, APPS_TIMEOUT_MS);
  let attached;
  const tried = [];
  for (const app of notIos(apps ?? []).sort(
    (a, b) => Number(b.device?.platform === 'android') - Number(a.device?.platform === 'android'),
  )) {
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/attach`, 'POST');
      const status = await api('/api/status');
      tried.push(`${app.name}: ${status.attached?.device?.platform ?? 'no platform'}`);
      if (status.attached?.device?.platform === 'android') {
        attached = status.attached;
        break;
      }
    } catch (err) {
      tried.push(`${app.name}: ${err.message}`);
    }
  }
  record(
    'attach to android app',
    attached !== undefined,
    attached
      ? `${attached.name} on ${attached.device.name}`
      : `${apps?.length ?? 0} app(s); ${tried.join('; ')}`,
  );

  // 3. The pid is what logcat filters on.
  record('pid set', attached?.pid !== undefined, `pid ${attached?.pid ?? 'missing'}`);

  // 4–7. Logs.
  const logs = async () => (await api('/api/logs?limit=5000')).entries;
  const native = (entries) => entries.filter((e) => e.source === 'native');
  const entries =
    attached === undefined
      ? []
      : ((await waitFor(async () => {
          const all = await logs();
          return native(all).length > 0 ? all : undefined;
        }, NATIVE_TIMEOUT_MS)) ?? (await logs()));
  const nativeEntries = native(entries);
  record(
    'native entries arrive',
    nativeEntries.length > 0,
    `${nativeEntries.length} native entries`,
  );
  const flutterTagged = nativeEntries.filter((e) => e.tag === 'flutter');
  record(
    'no flutter-tagged native entries',
    flutterTagged.length === 0,
    `${flutterTagged.length} found`,
  );
  const newest = Math.max(...nativeEntries.map((e) => e.ts));
  const age = Date.now() - newest;
  record(
    'native timestamps are recent',
    nativeEntries.length > 0 && Math.abs(age) <= FRESH_MS,
    nativeEntries.length > 0 ? `newest is ${(age / 1000).toFixed(1)} s old` : 'no entries',
  );
  const appEntries = entries.filter((e) => e.source === 'app');
  record('app entries arrive', appEntries.length > 0, `${appEntries.length} app entries`);

  // 8. Clean shutdown.
  daemon.kill('SIGINT');
  const exit = await Promise.race([exited, sleep(EXIT_TIMEOUT_MS).then(() => undefined)]);
  record(
    'daemon exits on SIGINT',
    exit !== undefined,
    exit ? `code ${exit.code ?? exit.signal}` : `still running after ${EXIT_TIMEOUT_MS / 1000} s`,
  );

  // 9. logcat must not outlive the daemon.
  const leftover = await pgrepLogcat();
  record(
    'no logcat left running',
    leftover.length === 0,
    leftover.length ? leftover.join(' | ') : 'none',
  );
} catch (err) {
  record('check ran to the end', false, mask(err instanceof Error ? err.message : String(err)));
} finally {
  if (daemon !== undefined && daemon.exitCode === null && daemon.signalCode === null)
    daemon.kill('SIGKILL');
  await rm(project, { recursive: true, force: true });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(`${'CHECK'.padEnd(width)}  RESULT  DETAIL`);
for (const r of results) {
  console.log(`${r.name.padEnd(width)}  ${r.pass ? 'PASS  ' : 'FAIL  '}  ${mask(r.detail)}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(
  failed === 0
    ? `All ${results.length} checks passed.`
    : `${failed} of ${results.length} checks failed.`,
);
if (failed > 0 && daemonOutput.length > 0) {
  console.log('\nDaemon output:\n' + mask(daemonOutput.join('')).trim());
}
process.exit(failed === 0 ? 0 : 1);
