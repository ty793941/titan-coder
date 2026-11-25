import { createServer } from 'node:http';

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export async function createWorkflowControlPlaneProxy({ targetBaseUrl, dropCompleteResponseOnce = false }) {
  let droppedCompleteResponse = false;
  let forwardedCompleteRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const target = new URL(request.url ?? '/', targetBaseUrl);
      const upstream = await fetch(target, {
        method: request.method,
        headers: request.headers,
        body: body.length === 0 || request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
      });
      const isComplete = target.pathname.includes('/api/internal/workflow/commands/') && target.pathname.endsWith('/complete');
      if (isComplete) forwardedCompleteRequests += 1;
      if (isComplete && dropCompleteResponseOnce && !droppedCompleteResponse) {
        droppedCompleteResponse = true;
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) {
        for await (const chunk of upstream.body) response.write(chunk);
      }
      response.end();
    } catch {
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy did not bind to a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get droppedCompleteResponse() { return droppedCompleteResponse; },
    get forwardedCompleteRequests() { return forwardedCompleteRequests; },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
