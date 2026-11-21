const { spawn } = require('node:child_process');
let timer;
process.on('message', message => {
  if (message.type === 'cancel') {
    if (timer) clearTimeout(timer);
    if (global.dispatch?.goal === 'stubborn') return;
    if (global.dispatch) progress('cancelled', {});
    process.exitCode = 0;
    process.disconnect();
    return;
  }
  if (!message.dispatch) return;
  global.dispatch = message.dispatch;
  global.sequence = 0;
  if (global.dispatch.goal === 'wrong-token') global.dispatch.claimToken = 'other-claim';
  progress('running', {});
  if (global.dispatch.goal === 'wrong-token') return;
  if (global.dispatch.goal === 'wrong-sequence') {
    global.sequence = -1;
    progress('output', {});
    return;
  }
  if (global.dispatch.goal === 'exit') process.exit(2);
  if (global.dispatch.goal === 'stubborn') {
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
    progress('output', { pid: descendant.pid });
    return;
  }
  if (global.dispatch.goal === 'hang') return;
  if (global.dispatch.goal === 'terminal-hang') {
    process.on('SIGTERM', () => {});
    progress('completed', { text: 'finished' });
    return;
  }
  progress('output', {
    text: `worker:${process.env.DAEMON_TEST_KEY || 'missing'}:${process.env.DAEMON_TEST_FORBIDDEN || 'filtered'}`,
    apiKey: 'should-not-be-durable',
  });
  timer = setTimeout(() => {
    progress('completed', { text: 'finished' });
    process.disconnect();
  }, 25);
});
function progress(type, payload) {
  process.send({ type: 'progress', progress: {
    eventId: `${global.dispatch.runId}-${++global.sequence}`,
    sequence: global.sequence,
    claimToken: global.dispatch.claimToken,
    type,
    payload,
  } });
}
