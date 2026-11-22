import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service.js';
import { authenticateConsole } from '../../common/console-auth.js';

@Controller('/api')
export class ArtifactsController {
  constructor(@Inject(ArtifactsService) private readonly artifacts: ArtifactsService) {}

  @Post('/tasks/:taskId/artifacts')
  create(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
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

  @Get('/artifacts/:artifactId')
  get(@Param('artifactId') artifactId: string) {
    return this.artifacts.get(artifactId);
  }

  @Get('/artifacts/:artifactId/content')
  content(@Param('artifactId') artifactId: string, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization);
    return this.artifacts.content(artifactId);
  }
}
