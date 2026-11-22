import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  Logger,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { AppModule } from "./app.module";
import { enableGracefulShutdown } from "./config/graceful-shutdown";
import { parseTrustProxy } from "./config/trust-proxy";
import { parseWebOrigins } from "./config/web-origins";
import { VALIDATION_PIPE_OPTIONS } from "./config/validation-pipe.config";
import { WebSocketCorsAdapter } from "./config/websocket-cors.adapter";

/** Strict CSP for JSON/API responses. */
const STRICT_CSP =
  "default-src 'self';frame-ancestors 'none';object-src 'none';base-uri 'self'";

/** Relaxed CSP required by Swagger UI (non-production `/api/docs` only). */
const SWAGGER_CSP =
  "default-src 'self';style-src 'self' 'unsafe-inline';script-src 'self' 'unsafe-inline';img-src 'self' data: validator.swagger.io;font-src 'self' data:";

/**
 * Builds the `Content-Security-Policy-Report-Only` header value used in
 * production.  When `CSP_REPORT_ONLY` is set to `"false"` (or absent),
 * report-only mode is disabled and the function returns null.
 *
 * The report-only policy intentionally mirrors the enforced STRICT_CSP so that
 * any directive tightening under consideration can be validated against real
 * traffic without immediately breaking clients.
 */
function buildReportOnlyCsp(
  reportOnlyEnv: string | undefined,
  reportUri: string,
): string | null {
  if (reportOnlyEnv === 'false' || !reportOnlyEnv) return null;
  return `${STRICT_CSP};report-to csp-endpoint;report-uri ${reportUri}`;
}

async function bootstrap() {
  // trustProxy must be set at adapter construction — Fastify does not allow
  // changing it after the server is created (Savitura/Savitools#419).
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true, trustProxy }),
  );

  const config = app.get(ConfigService);
  const maxWasmFileSize = Number(config.get<string>('MAX_WASM_FILE_SIZE') ?? '5242880');
  const resolvedMaxWasmFileSize = Number.isFinite(maxWasmFileSize) && maxWasmFileSize > 0 ? maxWasmFileSize : 5 * 1024 * 1024;

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: resolvedMaxWasmFileSize } });

  const port = config.get<number>('API_PORT', 3001);
  const prefix = config.get<string>('API_PREFIX', 'api');
  // One allow-list for HTTP CORS, Socket.IO CORS and the gateway check.
  const webOrigins = parseWebOrigins(config.get<string>('WEB_ORIGIN'));
  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  // Security headers on every response (Savitura/Savitools#417). Helmet's
  // built-in CSP is disabled so we can apply a strict policy everywhere and
  // relax it only for Swagger UI in non-production.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: isProduction
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
      : false,
  });

  const docsPath = `/${prefix}/docs`;
  /* eslint-disable @typescript-eslint/no-explicit-any -- Fastify onSend hook typing */
  const fastifyForHeaders = app.getHttpAdapter().getInstance() as any;

  // Build the absolute report endpoint URL.  The API_PUBLIC_URL env var is the
  // canonical origin browsers can reach (required in production when
  // CSP_REPORT_ONLY is enabled); in other environments we fall back to
  // constructing a localhost URL so local testing still works.
  const reportOnlyEnv = config.get<string>('CSP_REPORT_ONLY');
  const apiPublicUrl = config.get<string>(
    'API_PUBLIC_URL',
    `http://localhost:${port}`,
  ).replace(/\/$/, '');
  const reportUri = `${apiPublicUrl}/${prefix}/v1/csp-report`;
  const reportOnlyCsp = buildReportOnlyCsp(reportOnlyEnv, reportUri);

  // Reporting-Endpoints group name referenced by the `report-to` CSP directive.
  const reportingEndpointsHeader = `csp-endpoint="${reportUri}"`;

  fastifyForHeaders.addHook(
    'onSend',
    async (request: any, reply: any, payload: unknown) => {
      const path = String(request.url ?? '').split('?')[0];
      const isDocs =
        !isProduction &&
        (path === docsPath || path.startsWith(`${docsPath}/`));
      if (!reply.getHeader('content-security-policy')) {
        reply.header(
          'Content-Security-Policy',
          isDocs ? SWAGGER_CSP : STRICT_CSP,
        );
      }
      if (reportOnlyCsp && !reply.getHeader('content-security-policy-report-only')) {
        reply.header('Content-Security-Policy-Report-Only', reportOnlyCsp);
        reply.header('Reporting-Endpoints', reportingEndpointsHeader);
      }
      return payload;
    },
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  app.setGlobalPrefix(prefix, {
    exclude: [{ path: "metrics", method: RequestMethod.GET }],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.enableCors({
    origin: webOrigins,
    credentials: true,
  });
  app.useWebSocketAdapter(new WebSocketCorsAdapter(app, webOrigins));

  // The options live in config/validation-pipe.config.ts so they can be
  // exercised as behaviour by main.spec.ts.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // Block GraphQL introspection in production
  if (nodeEnv === 'production') {
    /* eslint-disable @typescript-eslint/no-explicit-any -- raw Fastify instance and request/reply shapes are not worth typing here */
    const fastify = app.getHttpAdapter().getInstance() as any;
    fastify.addHook('preHandler', async (request: any, reply: any) => {
      const body = request.body;
      const rawQuery =
        (body && typeof body === 'object' && body.query) ||
        (typeof body === 'string' ? body : null) ||
        (request.query && request.query.query) ||
        null;

      if (
        typeof rawQuery === 'string' &&
        /\b___schema|__type\b/i.test(rawQuery)
      ) {
        await reply.code(400).send({
          errors: [{ message: 'GraphQL introspection is not allowed in production.' }],
        });
        return;
      }
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // Only enable Swagger in development and staging environments
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("SaviTools API")
      .setDescription("Developer infrastructure for the Stellar ecosystem")
      .setVersion("1.0")
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document);
  }

  // Nest only registers its SIGTERM/SIGINT listeners when this is called, and
  // without it none of the OnModuleDestroy/OnApplicationShutdown hooks run on
  // container stop. Must happen before listen() so the handlers exist for the
  // whole lifetime of the process.
  enableGracefulShutdown(app);

  await app.listen(port, "0.0.0.0");
  console.log(`SaviTools API running on http://localhost:${port}/${prefix}`);
  console.log(`Swagger docs at http://localhost:${port}/${prefix}/docs`);
}

bootstrap().catch((error) => {
  new Logger("Bootstrap").error(
    `Savitools API failed to start: ${
      error instanceof Error ? error.message : String(error)
    }`,
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
