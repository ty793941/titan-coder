import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

@Controller('/api')
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post('/tasks/:taskId/sessions')
  create(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.sessions.create(taskId, body, idempotencyKey);
  }

  @Get('/sessions/:sessionId')
  get(@Param('sessionId') sessionId: string) {
    return this.sessions.get(sessionId);
  }
}
