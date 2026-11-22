import { Logger } from '@nestjs/common';
import { MONITOR_ROLES } from '../modules/monitor/monitor-runtime.config';

/**
 * Startup environment validation (Savitura/Savitools#197).
 *
 * Keeps the runtime reads in the codebase and the documented templates
 * honest: required URLs must be present, production must use HTTPS, auth and
 * encryption secrets must not be placeholders, and feature flags that enable
 * optional modules must be accompanied by the variables those modules read.
 */

const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

const PLACEHOLDER_PATTERNS = [
  /^change-me/i,
  /^changeme/i,
  /^your-/i,
  /placeholder/i,
  /^secret$/i,
  /^password$/i,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Loopback origins are exempt from the production HTTPS rule. */
function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Splits a comma-separated origin list (Savitura/Savitools#255). Unlike
 * `parseWebOrigins` there is no default: an unset value means "nothing to
 * validate" rather than "validate localhost".
 */
function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Runtime-read variables and their exact purposes — keep in sync with the
 *  `.env.example` templates. */
export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

export function collectConfigurationErrors(
  config: Record<string, unknown>,
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const nodeEnv = (get('NODE_ENV') ?? 'development').toLowerCase();
  const isProduction = nodeEnv === 'production';

  // ─── Required URLs ────────────────────────────────────────────────────────
  const databaseUrl = get('DATABASE_URL');
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required');
  } else if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a PostgreSQL connection string');
  }

  const redisUrl = get('REDIS_URL');
  if (!redisUrl) {
    errors.push('REDIS_URL is required');
  } else if (!/^rediss?:\/\//i.test(redisUrl)) {
    errors.push('REDIS_URL must be a Redis connection string');
  }

  // ─── Auth & encryption secrets ────────────────────────────────────────────
  const jwtSecret = get('JWT_SECRET');
  if (!jwtSecret) {
    errors.push('JWT_SECRET is required (JwtModule reads it at startup)');
  } else if (isPlaceholder(jwtSecret)) {
    const message = 'JWT_SECRET must be replaced with a generated random value';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  }

  const encryptionSecret = get('ENCRYPTION_SECRET');
  if (!encryptionSecret) {
    const message =
      'ENCRYPTION_SECRET is required (auth vault/connected-account encryption derives per-user keys from it)';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  } else if (isPlaceholder(encryptionSecret)) {
    const message =
      'ENCRYPTION_SECRET must be replaced with a generated secret';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  } else if (isProduction && encryptionSecret.length < 32) {
    errors.push('ENCRYPTION_SECRET must be at least 32 characters in production');
  }

  if (isProduction && jwtSecret && jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }

  // ─── Production HTTPS ─────────────────────────────────────────────────────
  if (isProduction) {
    for (const key of ['STELLAR_HORIZON_URL', 'STELLAR_RPC_URL'] as const) {
      const value = get(key);
      if (value && isHttpUrl(value) && !isLoopbackOrigin(value)) {
        errors.push(`${key} must use HTTPS in production`);
      }
    }
    // WEB_ORIGIN may list several origins; every public one must be HTTPS.
    for (const origin of splitOrigins(get('WEB_ORIGIN'))) {
      if (isHttpUrl(origin) && !isLoopbackOrigin(origin)) {
        errors.push('WEB_ORIGIN must use HTTPS in production');
        break;
      }
    }
  }

  // ─── Monitor role ─────────────────────────────────────────────────────────
  const monitorRole = get('MONITOR_ROLE');
  if (
    monitorRole &&
    !(MONITOR_ROLES as readonly string[]).includes(monitorRole.toLowerCase())
  ) {
    errors.push(
      `MONITOR_ROLE must be one of ${MONITOR_ROLES.join(', ')} (received "${monitorRole}")`,
    );
  }

  // ─── Contracts module (eagerly constructed — required at startup) ─────────
  const deployerSecret = get('DEPLOYER_SECRET_KEY');
  if (!deployerSecret) {
    errors.push(
      'DEPLOYER_SECRET_KEY is required (ContractsService calls getOrThrow during startup)',
    );
  } else if (!/^S[0-9A-Z]{55}$/.test(deployerSecret)) {
    const message =
      'DEPLOYER_SECRET_KEY must be a valid Stellar secret key (56 characters starting with S)';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  }

  // DEPLOYER_SECRET_KEY is shared by every allowlisted user, so the contracts
  // module is testnet/futurenet only (Savitura/Savitools#425).
  const stellarNetwork = (get('STELLAR_NETWORK') ?? '').trim().toLowerCase();
  if (
    ['mainnet', 'public', 'pubnet'].includes(stellarNetwork) ||
    get('STELLAR_NETWORK_PASSPHRASE') === PUBLIC_NETWORK_PASSPHRASE
  ) {
    errors.push(
      'STELLAR_NETWORK / STELLAR_NETWORK_PASSPHRASE must be a test network (testnet, futurenet or local): the shared DEPLOYER_SECRET_KEY must never spend mainnet funds',
    );
  }

  // ─── Feature-specific settings ────────────────────────────────────────────
  if (get('RESEND_API_KEY') && !get('RESEND_FROM_EMAIL')) {
    errors.push('RESEND_FROM_EMAIL is required when RESEND_API_KEY is set');
  }

  // ─── CSP reporting ────────────────────────────────────────────────────────
  // When report-only mode is enabled in production the browser posts violations
  // to the absolute URL built from API_PUBLIC_URL.  Require it to be an HTTPS
  // URL in production so report payloads are not sent over plain HTTP.
  const cspReportOnly = get('CSP_REPORT_ONLY');
  if (cspReportOnly && cspReportOnly !== 'false' && cspReportOnly !== 'true') {
    errors.push('CSP_REPORT_ONLY must be "true" or "false"');
  }
  if (isProduction && cspReportOnly === 'true') {
    const apiPublicUrl = get('API_PUBLIC_URL');
    if (!apiPublicUrl) {
      errors.push('API_PUBLIC_URL is required when CSP_REPORT_ONLY is "true" in production');
    } else if (isHttpUrl(apiPublicUrl) && !isLoopbackOrigin(apiPublicUrl)) {
      errors.push('API_PUBLIC_URL must use HTTPS in production');
    }
  }

  const fluxaClientId = get('FLUXA_CLIENT_ID');
  if (fluxaClientId) {
    if (!get('FLUXA_CLIENT_SECRET')) {
      errors.push('FLUXA_CLIENT_SECRET is required when FLUXA_CLIENT_ID is set');
    }
    if (!get('FLUXA_AUTH_URL')) {
      errors.push('FLUXA_AUTH_URL is required when FLUXA_CLIENT_ID is set');
    }
  }

  // ─── Playground spec cache ────────────────────────────────────────────────
  // Env values are strings; reject non-positive/non-integer values at boot so
  // the service never caches with a NaN TTL (Savitura/Savitools#247).
  const playgroundSpecTtl = get('PLAYGROUND_SPEC_TTL_MS');
  if (playgroundSpecTtl !== undefined) {
    if (!/^\d+$/.test(playgroundSpecTtl) || Number(playgroundSpecTtl) <= 0) {
      errors.push(
        'PLAYGROUND_SPEC_TTL_MS must be a positive integer number of milliseconds',
      );
    }
  }

  return { errors, warnings };
}

/**
 * ConfigModule `validate` hook: throws a single aggregated error listing
 * every misconfiguration, so operators see all problems at once instead of
 * discovering them one failed `getOrThrow` at a time.
 */
export function validateEnvironment(config: Record<string, unknown>): Record<string, unknown> {
  const { errors, warnings } = collectConfigurationErrors(config);
  const logger = new Logger('EnvironmentValidation');
  for (const warning of warnings) {
    logger.warn(warning);
  }
  if (errors.length > 0) {
    throw new Error(
      `Environment configuration failed validation:\n- ${errors.join('\n- ')}`,
    );
  }
  return config;
}
