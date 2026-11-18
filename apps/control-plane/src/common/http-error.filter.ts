import { Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { DomainError } from '@titan/contracts';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (process.env.CONTROL_PLANE_LOG === 'debug') {
      console.error(exception);
    }
    const response = host.switchToHttp().getResponse<{ status: (code: number) => { send: (body: unknown) => void } }>();
    const request = host.switchToHttp().getRequest<{ headers?: Record<string, string | undefined> }>();
    const traceId = request.headers?.['x-trace-id'] ?? `trace_${Date.now()}`;
    if (exception instanceof ZodError) {
      response.status(400).send({ code: 'VALIDATION_FAILED', message: 'request validation failed', details: exception.flatten(), traceId, retryable: false, occurredAt: new Date().toISOString() });
      return;
    }
    if (exception instanceof DomainError) {
      response.status(this.statusFor(exception.code)).send({ code: exception.code, message: exception.message, details: exception.details, traceId, retryable: this.retryable(exception.code), occurredAt: new Date().toISOString() });
      return;
    }
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).send({ code: 'VALIDATION_FAILED', message: exception.message, details: {}, traceId, retryable: false, occurredAt: new Date().toISOString() });
      return;
    }
    response.status(500).send({ code: 'INTERNAL_ERROR', message: 'internal server error', details: {}, traceId, retryable: false, occurredAt: new Date().toISOString() });
  }

  private statusFor(code: string): number {
    if (code === 'RESOURCE_NOT_FOUND') return 404;
    if (code === 'PERMISSION_DENIED') return 403;
    if (code === 'IDEMPOTENCY_CONFLICT' || code === 'VERSION_CONFLICT' || code === 'EVENT_SEQUENCE_GAP' || code === 'PLAN_HASH_STALE') return 409;
    return 400;
  }

  private retryable(code: string): boolean {
    return code === 'DAEMON_UNAVAILABLE' || code === 'TOOL_TIMEOUT' || code === 'RUNTIME_ADAPTER_UNAVAILABLE';
  }
}
