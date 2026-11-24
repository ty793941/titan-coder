import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { DatabaseService } from './database/database.service.js';
import { WorkflowAuth, type WorkflowIdentityConfig, type WorkflowCredentialResolver } from './common/workflow-auth.js';

export async function createApp(options: { workflowIdentity?: WorkflowIdentityConfig; resolveWorkflowCredential?: WorkflowCredentialResolver } = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: process.env.CONTROL_PLANE_LOG === 'debug' ? ['log', 'error', 'warn'] : false,
  });
  app.useGlobalFilters(new HttpErrorFilter());
  const identity = options.workflowIdentity ?? (process.env.TITAN_WORKFLOW_CREDENTIAL_REF && process.env.TITAN_WORKFLOW_WORKER_ID
    ? { credentialRef: process.env.TITAN_WORKFLOW_CREDENTIAL_REF, workerId: process.env.TITAN_WORKFLOW_WORKER_ID } : undefined);
  await app.get(DatabaseService).initialize();
  try { await app.get(WorkflowAuth).initialize(identity, options.resolveWorkflowCredential); }
  catch (error) { await app.close(); throw error; }
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf8');
    if (rawBody.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  await fastify.ready();
  return app;
}

export async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(process.env.CONTROL_PLANE_PORT ? Number(process.env.CONTROL_PLANE_PORT) : 3000, '127.0.0.1');
}

if (process.argv[1]?.endsWith('/main.js')) {
  void bootstrap();
}
