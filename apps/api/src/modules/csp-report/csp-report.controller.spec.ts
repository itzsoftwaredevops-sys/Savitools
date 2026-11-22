import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Module } from '@nestjs/common';
import { CspReportController, normaliseCspBody } from './csp-report.controller';

@Module({ controllers: [CspReportController] })
class CspReportFixtureModule {}

/** Registers the two browser CSP content types as JSON aliases on a Fastify instance. */
function registerCspContentTypeParsers(app: NestFastifyApplication) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fastify = app.getHttpAdapter().getInstance() as any;
  const jsonParser = async (_request: any, body: string) =>
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

// ─── normaliseCspBody unit tests ──────────────────────────────────────────────

describe('normaliseCspBody()', () => {
  it('maps camelCase Reporting-API fields', () => {
    const result = normaliseCspBody({
      blockedURL: 'https://evil.example/x.js',
      effectiveDirective: 'script-src',
      documentURL: 'https://app.example/',
      disposition: 'report',
      statusCode: 200,
      lineNumber: 42,
      columnNumber: 7,
      sourceFile: 'https://app.example/main.js',
      sample: 'eval(',
      originalPolicy: "default-src 'self'",
      referrer: 'https://app.example/',
    });

    expect(result).toEqual({
      blockedUri: 'https://evil.example/x.js',
      effectiveDirective: 'script-src',
      documentUri: 'https://app.example/',
      disposition: 'report',
      statusCode: 200,
      lineNumber: 42,
      columnNumber: 7,
      sourceFile: 'https://app.example/main.js',
      sample: 'eval(',
      originalPolicy: "default-src 'self'",
      referrer: 'https://app.example/',
    });
  });

  it('maps kebab-case report-uri fields', () => {
    const result = normaliseCspBody({
      'blocked-uri': 'https://cdn.example/script.js',
      'effective-directive': 'script-src',
      'document-uri': 'https://app.example/page',
      'original-policy': "default-src 'self'; script-src 'self'",
      'script-sample': 'inline()',
      'status-code': 0,
      'line-number': 1,
      'column-number': 1,
      'source-file': 'https://app.example/page',
    });

    expect(result.blockedUri).toBe('https://cdn.example/script.js');
    expect(result.effectiveDirective).toBe('script-src');
    expect(result.sample).toBe('inline()');
    expect(result.statusCode).toBe(0);
  });

  it('truncates values longer than 1024 characters', () => {
    const long = 'x'.repeat(2048);
    const result = normaliseCspBody({ blockedURL: long });

    expect(result.blockedUri).toHaveLength(1024);
  });

  it('returns undefined for missing or non-string fields', () => {
    const result = normaliseCspBody({});

    expect(result.blockedUri).toBeUndefined();
    expect(result.effectiveDirective).toBeUndefined();
    expect(result.statusCode).toBeUndefined();
  });

  it('returns undefined for empty-string fields', () => {
    const result = normaliseCspBody({ blockedURL: '   ' });

    expect(result.blockedUri).toBeUndefined();
  });

  it('handles null and non-object body gracefully', () => {
    expect(() => normaliseCspBody(null)).not.toThrow();
    expect(() => normaliseCspBody('bad')).not.toThrow();
    expect(() => normaliseCspBody(undefined)).not.toThrow();
  });
});

// ─── HTTP endpoint integration tests ─────────────────────────────────────────

describe('CspReportController (HTTP)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CspReportFixtureModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    registerCspContentTypeParsers(app);
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 204 for a valid Reporting API payload', async () => {
    const payload = [
      {
        type: 'csp-violation',
        url: 'https://app.example/',
        body: {
          blockedURL: 'https://evil.example/x.js',
          effectiveDirective: 'script-src',
          documentURL: 'https://app.example/',
          disposition: 'report',
        },
      },
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/csp-report',
      payload,
      headers: { 'content-type': 'application/reports+json' },
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 204 for a valid legacy report-uri payload', async () => {
    const payload = {
      'csp-report': {
        'blocked-uri': 'https://cdn.example/x.js',
        'effective-directive': 'script-src',
        'document-uri': 'https://app.example/',
        'original-policy': "default-src 'self'",
      },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/csp-report',
      payload,
      headers: { 'content-type': 'application/csp-report' },
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 204 and silently drops non-csp-violation Reporting API types', async () => {
    const payload = [
      { type: 'deprecation', url: 'https://app.example/', body: {} },
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/csp-report',
      payload,
      headers: { 'content-type': 'application/reports+json' },
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 204 for an empty Reporting API array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/csp-report',
      payload: [],
      headers: { 'content-type': 'application/reports+json' },
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 204 for a malformed body and does not throw', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/csp-report',
      payload: { unexpected: true },
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(204);
  });
});
