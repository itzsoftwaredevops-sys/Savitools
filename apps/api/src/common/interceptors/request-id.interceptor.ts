import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Correlation header echoed on every response a matched route produces. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Longest caller-supplied correlation id accepted; longer values are replaced. */
export const REQUEST_ID_MAX_LENGTH = 128;

export function isValidRequestId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= REQUEST_ID_MAX_LENGTH &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export interface RequestWithRequestId extends FastifyRequest {
  requestId?: string;
}

/**
 * Gives every matched request a correlation id: the caller's `x-request-id`
 * when it is present and sane, otherwise a fresh UUID. The id is echoed on the
 * response and stored on the request as `requestId`, so log lines can be tied
 * to a request and `ApiExceptionFilter` can repeat it in the error envelope.
 *
 * Interceptors only run for a route that matched; a request for an unknown path
 * still gets `path`/`timestamp` from the filter but has no generated id.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Global interceptors also run for WebSocket gateways, whose arguments are
    // (client, data) and have no response object to carry a header.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithRequestId>();
    const reply = http.getResponse<FastifyReply>();

    const requestId = this.callerSupplied(request) ?? randomUUID();
    request.requestId = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);

    return next.handle();
  }

  private callerSupplied(request: RequestWithRequestId): string | undefined {
    const header = request.headers?.[REQUEST_ID_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return isValidRequestId(trimmed) ? trimmed : undefined;
  }
}
