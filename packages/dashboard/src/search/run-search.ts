/** A search pass: the pattern and each candidate line's key and search text. */
export interface SearchRequest {
  id: number;
  pattern: string;
  items: [key: number, text: string][];
}

export type SearchReply = { id: number; keys: number[] } | { id: number; error: string };

/** The worker's whole job, kept pure so it can be tested and run inline. */
export function runSearch(request: SearchRequest): SearchReply {
  let regex: RegExp;
  try {
    regex = new RegExp(request.pattern, 'i');
  } catch (err) {
    return { id: request.id, error: err instanceof Error ? err.message : 'Invalid pattern' };
  }
  const keys: number[] = [];
  for (const [key, text] of request.items) if (regex.test(text)) keys.push(key);
  return { id: request.id, keys };
}
