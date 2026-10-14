# 0001. Dashboard login with a strict cookie

Date: 2026-10-14

## Status

Accepted (PM decision D1, 14 Oct 2026)

## Context

The daemon's API and WebSocket need the session token from `.flutterdeck/runtime.json`. The plan said the dashboard gets the token from the URL on first load. Claude Desktop's Browser pane rejects a localhost URL with a path or query, and project rules forbid tokens in URLs. The other option was to write the token into the served HTML, where any page script (and any XSS bug) could read it.

## Decision

We will set a cookie `deck_session=<token>; HttpOnly; SameSite=Strict; Path=/` when the dashboard page (`/`) is loaded with a localhost `Host` as a top-level navigation (`Sec-Fetch-Site` is `none` or `same-origin`, or absent). The API and WebSocket accept this cookie as well as the existing header. The Host and Origin checks stay. The WebSocket stops accepting the token in its query string.

## Consequences

- No token appears in a URL or in page JavaScript.
- Web pages on other sites can't send the cookie and are already blocked by the Origin check.
- A local program that can call 127.0.0.1 can still get the cookie by loading `/`. That is the same exposure as reading `runtime.json` today; the threat model is web pages, not local programs.
- Every new route and socket must accept the cookie and keep the Host and Origin checks; the reviewer checks this.
