import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { EventsService } from '../events/events.service.js';
import { TasksService } from './tasks.service.js';

@Controller('/api')
export class TasksController {
  constructor(
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(EventsService) private readonly eventStore: EventsService,
  ) {}

  @Post('/projects/:projectId/tasks')
  create(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.tasks.create(projectId, body, idempotencyKey);
  }

  @Get('/tasks/:taskId')
  get(@Param('taskId') taskId: string) {
    return this.tasks.get(taskId);
  }

  @Get('/tasks/:taskId/events')
  events(@Param('taskId') taskId: string) {
    return this.eventStore.listForTask(taskId);
  }

  @Post('/tasks/:taskId/stage')
  @HttpCode(200)
  advanceStage(@Param('taskId') taskId: string, @Body() body: unknown) {
    return this.tasks.advanceStage(taskId, body);
  }
}
