import type { z } from 'zod';

/** A request the shared schemas refused: answered with 400 and the zod issues. */
export class BadRequest extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new BadRequest('Invalid request', result.error.issues);
  return result.data;
}

export async function jsonBody(req: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest('Body must be JSON');
  }
}
