import { describe, expect, it } from 'vitest';
import { browserCommand, isDashboardUrl } from './browser.js';

const URL_OK = 'http://127.0.0.1:9147/';
const exists = (paths: string[]) => (path: string) => paths.includes(path);

describe('isDashboardUrl', () => {
  it.each([URL_OK, 'http://127.0.0.1:1024/', 'http://127.0.0.1:65535/'])('accepts %s', (url) => {
    expect(isDashboardUrl(url)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:9147',
    'http://127.0.0.1:9147/x',
    'http://127.0.0.1:9147/?a=1',
    'http://localhost:9147/',
    'https://127.0.0.1:9147/',
    'http://127.0.0.1:0/',
    'http://127.0.0.1:70000/',
    'http://127.0.0.1:09147/',
    'javascript:alert(1)//http://127.0.0.1:9147/',
    'http://127.0.0.1:9147/ & calc',
    'http://evil@127.0.0.1:9147/',
  ])('refuses %s', (url) => {
    expect(isDashboardUrl(url)).toBe(false);
  });
});

describe('browserCommand', () => {
  it('uses /usr/bin/open on macOS', () => {
    expect(browserCommand(URL_OK, { platform: 'darwin', exists: exists([]) })).toEqual({
      command: '/usr/bin/open',
      args: [URL_OK],
    });
  });

  it('uses xdg-open from a system folder only on Linux', () => {
    expect(
      browserCommand(URL_OK, { platform: 'linux', exists: exists(['/usr/local/bin/xdg-open']) }),
    ).toEqual({ command: '/usr/local/bin/xdg-open', args: [URL_OK] });
    expect(browserCommand(URL_OK, { platform: 'linux', exists: exists([]) })).toBeUndefined();
  });

  it('uses explorer.exe from the Windows folder, never cmd', () => {
    expect(
      browserCommand(URL_OK, { platform: 'win32', exists: exists([]), systemRoot: 'D:\\Windows' }),
    ).toEqual({ command: 'D:\\Windows\\explorer.exe', args: [URL_OK] });
    // A relative SystemRoot would resolve against the current folder.
    expect(
      browserCommand(URL_OK, { platform: 'win32', exists: exists([]), systemRoot: 'Windows' }),
    ).toBeUndefined();
  });

  it('refuses any other URL', () => {
    expect(
      browserCommand('http://127.0.0.1:9147/x', { platform: 'darwin', exists: exists([]) }),
    ).toBeUndefined();
  });
});
