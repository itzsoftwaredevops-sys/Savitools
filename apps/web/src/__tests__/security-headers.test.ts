/**
 * @jest-environment node
 *
 * Security header regression test (Savitura/Savitools#252).
 *
 * The headers live in `next.config.ts` as a static `headers()` result, so the
 * test asserts them there. It used to `fetch('http://localhost:3000')`, which
 * meant it could only pass against a manually started dev server and therefore
 * failed in CI on every run — a red suite proves nothing.
 */
import type { NextConfig } from 'next';

const REQUIRED_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'strict-transport-security',
  'x-dns-prefetch-control',
  'reporting-endpoints',
] as const;

const FORBIDDEN_HEADERS = ['x-powered-by'] as const;

/** Loads `next.config.ts` with a given NODE_ENV, the way `next build` does. */
async function loadConfig(env: string): Promise<NextConfig> {
  // `next` declares NODE_ENV readonly, hence the writable view of the same object.
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previous = mutableEnv.NODE_ENV;

  jest.resetModules();
  mutableEnv.NODE_ENV = env;

  try {
    const loaded = (await import('../../next.config')) as { default: NextConfig };
    return loaded.default;
  } finally {
    mutableEnv.NODE_ENV = previous;
  }
}

/** Flattens the config's `headers()` output into lower-cased key/value pairs. */
async function loadHeaders(env = 'test'): Promise<Record<string, string>> {
  const config = await loadConfig(env);
  const rules = (await config.headers?.()) ?? [];

  const headers: Record<string, string> = {};
  for (const rule of rules) {
    for (const header of rule.headers) {
      headers[header.key.toLowerCase()] = header.value;
    }
  }
  return headers;
}

describe('Security Headers', () => {
  it('serves every required header on all routes', async () => {
    const headers = await loadHeaders();

    for (const header of REQUIRED_HEADERS) {
      expect(headers).toHaveProperty(header);
      expect(headers[header]).toBeTruthy();
    }

    for (const header of FORBIDDEN_HEADERS) {
      expect(headers).not.toHaveProperty(header);
    }

    const config = await loadConfig('test');
    const rules = config.headers ? await config.headers() : [];
    expect(rules.map((rule) => rule.source)).toEqual(['/:path*']);
  });

  it('has a CSP with frame-ancestors set to self', async () => {
    const headers = await loadHeaders();

    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });

  it('has X-Content-Type-Options: nosniff', async () => {
    const headers = await loadHeaders();

    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('has Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const headers = await loadHeaders();

    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('has a Permissions-Policy with restrictive defaults', async () => {
    const permissionsPolicy = (await loadHeaders())['permissions-policy'];

    expect(permissionsPolicy).toContain('accelerometer=()');
    // `self` keeps camera access for same-origin pages only so the offline QR
    // handoff can scan frames (Savitura/Savitools#344).
    expect(permissionsPolicy).toContain('camera=(self)');
    expect(permissionsPolicy).not.toContain('camera=()');
    expect(permissionsPolicy).toContain('geolocation=()');
    expect(permissionsPolicy).toContain('microphone=()');
    expect(permissionsPolicy).toContain('payment=()');
  });

  it('only enables HSTS in production', async () => {
    expect((await loadHeaders('test'))['strict-transport-security']).toBe('max-age=0');

    const production = (await loadHeaders('production'))['strict-transport-security'];
    expect(production).toContain('max-age=63072000');
    expect(production).toContain('includeSubDomains');
    expect(production).toContain('preload');
  });

  it('does not expose the X-Powered-By header', async () => {
    const config = await loadConfig('test');

    expect(config.poweredByHeader).toBe(false);
    expect(await loadHeaders()).not.toHaveProperty('x-powered-by');
  });

  it('sets Reporting-Endpoints to the CSP report endpoint', async () => {
    const headers = await loadHeaders();

    expect(headers['reporting-endpoints']).toMatch(/csp-endpoint="[^"]+\/api\/v1\/csp-report"/);
  });

  it('includes report-to and report-uri directives in the enforced CSP', async () => {
    const csp = (await loadHeaders())['content-security-policy'];

    expect(csp).toContain('report-to csp-endpoint');
    expect(csp).toContain('report-uri ');
    expect(csp).toMatch(/report-uri [^\s;]+\/api\/v1\/csp-report/);
  });

  it('adds Content-Security-Policy-Report-Only only in production', async () => {
    const devHeaders = await loadHeaders('development');
    expect(devHeaders).not.toHaveProperty('content-security-policy-report-only');

    const prodHeaders = await loadHeaders('production');
    expect(prodHeaders).toHaveProperty('content-security-policy-report-only');
  });

  it('report-only policy omits unsafe-inline and unsafe-eval', async () => {
    const reportOnly = (await loadHeaders('production'))['content-security-policy-report-only'];

    expect(reportOnly).not.toContain("'unsafe-inline'");
    expect(reportOnly).not.toContain("'unsafe-eval'");
  });

  it('report-only policy carries report-to and report-uri directives', async () => {
    const reportOnly = (await loadHeaders('production'))['content-security-policy-report-only'];

    expect(reportOnly).toContain('report-to csp-endpoint');
    expect(reportOnly).toMatch(/report-uri [^\s;]+\/api\/v1\/csp-report/);
  });
});
