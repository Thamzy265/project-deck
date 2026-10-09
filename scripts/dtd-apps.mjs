#!/usr/bin/env node
// Lists every Dart Tooling Daemon on this machine and the apps registered in it.
// Read-only: only calls ConnectedApp.getVmServices. Auth codes are masked in the output.
// Usage: node scripts/dtd-apps.mjs
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function dataHome() {
  if (process.env.DART_DATA_HOME) return process.env.DART_DATA_HOME;
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'Dart');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'Dart');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'Dart');
}

const mask = (uri) => uri?.replace(/\/[^/]+\/?$/, '/…/');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function getVmServices(wsUri) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUri);
    const timer = setTimeout(() => (ws.close(), reject(new Error('timed out'))), 3000);
    ws.onerror = () => (clearTimeout(timer), reject(new Error('could not connect')));
    // Methods without parameters must omit `params` entirely; DTD rejects `params: {}`.
    ws.onopen = () =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ConnectedApp.getVmServices' }));
    ws.onmessage = (msg) => {
      clearTimeout(timer);
      ws.close();
      const body = JSON.parse(msg.data);
      if (body.error) reject(new Error(body.error.message));
      else resolve(body.result.vmServices);
    };
  });
}

const dir = join(dataHome(), 'dtd');
const files = await readdir(dir).catch(() => []);
if (files.length === 0)
  console.log(`No DTD files in ${dir}. Dart 3.12+ and a running IDE or flutter run are needed.`);

for (const file of files) {
  const info = JSON.parse(await readFile(join(dir, file), 'utf8'));
  const label = `DTD pid ${info.pid} (${info.ideName ?? 'no IDE name'}, Dart ${info.dartVersion.split(' ')[0]})`;
  if (!isAlive(info.pid)) {
    console.log(`${label}: stale, process is gone`);
    continue;
  }
  try {
    const apps = await getVmServices(info.wsUri);
    console.log(`${label}: ${apps.length} app(s)`);
    for (const app of apps) console.log(`  - ${app.name ?? '(unnamed)'}  ${mask(app.uri)}`);
  } catch (err) {
    console.log(`${label}: ${err.message}`);
  }
}
