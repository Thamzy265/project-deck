#!/usr/bin/env node
/**
 * For QA and the PM check: runs main.js over stdio the way Claude does and calls tools.
 *   node packages/mcp/dist/qa-client.js [--project <dir>] [<tool> [<json arguments>]]
 * Without a tool it lists the tools. Prints each result's text as Claude would see it.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values, positionals } = parseArgs({
  options: { project: { type: 'string', default: process.cwd() } },
  allowPositionals: true,
});
const [tool, rawArgs = '{}'] = positionals;
const args: unknown = JSON.parse(rawArgs);
if (typeof args !== 'object' || args === null || Array.isArray(args)) {
  throw new Error('Arguments must be a JSON object, for example {"minLevel":"warn"}');
}

const client = new Client({ name: 'flutterdeck-qa', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./main.js', import.meta.url)),
      '--project',
      resolve(values.project),
    ],
  }),
);
try {
  if (tool === undefined) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: ${t.description ?? ''}\n`);
  } else {
    const result = await client.callTool({
      name: tool,
      arguments: args as Record<string, unknown>,
    });
    if (result.isError === true) console.log('(tool error)');
    for (const part of result.content as { type: string; text?: string }[]) {
      console.log(part.text ?? `[${part.type}]`);
    }
  }
} finally {
  await client.close();
}
