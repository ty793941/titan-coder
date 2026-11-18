import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service.js';

@Controller('/api/tasks')
export class ArtifactsController {
  constructor(@Inject(ArtifactsService) private readonly artifacts: ArtifactsService) {}

  @Post('/:taskId/artifacts')
  create(
    @Param('taskId') taskId: string,
    @Body() body: { type: string; content: string; sourceArtifacts?: string[]; sessionId?: string },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.artifacts.create(taskId, body, idempotencyKey ?? `artifact-${Date.now()}`);
  }

  @Get('/:taskId/artifacts')
  list(@Param('taskId') taskId: string) {
    return this.artifacts.list(taskId);
  }
}
