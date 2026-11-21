import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { RunsService } from './runs.service.js';

@Controller('/api')
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Post('/sessions/:sessionId/runs')
  create(
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.runs.create(sessionId, body, idempotencyKey);
  }

  @Get('/runs/:runId')
  get(@Param('runId') runId: string) {
    return this.runs.get(runId);
  }

  @Post('/runs/:runId/fail')
  @HttpCode(204)
  async fail(@Param('runId') runId: string, @Body() body: { errorCode?: string }) {
    await this.runs.fail(runId, body.errorCode ?? 'TOOL_EXECUTION_FAILED');
  }

  @Post('/runs/:runId/complete')
  @HttpCode(204)
  async complete(@Param('runId') runId: string) {
    await this.runs.complete(runId);
  }

  @Post('/runs/:runId/cancel')
  @HttpCode(200)
  cancel(@Param('runId') runId: string) {
    return this.runs.cancel(runId);
  }
}
