#!/usr/bin/env node
// End-to-end check of the M1 acceptance criterion: the daemon attaches next to a debugger without
// breaking it. Needs the sample app from `scripts/qa/android-sample-app.sh up`.
//
// macOS and Linux only: it needs the bash script above and looks for `adb` without `.exe`.
//
// A second, independent VM service client stands in for the IDE debugger. It connects first and sets
// a breakpoint, as the IDE would. Then the daemon (real mode, temp project) lists and attaches to the
// app, the sample app's source is edited and `POST /api/reload` runs, and the breakpoint must still
// hit. Last, the daemon stops and the debugger and the app must be unaffected.
//
// Prints a CHECK/RESULT/DETAIL table and exits non-zero on any failure. Tokens and auth codes in
// VM service and DTD URIs are masked. Restores the edited source and removes the breakpoint.
//
// Usage: node scripts/qa/check-m1-acceptance.mjs [--control] [--evidence <dir>]
//   --control   no daemon: the debugger client triggers the hot reload itself through the Flutter
//               tool's `reloadSources` service (the same service the daemon calls). Shows whether a
//               breakpoint that stops hitting after a reload is caused by the daemon or not.
//   --evidence  folder for screenshots, the screen recording and the masked debugger JSON-RPC
//               traffic (default: qa-artifacts/M1). Keep it git-ignored.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { scratchHomeEnv } from './scratch-home.mjs';

const { fetch, URL, WebSocket } = globalThis;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON = join(ROOT, 'packages', 'daemon', 'dist', 'main.js');
const APP_NAME = 'qa_sample_app';
const APP_ID = `com.example.${APP_NAME}`;
const QA_DIR = (process.env.QA_ANDROID_DIR ?? join(tmpdir(), 'project-deck-qa-android')).replace(
  /\/$/,
  '',
);
const MAIN_DART = join(QA_DIR, APP_NAME, 'lib', 'main.dart');
const ORIGINAL_TEXT = "'qa-sample print tick $n'";
const RELOADED_TEXT = "'qa-sample reloaded tick $n'";
const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Android', 'sdk')
    : join(homedir(), 'Android', 'Sdk'));
const ADB = join(ANDROID_HOME, 'platform-tools', 'adb');
const HIT_TIMEOUT_MS = 20_000;
const RECORD_LIMIT_S = 170;

const { values: args } = parseArgs({
  options: { evidence: { type: 'string' }, control: { type: 'boolean', default: false } },
});
const CONTROL = args.control;
const EVIDENCE = resolve(args.evidence ?? join(ROOT, 'qa-artifacts', 'M1'));
const RUN = CONTROL ? 'control' : 'm1';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  return pass;
}
function must(name, pass, detail) {
  if (!record(name, pass, detail)) throw new Error(`stopped after "${name}"`);
}

const secrets = [];
// The daemon token and the auth codes in VM service / DTD URIs both grant access.
const mask = (text) =>
  secrets
    .reduce((t, s) => t.replaceAll(s, '***'), String(text))
    .replace(/\b((?:ws|wss|http|https):\/\/[^/\s"]+)\/[^\s"]*/g, '$1/…');

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
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

function adb(argv, encoding = 'utf8') {
  return new Promise((ok, fail) =>
    execFile(ADB, argv, { encoding, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? fail(err) : ok(stdout),
    ),
  );
}

// The emulator running the sample app. Physical devices and other emulators are left alone.
async function findSerial() {
  const lines = (await adb(['devices'])).split('\n');
  for (const serial of lines.map((l) => /^(emulator-\d+)\s+device$/.exec(l)?.[1]).filter(Boolean)) {
    const pid = (await adb(['-s', serial, 'shell', 'pidof', APP_ID]).catch(() => '')).trim();
    if (pid !== '') return { serial, pid };
  }
  return undefined;
}

// --- The stand-in debugger: a plain JSON-RPC client on the app's VM service. ---

function dartDataHome() {
  if (process.env.DART_DATA_HOME) return process.env.DART_DATA_HOME;
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'Dart');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'Dart');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'Dart');
}

class RpcClient {
  constructor(uri, traffic) {
    this.ws = new WebSocket(uri);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.traffic = traffic;
    this.closed = false;
    // A lasting listener, so a socket error after open() is never unhandled. 'close' follows it
    // and fails the pending calls.
    this.ws.addEventListener('error', () => {});
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { fail } of this.pending.values()) fail(new Error('socket closed'));
      this.pending.clear();
    });
    this.ws.addEventListener('message', (msg) => {
      let body;
      try {
        body = JSON.parse(String(msg.data));
      } catch {
        this.traffic?.push({ dir: 'in', t: Date.now(), malformed: true });
        return;
      }
      if (body === null || typeof body !== 'object') return;
      this.traffic?.push({ dir: 'in', t: Date.now(), body });
      if (body.id !== undefined && this.pending.has(body.id)) {
        const { ok, fail } = this.pending.get(body.id);
        this.pending.delete(body.id);
        if (body.error) fail(new Error(`${body.error.code}: ${body.error.message}`));
        else ok(body.result);
      } else if (body.method === 'streamNotify') {
        for (const fn of this.listeners) fn(body.params);
      }
    });
  }
  // A DTD or VM service that accepts the TCP connection but never answers must not hang the check.
  open(timeoutMs = 5000) {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        fail(new Error('connect timed out'));
        this.ws.close();
      }, timeoutMs);
      this.ws.addEventListener('open', () => (clearTimeout(timer), ok()), { once: true });
      this.ws.addEventListener(
        'error',
        () => (clearTimeout(timer), fail(new Error('could not connect'))),
        { once: true },
      );
    });
  }
  call(method, params, timeoutMs = 10_000) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    this.traffic?.push({ dir: 'out', t: Date.now(), body: msg });
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() {
    this.ws.close();
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The check only ever talks to this machine.
function isLoopback(uri) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

// Ask every live DTD for its apps and return the sample app's VM service URI. Skips DTD files whose
// process is gone (stale), that don't parse, or that point off this machine.
async function sampleAppVmUri() {
  const dir = join(dartDataHome(), 'dtd');
  for (const file of await readdir(dir).catch(() => [])) {
    let info;
    try {
      info = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (typeof info?.wsUri !== 'string') continue;
    secrets.push(info.wsUri);
    if (!Number.isInteger(info.pid) || !isAlive(info.pid) || !isLoopback(info.wsUri)) continue;
    const dtd = new RpcClient(info.wsUri);
    try {
      await dtd.open(3000);
      // DTD rejects `params: {}` for methods without parameters.
      const { vmServices } = await dtd.call('ConnectedApp.getVmServices', undefined, 3000);
      const app = vmServices.find((s) => s.name?.includes(`Package: ${APP_NAME}`));
      if (app !== undefined && typeof app.uri === 'string') {
        secrets.push(app.uri);
        if (isLoopback(app.uri)) return { uri: app.uri, name: app.name };
      }
    } catch {
      // A stale or unreachable DTD; try the next one.
    } finally {
      dtd.close();
    }
  }
  return undefined;
}

function toWs(uri) {
  const u = new URL(uri);
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return u.href;
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/?$/, '/ws');
  return u.href;
}

// --- Evidence ---

async function screenshot(serial, name) {
  if (serial === undefined) return 'no device';
  try {
    const png = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], 'buffer');
    const file = join(EVIDENCE, 'screens', `${RUN}-${name}.png`);
    await writeFile(file, png);
    shots.push(file);
    return file;
  } catch (err) {
    return `screenshot failed: ${err.message}`;
  }
}

const shots = [];
const traffic = [];
const daemonOutput = [];
const project = await mkdtemp(join(tmpdir(), 'deck-qa-m1-'));
// The daemon's port registry goes to a scratch home, never the user's ~/.flutterdeck.
const scratchHome = await scratchHomeEnv();
// Unique per run, so the clean-up can stop and delete only this run's recording.
const devicePath = `/sdcard/project-deck-qa-${RUN}-${process.pid}-${Date.now()}.mp4`;
let daemon;
let daemonExited;
let debuggerClient;
let isolateId;
let breakpointId;
let originalSource;
let edited = false;
// Flutter tool services seen on the Service stream (reloadSources among them).
const services = new Map();
let recorder;
let serial;

// Hits are resumed at once (like a developer pressing Resume) unless a waiter wants the next one.
const hits = [];
let hitWaiter;
let autoResume = true;

// Runs once, from the finally below or from a SIGINT/SIGTERM handler, so an interrupted run also
// stops the daemon, unpauses the app, restores the source and stops the screen recording.
let cleanupDone;
function cleanup() {
  cleanupDone ??= (async () => {
    if (daemon !== undefined && daemon.exitCode === null && daemon.signalCode === null)
      daemon.kill('SIGKILL');
    if (debuggerClient !== undefined && !debuggerClient.closed) {
      hitWaiter = undefined;
      autoResume = false;
      if (breakpointId !== undefined)
        await debuggerClient.call('removeBreakpoint', { isolateId, breakpointId }).catch(() => {});
      // Never leave the app paused.
      await debuggerClient.call('resume', { isolateId }).catch(() => {});
    }
    if (originalSource !== undefined) await writeFile(MAIN_DART, originalSource).catch(() => {});
    // Reload the restored source too, so the app doesn't keep running the edited code into the next run.
    const reloadMethod = services.get('reloadSources');
    if (
      edited &&
      reloadMethod !== undefined &&
      debuggerClient !== undefined &&
      !debuggerClient.closed
    )
      await debuggerClient.call(reloadMethod, { isolateId }, 30_000).catch(() => {});
    debuggerClient?.close();
    if (recorder !== undefined) {
      // screenrecord finishes the file on SIGINT. Signal only this run's screenrecord, matched by its
      // unique file path; `screenrecor[d]` keeps the pattern from matching the shell running pkill.
      await adb([
        '-s',
        serial,
        'shell',
        'pkill',
        '-INT',
        '-f',
        `'screenrecor[d] .*${devicePath}'`,
      ]).catch(() => {});
      await sleep(2000);
      await adb(['-s', serial, 'pull', devicePath, join(EVIDENCE, `${RUN}-acceptance.mp4`)]).catch(
        () => {},
      );
      await adb(['-s', serial, 'shell', 'rm', '-f', devicePath]).catch(() => {});
    }
    await writeFile(
      join(EVIDENCE, `${RUN}-debugger-jsonrpc.json`),
      mask(JSON.stringify(traffic.slice(0, 400), null, 2)),
    ).catch(() => {});
    await rm(project, { recursive: true, force: true }).catch(() => {});
    await scratchHome.cleanup().catch(() => {});
  })();
  return cleanupDone;
}

// Printed once, by whichever of the normal end or a signal handler gets there first.
let reported;
function report() {
  if (reported !== undefined) return reported;
  // Informational, not a check: how many PauseBreakpoint events the debugger saw in total.
  results.push({ name: 'breakpoint hits seen', pass: null, detail: String(hits.length) });
  const width = Math.max(...results.map((r) => r.name.length));
  console.log(`${'CHECK'.padEnd(width)}  RESULT  DETAIL`);
  for (const r of results) {
    const label = r.pass === null ? 'INFO  ' : r.pass ? 'PASS  ' : 'FAIL  ';
    console.log(`${r.name.padEnd(width)}  ${label}  ${mask(r.detail)}`);
  }
  const checks = results.filter((r) => r.pass !== null);
  const failed = checks.filter((r) => !r.pass).length;
  console.log(
    failed === 0
      ? `All ${checks.length} checks passed.`
      : `${failed} of ${checks.length} checks failed.`,
  );
  console.log(`Evidence: ${shots.length} screenshot(s) in ${join(EVIDENCE, 'screens')}`);
  if (failed > 0 && daemonOutput.length > 0) {
    console.log('\nDaemon output:\n' + mask(daemonOutput.join('')).trim());
  }
  reported = failed === 0 ? 0 : 1;
  return reported;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    record('check ran to the end', false, `stopped by ${signal}`);
    void cleanup()
      .catch(() => {})
      .finally(() => {
        report();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  });
}

try {
  await mkdir(join(EVIDENCE, 'screens'), { recursive: true });
  const device = await findSerial();
  serial = device?.serial;
  must(
    'sample app runs on android',
    device !== undefined,
    device ? `${APP_ID} pid ${device.pid} on ${device.serial}` : `${APP_ID} not running`,
  );
  recorder = spawn(
    ADB,
    ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(RECORD_LIMIT_S), devicePath],
    {
      stdio: 'ignore',
    },
  );
  recorder.on('error', () => {});

  // 1. Start the daemon in real mode on a temp project (not in control mode).
  let api = async () => {
    throw new Error('no daemon in control mode');
  };
  if (!CONTROL) {
    const port = await freePort();
    daemon = spawn(process.execPath, [DAEMON, '--project', project, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scratchHome.env,
    });
    daemon.on('error', (err) => daemonOutput.push(`spawn error: ${err.message}\n`));
    daemonExited = new Promise((ok) => daemon.once('exit', (code, signal) => ok({ code, signal })));
    for (const stream of [daemon.stdout, daemon.stderr]) {
      stream.on('error', () => {});
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => daemonOutput.push(chunk));
    }
    const runtime = await waitFor(
      async () => JSON.parse(await readFile(join(project, '.flutterdeck', 'runtime.json'), 'utf8')),
      10_000,
    );
    must('daemon starts (real mode)', runtime !== undefined, runtime ? `port ${runtime.port}` : '');
    secrets.push(runtime.token);
    const base = `http://127.0.0.1:${runtime.port}`;
    api = async (path, method = 'GET') => {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${runtime.token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${body.error ?? ''}`);
      return body;
    };
  }

  // 2. The stand-in IDE debugger connects to the same VM service and sets a breakpoint.
  const vm = await sampleAppVmUri();
  must(
    'DTD reports the sample app',
    vm !== undefined,
    vm ? `${vm.name} at ${vm.uri}` : 'not found',
  );
  secrets.push(vm.uri, toWs(vm.uri));
  debuggerClient = new RpcClient(toWs(vm.uri), traffic);
  await debuggerClient.open();
  debuggerClient.listeners.add((params) => {
    const event = params.event;
    if (event?.kind === 'ServiceRegistered') services.set(event.service, event.method);
    if (params.streamId !== 'Debug' || event?.kind !== 'PauseBreakpoint') return;
    const hit = {
      t: Date.now(),
      line: event.topFrame?.location?.line,
      ours: (event.pauseBreakpoints ?? []).some((b) => b.id === breakpointId),
      isolate: event.isolate.id,
    };
    hits.push(hit);
    if (hitWaiter !== undefined) {
      const waiter = hitWaiter;
      hitWaiter = undefined;
      waiter(hit);
    } else if (autoResume) {
      debuggerClient.call('resume', { isolateId: hit.isolate }).catch(() => {});
    }
  });
  await debuggerClient.call('streamListen', { streamId: 'Debug' });
  // DDS replays the services already registered (the Flutter tool's reloadSources among them).
  await debuggerClient.call('streamListen', { streamId: 'Service' });
  const vmInfo = await debuggerClient.call('getVM');
  const isolate = vmInfo.isolates.find((i) => i.name === 'main') ?? vmInfo.isolates[0];
  isolateId = isolate.id;
  originalSource = await readFile(MAIN_DART, 'utf8');
  const line = originalSource.split('\n').findIndex((l) => l.includes('// qa-breakpoint')) + 1;
  must('breakpoint line found', line > 0, `main.dart line ${line}`);
  const bp = await debuggerClient.call('addBreakpointWithScriptUri', {
    isolateId,
    scriptUri: `package:${APP_NAME}/main.dart`,
    line,
  });
  breakpointId = bp.id;
  record('debugger sets breakpoint', bp.type === 'Breakpoint', `${bp.id}, resolved ${bp.resolved}`);

  // The timer is cleared when the hit wins, and a timeout only clears its own waiter, so a stale
  // timer can never swallow a later call's hit and leave the app paused.
  const waitHit = (timeoutMs) =>
    new Promise((ok) => {
      const waiter = (hit) => {
        clearTimeout(timer);
        ok(hit);
      };
      const timer = setTimeout(() => {
        if (hitWaiter === waiter) hitWaiter = undefined;
        ok(undefined);
      }, timeoutMs);
      hitWaiter = waiter;
    });
  const before = await waitHit(HIT_TIMEOUT_MS);
  if (before !== undefined) await debuggerClient.call('resume', { isolateId });
  must(
    CONTROL ? 'breakpoint hits (debugger only)' : 'breakpoint hits before attach',
    before?.ours === true && before.line === line,
    before ? `paused at line ${before.line}, resumed` : 'no PauseBreakpoint',
  );

  // 3. The daemon lists the app and attaches next to the debugger.
  let app;
  if (!CONTROL) {
    const apps = await waitFor(async () => {
      const list = await api('/api/apps');
      return list.some((a) => a.name.includes(APP_NAME)) ? list : undefined;
    }, 60_000);
    app = apps?.find((a) => a.name.includes(APP_NAME));
    must(
      'daemon lists the sample app',
      app !== undefined,
      `${apps?.length ?? 0} app(s): ${(apps ?? []).map((a) => `${a.name} (${a.device?.platform ?? '?'})`).join(', ')}`,
    );
    const attach = await api(`/api/apps/${encodeURIComponent(app.id)}/attach`, 'POST');
    const status = await api('/api/status');
    must(
      'daemon attaches',
      status.attached?.id === app.id,
      status.attached
        ? `${status.attached.name} pid ${status.attached.pid}`
        : JSON.stringify(attach),
    );
  }
  await screenshot(serial, CONTROL ? '1-before-reload' : '1-attached');

  // 4. Edit the source and hot reload through the daemon. Reload right after a resumed hit so the
  // isolate is running; hits come every 5 s.
  must('source has the original string', originalSource.includes(ORIGINAL_TEXT), ORIGINAL_TEXT);
  if (!CONTROL) {
    // An app still running the edited code from an earlier run would print the new string without
    // any reload, and make the log check below pass on its own. Look at the newest print tick only,
    // so old lines from a run that was reloaded back are ignored.
    const latest = await waitFor(async () => {
      const { entries } = await api('/api/logs?text=qa-sample&limit=20');
      const ticks = entries.filter((e) => /qa-sample (print|reloaded) tick/.test(e.message));
      return ticks.length > 0 ? ticks.reduce((a, b) => (b.ts > a.ts ? b : a)) : undefined;
    }, 5_000);
    must(
      'app runs the original code',
      latest !== undefined && latest.message.includes('print tick'),
      latest === undefined
        ? 'no print ticks in the logs'
        : latest.message.includes('print tick')
          ? latest.message
          : 'the app still prints the reloaded string; restart it (android-sample-app.sh down, then up)',
    );
  }
  edited = true;
  await writeFile(MAIN_DART, originalSource.replace(ORIGINAL_TEXT, RELOADED_TEXT));
  const sync = await waitHit(HIT_TIMEOUT_MS);
  if (sync !== undefined) await debuggerClient.call('resume', { isolateId });
  record(
    CONTROL ? 'breakpoint hits before reload' : 'breakpoint hits after attach',
    sync?.ours === true && sync.line === line,
    sync ? `paused at line ${sync.line}, resumed` : 'no PauseBreakpoint',
  );
  const reloadStart = Date.now();
  if (CONTROL) {
    const method = services.get('reloadSources');
    must(
      'reloadSources service registered',
      typeof method === 'string',
      method ??
        'the Flutter tool did not register reloadSources; is the app started by flutter run?',
    );
    const reload = await debuggerClient.call(method, { isolateId }, 30_000).catch((e) => e);
    record(
      'reload via Flutter tool service',
      !(reload instanceof Error) && reload.type === 'Success',
      reload instanceof Error ? reload.message : `${method}: ${reload.type}`,
    );
  } else {
    const reload = await api('/api/reload', 'POST');
    record(
      'POST /api/reload',
      reload.ok === true && reload.kind === 'hot-reload',
      JSON.stringify(reload),
    );
    const reloaded = await waitFor(async () => {
      const { entries } = await api('/api/logs?text=qa-sample%20reloaded%20tick&limit=20');
      return entries.find((e) => e.ts >= reloadStart - 1000);
    }, 10_000);
    record(
      'new string in GET /api/logs',
      reloaded !== undefined,
      reloaded ? reloaded.message : 'not seen within 10 s',
    );
  }
  await sleep(1500);
  await screenshot(serial, '2-reloaded');

  // 5. The breakpoint still hits after attach and reload.
  autoResume = false;
  let after = await waitHit(HIT_TIMEOUT_MS);
  const iso = await debuggerClient.call('getIsolate', { isolateId });
  const kept = (iso.breakpoints ?? []).find((b) => b.id === breakpointId);
  record(
    'breakpoint still hits after reload',
    after?.ours === true && after.line === line,
    after
      ? `PauseBreakpoint at line ${after.line}, ${((after.t - reloadStart) / 1000).toFixed(1)} s after reload`
      : `no PauseBreakpoint in ${HIT_TIMEOUT_MS / 1000} s; VM still lists ${breakpointId}: ${kept !== undefined}, resolved ${kept?.resolved}`,
  );
  if (after === undefined) {
    // What an IDE user would do: remove the breakpoint and set it again.
    await debuggerClient.call('removeBreakpoint', { isolateId, breakpointId });
    const again = await debuggerClient.call('addBreakpointWithScriptUri', {
      isolateId,
      scriptUri: `package:${APP_NAME}/main.dart`,
      line,
    });
    breakpointId = again.id;
    after = await waitHit(HIT_TIMEOUT_MS);
    record(
      'hits again once breakpoint is re-set',
      after?.ours === true && after.line === line,
      after ? `${again.id} paused at line ${after.line}` : 'no PauseBreakpoint',
    );
  }
  if (after === undefined) throw new Error('breakpoint never hit after the reload');
  await screenshot(serial, '3-paused-at-breakpoint');
  if (CONTROL) {
    await debuggerClient.call('resume', { isolateId });
    record('debugger resumes', true, 'resume ok');
    throw new Error('control run done');
  }
  const stillAttached = (await api('/api/status')).attached?.id === app.id;
  await debuggerClient.call('resume', { isolateId });
  autoResume = true;
  const resumedAt = Date.now();
  record('debugger resumes', true, 'resume ok');
  record('daemon attached while paused', stillAttached, stillAttached ? 'yes' : 'detached');
  const flowing = await waitFor(async () => {
    const { entries } = await api('/api/logs?text=qa-sample%20reloaded%20tick&limit=20');
    return entries.find((e) => e.ts > resumedAt);
  }, 10_000);
  const attachedAfter = (await api('/api/status')).attached?.id === app.id;
  record(
    'logs flow after resume',
    flowing !== undefined && attachedAfter,
    flowing ? `${flowing.message}; still attached ${attachedAfter}` : 'no new entries in 10 s',
  );

  // 6. Stop the daemon. The debugger and the app must not notice.
  daemon.kill('SIGINT');
  const exit = await Promise.race([daemonExited, sleep(3000).then(() => undefined)]);
  record('daemon stops', exit !== undefined, exit ? `code ${exit.code ?? exit.signal}` : 'hung');
  await sleep(1000);
  const live = await debuggerClient.call('getIsolate', { isolateId }).catch((e) => e);
  record(
    'debugger still connected',
    !debuggerClient.closed && !(live instanceof Error),
    live instanceof Error ? live.message : `isolate ${live.name} ${live.pauseEvent?.kind}`,
  );
  const afterStop = await waitHit(HIT_TIMEOUT_MS);
  if (afterStop !== undefined) await debuggerClient.call('resume', { isolateId });
  record(
    'breakpoint hits after daemon stop',
    afterStop?.ours === true,
    afterStop ? `line ${afterStop.line}, resumed` : 'no PauseBreakpoint',
  );
  const now = await findSerial();
  record(
    'app still running',
    now?.pid === device.pid,
    now ? `pid ${now.pid} (was ${device.pid})` : 'app process gone',
  );
  await sleep(1500);
  await screenshot(serial, '4-after-daemon-stop');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message !== 'control run done') record('check ran to the end', false, message);
} finally {
  await cleanup();
}

process.exit(report());
