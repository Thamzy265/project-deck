import { describe, expect, it } from 'vitest';
import { DaemonAlreadyRunningError } from './daemon.js';
import { formatStartupError } from './startup-error.js';

describe('formatStartupError', () => {
  it('prints a second-daemon refusal as is', () => {
    expect(formatStartupError(new DaemonAlreadyRunningError(9148))).toBe(
      'A project-deck daemon is already running for this project on port 9148',
    );
  });

  it('turns a system error into one line without a stack', () => {
    const err = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:80'), {
      code: 'EACCES',
    });
    const line = formatStartupError(err);
    expect(line).toBe(
      'project-deck daemon could not start: listen EACCES: permission denied 127.0.0.1:80',
    );
  });

  it('keeps multi-line messages and non-errors on one line', () => {
    expect(formatStartupError(new Error('first\nsecond'))).toBe(
      'project-deck daemon could not start: first second',
    );
    expect(formatStartupError('boom')).toBe('project-deck daemon could not start: boom');
  });

  it('still prints one line for null, undefined and numbers', () => {
    expect(formatStartupError(null)).toBe('project-deck daemon could not start: null');
    expect(formatStartupError(undefined)).toBe('project-deck daemon could not start: undefined');
    expect(formatStartupError(42)).toBe('project-deck daemon could not start: 42');
  });

  it('collapses CRLF and trailing newlines', () => {
    const line = formatStartupError(new Error('a\r\n  b\r\n'));
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('a b');
  });

  it.fails('BUG: an error-like object that is not an Error prints [object Object]', () => {
    const line = formatStartupError({ message: 'listen EADDRNOTAVAIL', code: 'EADDRNOTAVAIL' });
    expect(line).toContain('EADDRNOTAVAIL');
  });

  it.fails('BUG: an Error with an empty message prints nothing after the colon', () => {
    const err = Object.assign(new Error(''), { code: 'EADDRNOTAVAIL' });
    expect(formatStartupError(err)).toContain('EADDRNOTAVAIL');
  });

  it.fails('BUG: an AggregateError with no message of its own drops the inner reasons', () => {
    // Node's own multi-address connect failures are shaped like this.
    const err = new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:1')], '');
    expect(formatStartupError(err)).toContain('ECONNREFUSED');
  });

  it.fails('BUG: a null-prototype object makes the formatter itself throw', () => {
    expect(() => formatStartupError(Object.create(null))).not.toThrow();
  });
});
