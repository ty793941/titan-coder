import { Controller, Get, Headers, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { DomainError } from '@titan/contracts';
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
    if (lastEventId !== undefined && (!/^\d+$/.test(lastEventId) || !Number.isSafeInteger(Number(lastEventId)))) {
      throw new DomainError('VALIDATION_FAILED', 'Last-Event-ID must be a non-negative safe integer');
    }
    const afterSequence = Number(lastEventId ?? 0);
    const events = await this.events.listForRun(runId, afterSequence);
    const response = reply.raw;
    if (response.destroyed) return;
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once('close', close);
    response.once('error', close);
    reply.hijack();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const write = async (frame: string) => {
      if (controller.signal.aborted || response.destroyed) return;
      if (!response.write(frame)) {
        await once(response, 'drain', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      }
    };
    const writeEvents = async (batch: typeof events) => {
      for (const event of batch) {
        if (controller.signal.aborted) return;
        await write(`id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    try {
      await writeEvents(events);
      if (follow !== 'true') return;
      let cursor = events.at(-1)?.sequence ?? afterSequence;
      let lastOutput = Date.now();
      await write(': connected\n\n');
      while (!controller.signal.aborted) {
        await setTimeout(250, undefined, { signal: controller.signal });
        const nextEvents = await this.events.listForRun(runId, cursor);
        if (controller.signal.aborted) break;
        await writeEvents(nextEvents);
        cursor = nextEvents.at(-1)?.sequence ?? cursor;
        if (nextEvents.length) lastOutput = Date.now();
        else if (Date.now() - lastOutput >= 15_000) {
          await write(': heartbeat\n\n');
          lastOutput = Date.now();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && !response.destroyed) {
        request.log.error({ err: error, runId }, 'SSE stream failed');
        const gap = error instanceof DomainError && error.code === 'EVENT_SEQUENCE_GAP';
        response.end(`event: stream.error\ndata: ${JSON.stringify({ code: gap ? 'EVENT_SEQUENCE_GAP' : 'INTERNAL_ERROR', message: gap ? 'Event sequence gap detected' : 'Event stream temporarily unavailable', retryable: !gap })}\n\n`);
      }
    } finally {
      controller.abort();
      response.removeListener('close', close);
      response.removeListener('error', close);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }
}
