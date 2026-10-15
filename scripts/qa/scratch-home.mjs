// A scratch home folder for the daemons the QA scripts start. Since M2 the daemon keeps a
// per-user port registry in ~/.flutterdeck, so with the real HOME a QA run would write
// there. The Dart data folder (DTD discovery) and the Android SDK are found from the real
// home, so they are passed explicitly.
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function dartDataHome(home) {
  if (process.env.DART_DATA_HOME) return process.env.DART_DATA_HOME;
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Dart');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? home, 'Dart');
  return join(process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'Dart');
}

function androidHome(home) {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;
  if (process.platform === 'darwin') return join(home, 'Library', 'Android', 'sdk');
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk');
  return join(home, 'Android', 'Sdk');
}

/** Environment for a daemon child process with a scratch HOME, and its clean-up. */
export async function scratchHomeEnv() {
  const real = homedir();
  const home = await mkdtemp(join(tmpdir(), 'deck-qa-home-'));
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DART_DATA_HOME: dartDataHome(real),
      ANDROID_HOME: androidHome(real),
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
