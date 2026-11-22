import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';

/**
 * Maximum number of characters accepted from each string field in a CSP report.
 * Browsers keep sample values short, but we enforce our own limit so malformed
 * or hostile payloads cannot bloat structured log entries.
 */
const MAX_FIELD_LENGTH = 1024;

function truncate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > MAX_FIELD_LENGTH
    ? trimmed.slice(0, MAX_FIELD_LENGTH)
    : trimmed || undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Minimal structured representation written to the logger. */
export interface NormalisedCspViolation {
  blockedUri: string | undefined;
  effectiveDirective: string | undefined;
  documentUri: string | undefined;
  disposition: string | undefined;
  statusCode: number | undefined;
  lineNumber: number | undefined;
  columnNumber: number | undefined;
  sourceFile: string | undefined;
  sample: string | undefined;
  originalPolicy: string | undefined;
  referrer: string | undefined;
}

/**
 * Normalises a single violation record from either the Reporting API
 * (`application/reports+json`) or the legacy report-uri format
 * (`application/csp-report`).
 */
export function normaliseCspBody(
  /* eslint-disable @typescript-eslint/no-explicit-any -- raw browser payload */
  body: any,
): NormalisedCspViolation {
  return {
    blockedUri: truncate(body?.blockedURL ?? body?.['blocked-uri']),
    effectiveDirective: truncate(
      body?.effectiveDirective ?? body?.['effective-directive'],
    ),
    documentUri: truncate(body?.documentURL ?? body?.['document-uri']),
    disposition: truncate(body?.disposition),
    statusCode: coerceNumber(body?.statusCode ?? body?.['status-code']),
    lineNumber: coerceNumber(body?.lineNumber ?? body?.['line-number']),
    columnNumber: coerceNumber(body?.columnNumber ?? body?.['column-number']),
    sourceFile: truncate(body?.sourceFile ?? body?.['source-file']),
    sample: truncate(body?.sample ?? body?.['script-sample']),
    originalPolicy: truncate(
      body?.originalPolicy ?? body?.['original-policy'],
    ),
    referrer: truncate(body?.referrer),
  };
}

/**
 * Receives and logs Content Security Policy violation reports from browsers.
 *
 * Two wire formats are accepted:
 *
 * 1. **Reporting API** (`Content-Type: application/reports+json`) — an array
 *    of objects where each item has `{ type, url, body }`. Only items whose
 *    `type` is `"csp-violation"` are logged; unknown types are discarded
 *    silently so future report types do not cause noise.
 *
 * 2. **Legacy report-uri** (`Content-Type: application/csp-report`) — a
 *    single object with a `"csp-report"` key containing the violation.
 *
 * The endpoint always returns 204 — browsers ignore the response body.
 */
@Controller({ path: 'csp-report' })
export class CspReportController {
  private readonly logger = new Logger(CspReportController.name);

  /* eslint-disable @typescript-eslint/no-explicit-any -- Fastify parses body as unknown */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(@Body() body: any): void {
    if (Array.isArray(body)) {
      // Reporting API (Level 1): [{ type, url, body }]
      for (const report of body) {
        if (
          report &&
          typeof report === 'object' &&
          report.type === 'csp-violation'
        ) {
          this.log(normaliseCspBody(report.body), report.url);
        }
      }
    } else if (body && typeof body === 'object' && body['csp-report']) {
      // Legacy report-uri: { "csp-report": { ... } }
      this.log(normaliseCspBody(body['csp-report']), undefined);
    }
    // Silently ignore anything else — malformed bodies, unsupported types, etc.
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private log(
    violation: NormalisedCspViolation,
    reportUrl: string | undefined,
  ): void {
    this.logger.warn('CSP violation', {
      ...violation,
      ...(reportUrl !== undefined && { reportUrl: truncate(reportUrl) }),
    });
  }
}
