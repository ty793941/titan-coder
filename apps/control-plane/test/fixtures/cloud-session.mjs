import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executeDispatch } from '/opt/titan/apps/agent-runtime/dist/worker.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { version, dispatch, credentials } = JSON.parse(input);
assert.equal(version, 1);
const secret = credentials[dispatch.config.credentialRef];
assert.equal(typeof secret, 'string');
const snapshot = await readFile('/workspace/session/answer.txt', 'utf8');
assert.equal(snapshot, 'snapshot roundtrip evidence');
assert.equal(dispatch.checkpoint.messages[0].text, 'portable fixture context');
const observation = {
  fixture: 'offline adapter; no paid inference', snapshot,
  inheritedCheckpointId: dispatch.checkpoint.id,
  messages: dispatch.checkpoint.messages,
  argvSafe: !JSON.stringify(process.argv).includes(secret),
  environmentSafe: !JSON.stringify(process.env).includes(secret),
};
let sent = false;
const adapter = {
  createSession: async () => ({ id: 'cloud-offline-fixture', runtime: 'qwen' }),
  sendInput: async () => {},
  streamEvents: async function* () {
    if (sent) { yield { type: 'session.completed' }; return; }
    sent = true;
    yield { type: 'tool.requested', payload: { id: 'cloud-source', name: 'artifact.write', arguments: { path: 'answer.md', content: '# Cloud fixture artifact\nSnapshot read inside Docker.', artifactType: 'source-diff' } } };
    yield { type: 'tool.requested', payload: { id: 'cloud-test-evidence', name: 'artifact.write', arguments: { path: 'test-evidence.json', content: JSON.stringify(observation), artifactType: 'test-report' } } };
  },
  cancel: async () => {}, close: async () => {},
};
const result = await executeDispatch(dispatch, {
  adapterFactory: () => adapter,
  credentialResolver: async reference => credentials[reference],
  sendProgress: progress => process.stdout.write(`${JSON.stringify({ version: 1, type: 'progress', progress })}\n`),
});
process.stdout.write(`${JSON.stringify({ version: 1, type: 'result', status: result.status })}\n`);
for (const key of Object.keys(credentials)) delete credentials[key];
assert.equal(result.status, 'satisfied');
