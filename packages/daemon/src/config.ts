// Moved to core so clients (the MCP server, the CLI) read the config without daemon code.
export { CONFIG_FILE, ConfigError, configPath, readConfig } from '@project-deck/core/node';
