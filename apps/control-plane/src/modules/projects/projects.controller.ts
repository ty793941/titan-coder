import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

@Controller('/api/projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Post()
  create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.projects.create(body, idempotencyKey);
  }
}
