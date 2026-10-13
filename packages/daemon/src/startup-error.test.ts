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

  it('uses the message of an error-like object that is not an Error', () => {
    const line = formatStartupError({ message: 'listen EADDRNOTAVAIL', code: 'EADDRNOTAVAIL' });
    expect(line).toBe('project-deck daemon could not start: listen EADDRNOTAVAIL');
  });

  it('falls back to the code of an error-like object without a message', () => {
    expect(formatStartupError({ code: 'EADDRNOTAVAIL' })).toBe(
      'project-deck daemon could not start: EADDRNOTAVAIL',
    );
  });

  it('falls back to the code, then the name, when an Error has an empty message', () => {
    const err = Object.assign(new Error(''), { code: 'EADDRNOTAVAIL' });
    expect(formatStartupError(err)).toBe('project-deck daemon could not start: EADDRNOTAVAIL');
    expect(formatStartupError(new TypeError('  '))).toBe(
      'project-deck daemon could not start: TypeError',
    );
  });

  it('joins the inner reasons of an AggregateError with no message of its own', () => {
    // Node's own multi-address connect failures are shaped like this.
    const err = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:1'), new Error('connect ECONNREFUSED ::1:1')],
      '',
    );
    expect(formatStartupError(err)).toBe(
      'project-deck daemon could not start: connect ECONNREFUSED 127.0.0.1:1; connect ECONNREFUSED ::1:1',
    );
  });

  it('prints a safe line for a null-prototype object instead of throwing', () => {
    expect(formatStartupError(Object.create(null))).toBe(
      'project-deck daemon could not start: unknown error',
    );
  });

  it('does not throw when reading the error itself throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    expect(formatStartupError(hostile)).toBe('project-deck daemon could not start: unknown error');
  });
});
