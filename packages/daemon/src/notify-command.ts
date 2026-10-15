/**
 * The OS notifier commands (PM decision D3, docs/design/m2-dashboard.md). Each is a fixed
 * program at a fixed absolute path with a fixed script; the title and text are data only:
 * - macOS: osascript's run handler reads them from argv, after `--`.
 * - Linux: notify-send from /usr/bin or /usr/local/bin only, after `--`, markup escaped.
 * - Windows: PowerShell gets them in environment variables, never in arguments (anything
 *   after -Command would be script text), and adds them to the toast as XML text nodes.
 */

export const MAX_NOTIFY_TITLE = 64;
export const MAX_NOTIFY_TEXT = 200;

export const MACOS_SCRIPT =
  'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';

export const LINUX_NOTIFY_SEND_PATHS = ['/usr/bin/notify-send', '/usr/local/bin/notify-send'];

/** PowerShell's own app id: Windows shows toasts only for a registered app. */
const POWERSHELL_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$lines = $xml.GetElementsByTagName('text')",
  '[void]$lines.Item(0).AppendChild($xml.CreateTextNode($env:DECK_NOTIFY_TITLE))',
  '[void]$lines.Item(1).AppendChild($xml.CreateTextNode($env:DECK_NOTIFY_TEXT))',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
].join('\n');

const ENCODED_WINDOWS_SCRIPT = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');

export interface NotifierCommand {
  /** Absolute path; spawned without a shell. */
  file: string;
  args: string[];
  /** The whole environment for the process, when it needs more than the daemon's. */
  env?: Record<string, string | undefined>;
}

export interface NotifierCommandDeps {
  env: Record<string, string | undefined>;
  /** notify-send's path, looked up in LINUX_NOTIFY_SEND_PATHS only. */
  findNotifySend: () => string | undefined;
}

/**
 * Control characters become spaces (a newline could start a new script line or option
 * somewhere); invisible format characters such as bidi overrides go. Then the text is cut
 * to `max` characters, with "…" marking the cut.
 */
export function cleanNotifyText(text: string, max: number): string {
  const flat = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

const escapeMarkup = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A plain local absolute path such as `C:\Windows`; anything odd falls back to the default. */
function systemRoot(env: Record<string, string | undefined>): string {
  const root = env.SystemRoot;
  return root !== undefined && /^[A-Za-z]:\\[A-Za-z0-9 _.\\-]*$/.test(root)
    ? root.replace(/\\+$/, '')
    : 'C:\\Windows';
}

/** The command that shows one notification, or undefined where there is no notifier. */
export function notifierCommand(
  platform: NodeJS.Platform,
  title: string,
  text: string,
  deps: NotifierCommandDeps,
): NotifierCommand | undefined {
  const t = cleanNotifyText(title, MAX_NOTIFY_TITLE);
  const body = cleanNotifyText(text, MAX_NOTIFY_TEXT);
  switch (platform) {
    case 'darwin':
      return { file: '/usr/bin/osascript', args: ['-e', MACOS_SCRIPT, '--', t, body] };
    case 'linux': {
      const file = deps.findNotifySend();
      if (file === undefined) return undefined;
      return { file, args: ['--', escapeMarkup(t), escapeMarkup(body)] };
    }
    case 'win32':
      return {
        file: `${systemRoot(deps.env)}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_WINDOWS_SCRIPT],
        env: { ...deps.env, DECK_NOTIFY_TITLE: t, DECK_NOTIFY_TEXT: body },
      };
    default:
      return undefined;
  }
}
