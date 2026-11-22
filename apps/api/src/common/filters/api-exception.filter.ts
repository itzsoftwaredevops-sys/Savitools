import { randomUUID } from 'crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  isValidRequestId,
  REQUEST_ID_HEADER,
  RequestWithRequestId,
} from '../interceptors/request-id.interceptor';

/** The single error shape every failing HTTP response uses. */
export interface ApiErrorEnvelope {
  statusCode: number;
  message: string | string[];
  error: string;
  code?: string;
  path: string;
  timestamp: string;
  requestId: string;
  /** Opaque details safe for client consumption (no secrets, PII, or raw XDR). */
  details?: Record<string, unknown>;
}

/** The single success shape every returning HTTP response uses. */
export interface ApiSuccessEnvelope<T = unknown> {
  statusCode: number;
  data: T;
  requestId: string | null;
  timestamp: string;
}

/** Union of success and error envelopes for contract testing. */
export type ApiEnvelope<T = unknown> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

/**
 * One error envelope for the whole API.
 *
 * Before this existed each module leaked whatever Nest's default produced (or
 * hand-built its own body), so a client could not rely on the shape of an error.
 * Everything now goes through here: `statusCode`, `message`, `error` (the fields
 * Nest already used and the web client already reads) plus `path`, `timestamp`
 * and the correlation `requestId`.
 *
 * A non-`HttpException` is a bug, not a client-facing message, so its text is
 * logged and replaced with a generic 500 body rather than echoed back.
 *
 * The filter is registered globally, and global filters also run for WebSocket
 * gateways, so a non-HTTP context is handed back to Nest's own contract instead
 * of trying to write an HTTP response.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.handleNonHttp(exception, host);
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<RequestWithRequestId>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const requestId = this.resolveRequestId(request);
    response.header(REQUEST_ID_HEADER, requestId);

    const detail = this.describe(exception, status);
    const envelope: ApiErrorEnvelope = {
      statusCode: status,
      message: detail.message,
      error: detail.error,
      code: detail.code,
      path: request.url ?? '',
      timestamp: new Date().toISOString(),
      requestId,
      ...(detail.details && { details: detail.details }),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method ?? ''} ${request.url ?? ''} -> ${status} requestId=${requestId}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).send(envelope);
  }

  /** `message`/`error` from the thrower, falling back to the status text. */
  private describe(
    exception: unknown,
    status: number,
  ): { message: string | string[]; error: string; code?: string; details?: Record<string, unknown> } {
    if (!(exception instanceof HttpException)) {
      return {
        message: 'Internal server error',
        error: this.statusText(status),
      };
    }

    const body = exception.getResponse();
    if (typeof body === 'string') {
      return { message: body, error: this.statusText(status) };
    }

    const record = (body ?? {}) as Record<string, unknown>;
    const message =
      typeof record.message === 'string' || Array.isArray(record.message)
        ? (record.message as string | string[])
        : this.statusText(status);
    const error =
      typeof record.error === 'string' && record.error.length > 0
        ? record.error
        : this.statusText(status);

    const code = record.code as string | undefined;
    const details = record.details as Record<string, unknown> | undefined;

    return { message, error, code, details };
  }

  /**
   * Prefer the id the interceptor stored; fall back to the caller's header so a
   * request with no matching route (a 404, where no interceptor ran) still
   * carries the correlation the client supplied.
   */
  private resolveRequestId(request: RequestWithRequestId): string {
    if (
      typeof request.requestId === 'string' &&
      isValidRequestId(request.requestId)
    ) {
      return request.requestId;
    }

    const header = request.headers?.[REQUEST_ID_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return isValidRequestId(trimmed) ? trimmed : randomUUID();
  }

  /** `INTERNAL_SERVER_ERROR` -> `Internal Server Error`, matching Nest defaults. */
  private statusText(status: number): string {
    const name = (HttpStatus as unknown as Record<
      number,
      string | undefined
    >)[status];
    if (typeof name !== 'string') return 'Error';
    return name
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * WebSocket gateways: reproduce `BaseWsExceptionFilter` so `@SubscribeMessage`
   * clients still receive the `exception` event now that a global filter exists.
   */
  private handleNonHttp(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'ws') {
      this.logger.error(
        `Unhandled exception outside HTTP: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      return;
    }

    const client = host
      .switchToWs()
      .getClient<{ emit?: (event: string, payload: unknown) => void }>();
    const message =
      exception instanceof Error ? exception.message : exception;
    client?.emit?.('exception', { status: 'error', message });
  }
}
