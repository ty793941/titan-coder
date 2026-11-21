import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { DaemonsService } from './daemons.service.js';
import { ExecutionService } from './execution.service.js';

@Controller('/api/daemons')
export class DaemonsController {
  constructor(
    @Inject(DaemonsService) private readonly daemons: DaemonsService,
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  @Post('/register')
  register(@Body() body: Parameters<DaemonsService['register']>[0]) {
    return this.daemons.register(body);
  }

  @Get('/:daemonId')
  get(@Param('daemonId') daemonId: string) {
    return this.daemons.get(daemonId);
  }

  @Post('/:daemonId/heartbeat')
  @HttpCode(200)
  async heartbeat(@Param('daemonId') daemonId: string, @Headers('authorization') authorization?: string, @Body() body?: unknown) {
    await this.daemons.authenticate(daemonId, authorization);
    z.object({ sequence: z.number().int().positive().safe().optional(), daemonId: z.literal(daemonId).optional(), occurredAt: z.string().datetime().optional() }).strict().parse(body ?? {});
    return this.daemons.heartbeat(daemonId);
  }

  @Post('/:daemonId/revoke')
  @HttpCode(204)
  async revoke(@Param('daemonId') daemonId: string, @Headers('authorization') authorization?: string): Promise<void> {
    await this.daemons.authenticate(daemonId, authorization);
    await this.daemons.revoke(daemonId);
  }

  @Post('/:daemonId/events')
  async event(
    @Param('daemonId') daemonId: string,
    @Body() body: { eventId: string; sequence: number; eventType: string; payload: Record<string, unknown> },
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('authorization') authorization?: string,
  ) {
    await this.daemons.authenticate(daemonId, authorization);
    const result = await this.daemons.appendEvent(daemonId, body);
    reply.status(result.created ? 201 : 200);
    return result;
  }

  @Get('/:daemonId/events')
  async events(@Param('daemonId') daemonId: string, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(daemonId, authorization);
    return this.daemons.listEvents(daemonId);
  }

  @Post('/:daemonId/claim')
  @HttpCode(200)
  async claim(@Param('daemonId') daemonId: string, @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('authorization') authorization?: string, @Body() body?: unknown) {
    await this.daemons.authenticate(daemonId, authorization);
    z.object({}).strict().parse(body ?? {});
    const result = await this.execution.claim(daemonId);
    if (!result) reply.status(204);
    return result;
  }

  @Post('/:daemonId/runs/:runId/progress')
  @HttpCode(200)
  async progress(@Param('daemonId') daemonId: string, @Param('runId') runId: string,
    @Body() body: unknown, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(daemonId, authorization);
    return this.execution.progress(daemonId, runId, body);
  }

  @Get('/:daemonId/runs/:runId/control')
  async control(@Param('daemonId') daemonId: string, @Param('runId') runId: string, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(daemonId, authorization);
    return this.execution.control(daemonId, runId);
  }

  @Get('/:daemonId/runs/:runId/job')
  async job(@Param('daemonId') daemonId: string, @Param('runId') runId: string, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(daemonId, authorization);
    return this.execution.job(daemonId, runId);
  }
}
