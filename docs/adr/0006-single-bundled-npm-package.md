# 0006. Ship the CLI as one bundled npm package

Date: 2026-11-10

## Status

Accepted (PM, 10 Nov 2026, M5 decision D1)

## Context

The CLI is built from 11 workspace packages (`@project-deck/*`) that import each other through `dist`. Users will run it with `npx`. Publishing every package exposes internal APIs, needs an npm org, pulls the dashboard's React and CodeMirror sources into every install, and leaves the bin name (`pitdeck`) different from the package name, so `npx pitdeck` would fetch an unscoped package we do not own. See [design/m5-release.md](../design/m5-release.md).

## Decision

We will publish one unscoped package, `pitdeck`, built with a bundler. It holds the CLI and our internal packages, the dashboard's built files, the two worker entry points and the sqlite-wasm file. A few pure-JS dependencies stay external. The `@project-deck/*` packages become `private`.

## Consequences

- `npx pitdeck` runs our package; the name is claimed by the first publish.
- One version to release; smaller download; internal APIs can change freely.
- We own a bundling step and must keep asset and worker paths correct; a CI smoke test installs the packed tarball on three OSes to prove it.
- Other projects cannot import our internal packages from npm.
