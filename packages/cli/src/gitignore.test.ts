import { describe, expect, it } from 'vitest';
import { GITIGNORE_BEGIN, GITIGNORE_END, IGNORED, addIgnoreBlock } from './gitignore.js';

describe('addIgnoreBlock', () => {
  it('creates the block for a missing file', () => {
    const text = addIgnoreBlock(undefined);
    expect(text).toBe([GITIGNORE_BEGIN, ...IGNORED, GITIGNORE_END, ''].join('\n'));
  });

  it('ignores the files that hold the token, logs and locks, and not config.json', () => {
    expect(IGNORED).toEqual(
      expect.arrayContaining([
        '.flutterdeck/state.json',
        '.flutterdeck/runtime.json',
        '.flutterdeck/daemon.log',
        '.flutterdeck/*.lock',
        '.flutterdeck/*.tmp',
        '.flutterdeck/*.stale',
      ]),
    );
    expect(IGNORED.some((line) => line.includes('config'))).toBe(false);
  });

  it('appends after existing lines, adding the missing final newline first', () => {
    const text = addIgnoreBlock('build/\n.dart_tool');
    expect(text?.startsWith('build/\n.dart_tool\n\n' + GITIGNORE_BEGIN + '\n')).toBe(true);
    expect(text?.endsWith(GITIGNORE_END + '\n')).toBe(true);
  });

  it('keeps Windows line endings', () => {
    const text = addIgnoreBlock('build/\r\n') ?? '';
    expect(text.startsWith('build/\r\n\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('changes nothing when the block is already there (idempotent)', () => {
    const once = addIgnoreBlock('build/\n') ?? '';
    expect(addIgnoreBlock(once)).toBeUndefined();
  });

  it('leaves a block the user edited alone', () => {
    const edited = `build/\n${GITIGNORE_BEGIN}\n.flutterdeck/runtime.json\n${GITIGNORE_END}\n`;
    expect(addIgnoreBlock(edited)).toBeUndefined();
  });

  it('starts the block on its own when the file is empty', () => {
    expect(addIgnoreBlock('')).toBe(addIgnoreBlock(undefined));
  });
});
