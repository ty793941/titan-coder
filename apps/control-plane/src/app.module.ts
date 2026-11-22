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

@Module({
  imports: [DatabaseModule],
  controllers: [ProjectsController, TasksController, SessionsController, RunsController, EventsController, ArtifactsController, DaemonsController, ConsoleController],
  providers: [IdempotencyService, EventsService, ProjectsService, TasksService, SessionsService, RunsService, ArtifactsService, DaemonsService, ExecutionService, ConsoleService],
})
export class AppModule {}
