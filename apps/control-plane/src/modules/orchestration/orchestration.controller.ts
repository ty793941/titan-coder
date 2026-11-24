import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { orchestrationEmptyRequestSchema } from '@titan/contracts';
import { authenticateConsole } from '../../common/console-auth.js';
import { BackgroundJobsService } from './background-jobs.service.js';
import { SchedulesService } from './schedules.service.js';

@Controller('/api/')
export class OrchestrationController {
  constructor(@Inject(BackgroundJobsService) private readonly jobs: BackgroundJobsService, @Inject(SchedulesService) private readonly schedules: SchedulesService) {}

  @Post('sessions/:id/background-jobs')
  createJob(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.jobs.create(id, body);
  }

  @Get('sessions/:id/background-jobs')
  listJobs(@Param('id') id: string, @Query() query: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.jobs.list(id, query);
  }

  @Get('background-jobs/:id')
  getJob(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.jobs.get(id);
  }

  @Post('background-jobs/:id/cancel')
  @HttpCode(200)
  cancelJob(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); orchestrationEmptyRequestSchema.parse(body); return this.jobs.cancel(id);
  }

  @Post('sessions/:id/schedules')
  createSchedule(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.schedules.create(id, body);
  }

  @Get('sessions/:id/schedules')
  listSchedules(@Param('id') id: string, @Query() query: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.schedules.list(id, query);
  }

  @Get('schedules/:id')
  getSchedule(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.schedules.get(id);
  }

  @Post('schedules/:id/update')
  @HttpCode(200)
  updateSchedule(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.schedules.change(id, 'update', body);
  }

  @Post('schedules/:id/enable')
  @HttpCode(200)
  enableSchedule(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.schedules.change(id, 'enable', body);
  }

  @Post('schedules/:id/pause')
  @HttpCode(200)
  pauseSchedule(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization); return this.schedules.change(id, 'pause', body);
  }
}
