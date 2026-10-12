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
});
