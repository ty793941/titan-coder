import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { authenticateConsole } from '../../common/console-auth.js';
import { DaemonsService } from '../daemons/daemons.service.js';
import { CloudExecutionsService } from './cloud-executions.service.js';

@Controller('/api')
export class CloudExecutionsController {
  constructor(@Inject(CloudExecutionsService) private readonly cloud: CloudExecutionsService, @Inject(DaemonsService) private readonly daemons: DaemonsService) {}

  @Get('/cloud-executions/:id')
  get(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization);
    return this.cloud.get(id);
  }

  @Post('/cloud-executions/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization?: string, @Headers('idempotency-key') key?: string) {
    authenticateConsole(authorization);
    z.object({ idempotencyKey: z.string().trim().min(1).max(200).optional() }).strict().parse(body ?? {});
    if (key !== undefined) z.string().trim().min(1).max(200).parse(key);
    return this.cloud.cancel(id);
  }

  @Post('/daemons/:id/runs/:runId/cloud')
  @HttpCode(200)
  async lifecycle(@Param('id') id: string, @Param('runId') runId: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    await this.daemons.authenticate(id, authorization);
    return this.cloud.lifecycle(id, runId, body);
  }
}
