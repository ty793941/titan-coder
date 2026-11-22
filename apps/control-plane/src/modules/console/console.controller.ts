import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { authenticateConsole } from '../../common/console-auth.js';
import { ConsoleService } from './console.service.js';

@Controller('/api/console')
export class ConsoleController {
  constructor(@Inject(ConsoleService) private readonly console: ConsoleService) {}

  @Get('/state')
  state(@Query() query: unknown, @Headers('authorization') authorization?: string) {
    authenticateConsole(authorization);
    return this.console.state(query);
  }
}
