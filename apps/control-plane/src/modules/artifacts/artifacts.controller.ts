import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service.js';

@Controller('/api')
export class ArtifactsController {
  constructor(@Inject(ArtifactsService) private readonly artifacts: ArtifactsService) {}

  @Post('/tasks/:taskId/artifacts')
  create(
    @Param('taskId') taskId: string,
    @Body() body: { type: string; content: string; sourceArtifacts?: string[]; sessionId?: string },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.artifacts.create(taskId, body, idempotencyKey ?? `artifact-${Date.now()}`);
  }

  @Get('/tasks/:taskId/artifacts')
  list(@Param('taskId') taskId: string, @Query('resolution') resolution?: string) {
    return this.artifacts.list(taskId, resolution);
  }

  @Post('/artifacts/:artifactId/approve')
  @HttpCode(200)
  approve(@Param('artifactId') artifactId: string) {
    return this.artifacts.approve(artifactId);
  }
}
