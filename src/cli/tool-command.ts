/** Single-shot JSON tools use exactly the MCP handlers and refusal boundaries. */
import { ValidationError } from '../errors.js';
import { type McpServerOptions, runReadOnlyTool } from './mcp.js';

export const TOOL_COMMANDS: readonly string[] = ['capabilities', 'schema', 'compile', 'explain-error'];

/**
 * Dispatch one CLI tool request; no banners are mixed into the JSON result.
 * @example runToolCommand({ command: 'compile', subcommand: '{"table":"users"}', positional: [] }, options)
 */
export async function runToolCommand(
  args: { command: string; subcommand?: string; positional: string[] },
  options: McpServerOptions,
): Promise<unknown> {
  if (args.positional.length > 0) throw new ValidationError('Tool commands accept at most one positional argument.');
  switch (args.command) {
    case 'doctor':
      if (options.engine !== 'sqlite') throw new ValidationError('Doctor tool commands require SQLite.');
      if (args.subcommand !== undefined) throw new ValidationError('SQLite doctor accepts no positional arguments.');
      return runReadOnlyTool(options, 'doctor_report');
    case 'capabilities':
      if (args.subcommand !== undefined) throw new ValidationError('capabilities accepts no positional argument.');
      return runReadOnlyTool(options, 'engine_capabilities');
    case 'schema':
      return runReadOnlyTool(options, args.subcommand === undefined ? 'schema_overview' : 'table_detail', {
        table: args.subcommand,
      });
    case 'explain-error':
      return runReadOnlyTool(options, 'explain_error', { code: args.subcommand });
    case 'compile': {
      let input: unknown;
      try {
        input = JSON.parse(args.subcommand ?? '');
      } catch {
        throw new ValidationError(
          'compile requires one JSON object: {"table":"users","operation":"findMany","args":{"limit":5}}',
        );
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError('compile requires a JSON object with table, operation and args.');
      }
      return runReadOnlyTool(options, 'compile_query', input as Record<string, unknown>);
    }
    default:
      throw new ValidationError('Unknown read-only tool command.');
  }
}
