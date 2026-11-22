# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in SaviTools, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email security concerns to: **security@savitura.com**
3. Include a detailed description of the vulnerability.
4. If possible, provide steps to reproduce or a proof-of-concept.

We aim to acknowledge reports within 48 hours and will work with you to understand and address the issue promptly.

## Security Measures

SaviTools implements the following security measures:

### API Protection

- **CORS**: Restricted origins via `WEB_ORIGIN` environment variable
- **Rate Limiting**: Configurable via `THROTTLE_LIMIT` and `THROTTLE_TTL`; auth routes (login/register/password reset) use a tighter 5 req/min per-IP override, with an additional per-email cap on forgot-password
- **Proxy trust**: Set `TRUST_PROXY` (hop count or CIDR list) so rate limiting keys on the real client IP behind a reverse proxy
- **Security headers**: `@fastify/helmet` on API responses (`X-Content-Type-Options`, `X-Frame-Options`, CSP, HSTS in production). CSP is relaxed only for `/api/docs` in non-production
- **Schema safety**: TypeORM `synchronize` is limited to `development`/`test`; deployments apply migrations (`RUN_MIGRATIONS` or `migration:run`)
- **Input Validation**: All API inputs are validated using class-validator
- **Authenticated Signing**: Testnet wallet and sandbox payment endpoints enforce JWT authentication and rate limiting for server-side secret key signing

### Webhook Security

- **HMAC-SHA256 Signing**: Outbound webhooks are signed using implementation in `webhook/signature.ts`, `contracts/events.service.ts`, and `monitor/notification-worker.service.ts` (using per-request secrets or configured keys; note that `WebhookService` does not read `WEBHOOK_SIGNING_SECRET` directly)
- **Timestamp Verification**: The signature covers `<timestamp>.<body>`, so a captured request cannot be replayed verbatim. Reject timestamps older than the replay window (default 300s) or more than 60s in the future
- **Signature Header**: `X-Webhook-Signature` with format `sha256=<hex>`, paired with `X-SaviTools-Timestamp` (integer Unix seconds)

### Authentication

- **JWT Tokens**: Secure session management with refresh token rotation
- **Password Hashing**: Argon2 for password storage

### Network Security

- **SSRF Protection**: Guards on outbound requests from Playground, Webhook, and Network modules
- **TLS**: All external API calls use HTTPS

### HTTP Security Headers (Configured in `apps/web/next.config.ts`)

The following security headers are set on all responses:

| Header                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                         | Purpose                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://horizon-testnet.stellar.org https://horizon.stellar.org https://friendbot.stellar.org https://api.fluxa.io https://api.crowdpay.io wss://*.stellar.org; frame-ancestors 'self'; form-action 'self'; base-uri 'self'; object-src 'none'` | Mitigates XSS, injection, and unauthorized framing |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                                                                                                                                                                                                                                                     | Prevents MIME-type sniffing                        |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                                                                                                                                                                                                                                                                                                                                                                                             | Controls referrer information sent with requests   |
| `Permissions-Policy`        | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()`                                                                                                                                                                                                                                                                                           | Restricts browser features and APIs                |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (production only)                                                                                                                                                                                                                                                                                                                                                              | Enforces HTTPS                                     |
| `X-DNS-Prefetch-Control`    | `on`                                                                                                                                                                                                                                                                                                                                                                                                                          | Enables DNS prefetching for performance            |
| `X-Powered-By`              | **Removed**                                                                                                                                                                                                                                                                                                                                                                                                                   | Hides Next.js version information                  |

### Supply Chain & Dependency Security

- **CodeQL Static Analysis (SAST)**: GitHub CodeQL scans all JavaScript and TypeScript source files (`apps/**`, `scripts/**`) on every push and pull request to `main`, and on a weekly schedule. The `security-and-quality` query suite covers CWE-mapped vulnerability classes including injection, XSS, SSRF, path traversal, and prototype pollution. Results are uploaded to the GitHub Security tab and saved as a SARIF workflow artifact. See [CodeQL Documentation](docs/codeql.md).
- **Dependency Review Enforcement**: Automated pull request gating in GitHub Actions (`.github/workflows/dependency-review.yml`) powered by `actions/dependency-review-action@v4`. Every PR targeting `main` is scanned for newly introduced or upgraded vulnerable dependencies (blocking at `moderate`, `high`, or `critical` severity) and non-compliant or restrictive viral copyleft licenses (e.g. AGPL-3.0, GPL-3.0). See [Dependency Review Documentation](docs/dependency-review.md).
- **SBOM Generation**: Automated CycloneDX Software Bill of Materials (SBOM) generation during builds.
- **Local Review & Audit**: Contributors can run `npm run review:deps` and `npm audit` to validate dependency review configuration and package compliance locally before opening pull requests.

## Security-Related Configuration

| Variable                 | Description                               |
| ------------------------ | ----------------------------------------- |
| `WEB_ORIGIN`             | Allowed CORS origin                       |
| `THROTTLE_TTL`           | Rate limit window (ms)                    |
| `THROTTLE_LIMIT`         | Max requests per window                   |
| `TRUST_PROXY`            | Fastify trustProxy (false/true/hops/CIDR) |
| `RUN_MIGRATIONS`         | Apply TypeORM migrations on API startup   |
| `WEBHOOK_SIGNING_SECRET` | HMAC key for webhook signatures           |
| `JWT_SECRET`             | Secret for JWT token signing              |

## Responsible Disclosure

We appreciate the security research community and will acknowledge researchers who report valid vulnerabilities (with permission) in our release notes.
