/**
 * Hook inputs as Claude Code sends them on stdin. DOC-BUILT, not recorded: shapes from
 * the hook input examples at code.claude.com/docs/en/hooks (read 15 Oct 2026), with the
 * tool names and results of the Dart MCP server's hot_reload and hot_restart tools from
 * dart-lang/ai pkgs/dart_mcp_server/lib/src/mixins/dtd.dart (main, 15 Oct 2026). QA
 * should replace them with recorded inputs from a real session.
 */

const common = {
  session_id: 'abc123',
  transcript_path: '/Users/dev/.claude/projects/shop/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/dev/shop_app',
  permission_mode: 'default',
};

/** Text that must never reach the daemon. */
export const SECRET_ASSISTANT_TEXT = 'The secret plan is in /Users/dev/notes.txt';
export const VM_SERVICE_URI = 'ws://127.0.0.1:52345/AbCdEf123_Q=/ws';

export const stop = {
  ...common,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: SECRET_ASSISTANT_TEXT,
  background_tasks: [
    {
      id: 'task-001',
      type: 'shell',
      status: 'running',
      description: 'tail logs',
      command: 'tail -f /var/log/syslog',
    },
  ],
  session_crons: [],
};

export const subagentStop = {
  ...common,
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id: 'def456',
  agent_type: 'Explore',
  agent_transcript_path: '/Users/dev/.claude/projects/shop/abc123/subagents/agent-def456.jsonl',
  last_assistant_message: SECRET_ASSISTANT_TEXT,
  background_tasks: [],
  session_crons: [],
};

export const permissionPrompt = {
  ...common,
  hook_event_name: 'Notification',
  message: 'Claude needs your permission to use Bash',
  title: 'Permission needed',
  notification_type: 'permission_prompt',
};

export const idlePrompt = {
  ...common,
  hook_event_name: 'Notification',
  message: 'Claude is waiting for your input',
  notification_type: 'idle_prompt',
};

export const authSuccess = {
  ...common,
  hook_event_name: 'Notification',
  message: 'Signed in',
  notification_type: 'auth_success',
};

/** The plugin's own Dart server: mcp__plugin_<plugin>_<server>__<tool>. */
export const PLUGIN_RELOAD_TOOL = 'mcp__plugin_flutterdeck_dart__hot_reload';

export const reloadSucceeded = {
  ...common,
  hook_event_name: 'PostToolUse',
  tool_name: PLUGIN_RELOAD_TOOL,
  tool_input: { clearRuntimeErrors: true, appUri: VM_SERVICE_URI },
  tool_response: [{ type: 'text', text: 'Hot reload succeeded.' }],
  tool_use_id: 'toolu_01ABC123',
  duration_ms: 812,
};

export const restartSucceeded = {
  ...reloadSucceeded,
  tool_name: 'mcp__dart__hot_restart',
  tool_input: {},
  tool_response: [{ type: 'text', text: 'Hot restart succeeded.' }],
};

/** The Dart MCP server's failed reload, if Claude Code reports it as PostToolUse. */
export const reloadFailedAsPostToolUse = {
  ...reloadSucceeded,
  tool_response: { content: [{ type: 'text', text: 'Hot reload failed.' }], isError: true },
};

/** An MCP error result fires PostToolUseFailure with the result text in `error`. */
export const reloadFailed = {
  ...common,
  hook_event_name: 'PostToolUseFailure',
  tool_name: PLUGIN_RELOAD_TOOL,
  tool_input: { appUri: VM_SERVICE_URI },
  tool_use_id: 'toolu_01ABC124',
  error: `Hot reload failed: RPCError: connection to ${VM_SERVICE_URI} closed while compiling /Users/dev/shop_app/lib/main.dart`,
  is_interrupt: false,
  duration_ms: 4187,
};

/**
 * The error shape QA saw from a real compile error or VM rejection (docs/qa/M2.md,
 * F-B5-1, 15 Oct 2026): one line, then a flutter_tools stack trace.
 */
export const reloadRejected = {
  ...common,
  hook_event_name: 'PostToolUseFailure',
  tool_name: PLUGIN_RELOAD_TOOL,
  tool_input: {},
  tool_use_id: 'toolu_01ABC125',
  error: [
    'Hot reload failed: s1.reloadSources: (-32000) Unable to reload sources: (-32603)',
    '#0      new _RemoteException (package:flutter_tools/src/vmservice.dart:120:5)',
    '#1      ResidentRunner.reloadSources (/Users/dev/flutter/packages/flutter_tools/lib/src/run_hot.dart:812:7)',
  ].join('\n'),
  is_interrupt: false,
  duration_ms: 1520,
};

export const restartFailedOtherPlugin = {
  ...reloadFailed,
  tool_name: 'mcp__plugin_dart-flutter_dart-mcp-server__hot_restart',
  error: 'Hot restart failed.',
};

export const reloadInterrupted = { ...reloadFailed, is_interrupt: true };

export const otherMcpTool = {
  ...reloadSucceeded,
  tool_name: 'mcp__plugin_flutterdeck_flutterdeck__deck_status',
};

/** Another server's hot_reload tool, not the Dart MCP server's. */
export const notDartReload = { ...reloadSucceeded, tool_name: 'mcp__vite__hot_reload' };
