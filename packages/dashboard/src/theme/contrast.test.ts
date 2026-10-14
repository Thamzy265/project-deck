import { describe, expect, it } from 'vitest';
import tokensCss from '../tokens.css?raw';
import { contrastRatio, readThemes } from './contrast.js';

const themes = readThemes(tokensCss);

/** Text colours and the backgrounds they appear on: 4.5:1 (WCAG 1.4.3). */
const TEXT = [
  'text',
  'text-muted',
  'accent',
  'status-ok',
  'status-error',
  'status-warn',
  'level-verbose',
  'level-debug',
  'level-info',
  'level-warning',
  'level-error',
];
/** Control borders and the focus ring: 3:1 (WCAG 1.4.11). */
const UI = ['border', 'focus', 'accent', 'status-ok', 'status-error'];
const BACKGROUNDS = ['bg', 'surface'];

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('colour tokens', () => {
  it('define both a light and a dark theme with the same names', () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
    expect(Object.keys(themes.light).length).toBeGreaterThan(10);
  });

  for (const [name, theme] of Object.entries(themes)) {
    for (const bg of BACKGROUNDS) {
      for (const fg of TEXT) {
        it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
          expect(contrastRatio(theme[fg] ?? '', theme[bg] ?? '')).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const fg of UI) {
        it(`${name}: ${fg} on ${bg} is at least 3:1`, () => {
          expect(contrastRatio(theme[fg] ?? '', theme[bg] ?? '')).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }
});
