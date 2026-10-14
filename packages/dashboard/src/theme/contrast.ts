/** WCAG 2.x contrast maths, used by the token check in the tests. */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match?.[1] === undefined) throw new Error(`Not a #rrggbb colour: '${hex}'`);
  const n = Number.parseInt(match[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

type Theme = Record<string, string>;

function colours(block: string): Theme {
  const out: Theme = {};
  for (const m of block.matchAll(/--deck-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

/** Light colours from the first `:root` block; dark ones from the `prefers-color-scheme` block. */
export function readThemes(css: string): { light: Theme; dark: Theme } {
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  if (darkStart === -1) throw new Error('No dark theme block');
  return { light: colours(css.slice(0, darkStart)), dark: colours(css.slice(darkStart)) };
}
