import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DomainError, jobObservationSchema, orchestrationEmptyRequestSchema, workflowCancelRequestSchema, workflowClaimRequestSchema, workflowCompleteRequestSchema, workflowFailRequestSchema, workflowRetryRequestSchema } from '@titan/contracts';
import { WorkflowAuth } from '../../common/workflow-auth.js';
import { BackgroundJobsService } from './background-jobs.service.js';
import { WorkflowCommandsService } from './workflow-commands.service.js';
import { SchedulesService } from './schedules.service.js';

@Controller('/api/internal/workflow/')
export class WorkflowInternalController {
  constructor(
    @Inject(WorkflowAuth) private readonly workflowAuth: WorkflowAuth,
    @Inject(BackgroundJobsService) private readonly jobs: BackgroundJobsService,
    @Inject(WorkflowCommandsService) private readonly commands: WorkflowCommandsService,
    @Inject(SchedulesService) private readonly schedules: SchedulesService,
  ) {}

  @Post('commands/claim')
  @HttpCode(200)
  async claim(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization);
    const parsed = workflowClaimRequestSchema.parse(body);
    if (parsed.workerId !== workerId) throw new DomainError('PERMISSION_DENIED', 'worker identity does not match the authenticated service');
    const command = await this.commands.claim(workerId);
    if (!command) reply.code(204);
    return command;
  }

  @Post('commands/:id/complete')
  @HttpCode(204)
  complete(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization);
    return this.commands.acknowledge(id, workflowCompleteRequestSchema.parse(body).claimToken, workerId);
  }

  @Post('commands/:id/retry')
  @HttpCode(204)
  retry(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); const parsed = workflowRetryRequestSchema.parse(body);
    return this.commands.acknowledge(id, parsed.claimToken, workerId, parsed);
  }

  @Get('jobs/:id')
  observe(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); return this.jobs.observe(id, workerId);
  }

  @Get('jobs/:id/execution')
  execution(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); return this.jobs.execution(id, workerId);
  }

  @Post('jobs/:id/dispatch')
  @HttpCode(200)
  dispatch(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); orchestrationEmptyRequestSchema.parse(body); return this.jobs.dispatch(id, workerId);
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); const input = workflowCancelRequestSchema.parse(body);
    const view = await this.jobs.cancel(id, input.reason, false, { type: 'system', id: workerId }, workerId);
    return jobObservationSchema.parse({ jobId: view.jobId, status: view.status, deadlineAt: view.deadlineAt, ...(view.runId ? { runId: view.runId } : {}), ...(view.errorCode ? { errorCode: view.errorCode } : {}) });
  }

  @Post('jobs/:id/fail')
  @HttpCode(200)
  fail(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization);
    return this.jobs.fail(id, workflowFailRequestSchema.parse(body).errorCode, workerId);
  }

  @Get('schedules/:id')
  schedule(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); return this.schedules.get(id, workerId);
  }

  @Post('schedules/:id/occurrences')
  @HttpCode(200)
  occurrence(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    const workerId = this.workflowAuth.authenticate(authorization); return this.schedules.occurrence(id, body, workerId);
  }
}
