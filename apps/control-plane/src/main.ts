import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { DatabaseService } from './database/database.service.js';

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: process.env.CONTROL_PLANE_LOG === 'debug' ? ['log', 'error', 'warn'] : false,
  });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.get(DatabaseService).initialize();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(process.env.CONTROL_PLANE_PORT ? Number(process.env.CONTROL_PLANE_PORT) : 3000, '127.0.0.1');
}

if (process.argv[1]?.endsWith('/main.js')) {
  void bootstrap();
}
