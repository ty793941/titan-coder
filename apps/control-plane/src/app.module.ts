import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { IdempotencyService } from './common/idempotency.service.js';
import { EventsController } from './modules/events/events.controller.js';
import { EventsService } from './modules/events/events.service.js';
import { ArtifactsController } from './modules/artifacts/artifacts.controller.js';
import { ArtifactsService } from './modules/artifacts/artifacts.service.js';
import { ProjectsController } from './modules/projects/projects.controller.js';
import { ProjectsService } from './modules/projects/projects.service.js';
import { RunsController } from './modules/runs/runs.controller.js';
import { RunsService } from './modules/runs/runs.service.js';
import { SessionsController } from './modules/sessions/sessions.controller.js';
import { SessionsService } from './modules/sessions/sessions.service.js';
import { TasksController } from './modules/tasks/tasks.controller.js';
import { TasksService } from './modules/tasks/tasks.service.js';
import { DaemonsController } from './modules/daemons/daemons.controller.js';
import { DaemonsService } from './modules/daemons/daemons.service.js';
import { ExecutionService } from './modules/daemons/execution.service.js';
import { ConsoleController } from './modules/console/console.controller.js';
import { ConsoleService } from './modules/console/console.service.js';
import { HandoffsController } from './modules/handoffs/handoffs.controller.js';
import { HandoffsService } from './modules/handoffs/handoffs.service.js';
import { CloudExecutionsController } from './modules/cloud-executions/cloud-executions.controller.js';
import { CloudExecutionsService } from './modules/cloud-executions/cloud-executions.service.js';
import { WorkflowAuth } from './common/workflow-auth.js';
import { BackgroundJobsService } from './modules/orchestration/background-jobs.service.js';
import { WorkflowCommandsService } from './modules/orchestration/workflow-commands.service.js';
import { SchedulesService } from './modules/orchestration/schedules.service.js';
import { OrchestrationController } from './modules/orchestration/orchestration.controller.js';
import { WorkflowInternalController } from './modules/orchestration/workflow-internal.controller.js';
import { WorkProposalsController } from './modules/work-proposals/work-proposals.controller.js';
import { WorkProposalsService } from './modules/work-proposals/work-proposals.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [ProjectsController, TasksController, SessionsController, RunsController, EventsController, ArtifactsController, DaemonsController, ConsoleController, HandoffsController, CloudExecutionsController, OrchestrationController, WorkflowInternalController, WorkProposalsController],
  providers: [IdempotencyService, EventsService, ProjectsService, TasksService, SessionsService, RunsService, ArtifactsService, DaemonsService, ExecutionService, ConsoleService, HandoffsService, CloudExecutionsService, WorkflowAuth, BackgroundJobsService, WorkflowCommandsService, SchedulesService, WorkProposalsService],
})
export class AppModule {}
