import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { authenticateConsole } from '../../common/console-auth.js';
import { DaemonsService } from '../daemons/daemons.service.js';
import { HandoffsService } from './handoffs.service.js';

@Controller('/api')
export class HandoffsController {
  constructor(@Inject(HandoffsService) private readonly handoffs: HandoffsService, @Inject(DaemonsService) private readonly daemons: DaemonsService) {}

  @Post('/sessions/:id/handoff')
  async create(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization: string | undefined, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    authenticateConsole(authorization);
    const result = await this.handoffs.create(id, body, key);
    reply.status(result.created ? 201 : 200);
    return result.handoff;
  }

  @Get('/handoffs/:id')
  get(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization);
    return this.handoffs.get(id);
  }

  @Get('/daemons/:id/handoffs/pending')
  async pending(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(id, authorization);
    return this.handoffs.pending(id);
  }

  @Post('/daemons/:id/handoffs/:handoffId/snapshot')
  @HttpCode(200)
  async snapshot(@Param('id') id: string, @Param('handoffId') handoffId: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(id, authorization);
    return this.handoffs.snapshot(id, handoffId, body);
  }

  @Post('/daemons/:id/handoffs/:handoffId/failure')
  @HttpCode(200)
  async failure(@Param('id') id: string, @Param('handoffId') handoffId: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(id, authorization);
    return this.handoffs.failure(id, handoffId, body);
  }
}
