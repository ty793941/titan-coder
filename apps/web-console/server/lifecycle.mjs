import { createConnection } from 'node:net';

export async function assertPortAvailable(port) {
  const occupied = await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
  if (occupied) throw new Error('CONTROL_PLANE_PORT_IN_USE');
}

export async function waitForControlPlane(child, baseUrl, token, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) throw new Error('CONTROL_PLANE_START_FAILED');
    try {
      const response = await fetch(`${baseUrl}/api/console/state?limit=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok) { await response.body?.cancel(); return; }
      await response.body?.cancel();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('CONTROL_PLANE_START_FAILED');
}
