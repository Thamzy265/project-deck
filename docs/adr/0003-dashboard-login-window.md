# 0003. A login window for the dashboard cookie

Date: 2026-10-14

## Status

Accepted (PM decision, 14 Oct 2026). Amends [0001](0001-dashboard-login-cookie.md): the cookie design stays; this decides when the cookie may be handed out.

## Context

ADR 0001 sets the dashboard cookie on any top-level `GET /` from localhost. The review of batch 1 found that a program run by another OS user on the same machine can do that request too (it can forge fetch metadata), get the cookie and then read logs, reload the app or stop the daemon. In M1 the `runtime.json` token, readable only by the daemon's own user, stopped other OS users. The project rule is that every request needs that token.

Options: accept the risk for the MVP; a short login window opened by someone who holds the token; or a code the user pastes into the dashboard on every daemon start.

## Decision

We will hand out the cookie only while a **login window** is open:

- The daemon opens a 2-minute window when it starts.
- `POST /api/login-window` opens a new 2-minute window. It accepts **only** the `runtime.json` token header, never the cookie. The FlutterDeck MCP server calls it when it starts (so a new Claude session can open the dashboard), and `flutterdeck open` calls it and prints the dashboard address.
- While the window is open, `GET /` as a top-level navigation sets the cookie as ADR 0001 describes. When it is closed, `GET /` serves a "Login needed" page that says to run `flutterdeck open` (or start a Claude session), and sets no cookie.
- A cookie already handed out stays valid until the daemon stops.

## Consequences

- Another OS user can only get a cookie by racing the user during an open window; outside it they need the token, which they can't read.
- The dashboard's one-time reload after a daemon restart (design note, "Session expiry") works because the restart opens a new window.
- If the pane opens more than 2 minutes after the daemon started and no Claude session started since, the user sees "Login needed" and runs `flutterdeck open`.
- The window length is a constant (2 minutes), not a setting.
