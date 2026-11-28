import { Body, Controller, Headers, Inject, Param, Post } from '@nestjs/common';
import { authenticateConsole } from '../../common/console-auth.js';
import { WorkProposalsService } from './work-proposals.service.js';

@Controller('/api/projects/:projectId/work-proposals')
export class WorkProposalsController {
  constructor(@Inject(WorkProposalsService) private readonly proposals: WorkProposalsService) {}

  @Post('/accept')
  accept(@Param('projectId') projectId: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization);
    return this.proposals.accept(projectId, body);
  }
}
