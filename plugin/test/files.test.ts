import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { posixRelative } from './files.js';
import { splitFrontmatter } from './frontmatter.js';

describe('posixRelative (review C1: Windows paths)', () => {
  it('turns Windows separators into /, so a filter on "/graders/" finds the file', () => {
    const rel = posixRelative(
      'C:\\repo\\plugin\\evals',
      'C:\\repo\\plugin\\evals\\db-pending-orders\\graders\\answer.md',
      path.win32,
    );
    expect(rel).toBe('db-pending-orders/graders/answer.md');
    expect(rel.split('/')).toEqual(['db-pending-orders', 'graders', 'answer.md']);
  });

  it('keeps POSIX paths as they are', () => {
    expect(posixRelative('/r/evals', '/r/evals/mocks/dart/dtd.md', path.posix)).toBe(
      'mocks/dart/dtd.md',
    );
  });
});

describe('splitFrontmatter', () => {
  it('reads LF and CRLF files, and a file with only frontmatter', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody')).toEqual({ front: 'a: 1', body: 'body' });
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nbody')).toEqual({ front: 'a: 1', body: 'body' });
    expect(splitFrontmatter('---\ntype: llm\n---')).toEqual({ front: 'type: llm', body: '' });
  });

  it('answers null without frontmatter', () => {
    expect(splitFrontmatter('{"a":1}')).toBeNull();
  });
});
