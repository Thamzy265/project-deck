# 0001. Dashboard login with a strict cookie

Date: 2026-10-14

## Status

Accepted (PM decision D1, 14 Oct 2026)

## Context

The daemon's API and WebSocket need the session token from `.flutterdeck/runtime.json`. The plan said the dashboard gets the token from the URL on first load. Claude Desktop's Browser pane rejects a localhost URL with a path or query, and project rules forbid tokens in URLs. The other option was to write the token into the served HTML, where any page script (and any XSS bug) could read it.

## Decision

We will set a cookie `deck_session_<port>=<session secret>; HttpOnly; SameSite=Strict; Path=/` when the dashboard page (`/`) is loaded with a localhost `Host` as a top-level navigation (`Sec-Fetch-Site` is `none` or `same-origin`, or absent). The session secret is random, made at daemon start, and is not the `runtime.json` token. The port is in the name because browsers don't separate cookies by port. The API and WebSocket accept this cookie as well as the existing token header; a cookie-authenticated request must also have `Sec-Fetch-Site: same-origin` (or no fetch metadata) and the exact Origin when present. No `GET` route has a side effect. The Host and Origin checks stay. The WebSocket stops accepting the token in its query string.

## Consequences

- No token appears in a URL or in page JavaScript.
- Web pages on other sites can't send the cookie and are already blocked by the Origin check. Pages on other 127.0.0.1 ports count as the same site, so the fetch-metadata and Origin checks are what stop them.
- The browser sends the cookie to every server on 127.0.0.1, whatever its port. Because the cookie holds a session secret that only opens the dashboard API, not the `runtime.json` token, another local server that sees it gets dashboard access only while this daemon runs. A program that can call 127.0.0.1 can also load `/` and get a cookie. Same-user local programs are outside the threat model, as in M1.
- The secret changes on every daemon start, so the dashboard reloads once to get a new cookie after a restart.
- Every new route and socket must accept the cookie and keep the Host and Origin checks; the reviewer checks this.
