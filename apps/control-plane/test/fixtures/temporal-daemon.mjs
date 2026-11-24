import { randomUUID } from 'node:crypto';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function call(baseUrl, path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? undefined : JSON.parse(text),
  };
}

export function createTemporalDaemonFixture({ baseUrl, daemonId, authToken }) {
  return {
    async claimExecution(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await call(baseUrl, `/api/daemons/${daemonId}/claim`, authToken, {});
        if (result.status === 200) return result.body;
        if (result.status !== 204) throw new Error(`daemon claim failed with HTTP ${result.status}`);
        await wait(100);
      }
      throw new Error('daemon claim timed out');
    },

    async progress(runId, claimToken, sequence, type, payload, eventId = randomUUID(), checkpoint) {
      return call(baseUrl, `/api/daemons/${daemonId}/runs/${runId}/progress`, authToken, {
        eventId,
        sequence,
        claimToken,
        type,
        payload,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
    },
  };
}
