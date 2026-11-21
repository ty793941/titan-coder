import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DaemonRunner, type DaemonRunnerOptions } from './daemon-runner.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) {
    process.stdout.write('Usage: node apps/daemon/dist/cli.js --config /absolute/local/daemon.json\n       node apps/daemon/dist/cli.js --url http://127.0.0.1:3000 --workspace-root /absolute/repo [--state-dir /absolute/.titan/daemon]\n');
    return;
  }
  let options: DaemonRunnerOptions;
  if (argv[0] === '--config' && argv.length === 2 && argv[1]) {
    options = JSON.parse(await readFile(resolve(argv[1]), 'utf8')) as DaemonRunnerOptions;
  } else {
    const roots: string[] = [];
    let baseUrl: string | undefined;
    let stateDirectory: string | undefined;
    const credentialEnv: string[] = [];
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('INVALID_DAEMON_ARGUMENTS');
      if (flag === '--url') baseUrl = value;
      else if (flag === '--workspace-root') roots.push(resolve(value));
      else if (flag === '--state-dir') stateDirectory = resolve(value);
      else if (flag === '--credential-env') credentialEnv.push(value);
      else throw new Error('INVALID_DAEMON_ARGUMENTS');
    }
    if (!baseUrl || !roots.length) throw new Error('DAEMON_URL_AND_ROOT_REQUIRED');
    const identity = createHash('sha256').update(JSON.stringify([baseUrl, roots])).digest('hex').slice(0, 16);
    options = { baseUrl, workspaceRoots: roots, stateDirectory: stateDirectory ?? join(homedir(), '.titan', 'daemons', identity), credentialEnv };
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await new DaemonRunner(options).run(controller.signal); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}

void main().catch(error => {
  const message = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'DAEMON_FAILED';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
