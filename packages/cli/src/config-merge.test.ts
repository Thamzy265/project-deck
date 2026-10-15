import { describe, expect, it } from 'vitest';
import { newConfigText, withPort } from './config-merge.js';

describe('newConfigText', () => {
  it('writes version 1 and the port', () => {
    expect(JSON.parse(newConfigText(9147))).toEqual({ version: 1, port: 9147 });
  });
});

describe('withPort', () => {
  it('adds the port and keeps every other setting and the layout', () => {
    const text = '{\n    "version": 1,\n    "logs": { "redact": false }\n}\n';
    const out = withPort(text, 9150);
    expect(JSON.parse(out)).toEqual({ version: 1, logs: { redact: false }, port: 9150 });
    expect(out).toContain('    "logs": { "redact": false }');
  });

  it('keeps a byte order mark', () => {
    const out = withPort('﻿{"version":1}', 9150);
    expect(out.startsWith('﻿')).toBe(true);
    expect(JSON.parse(out.slice(1))).toEqual({ version: 1, port: 9150 });
  });
});
