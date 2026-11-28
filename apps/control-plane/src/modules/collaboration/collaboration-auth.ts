import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { authenticateConsole } from '../../common/console-auth.js';

@Injectable()
export class CollaborationConsoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    authenticateConsole(
      context
        .switchToHttp()
        .getRequest<{ headers: { authorization?: string } }>().headers
        .authorization,
    );
    return true;
  }
}
