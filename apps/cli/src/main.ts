import { ApiClient, type ApiError } from './client.js';
import { createTask } from './commands/task.js';
import { getRun } from './commands/run.js';

export type CliResult = { exitCode: number; stdout: string };

export async function runCli(argv: string[]): Promise<CliResult> {
  const json = argv.includes('--json');
  try {
    const client = new ApiClient(value(argv, '--base-url'));
    const args = parseFlags(argv);
    const result = argv[0] === 'task' && argv[1] === 'create'
      ? await createTask(client, args)
      : argv[0] === 'run' && argv[1] === 'get'
        ? await getRun(client, argv[2] ?? '')
        : (() => { throw new Error('unsupported command'); })();
    return { exitCode: 0, stdout: json ? JSON.stringify(result) : `${JSON.stringify(result)}\n` };
  } catch (error) {
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
    if (token?.startsWith('--') && token !== '--json') flags[token.slice(2)] = argv[index + 1] ?? '';
  }
  return flags;
}

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith('/main.js')) void runCli(process.argv.slice(2)).then(result => process.stdout.write(result.stdout));
