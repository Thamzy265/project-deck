// Moved to core so clients (the MCP server, the CLI) read the file without daemon code.
export {
  RUNTIME_FILE,
  RuntimeInfoSchema,
  STATE_DIR,
  readRuntime,
  removeRuntime,
  runtimePath,
  writeRuntime,
} from '@project-deck/core/node';
export type { RuntimeInfo } from '@project-deck/core/node';
