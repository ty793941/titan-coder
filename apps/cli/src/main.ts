#!/usr/bin/env node
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient, type ApiError } from './client.js';
import { createTask, getTask } from './commands/task.js';
import { cancelRun, createRun, followRunEvents, getRun, getRunEvents, pauseRun, resumeRun, type FollowOptions } from './commands/run.js';
import { createSession, getSession } from './commands/session.js';
import { getDaemon, heartbeatDaemon, registerDaemon, revokeDaemon } from './commands/daemon.js';

export type CliResult = { exitCode: number; stdout: string };

const help = `Usage: platform <command> [options]
  task create --project <id> --title <title> --goal <goal>
  task get <taskId>
  session create <taskId> --goal <goal> [--plan-hash <hash>]
  session get <sessionId>
  run create <sessionId> [--idempotency-key <key>]
  run get <runId>
  run pause <runId>
  run resume <runId> [--idempotency-key <key>] [--plan-hash <hash>] [--checkpoint-id <id>]
  run cancel <runId>
  run events <runId> [--last-event-id <sequence>] [--follow]
  daemon register [--machine <name>] [--workspace-root <path>] [--capabilities <csv>]
    [--max-concurrent-sessions <number>] [--daemon-version <version>]
  daemon status <daemonId>
  daemon heartbeat <daemonId>
  daemon revoke <daemonId>
Options: --base-url <url> --json --idempotency-key <key> --help
Follow writes one JSON event per line; Ctrl-C stops following.
`;

export async function runCli(argv: string[], options: FollowOptions = {}): Promise<CliResult> {
  const json = argv.includes('--json');
  try {
    if (!argv.length || argv.includes('--help') || argv[0] === 'help') return { exitCode: 0, stdout: help };
    const client = new ApiClient(value(argv, '--base-url'));
    const args = parseFlags(argv);
    const id = () => {
      if (!argv[2] || argv[2].startsWith('--')) throw { code: 'VALIDATION_FAILED', message: 'Resource ID is required' };
      return argv[2];
    };
    let result: unknown;
    switch (`${argv[0]} ${argv[1]}`) {
      case 'task create': result = await createTask(client, args); break;
      case 'task get': result = await getTask(client, id()); break;
      case 'session create': result = await createSession(client, id(), args); break;
      case 'session get': result = await getSession(client, id()); break;
      case 'run create': result = await createRun(client, id(), args); break;
      case 'run get': result = await getRun(client, id()); break;
      case 'run pause': result = await pauseRun(client, id()); break;
      case 'run resume': result = await resumeRun(client, id(), args); break;
      case 'run cancel': result = await cancelRun(client, id()); break;
      case 'run events':
        if (argv.includes('--follow')) {
          await followRunEvents(client, id(), args.lastEventId, { ...options, write: options.write ?? writeStdout });
          return { exitCode: 0, stdout: '' };
        }
        result = await getRunEvents(client, id(), args.lastEventId);
        break;
      case 'daemon register': result = await registerDaemon(client, args); break;
      case 'daemon status': result = await getDaemon(client, id()); break;
      case 'daemon heartbeat': result = await heartbeatDaemon(client, id()); break;
      case 'daemon revoke': result = await revokeDaemon(client, id()); break;
      default: throw new Error('unsupported command; use --help');
    }
    return { exitCode: 0, stdout: json ? JSON.stringify(result ?? null) : `${JSON.stringify(result ?? null)}\n` };
  } catch (error) {
    if (options.signal?.aborted) return { exitCode: 0, stdout: '' };
    const apiError = error as Partial<ApiError>;
    const payload = { code: apiError.code ?? 'CLI_ERROR', message: apiError.message ?? String(error) };
    const exitCode = payload.code === 'RESOURCE_NOT_FOUND' || payload.code === 'VALIDATION_FAILED' ? 2 : 1;
    return { exitCode, stdout: json ? JSON.stringify(payload) : `${payload.code}: ${payload.message}\n` };
  }
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--') || ['--json', '--follow', '--help'].includes(token)) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw { code: 'VALIDATION_FAILED', message: `${token} requires a value` };
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function writeStdout(text: string): Promise<void> {
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  void runCli(process.argv.slice(2), { signal: controller.signal }).then(async result => {
    process.exitCode = result.exitCode;
    await writeStdout(result.stdout);
  }).catch(error => {
    process.exitCode = 1;
    process.stderr.write(`${String(error)}\n`);
  }).finally(() => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  });
}
