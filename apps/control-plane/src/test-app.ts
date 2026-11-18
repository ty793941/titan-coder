import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createApp } from './main.js';

type TestAgent = ReturnType<typeof request>;

export async function createTestApp(): Promise<{
  get: TestAgent['get'];
  post: TestAgent['post'];
  close: () => Promise<void>;
}> {
  const app: NestFastifyApplication = await createApp();
  const agent = request(app.getHttpServer());
  return {
    get: agent.get.bind(agent) as TestAgent['get'],
    post: agent.post.bind(agent) as TestAgent['post'],
    close: () => app.close(),
  };
}
