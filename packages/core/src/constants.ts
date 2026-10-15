/** The header that carries the runtime.json token. Never a URL or a cookie. */
export const TOKEN_HEADER = 'x-deck-token';

/**
 * FlutterDeck's version, shared by the daemon and its clients so a client can tell a
 * daemon from an older build (shown on /api/health).
 */
export const DECK_VERSION = '0.0.0';
