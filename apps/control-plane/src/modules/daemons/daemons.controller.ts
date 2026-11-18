import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DaemonsService } from './daemons.service.js';

@Controller('/api/daemons')
export class DaemonsController {
  constructor(@Inject(DaemonsService) private readonly daemons: DaemonsService) {}

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
  heartbeat(@Param('daemonId') daemonId: string) {
    return this.daemons.heartbeat(daemonId);
  }

  @Post('/:daemonId/revoke')
  @HttpCode(204)
  async revoke(@Param('daemonId') daemonId: string): Promise<void> {
    await this.daemons.revoke(daemonId);
  }

  @Post('/:daemonId/events')
  async event(
    @Param('daemonId') daemonId: string,
    @Body() body: { eventId: string; sequence: number; eventType: string; payload: Record<string, unknown> },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.daemons.appendEvent(daemonId, body);
    reply.status(result.created ? 201 : 200);
    return result;
  }

  @Get('/:daemonId/events')
  events(@Param('daemonId') daemonId: string) {
    return this.daemons.listEvents(daemonId);
  }
}
