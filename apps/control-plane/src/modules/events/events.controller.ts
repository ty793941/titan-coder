import { Controller, Get, Headers, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EventsService } from './events.service.js';

@Controller('/api/runs')
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Get('/:runId/events')
  async stream(
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('follow') follow: string | undefined,
    @Req() request: FastifyRequest,
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
    if (follow === 'true') {
      let cursor = events.at(-1)?.sequence ?? afterSequence;
      const interval = setInterval(async () => {
        const nextEvents = await this.events.listForRun(runId, cursor);
        for (const event of nextEvents) {
          cursor = event.sequence;
          reply.raw.write(`id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }, 250);
      request.raw.once('close', () => clearInterval(interval));
      return;
    }
    reply.raw.end();
  }
}
