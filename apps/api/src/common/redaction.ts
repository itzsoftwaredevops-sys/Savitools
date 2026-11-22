export const REDACTED = '[REDACTED]';

/** JWT token shape: three base64url segments separated by dots. */
export const JWT_REGEX = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Stellar secret seed: S followed by 56 StrKey characters. */
export const SEED_REGEX = /S[A-Z2-7]{55}/g;

/** Bearer token prefix. */
export const BEARER_PREFIX = 'Bearer ';

/**
 * Redact sensitive strings: JWTs, seeds, bearer tokens.
 * Safe for use in diagnostic previews, clipboard exports, and error reporting.
 */
export function redactString(value: string): string {
  if (!value) {
    return value;
  }
  let out = value.replace(JWT_REGEX, REDACTED);
  out = out.replace(SEED_REGEX, REDACTED);
  out = out.replace(
    new RegExp(`^${BEARER_PREFIX}[A-Za-z0-9_.-]+`, 'gi'),
    `${BEARER_PREFIX}${REDACTED}`,
  );
  return out;
}

/**
 * Known sensitive key patterns (case-insensitive substring matching).
 * Covers JWT, token, secret, key, signature, credential, and more.
 */
export const SENSITIVE_KEY_PATTERNS = [
  /key/i,
  /jwt/i,
  /token/i,
  /secret/i,
  /signature/i,
  /signing_key/i,
  /private/i,
  /password/i,
  /authorization/i,
  /proxy-authorization/i,
  /credential/i,
  /cookie/i,
];

/** Known sensitive field names (exact match, case-insensitive). */
export const SENSITIVE_FIELD_PATTERNS = [
  /^(first_name)$/i,
  /^(last_name)$/i,
  /^(email)$/i,
  /^(phone_number)$/i,
  /^(phone)$/i,
  /^(address)$/i,
  /^(birth_date)$/i,
  /^(birth_place)$/i,
  /^(id_number)$/i,
  /^(tax_id)$/i,
  /^(ssn)$/i,
  /^(document_number)$/i,
  /^(account_number)$/i,
  /^(routing_number)$/i,
  /^(card_number)$/i,
  /^(cvv)$/i,
];

/**
 * Check if a key (header name, object key) is considered sensitive.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Check if a field name is considered sensitive (exact match).
 */
export function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Deep redact sensitive values from an object/array structure.
 * Uses a keyHint to check for sensitive keys; falls back to pattern matching
 * on string values (JWT, seed, bearer detection).
 */
export function redactValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && isSensitiveKey(keyHint)) {
    return REDACTED;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keyHint));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

/** Redact sensitive keys from a headers object. Coerces values to strings. */
export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : String(value);
  }
  return redacted;
}

/** Redact URLs to origin + pathname only, keeping copy-safe reports. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}
