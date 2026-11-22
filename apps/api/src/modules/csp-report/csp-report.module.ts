import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { CspReportController } from './csp-report.controller';

/**
 * Exposes `POST /api/v1/csp-report` for browsers to deliver CSP violation
 * reports to.  Wire format details are in `CspReportController`.
 *
 * Fastify only parses `application/json` by default.  Browsers send violation
 * reports as `application/reports+json` (Reporting API, Level 1) or
 * `application/csp-report` (legacy report-uri).  Both content types are
 * registered here as JSON aliases so the body reaches the controller already
 * parsed.  The registration is deferred to `onModuleInit` so the Fastify
 * instance is fully constructed before we touch it.
 */
@Module({
  controllers: [CspReportController],
})
export class CspReportModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit() {
    /* eslint-disable @typescript-eslint/no-explicit-any -- raw Fastify instance */
    const fastify = this.adapterHost.httpAdapter.getInstance() as any;

    const jsonParser = async (request: any, body: string) =>
      JSON.parse(body) as unknown;

    for (const contentType of [
      'application/reports+json',
      'application/csp-report',
    ]) {
      if (!fastify.hasContentTypeParser(contentType)) {
        fastify.addContentTypeParser(
          contentType,
          { parseAs: 'string' },
          jsonParser,
        );
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}
