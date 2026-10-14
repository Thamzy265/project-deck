import { createHash } from 'node:crypto';

/** The CSP of every other answer. */
export const DEFAULT_CSP = "default-src 'self'; connect-src 'self'; frame-ancestors 'none'";

// Centred, system font, light and dark. Kept in the page so it works before any login.
const STYLE =
  ':root{color-scheme:light dark}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fff;color:#16181d}' +
  'main{max-width:32rem;padding:1rem;text-align:center}' +
  'code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f3f4f6;padding:0 .25rem;' +
  'border-radius:.25rem}' +
  '@media (prefers-color-scheme: dark){body{background:#121418;color:#e6e8ec}code{background:#1d2027}}';

/**
 * Only this exact style may run on the page: the CSP names its hash, so no other inline
 * style or script is allowed (no 'unsafe-inline').
 */
export const LOGIN_PAGE_CSP =
  "default-src 'self'; " +
  `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'; ` +
  "connect-src 'self'; frame-ancestors 'none'";

export const LOGIN_NEEDED_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>FlutterDeck</title><style>${STYLE}</style>` +
  '<main><p>Login needed. Run <code>flutterdeck open</code> in your project (or start a ' +
  'Claude session with the plugin), then reload this page.</p></main></html>';
