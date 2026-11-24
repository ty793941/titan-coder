import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let dispatch;
let sequence = 0;
function progress(type, checkpoint) {
  process.send({ type: 'progress', progress: {
    eventId: randomUUID(), sequence: ++sequence, claimToken: dispatch.claimToken, type, payload: {},
    ...(checkpoint ? { checkpoint } : {}),
  } });
}
process.on('message', async message => {
  if (message.type === 'cancel') {
    progress('cancelled');
    process.disconnect();
    return;
  }
  if (!message.dispatch) return;
  dispatch = message.dispatch;
  await mkdir(join(dispatch.config.workspacePath, '.titan'), { recursive: true });
  await writeFile(join(dispatch.config.workspacePath, '.titan', 'source-pid'), String(process.pid));
  progress('running');
  progress('checkpoint', { id: `checkpoint_${randomUUID()}`, messages: [{ role: 'assistant', text: 'portable fixture context' }], successfulTools: [], evidence: [] });
});
