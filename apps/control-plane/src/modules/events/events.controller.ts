import { Controller, Get, Headers, Inject, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { EventsService } from './events.service.js';

@Controller('/api/runs')
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Get('/:runId/events')
  async stream(
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const afterSequence = Number(lastEventId ?? 0);
    const events = await this.events.listForRun(runId, Number.isFinite(afterSequence) ? afterSequence : 0);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const event of events) {
      reply.raw.write(`id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    reply.raw.end();
  }
}
