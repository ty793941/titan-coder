import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ProcessGroup } from '../src/process-group.js';

it('escalates cancellation when the process ignores SIGTERM', async () => {
  const group = new ProcessGroup();
  const child = group.start(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], process.cwd(), {});
  const exited = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    const result = await Promise.race([
      group.cancel({ killAfterMs: 30 }).then(() => 'cancelled'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 200)),
    ]);
    expect(result).toBe('cancelled');
    await exited;
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
});
