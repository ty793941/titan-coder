import { executeDispatch } from '../../../agent-runtime/dist/worker.js';

process.on('message', async message => {
  if (!message.dispatch) return;
  let toolSent = false;
  const adapter = {
    createSession: async () => ({ id: 'local-fixture', runtime: 'qwen' }),
    sendInput: async () => {},
    streamEvents: async function* () {
      if (!toolSent) {
        toolSent = true;
        yield { type: 'tool.requested', payload: { id: 'write-evidence', name: 'artifact.write', arguments: { path: 'acceptance.md', content: '# Local execution evidence' } } };
      } else yield { type: 'session.completed' };
    },
    cancel: async () => {}, close: async () => {},
  };
  await executeDispatch(message.dispatch, {
    adapterFactory: () => adapter,
    credentialResolver: async () => 'local-fixture-secret',
  });
});
