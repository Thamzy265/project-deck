import { describe, expect, it } from 'vitest';
import {
  LINUX_NOTIFY_SEND_PATHS,
  MACOS_SCRIPT,
  MAX_NOTIFY_TEXT,
  MAX_NOTIFY_TITLE,
  WINDOWS_SCRIPT,
  cleanNotifyText,
  notifierCommand,
} from './notify-command.js';

/** Text that some layer could read as code, an option or markup. */
const PAYLOADS = [
  `it's "quoted"`,
  'back`tick`',
  '$(touch /tmp/pwned)',
  'a; rm -rf ~',
  'line one\nline two\r\n',
  '-e do shell script "id"',
  '--help',
  '<b>bold</b> & <i>it</i>',
  '</text></binding></visual><actions><action activationType="protocol" arguments="https://x"/></actions>',
  '%SystemRoot% ${env:PATH} $env:USERPROFILE',
];

const decode = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf16le');

describe('cleanNotifyText', () => {
  it('removes control and invisible format characters and squeezes white space', () => {
    expect(cleanNotifyText('a\nb\tc\u0000d\u001be[31m\u202eevil\u200b!', 100)).toBe(
      'a b c d e[31mevil!',
    );
  });

  it('cuts to the limit in characters, marking the cut', () => {
    expect(cleanNotifyText('x'.repeat(300), MAX_NOTIFY_TEXT)).toHaveLength(MAX_NOTIFY_TEXT);
    expect(cleanNotifyText('x'.repeat(300), MAX_NOTIFY_TEXT).endsWith('…')).toBe(true);
    expect(cleanNotifyText('😀'.repeat(70), MAX_NOTIFY_TITLE)).toBe(`${'😀'.repeat(63)}…`);
    expect(cleanNotifyText('short', MAX_NOTIFY_TITLE)).toBe('short');
  });
});

describe('notifierCommand on macOS', () => {
  const deps = { env: {}, findNotifySend: () => undefined };

  it.each(PAYLOADS)('passes %j only as a separate argument after the fixed script', (payload) => {
    const cmd = notifierCommand('darwin', 'FlutterDeck', payload, deps);
    expect(cmd?.file).toBe('/usr/bin/osascript');
    expect(cmd?.args).toEqual([
      '-e',
      MACOS_SCRIPT,
      '--',
      'FlutterDeck',
      cleanNotifyText(payload, MAX_NOTIFY_TEXT),
    ]);
    expect(cmd?.env).toBeUndefined();
  });

  it('reads title and text from argv in the fixed script', () => {
    expect(MACOS_SCRIPT).toBe(
      'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
    );
  });

  it('cleans the title too', () => {
    const cmd = notifierCommand('darwin', 'a\nb'.repeat(40), 'x', deps);
    expect(cmd?.args[3]).toBe(cleanNotifyText('a\nb'.repeat(40), MAX_NOTIFY_TITLE));
    expect(cmd?.args[3]).not.toContain('\n');
  });
});

describe('notifierCommand on Linux', () => {
  const found = { env: {}, findNotifySend: () => '/usr/bin/notify-send' };

  it.each(PAYLOADS)('passes %j after "--" with markup escaped', (payload) => {
    const cmd = notifierCommand('linux', 'Flutter<Deck>', payload, found);
    expect(cmd?.file).toBe('/usr/bin/notify-send');
    const [dashes, title, text, ...rest] = cmd?.args ?? [];
    expect(dashes).toBe('--');
    expect(rest).toEqual([]);
    expect(title).toBe('Flutter&lt;Deck&gt;');
    expect(text).not.toMatch(/[<>\n\r]/);
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it('escapes &, < and >', () => {
    expect(notifierCommand('linux', 't', '<b>&</b>', found)?.args[2]).toBe(
      '&lt;b&gt;&amp;&lt;/b&gt;',
    );
  });

  it('only looks in the fixed system folders', () => {
    expect(LINUX_NOTIFY_SEND_PATHS).toEqual(['/usr/bin/notify-send', '/usr/local/bin/notify-send']);
  });

  it('gives no command when notify-send is missing', () => {
    expect(
      notifierCommand('linux', 't', 'x', { env: {}, findNotifySend: () => undefined }),
    ).toBeUndefined();
  });
});

describe('notifierCommand on Windows', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil' };
  const deps = { env, findNotifySend: () => undefined };

  it.each(PAYLOADS)(
    'never puts %j in the arguments, only in two environment variables',
    (payload) => {
      const cmd = notifierCommand('win32', 'FlutterDeck', payload, deps);
      expect(cmd?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(cmd?.args).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
      ]);
      const script = decode(cmd?.args[3] ?? '');
      expect(script).toBe(WINDOWS_SCRIPT);
      const cleaned = cleanNotifyText(payload, MAX_NOTIFY_TEXT);
      for (const arg of cmd?.args ?? []) expect(arg).not.toContain(cleaned);
      expect(script).not.toContain(cleaned);
      expect(cmd?.env?.DECK_NOTIFY_TITLE).toBe('FlutterDeck');
      expect(cmd?.env?.DECK_NOTIFY_TEXT).toBe(cleaned);
      // The rest of the environment is kept: PowerShell needs SystemRoot and friends.
      expect(cmd?.env?.SystemRoot).toBe('C:\\Windows');
    },
  );

  it('builds the toast from the ToastText02 template with text nodes only', () => {
    expect(WINDOWS_SCRIPT).toContain('ToastTemplateType]::ToastText02');
    expect(WINDOWS_SCRIPT).toContain('CreateTextNode($env:DECK_NOTIFY_TITLE)');
    expect(WINDOWS_SCRIPT).toContain('CreateTextNode($env:DECK_NOTIFY_TEXT)');
    // The text never becomes XML source or script text.
    expect(WINDOWS_SCRIPT).not.toMatch(/LoadXml|InnerXml|Invoke-Expression|iex\b|-f\s/i);
    expect(WINDOWS_SCRIPT.match(/\$env:\w+/g)).toEqual([
      '$env:DECK_NOTIFY_TITLE',
      '$env:DECK_NOTIFY_TEXT',
    ]);
  });

  it.each([
    ['missing', undefined],
    ['relative', 'Windows'],
    ['with a quote', 'C:\\Win" & calc'],
    ['a share', '\\\\server\\share'],
    ['with a pipe', 'C:\\Windows|x'],
  ])('falls back to C:\\Windows when SystemRoot is %s', (_, systemRoot) => {
    const cmd = notifierCommand('win32', 't', 'x', {
      env: systemRoot === undefined ? {} : { SystemRoot: systemRoot },
      findNotifySend: () => undefined,
    });
    expect(cmd?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('uses another drive for SystemRoot when it is a plain absolute path', () => {
    const cmd = notifierCommand('win32', 't', 'x', {
      env: { SystemRoot: 'D:\\WINNT' },
      findNotifySend: () => undefined,
    });
    expect(cmd?.file).toBe('D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('notifierCommand elsewhere', () => {
  it('gives no command on other platforms', () => {
    expect(
      notifierCommand('freebsd', 't', 'x', {
        env: {},
        findNotifySend: () => '/usr/bin/notify-send',
      }),
    ).toBeUndefined();
  });
});
