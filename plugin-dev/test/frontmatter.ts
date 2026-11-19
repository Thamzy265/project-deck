/** The YAML frontmatter of a Markdown file, as Claude Code and `claude plugin eval` read it. */
export function splitFrontmatter(text: string): { front: string; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return match === null ? null : { front: match[1] ?? '', body: match[2] ?? '' };
}
