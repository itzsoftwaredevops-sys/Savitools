# SaviTools API Reference

Developer infrastructure for the Stellar ecosystem.

## Base URLs

| Environment           | URL                                     | Notes                        |
| --------------------- | --------------------------------------- | ---------------------------- |
| **Mainnet**           | `https://api.savitools.com/api`         | Production Stellar network   |
| **Testnet**           | `https://testnet-api.savitools.com/api` | Stellar testnet environment  |
| **Local Development** | `http://localhost:3001/api`             | Development server (default) |

## API Versioning

The API uses URI-based versioning. All endpoints are prefixed with `/v1` (or the version number). The current default version is `v1`.

Example: `GET /api/v1/health`

## Error Responses and Correlation IDs

API errors use a consistent JSON envelope containing `statusCode`, `message`, `error`, `path`, `timestamp`, and `requestId`; optional machine-readable `code` and safe `details` may also be present. The `requestId` is also returned in the `x-request-id` response header. Existing status, `message`, and `error` fields are unchanged. Successful response bodies are not wrapped by this contract.

The web client sends a UUID in `x-request-id` for each API request. Other clients may provide their own ID of up to 128 ASCII letters, digits, periods, underscores, colons, or hyphens; invalid values are replaced with a generated UUID. The API returns that effective ID in every error envelope, including unknown-route errors, and logs it with server errors so support can correlate a report with server logs. Treat IDs as opaque diagnostic metadata, not as credentials; do not put personal or secret data in them.

## Authentication

### Public vs Protected Endpoints

- **Public endpoints**: No authentication required (e.g., `/wallet/generate`, `/simulator/paths`)
- **Protected endpoints**: Require valid JWT authentication via HTTP-only cookies

### Getting an API Key

1. Register or login to create a session
2. Use the issued JWT cookie for subsequent requests

### Authentication Methods

#### HTTP Cookie (Recommended)

The API uses **HTTP-only cookies** to store JWT tokens automatically after authentication. When you call `POST /auth/login` or `POST /auth/register`, the response sets:

- `access_token` cookie (15-minute expiration)
- `refresh_token` cookie (7-day expiration)

All subsequent requests automatically include these cookies. No header configuration needed.

#### Header-Based Authentication (Optional)

If cookies are disabled, use:

```
Authorization: Bearer {accessToken}
```

### Cookie Refresh

To refresh an expired access token:

```bash
curl -X POST http://localhost:3001/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  --cookie "refresh_token=YOUR_REFRESH_TOKEN"
```

## Endpoint Catalog

### Federation asset metadata and home-domain validation

These public, read-only endpoints inspect the domain's `/.well-known/stellar.toml`. They do not store results or require a user session. TOML responses use the existing five-minute, bounded in-memory cache (up to 200 domains); concurrent requests for the same domain share a fetch. Fetches retain the federation module's timeout, response-size, redirect, and public-host SSRF limits. No secrets are accepted or returned.

#### GET `/federation/validate-home-domain?domain=example.com&issuer=G...`

Checks the issuer key appears in the domain's `ACCOUNTS` array. An optional account `HOME_DOMAIN` value must also match the normalized domain. A mismatch is returned as a successful validation result with `valid: false`; malformed inputs use the standard `400` error envelope and an unavailable TOML uses the existing federation error responses.

**Response (200):**

```json
{ "valid": true, "domain": "example.com", "issuer": "G...", "reason": null }
```

#### GET `/federation/asset-metadata?domain=example.com&code=USDC&issuer=G...`

Returns the matching `[[CURRENCIES]]` metadata only when the issuer passes the home-domain check. Asset codes must contain 1–12 ASCII letters or digits and issuer must be a Stellar public key. An undeclared currency returns `404`; an issuer that fails domain validation returns `400`.

**Response (200):**

```json
{ "code": "USDC", "issuer": "G...", "name": "USD Coin", "display_decimals": 7 }
```

The existing `FEDERATION_TOML_CACHE_TTL_MS` and `FEDERATION_TOML_CACHE_MAX_ENTRIES` settings control cache behavior (defaults: 5 minutes and 200 domains). TOML fetches have a 15-second timeout. `FEDERATION_REQUEST_TIMEOUT_MS` (default 5 seconds) is the overall SEP inspection deadline; `FEDERATION_PROBE_TIMEOUT_MS` (default 3 seconds) bounds each endpoint probe. Invalid or non-positive setting values use their defaults. TOML payloads are limited to 512 KiB, nesting depth 64, and 10,000 parsed keys.

### Health & Status

#### GET `/health`

Health check endpoint.

**Request:**

```bash
curl http://localhost:3001/api/v1/health
```

**Response (200):**

```json
{
  "status": "ok"
}
```

---

### Authentication

#### POST `/auth/register`

Register a new user with email and password.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123"
  }'
```

**Response (201):**

```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": null
  }
}
```

**Errors:**

- `400`: User already exists or invalid email format

---

#### POST `/auth/login`

Login with email and password.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123"
  }'
```

**Response (200):**

```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": null
  }
}
```

**Cookies Set:**

- `access_token` (15 min TTL)
- `refresh_token` (7 day TTL)

**Errors:**

- `401`: Invalid email or password

---

#### POST `/auth/forgot-password`

Request a password reset email (see Savitura/Savitools#196). The response is identical whether or not the account exists — the endpoint cannot be used to enumerate registered emails. Requests are rate-limited per IP and per email.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com" }'
```

**Response (200):**

```json
{
  "message": "If an account with that email exists, we have sent a link to reset your password."
}
```

The email contains a link to `/reset-password?token=…`. The token is stored hashed (SHA-256), is single-use, and expires after 30 minutes.

---

#### POST `/auth/reset-password`

Set a new password with a valid, unused, unexpired reset token. On success every active refresh-token family for the user is revoked, signing out all other sessions.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "RESET_TOKEN_FROM_EMAIL",
    "password": "NewSecurePassword123"
  }'
```

**Response (200):**

```json
{
  "message": "Password updated. You can now sign in with your new password."
}
```

**Errors:**

- `404`: Reset token is invalid (or already used)
- `410`: `RESET_TOKEN_EXPIRED`

---

#### POST `/auth/refresh`

Rotate refresh token and issue a new access token.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/refresh \
  --cookie "refresh_token=YOUR_REFRESH_TOKEN"
```

**Response (200):**

```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com"
  }
}
```

**Errors:**

- `401`: Invalid or expired refresh token

---

#### POST `/auth/logout`

Invalidate refresh token and clear auth cookies.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/logout
```

**Response (200):**

```json
{
  "success": true
}
```

---

#### POST `/auth/fluxa`

Exchange a Fluxa API key for a SaviTools session and link accounts.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/auth/fluxa \
  -H "Content-Type: application/json" \
  -d '{
    "fluxaApiKey": "your-fluxa-api-key"
  }'
```

**Response (200):**

```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": "fluxa-tenant-id"
  }
}
```

**Errors:**

- `400`: Invalid Fluxa API key

---

#### GET `/auth/me`

Get the current authenticated user.

**Request:**

```bash
curl http://localhost:3001/api/v1/auth/me \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": null
  }
}
```

**Errors:**

- `401`: Not authenticated

---

### Wallet & Keypair Generation

#### POST `/wallet/generate`

Generate a new Stellar keypair (public key + secret).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/wallet/generate
```

**Response (201):**

```json
{
  "publicKey": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C",
  "secret": "SBUQ54DRQG5Q3QLQHJEZ5ODSLGE...TRUNCATED"
}
```

---

#### POST `/wallet/fund`

Fund a testnet account via Friendbot (10 XLM).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/wallet/fund \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C"
  }'
```

**Response (200):**

```json
{
  "success": true,
  "amount": "10.0000000",
  "currency": "XLM",
  "transactionHash": "6c1e1f6..."
}
```

**Errors:**

- `400`: Invalid public key or funding failed (rate-limited, etc.)

---

#### GET `/wallet/balances?publicKey=GBZR...`

Get asset balances for a Stellar account.

**Request:**

```bash
curl "http://localhost:3001/api/v1/wallet/balances?publicKey=GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C"
```

**Response (200):**

```json
{
  "balances": [
    {
      "asset_type": "native",
      "balance": "9.9999800",
      "asset_code": "XLM"
    },
    {
      "asset_type": "credit_alphanum4",
      "asset_code": "USDC",
      "asset_issuer": "GA...",
      "balance": "100.0000000",
      "limit": "922337203685.4775807"
    }
  ]
}
```

**Errors:**

- `400`: Invalid public key or account not found

---

#### POST `/wallet/payment`

Submit a payment the client already built and signed (requires JWT authentication and rate limiting). The source secret never leaves the client.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/wallet/payment \
  -H "Content-Type: application/json" \
  -d '{
    "signedXdr": "AAAAAgAAAAB..."
  }'
```

**Response (200):**

```json
{
  "success": true,
  "txHash": "6c1e1f6fe..."
}
```

**Errors:**

- `400`: Invalid signed XDR, unsigned envelope, or Horizon rejected the transaction

---

### Simulator (Payment Paths & Fees)

#### GET `/simulator/paths?direction=...&source_asset_*=...&destination_asset_*=...&amount=...&network=...`

Find payment paths between two assets.

**Query Parameters:**

- `direction` (required): `strict_send` or `strict_receive`
- `source_asset_type` (required): `native` | `credit_alphanum4` | `credit_alphanum12`
- `source_asset_code` (optional): Asset code (e.g., `USDC`)
- `source_asset_issuer` (optional): Asset issuer public key
- `destination_asset_type` (required): Asset type for destination
- `destination_asset_code` (optional): Destination asset code
- `destination_asset_issuer` (optional): Destination asset issuer
- `amount` (required): Amount to send/receive
- `network` (optional, default `mainnet`): `mainnet` or `testnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/simulator/paths?direction=strict_send&source_asset_type=native&destination_asset_type=credit_alphanum4&destination_asset_code=USDC&destination_asset_issuer=GA...&amount=100&network=testnet"
```

**Response (200):**

```json
{
  "paths": [
    {
      "path": [
        {
          "asset_type": "native"
        }
      ],
      "destination_amount": "99.5000000",
      "source_amount": "100.0000000"
    }
  ],
  "direction": "strict_send"
}
```

**Errors:**

- `400`: Invalid parameters or no paths found

---

#### POST `/simulator/estimate`

Compute destination_min or send_max for a selected path with slippage.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/simulator/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "path": [...],
    "sendAmount": "100.0",
    "slippagePercent": 1.5
  }'
```

**Response (200):**

```json
{
  "sourceAmount": "100.0000000",
  "destinationAmount": "98.5000000"
}
```

**Errors:**

- `400`: Invalid path or amount

---

#### POST `/simulator/path-send`

Find paths for a strict send payment (you control the amount sent).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/simulator/path-send \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAsset": {...},
    "destinationAsset": {...},
    "sendAmount": "100.0",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "paths": [...],
  "direction": "strict_send"
}
```

---

#### POST `/simulator/path-receive`

Find paths for a strict receive payment (you control the amount received).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/simulator/path-receive \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAsset": {...},
    "destinationAsset": {...},
    "receiveAmount": "100.0",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "paths": [...],
  "direction": "strict_receive"
}
```

---

#### GET `/simulator/fee?operations=1&network=testnet`

Estimate transaction fee based on current network fee stats.

**Query Parameters:**

- `operations` (optional, default `1`): Number of operations in the transaction
- `network` (optional, default `testnet`): `mainnet` or `testnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/simulator/fee?operations=3&network=testnet"
```

**Response (200):**

```json
{
  "baseFee": 100,
  "totalFee": 300,
  "operations": 3,
  "network": "testnet"
}
```

---

#### POST `/simulator/path-payment-lab`

Price several slippage tolerances against a single simulated adverse rate move (Savitura/Savitools#351).

A path payment carries a tolerance rather than a locked rate: `destinationMin` for `strict_send`, `sendMax` for `strict_receive`. The network fails the operation when the live route cannot fill inside it. This endpoint reads the live route table for a pair and prices up to ten tolerances against one adverse move, so they can be compared directly.

**Request body:**

- `direction` (required): `strict_send` or `strict_receive`
- `sourceAsset` (required): `XLM` or `CODE:ISSUER`
- `destinationAsset` (required): `XLM` or `CODE:ISSUER`
- `amount` (required): the pinned leg — the source amount for `strict_send`, the destination amount for `strict_receive`. Up to 15 integer and 7 fractional digits
- `slippageScenarios` (required): 1–10 tolerance percentages, each at least `0.01` and at most `100`
- `adverseMovePercent` (optional, default `0`): the deterioration to simulate between quote and landing, `0`–`100`
- `routeIndex` (optional, default `0`): which route to simulate, zero-based in the order Horizon returned them. `0` is the best route
- `network` (optional, default `testnet`): `mainnet` or `testnet`

**Request:**

```bash
curl -X POST "http://localhost:3001/api/v1/simulator/path-payment-lab" \
  -H "content-type: application/json" \
  -d '{
    "direction": "strict_send",
    "sourceAsset": "XLM",
    "destinationAsset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ",
    "amount": "100.0000000",
    "slippageScenarios": [0.1, 0.5, 1, 5],
    "adverseMovePercent": 2,
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "network": "testnet",
  "direction": "strict_send",
  "sourceAsset": "XLM",
  "destinationAsset": "USDC:GA5Z…JCJQ",
  "routeCount": 2,
  "route": {
    "index": 0,
    "pathLength": 1,
    "sourceAmount": "100.0000000",
    "destinationAmount": "98.0000000",
    "exchangeRate": "0.98",
    "fixedAmount": "100.0000000",
    "variableAmount": "98.0000000",
    "hops": [{ "assetType": "credit_alphanum4", "assetCode": "USDC", "assetIssuer": "GA5Z…JCJQ" }]
  },
  "comparison": {
    "direction": "strict_send",
    "guaranteeField": "destinationMin",
    "fixedAmount": "100.0000000",
    "quotedVariableAmount": "98.0000000",
    "adverseMovePercent": 2,
    "adverseVariableAmount": "96.0000000",
    "scenarios": [
      {
        "slippagePercent": 0.1,
        "guarantee": "97.9020000",
        "adverseAmount": "96.0000000",
        "headroom": "-1.9020000",
        "headroomPercent": -1.9408,
        "tolerableMovePercent": 0.1,
        "verdict": "fail"
      }
    ],
    "tightestSlippagePercent": 0.1,
    "widestSlippagePercent": 5,
    "recommendedSlippagePercent": 5,
    "recommendedHeadroomPercent": 3,
    "exceededByEveryScenario": false,
    "routeDispersionPercent": null
  }
}
```

**How the arithmetic works:**

|                        | `destinationMin` (strict send) | `sendMax` (strict receive) |
| ---------------------- | ------------------------------ | -------------------------- |
| Guarantee              | `floor(variable × (1 − s))`    | `ceil(variable × (1 + s))` |
| Worst case at the move | `floor(variable × (1 − m))`    | `ceil(variable × (1 + m))` |
| Headroom               | `worstCase − guarantee`        | `guarantee − worstCase`    |

where `s` is the tolerance and `m` the adverse move, both as fractions. The two directions subtract differently because a `destinationMin` is a floor the fill must stay _above_ while a `sendMax` is a ceiling it must stay _below_; in both cases a positive `headroom` means the payment clears.

- `verdict` is `pass`, `fail`, or `exact`. `exact` means the tolerance and the move produced the same amount, so the payment clears only if the rate does not move by another stroop — treat it as a failure.
- All amount arithmetic runs on exact stroop integers and rounds the way the network rounds, so a reported `destinationMin`/`sendMax` is always one the network accepts. No amount is ever held in a floating-point number.
- `recommendedSlippagePercent` is the _narrowest_ compared tolerance that still absorbs the move; anything tighter would fail. It is `null` and `exceededByEveryScenario` is `true` when every compared tolerance is exceeded.
- `routeDispersionPercent` reports how far the selected route already sits below the best route, as a percentage of the best one. It is `null` when route `0` was simulated.

**Limits:**

- `slippageScenarios`: 1–10 entries, each `0.01`–`100`. A tolerance below `0.01%` would round to zero hundredths of a percent and mean "no tolerance", so it is rejected rather than silently accepted.
- `adverseMovePercent`: `0`–`100`.
- `routeIndex`: `0` to `routeCount − 1`.

**Errors:**

- `400`: invalid amount, asset format, or tolerance; `routeIndex` beyond the routes Horizon returned; no route for the pair
- `429`: global rate limit exceeded

**Operational notes:**

- The call is not cached. A run is a pure function of the live route table plus the caller's tolerances, and any cached answer would describe a route table that has since moved.
- `POST` answers `200`, not `201`: nothing is created.

---

### Liquidity Pools

#### GET `/liquidity-pools/search?assetA=...&assetB=...&network=...`

Search for liquidity pools by asset pair on Stellar.

**Query Parameters:**

- `assetA` (required): First asset in the pair. Use `XLM` for native or `CODE:ISSUER` for non-native.
- `assetB` (required): Second asset in the pair. Use `XLM` for native or `CODE:ISSUER` for non-native.
- `network` (optional, default `testnet`): `mainnet` or `testnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/liquidity-pools/search?assetA=XLM&assetB=USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5&network=testnet"
```

**Response (200):**

```json
[
  {
    "poolId": "a468d41d61e...",
    "network": "testnet",
    "assetA": "native",
    "assetB": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "reserveA": "1000000.0000000",
    "reserveB": "500000.0000000",
    "totalShares": "707106.7811865",
    "feePct": "0.30%",
    "totalTrustlines": 42,
    "type": "constant_product",
    "spotPriceAperB": "2.0000000",
    "spotPriceBperA": "0.5000000"
  }
]
```

**Errors:**

- `400`: Invalid asset format or network

---

#### GET `/liquidity-pools/details?poolId=...&network=...`

Get detailed information about a specific pool.

**Query Parameters:**

- `poolId` (required): 64-character hex pool ID
- `network` (optional, default `testnet`): `mainnet` or `testnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/liquidity-pools/details?poolId=a468d41d61e...&network=testnet"
```

**Response (200):**

```json
{
  "poolId": "a468d41d61e...",
  "network": "testnet",
  "assetA": "native",
  "assetB": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "reserveA": "1000000.0000000",
  "reserveB": "500000.0000000",
  "totalShares": "707106.7811865",
  "feePct": "0.30%",
  "totalTrustlines": 42,
  "type": "constant_product",
  "spotPriceAperB": "2.0000000",
  "spotPriceBperA": "0.5000000"
}
```

**Errors:**

- `400`: Invalid pool ID or network
- `404`: Pool not found

---

#### POST `/liquidity-pools/share-value`

Calculate the value of LP shares.

**Request Body:**

```json
{
  "poolId": "a468d41d61e...",
  "shares": "100.0000000",
  "network": "testnet"
}
```

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/liquidity-pools/share-value \
  -H "Content-Type: application/json" \
  -d '{
    "poolId": "a468d41d61e...",
    "shares": "100.0000000",
    "network": "testnet"
  }'
```

**Response (201):**

```json
{
  "poolId": "a468d41d61e...",
  "network": "testnet",
  "shares": "100.0000000",
  "valueA": "141.4213562",
  "valueB": "70.7106781",
  "sharePercentage": "0.01414214",
  "assetA": "native",
  "assetB": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
}
```

**Errors:**

- `400`: Invalid input or pool state (e.g., empty pool, shares exceed total)
- `404`: Pool not found

---

#### POST `/liquidity-pools/watch` (Protected)

Add a pool to your watchlist. Requires authentication.

**Request Body:**

```json
{
  "poolId": "a468d41d61e...",
  "assetA": "XLM",
  "assetB": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "label": "My XLM/USDC Pool",
  "network": "testnet"
}
```

**Response (201):**

```json
{
  "id": "uuid",
  "poolId": "a468d41d61e...",
  "network": "testnet",
  "assetA": "XLM",
  "assetB": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "label": "My XLM/USDC Pool",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Errors:**

- `400`: Invalid input or pool does not exist
- `401`: Authentication required

---

#### POST `/liquidity-pools/unwatch` (Protected)

Remove a pool from your watchlist. Requires authentication.

**Request Body:**

```json
{
  "id": "uuid"
}
```

**Response (204):** No content

**Errors:**

- `401`: Authentication required
- `404`: Watched pool not found

---

#### GET `/liquidity-pools/watched` (Protected)

Get your watched pools. Requires authentication.

**Response (200):**

```json
[
  {
    "id": "uuid",
    "poolId": "a468d41d61e...",
    "network": "testnet",
    "assetA": "XLM",
    "assetB": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "label": "My XLM/USDC Pool",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
]
```

**Errors:**

- `401`: Authentication required

---

### Multisig (Signer Weights & Thresholds)

#### GET `/multisig/limits`

Publishes the bounds `POST /multisig/simulate` accepts, so a client can validate a form before a round trip rather than after a 400 (Savitura/Savitools#352).

**Request:**

```bash
curl "http://localhost:3001/api/v1/multisig/limits"
```

**Response (200):**

```json
{
  "maxSigners": 21,
  "maxSignerWeight": 255,
  "maxThreshold": 255,
  "operationThresholds": [
    { "kind": "low", "gates": "Trustline and offer operations" },
    { "kind": "medium", "gates": "Payments and path payments" },
    { "kind": "high", "gates": "Account settings and clawbacks" }
  ]
}
```

`maxSigners` is 21 because SEP-0023 allows 20 additional signers plus the master key, and a request may describe the master key too. `maxSignerWeight` and `maxThreshold` are 255 because that is the `uint8` the XDR uses.

---

#### POST `/multisig/simulate`

Evaluate a weighted multisig against the signatures collected so far.

A Stellar multisig is not "2 of 3 signers" — it is any subset of signers whose weights total at least the threshold. This endpoint answers what that collected weight authorises, which weight classes are cleared, which signers are still outstanding, and which configuration risks apply.

**Request body:**

- `threshold` (required): the weight the operation needs, `0`–`255`. This is the account's `medium` threshold, which gates payments and path payments
- `signers` (required): 1–21 entries, each with:
  - `key` (required): a `G…` account id
  - `weight` (required): `0`–`255`
  - `signed` (optional, default `false`): whether a signature from this signer is collected
  - `required` (optional, default `false`): a master-weight-0 required signer. Its weight must be `0`
- `lowThreshold` / `highThreshold` (optional): the `low` and `high` weight classes. Both default to `threshold`, which is what Stellar itself defaults them to
- `minTime` / `maxTime` (optional): the transaction validity window, as unix seconds or an ISO 8601 timestamp. Omit or send an empty value for "unbounded"

**Request:**

```bash
curl -X POST "http://localhost:3001/api/v1/multisig/simulate" \
  -H "content-type: application/json" \
  -d '{
    "threshold": 2,
    "lowThreshold": 1,
    "highThreshold": 3,
    "signers": [
      { "key": "GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ", "weight": 2, "signed": true },
      { "key": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", "weight": 1, "signed": false },
      { "key": "GBRPYHIL3CI3FNQ4BXNFMNDLFJUNSU2HY3ZMFSLONUCEOASW7QC7OX2H", "weight": 1, "signed": false }
    ]
  }'
```

**Response (200):**

```json
{
  "threshold": 2,
  "lowThreshold": 1,
  "mediumThreshold": 2,
  "highThreshold": 3,
  "totalWeight": 4,
  "signedWeight": 2,
  "deficit": 0,
  "surplus": 0,
  "progressPercent": 100,
  "satisfied": true,
  "canSubmit": true,
  "signers": [
    {
      "key": "GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ",
      "weight": 2,
      "signed": true,
      "required": false,
      "shareOfTotalPercent": 50,
      "shareOfThresholdPercent": 100,
      "controlsAccount": true,
      "indispensable": true,
      "redundant": false
    }
  ],
  "operationThresholds": [
    { "kind": "low", "requiredWeight": 1, "collectedWeight": 2, "deficit": 0, "cleared": true },
    { "kind": "medium", "requiredWeight": 2, "collectedWeight": 2, "deficit": 0, "cleared": true },
    { "kind": "high", "requiredWeight": 3, "collectedWeight": 2, "deficit": 1, "cleared": false }
  ],
  "outstandingRequiredSigners": [],
  "minimumSignersNeeded": [],
  "minimumSetWeight": 0,
  "duplicateSigners": [],
  "risks": [
    {
      "code": "SINGLE_SIGNER_CONTROLS",
      "severity": "warning",
      "message": "Signer weight 2 alone reaches the threshold of 2.",
      "signers": ["GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ"]
    }
  ],
  "timeBounds": {
    "minTime": null,
    "maxTime": null,
    "notYetActive": false,
    "expired": false,
    "invalid": false
  }
}
```

**Field notes:**

- `satisfied` is `signedWeight >= threshold`. `canSubmit` additionally requires every `required` signer to have signed — a missing required signer blocks the account regardless of collected weight.
- `progressPercent` is `min(signedWeight / threshold, 1)`, and is `100` when the threshold is `0`.
- `minimumSignersNeeded` is the **smallest** set of outstanding signers that reaches the threshold, chosen on fewest signers and then the tightest fit, so the answer never commits more weight than the quorum needs. It is `null` when no combination of the remaining signers is enough. `null` and `[]` are therefore different answers: unreachable versus already satisfied.
- `indispensable`/`redundant` describe the configured signer set — what happens if that key is removed — while `minimumSignersNeeded` answers who still has to sign.
- `duplicateSigners` lists keys that appear more than once. The totals include them because the request did, but Stellar counts each key once; the finding is reported rather than silently deduplicated.

**Risk codes:**

| Code                             | Severity | Meaning                                                                                    |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `THRESHOLD_ZERO`                 | critical | A threshold of 0 authorises the operation without any signature                            |
| `THRESHOLD_UNREACHABLE`          | critical | No signer carries weight, so no signature set can reach a threshold of 1 or more           |
| `THRESHOLD_ABOVE_TOTAL_WEIGHT`   | critical | Total weight is below the threshold                                                        |
| `REQUIRED_SIGNER_UNSIGNED`       | critical | A required signer has not signed, so the account cannot be modified                        |
| `SINGLE_SIGNER_CONTROLS`         | warning  | One signer's weight alone reaches the threshold                                            |
| `REQUIRES_EVERY_SIGNER`          | warning  | Removing any weighted signer drops the account below the threshold                         |
| `QUORUM_SINGLE_POINT_OF_FAILURE` | warning  | One outstanding signature completes the quorum, so that signer can stall the account alone |
| `DUPLICATE_SIGNER`               | warning  | The same key appears more than once                                                        |
| `ZERO_WEIGHT_SIGNERS`            | info     | Zero-weight signers are recorded but add no weight                                         |
| `REDUNDANT_SIGNER`               | info     | These signers could be dropped without weakening the quorum                                |

**Limits:**

- `signers`: 1–21 entries
- `weight`, `threshold`, `lowThreshold`, `highThreshold`: integers `0`–`255`
- `minTime`/`maxTime`: unix seconds or ISO 8601; `minTime` must not be after `maxTime`

**Errors:**

- `400`: weight or threshold outside `0`–`255`, more than 21 signers, a `required` signer carrying weight, a window that closes before it opens, or an unreadable timestamp
- `429`: global rate limit exceeded

**Operational notes:**

- The call is stateless: nothing is fetched and nothing is stored. The same request always yields the same answer, so it is safe to try configurations that do not exist.
- `POST` answers `200`, not `201`: nothing is created.

---

### Composer (Transaction Building)

#### GET `/composer/operations`

List all supported operation types with field schemas.

**Request:**

```bash
curl http://localhost:3001/api/v1/composer/operations
```

**Response (200):**

```json
{
  "operations": [
    {
      "type": "payment",
      "description": "Send an asset to another account",
      "fields": [
        {
          "name": "destination",
          "type": "string",
          "description": "Destination account public key",
          "required": true
        },
        {
          "name": "asset",
          "type": "object",
          "description": "Asset to send"
        },
        {
          "name": "amount",
          "type": "string",
          "description": "Amount to send"
        }
      ]
    },
    {
      "type": "path_payment_strict_send",
      "description": "Send an asset via a specific path",
      "fields": [...]
    }
  ]
}
```

---

#### POST `/composer/build`

Build a multi-op transaction and return unsigned XDR envelope.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/composer/build \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAccount": {
      "publicKey": "GBZR7...",
      "sequence": "1234567890"
    },
    "fee": "300",
    "operations": [
      {
        "type": "payment",
        "destination": "GBUQWP...",
        "asset": "native",
        "amount": "10.00"
      }
    ],
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "xdr": "AAAAAgAAAAB+Ht3sW...",
  "hash": "5fa...",
  "envelope_type": "ENVELOPE_TYPE_TX"
}
```

**Errors:**

- `400`: Invalid transaction parameters

---

#### POST `/composer/simulate`

Dry-run an XDR transaction against Horizon; returns fee and result codes.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/composer/simulate \
  -H "Content-Type: application/json" \
  -d '{
    "xdr": "AAAAAgAAAAB+Ht3sW...",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "resultXdr": "...",
  "fee": "300",
  "resultCode": "txSUCCESS",
  "operationResults": [
    {
      "code": "opSUCCESS"
    }
  ]
}
```

**Errors:**

- `400`: Invalid XDR or simulation failed

---

### Inspector (Transaction & XDR Inspection)

#### GET `/inspector/tx/:hash`

Fetch, decode, and inspect a Stellar transaction by hash.

**Query Parameters:**

- `network` (optional, default `testnet`): `testnet` or `mainnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/inspector/tx/5fa1f6d8a7c..."
```

**Response (200):**

```json
{
  "hash": "5fa1f6d8a7c...",
  "ledger": 12345,
  "createdAt": "2024-06-21T12:34:56Z",
  "sourceAccount": "GBZR7...",
  "sequenceNumber": "1234567890",
  "feeCharged": "300",
  "maxFee": "300",
  "memo": null,
  "memoType": "none",
  "timeBounds": null,
  "signatures": ["..."],
  "success": true,
  "resultCode": "tx_success",
  "resultExplanation": "The transaction was code-path complete and succeeded.",
  "operationCount": 1,
  "operations": [
    {
      "type": "payment",
      "fields": {
        "destination": "GBUQWP...",
        "amount": "10.00",
        "asset": "XLM"
      },
      "index": 0,
      "resultCode": "op_success",
      "resultExplanation": "The payment operation succeeded.",
      "success": true,
      "effects": []
    }
  ],
  "rawJson": {},
  "network": "testnet",
  "composerPayload": {}
}
```

**Errors:**

- `404`: Transaction not found

---

#### GET `/inspector/tx/:hash/export`

Export a transaction breakdown as CSV (UTF-8 BOM included for Excel compatibility).

**Query Parameters:**

- `network` (optional, default `testnet`): `testnet` or `mainnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/inspector/tx/5fa1f6d8a7c.../export?network=testnet"
```

**Response (200):** `text/csv` attachment

```
hash,network,ledger,created_at,source_account,sequence_number,fee_charged,max_fee,memo,memo_type,success,result_code,result_explanation,operation_index,operation_type,operation_label,operation_source,operation_result_code,operation_success,operation_effects,operation_fields
```

**Errors:**

- `404`: Transaction not found

---

#### GET `/inspector/account/:publicKey/txs`

Get the last 20 transactions for a Stellar account.

**Query Parameters:**

- `network` (optional, default `testnet`): `testnet` or `mainnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/inspector/account/GBZR7.../txs"
```

**Response (200):**

```json
[
  {
    "hash": "5fa1f6d8a7c...",
    "createdAt": "2024-06-21T12:34:56Z",
    "operationCount": 1,
    "feeCharged": "300",
    "success": true,
    "resultCode": "tx_success"
  }
]
```

**Errors:**

- `404`: Account not found

---

#### POST `/inspector/decode-xdr`

Decode raw Stellar XDR envelope (offline, no Horizon network call required).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/inspector/decode-xdr \
  -H "Content-Type: application/json" \
  -d '{
    "xdr": "AAAAAgAAAAB+Ht3sW...",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "hash": "5fa1f6d8a7c...",
  "ledger": 0,
  "createdAt": "",
  "sourceAccount": "GBZR7...",
  "sequenceNumber": "1234567890",
  "feeCharged": "0",
  "maxFee": "300",
  "memo": null,
  "memoType": "none",
  "timeBounds": null,
  "signatures": ["..."],
  "success": true,
  "resultCode": "tx_success",
  "resultExplanation": "Transaction decoded from XDR — not yet submitted.",
  "operationCount": 1,
  "operations": [
    {
      "type": "payment",
      "fields": {
        "destination": "GBUQWP...",
        "amount": "10.00",
        "asset": "XLM"
      },
      "index": 0,
      "resultCode": null,
      "resultExplanation": null,
      "success": true,
      "effects": []
    }
  ],
  "rawJson": null,
  "network": "testnet",
  "composerPayload": {}
}
```

**Errors:**

- `400`: Invalid XDR

---

#### POST `/inspector/strkey/validate`

Validate a batch of Stellar StrKeys offline (no Horizon call). Every value is trimmed and validated independently, so one malformed value never fails the request.

**Limits:** `inputs` must hold 1–500 strings of at most 256 characters each; anything else is rejected with `400`. The global rate limit applies.

**Supported prefixes:** `G` (`ed25519_public_key`), `S` (`ed25519_secret_seed`), `M` (`muxed_account`), `T` (`pre_auth_tx`), `X` (`sha256_hash`), `P` (`signed_payload`), `C` (`contract`).

**Privacy:** values that look like secret seeds (`S…`, any case) are masked in the response (`S****…ABCD`, `redacted: true`), and seeds or JWTs embedded in other text are replaced with `[REDACTED]`. Inputs are not stored or logged. Prefer the browser-only StrKey lab for real secret seeds.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/inspector/strkey/validate \
  -H "Content-Type: application/json" \
  -d '{ "inputs": ["GBZR7...", "gbzr7...", "CAAAA..."] }'
```

**Response (200):**

```json
{
  "summary": { "total": 3, "valid": 2, "invalid": 1 },
  "results": [
    {
      "index": 0,
      "input": "GBZR7...",
      "redacted": false,
      "valid": true,
      "keyType": "ed25519_public_key",
      "error": null
    },
    {
      "index": 1,
      "input": "gbzr7...",
      "redacted": false,
      "valid": false,
      "keyType": null,
      "error": {
        "code": "invalid_characters",
        "message": "StrKeys use only upper-case A-Z and digits 2-7 (base32)"
      }
    },
    {
      "index": 2,
      "input": "CAAAA...",
      "redacted": false,
      "valid": true,
      "keyType": "contract",
      "error": null
    }
  ]
}
```

`keyType` is the type implied by the prefix (also on invalid rows), or `null` for an unknown prefix. `error.code` is one of `empty`, `invalid_characters`, `unknown_prefix`, `invalid_length`, `invalid_checksum`.

**Errors:**

- `400`: `inputs` missing, empty, longer than 500 items, or containing a non-string / over-long value

---

#### POST `/inspector/strkey/validate/export`

Same request body and validation as `/inspector/strkey/validate`; responds with a `text/csv` attachment (`strkey-validation.csv`, UTF-8 BOM for Excel, `Cache-Control: no-store`). One row per input in request order. Secret seeds are masked exactly as in the JSON response, and inputs a spreadsheet would treat as a formula (leading `=`, `+`, `-`, `@`) are prefixed with `'`.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/inspector/strkey/validate/export \
  -H "Content-Type: application/json" \
  -d '{ "inputs": ["GBZR7...", "gbzr7..."] }' \
  -o strkey-validation.csv
```

**Response (200):** `text/csv` attachment

```
index,input,valid,key_type,error_code,error_message
0,GBZR7...,true,ed25519_public_key,,
1,gbzr7...,false,,invalid_characters,StrKeys use only upper-case A-Z and digits 2-7 (base32)
```

**Errors:**

- `400`: same as `/inspector/strkey/validate`

---

### Network

#### GET `/network/status?network=mainnet`

Get current Stellar network status and fees.

**Query Parameters:**

- `network` (optional, default `mainnet`): `mainnet` or `testnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/network/status?network=testnet"
```

**Response (200):**

```json
{
  "network": "testnet",
  "baseFee": 100,
  "baseReserve": 0.5,
  "protocolVersion": 21,
  "timestamp": "2024-06-21T12:34:56Z"
}
```

---

#### GET `/network/status/history?network=mainnet`

Get last 60 minutes of network status history.

**Query Parameters:**

- `network` (optional, default `mainnet`): `mainnet` or `testnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/network/status/history?network=testnet"
```

**Response (200):**

```json
{
  "network": "testnet",
  "history": [
    {
      "timestamp": "2024-06-21T11:34:56Z",
      "baseFee": 100,
      "baseReserve": 0.5
    },
    {
      "timestamp": "2024-06-21T12:34:56Z",
      "baseFee": 100,
      "baseReserve": 0.5
    }
  ]
}
```

---

### Contracts (Soroban)

#### GET `/contracts/events`

Fetch and decode Soroban events for a contract. This read-only endpoint does not require authentication.

**Query parameters:** `contractId` (required), `network` (`testnet` or `mainnet`, default `testnet`), `type` (`contract`, `system`, or `diagnostic`), `startLedger` or `cursor` (mutually exclusive), `endLedger`, and `limit` (1–200).

#### POST `/contracts/events/filter`

Filter decoded events in memory. The request accepts up to 1,000 events and 10 criteria. Criteria are ANDed. Text criteria (`topic_contains`, `value_type_is`, `value_equals`) require a non-empty `value` of at most 256 characters. A `ledger_range` requires `from` or `to`; supplied bounds must be non-negative safe integers and `from` must not exceed `to`. Invalid criteria return `400`.

```json
{
  "events": [],
  "criteria": [
    { "kind": "topic_contains", "value": "transfer" },
    { "kind": "ledger_range", "from": 100, "to": 200 }
  ]
}
```

#### POST `/contracts/events/replay`

Replay filtered events to a webhook. This endpoint requires authentication; URLs are checked against SSRF protections. See the [Contract Events guide](contract-events.md).

#### POST `/contracts/deploy`

Deploy a Soroban smart contract from a WASM file.

**Request (multipart/form-data):**

```bash
curl -X POST http://localhost:3001/api/v1/contracts/deploy \
  -F "file=@contract.wasm" \
  -F "args=[\"arg1\",\"arg2\"]"
```

**Response (200):**

```json
{
  "contractId": "CABC...",
  "deployTransactionHash": "5fa1f6d...",
  "wasmHash": "9e5551...",
  "network": "testnet"
}
```

**Errors:**

- `400`: Invalid WASM file or deployment failed

---

#### POST `/contracts/:contractId/invoke`

Invoke a contract function.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/contracts/CABC.../invoke \
  -H "Content-Type: application/json" \
  -d '{
    "functionName": "transfer",
    "args": ["GBU...", "100.00"]
  }'
```

**Response (200):**

```json
{
  "result": "...",
  "transactionHash": "5fa1f6d..."
}
```

**Errors:**

- `400`: Invalid contract ID or parameters

---

#### GET `/contracts/:contractId/info`

Get contract metadata from the network.

**Request:**

```bash
curl http://localhost:3001/api/v1/contracts/CABC.../info
```

**Response (200):**

```json
{
  "contractId": "CABC...",
  "wasmHash": "9e5551...",
  "createdLedger": 12345,
  "createdAt": "2024-06-21T12:34:56Z"
}
```

**Errors:**

- `404`: Contract not found

---

### Webhooks

#### GET `/webhooks/templates`

List all supported webhook event types with schemas and sample payloads.

**Request:**

```bash
curl http://localhost:3001/api/v1/webhooks/templates
```

**Response (200):**

```json
[
  {
    "eventType": "transaction.submitted",
    "description": "Emitted when a transaction is submitted",
    "schema": {},
    "samplePayload": {}
  }
]
```

---

---

#### POST `/webhooks/send`

Send a webhook payload to a target endpoint. Requires authentication.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/webhooks/send \
  -H "Content-Type: application/json" \
  --cookie "savitools_access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "endpointUrl": "https://example.com/webhook",
    "eventType": "transaction.submitted",
    "payload": {}
  }'
```

**Response (201):** a `WebhookHistoryEntry` (see `/webhooks/history`).

```json
{
  "id": "1f0c...",
  "eventType": "transaction.submitted",
  "endpointUrl": "https://example.com/webhook",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json"
  },
  "payload": {},
  "responseStatus": 200,
  "responseBody": "ok",
  "latencyMs": 250,
  "timestamp": 1717243200000
}
```

`signature.body` is byte-for-byte the request body that was sent and signed, so a receiver (or
the Webhook Tester UI) can recompute the identical HMAC from `signature.timestamp` and
`signature.body` without guessing the serialisation. The signature value in
`requestHeaders` is redacted before storage; `signature.signature` carries the value that went
on the wire.

**Errors:**

- `400`: Invalid webhook payload or an unsafe destination
- `502`: Request payload exceeds the size limit, or the destination failed

---

#### GET `/webhooks/history`

Get the last 50 webhook send attempts. Requires authentication.

**Request:**

```bash
curl http://localhost:3001/api/v1/webhooks/history \
  --cookie "savitools_access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
[
  {
    "id": "1f0c...",
    "eventType": "transaction.submitted",
    "endpointUrl": "https://example.com/webhook",
    "method": "POST",
    "requestHeaders": {"X-SaviTools-Timestamp": "1717243200"},
    "payload": {...},
    "statusCode": 200,
    "responseStatus": 200,
    "responseBody": "ok",
    "latencyMs": 250,
    "timestamp": 1717243200000
  }
]
```

Entries recorded under the legacy body-only signing format are returned with
`"legacySignature": true`.

---

#### POST `/webhooks/replay/:id`

Replay a previous webhook send attempt. Requires authentication.

The stored secret-shaped headers are redacted and cannot be reconstructed, so the replay is
signed afresh with the deployment-wide `WEBHOOK_SIGNING_SECRET` (or sent unsigned if none is
configured). Any recorded signing header is dropped first, so the replay never carries a
timestamp that disagrees with the signature beside it.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/webhooks/replay/1f0c... \
  --cookie "savitools_access_token=YOUR_ACCESS_TOKEN"
```

**Response (201):** a new `WebhookHistoryEntry`, as returned by `/webhooks/send`.

**Errors:**

- `404`: Webhook attempt not found

---

### Playground (API Proxy & Key Management)

#### GET `/playground/spec/:provider`

Fetch and cache an OpenAPI spec for a provider (requires authentication).

**Request:**

```bash
curl http://localhost:3001/api/v1/playground/spec/stripe \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
{
  "provider": "stripe",
  "spec": {...}
}
```

**Errors:**

- `404`: Provider spec not found
- `401`: Not authenticated

---

#### POST `/playground/proxy`

Proxy a request to the target API with server-side auth (requires authentication).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/playground/proxy \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "provider": "stripe",
    "method": "GET",
    "path": "/v1/customers",
    "params": {}
  }'
```

**Response (200):**

```json
{
  "statusCode": 200,
  "body": {...}
}
```

---

#### POST `/playground/keys`

Save an encrypted API key (requires authentication).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/playground/keys \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "provider": "stripe",
    "key": "sk_live_..."
  }'
```

**Response (201):**

```json
{
  "id": "key-123",
  "provider": "stripe",
  "keyMasked": "sk_live_...***"
}
```

---

#### GET `/playground/keys`

List stored API keys (masked, requires authentication).

**Request:**

```bash
curl http://localhost:3001/api/v1/playground/keys \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
{
  "keys": [
    {
      "id": "key-123",
      "provider": "stripe",
      "keyMasked": "sk_live_...***"
    }
  ]
}
```

---

#### PUT `/playground/keys/:id`

Update a stored API key (requires authentication).

**Request:**

```bash
curl -X PUT http://localhost:3001/api/v1/playground/keys/key-123 \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "key": "sk_live_new..."
  }'
```

**Response (200):**

```json
{
  "id": "key-123",
  "keyMasked": "sk_live_...***"
}
```

---

#### DELETE `/playground/keys/:id`

Delete a stored API key (requires authentication).

**Request:**

```bash
curl -X DELETE http://localhost:3001/api/v1/playground/keys/key-123 \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (204):**
No content

---

### Workspaces (User State Persistence)

#### GET `/workspaces/:tool`

Get persisted tool state for the current user (requires authentication).

**Path Parameters:**

- `tool`: `sandbox` | `inspector` | `webhooks` | `composer`

**Request:**

```bash
curl http://localhost:3001/api/v1/workspaces/composer \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
{
  "tool": "composer",
  "data": {...}
}
```

**Errors:**

- `400`: Invalid tool name
- `401`: Not authenticated

---

#### PUT `/workspaces/:tool`

Save tool state for the current user (requires authentication).

**Request:**

```bash
curl -X PUT http://localhost:3001/api/v1/workspaces/composer \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "data": {...}
  }'
```

**Response (200):**

```json
{
  "tool": "composer",
  "data": {...}
}
```

---

### Monitors (Account & Contract Watches)

#### POST `/monitor/watches`

Create a watch for an account or contract (requires authentication).

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/monitor/watches \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "address": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C",
    "type": "account",
    "label": "My Account",
    "network": "testnet"
  }'
```

**Response (201):**

```json
{
  "id": "watch-123",
  "address": "GBZR7...",
  "type": "account",
  "label": "My Account"
}
```

---

#### GET `/monitor/watches`

Get all watches for the current user (requires authentication).

**Request:**

```bash
curl http://localhost:3001/api/v1/monitor/watches \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
{
  "watches": [
    {
      "id": "watch-123",
      "address": "GBZR7...",
      "type": "account",
      "label": "My Account"
    }
  ]
}
```

---

#### DELETE `/monitor/watches/:id`

Delete a watch (requires authentication).

**Request:**

```bash
curl -X DELETE http://localhost:3001/api/v1/monitor/watches/watch-123 \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (204):**
No content

---

#### GET `/monitor/watches/:id/alerts`

Get alerts for a watch (requires authentication).

**Request:**

```bash
curl http://localhost:3001/api/v1/monitor/watches/watch-123/alerts \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
[
  {
    "id": "alert-456",
    "watchId": "watch-123",
    "conditionType": "balance_threshold"
  }
]
```

---

#### GET `/monitor/search`

Search watch events across the current user's watches (requires authentication). Accepts the same filters as the CSV export endpoint.

**Query Parameters:**

- `watchId` (optional): Restrict to a single watch
- `eventType` (optional): `transaction`, `payment`, or `contract`
- `q` (optional): Free-text search across event payloads (hashes, accounts, assets)
- `from` (optional): ISO date — events at or after this time
- `to` (optional): ISO date — events at or before this time
- `page` (optional, default `1`)
- `limit` (optional, default `25`, max `100`)

**Request:**

```bash
curl "http://localhost:3001/api/v1/monitor/search?eventType=payment&q=GBZR7...&limit=50" \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**

```json
{
  "items": [
    {
      "id": "...",
      "watchId": "...",
      "eventType": "payment",
      "payload": {},
      "occurredAt": "2026-08-31T12:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 1
}
```

---

#### GET `/monitor/search/export`

Export monitor search results as CSV (requires authentication). Accepts the exact same query parameters as `GET /monitor/search`. The response is a `text/csv` attachment with a UTF-8 BOM; large result sets are streamed in chunks and capped at `10000` rows.

**Request:**

```bash
curl "http://localhost:3001/api/v1/monitor/search/export?eventType=payment&limit=10000" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -o monitor-search.csv
```

**Response (200):** `text/csv` attachment

```
event_type,occurred_at,amount,asset,from,to,transaction_hash,paging_token,watch_id,payload
```

---

### SDK Generation

#### POST `/sdkgen/generate`

Generate SDK code from a provider spec.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sdkgen/generate \
  -H "Content-Type: application/json" \
  -d '{
    "spec": "fluxa",
    "language": "typescript",
    "endpoint": "https://api.example.com"
  }'
```

**Response (200):**

```json
{
  "code": "// Generated TypeScript SDK\nimport axios from 'axios';\n..."
}
```

---

## Error Reference

### Common HTTP Status Codes

| Code  | Meaning               | When It Occurs                                  |
| ----- | --------------------- | ----------------------------------------------- |
| `200` | OK                    | Successful GET, POST, or PUT request            |
| `201` | Created               | Successful resource creation (POST)             |
| `204` | No Content            | Successful DELETE request                       |
| `400` | Bad Request           | Invalid request parameters or validation failed |
| `401` | Unauthorized          | Missing or invalid authentication token         |
| `404` | Not Found             | Resource does not exist                         |
| `422` | Unprocessable Entity  | Semantic error in request (e.g., invalid WASM)  |
| `500` | Internal Server Error | Unexpected server error                         |

### SaviTools-Specific Errors

#### `400 Bad Request - Invalid Public Key`

**Meaning:** The Stellar public key provided is malformed or invalid.
**Suggested Resolution:** Verify the public key format (starts with `G`, 56 characters). Use `/wallet/generate` if unsure.

#### `400 Bad Request - Insufficient Balance`

**Meaning:** The source account doesn't have enough native asset to cover the transaction fee and amount.
**Suggested Resolution:** Use `/wallet/fund` to add testnet funds, or send a smaller amount.

#### `401 Unauthorized - Invalid Credentials`

**Meaning:** Email/password combination is incorrect.
**Suggested Resolution:** Double-check your email and password. Register a new account if needed.

#### `401 Unauthorized - Expired Token`

**Meaning:** Your access token has expired (default 15 minutes).
**Suggested Resolution:** Call `POST /auth/refresh` with your refresh token to get a new access token.

#### `404 Not Found - Transaction Not Found`

**Meaning:** The specified transaction hash doesn't exist on the network.
**Suggested Resolution:** Verify the transaction hash is correct and the network (mainnet/testnet) is correct.

#### `422 Unprocessable Entity - Invalid WASM`

**Meaning:** The uploaded file is not a valid Soroban WASM binary.
**Suggested Resolution:** Ensure the file is a compiled `.wasm` file from a Soroban contract.

### Stellar/Horizon Pass-Through Errors

SaviTools proxies some errors directly from the Stellar Horizon API. These errors include:

- **`op_no_trust`**: Destination account doesn't have a trustline for the asset
- **`op_line_full`**: Destination account's limit for the asset is at max
- **`op_underfunded`**: Source account doesn't have enough funds
- **`tx_bad_seq`**: Transaction sequence number is incorrect
- **`tx_bad_auth`**: Transaction hasn't been signed by the required signers

**Example Horizon Error Response:**

```json
{
  "type": "https://stellar.org/horizon-errors/transaction-failed",
  "title": "Transaction Failed",
  "status": 400,
  "detail": "...",
  "extras": {
    "envelope_xdr": "...",
    "result_xdr": "...",
    "result_codes": {
      "transaction": "tx_failed",
      "operations": ["op_no_trust"]
    }
  }
}
```

For a complete list, refer to the [Stellar Horizon API documentation](http://web.archive.org/web/20210613121751/https://developers.stellar.org/api/errors/).

---

## Caching Behavior

Caching is not currently implemented in the API; all requests are processed dynamically against upstream services and databases.

---

## Rate Limiting

**Current Status:** Rate limiting is enforced globally across all endpoints via NestJS ThrottlerGuard according to application configuration.

---

## CORS & Security

- **CORS Origin:** Controlled by `WEB_ORIGIN` environment variable (default: `http://localhost:3000`)
- **HTTPS:** Enforced in production; cookies marked with `Secure` flag
- **Session Security:** HTTP-only cookies store authentication tokens securely.
- **Input Validation:** All inputs are validated and sanitized server-side

---

## Support & Feedback

- **API Status:** [Check Stellar Horizon Status](https://dashboard.stellar.org/)
- **Bug Reports:** [GitHub Issues](https://github.com/Savitura/Savitools/issues)
- **Questions:** Refer to [Stellar Docs](https://developers.stellar.org/)

---

### SEP-10 Web Authentication Debugger

#### POST `/sep10/fetch-challenge`

Fetches an authentication challenge from a SEP-10 server.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sep10/fetch-challenge \
  -H "Content-Type: application/json" \
  -d '{
    "webAuthEndpoint": "https://testanchor.stellar.org/auth",
    "clientAccountId": "GABC...",
    "homeDomain": "testanchor.stellar.org"
  }'
```

**Response (200):**

```json
{
  "transaction": "AAAAAgAAAA...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "parsed": {
    "source": "GABC...",
    "sequence": "0"
  }
}
```

---

#### POST `/sep10/validate-challenge`

Validates a SEP-10 challenge transaction.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sep10/validate-challenge \
  -H "Content-Type: application/json" \
  -d '{
    "challengeXdr": "AAAAAgAAAA...",
    "serverSigningKey": "GABC...",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "isValid": true,
  "clientAccountId": "GABC...",
  "timeBounds": {
    "minTime": "1234567890",
    "maxTime": "1234567990",
    "isValid": true
  },
  "issues": []
}
```

---

#### POST `/sep10/sign-challenge`

Signs a challenge transaction with a keypair.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sep10/sign-challenge \
  -H "Content-Type: application/json" \
  -d '{
    "challengeXdr": "AAAAAgAAAA...",
    "signerSecretKey": "SABC...",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "signedTransaction": "AAAAAgAAAA..."
}
```

---

#### POST `/sep10/token-exchange`

Exchanges a signed challenge for a JWT token.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sep10/token-exchange \
  -H "Content-Type: application/json" \
  -d '{
    "webAuthEndpoint": "https://testanchor.stellar.org/auth",
    "signedChallengeXdr": "AAAAAgAAAA..."
  }'
```

**Response (200):**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### Soroban Contract Storage Explorer

#### POST `/soroban-storage/query`

Queries contract storage for a specific key.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/soroban-storage/query \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "CABC...",
    "key": "balance",
    "network": "testnet",
    "keyType": "symbol"
  }'
```

**Response (200):**

```json
{
  "key": "balance",
  "value": {
    "type": "u128",
    "value": "1000000"
  },
  "lastModified": 12345
}
```

---

#### POST `/soroban-storage/compare`

Compares storage between two contracts.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/soroban-storage/compare \
  -H "Content-Type: application/json" \
  -d '{
    "contractId1": "CABC...",
    "contractId2": "CDEF...",
    "key": "balance",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "key": "balance",
  "contract1": {
    "value": { "type": "u128", "value": "1000000" },
    "exists": true
  },
  "contract2": {
    "value": { "type": "u128", "value": "2000000" },
    "exists": true
  },
  "differences": [...]
}
```

---

#### POST `/soroban-storage/typed-key`

Generates a properly typed storage key.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/soroban-storage/typed-key \
  -H "Content-Type: application/json" \
  -d '{
    "keyType": "map",
    "keyComponents": [
      { "type": "symbol", "value": "balances" },
      { "type": "address", "value": "GABC..." }
    ]
  }'
```

**Response (200):**

```json
{
  "key": "AAAADwAAAAhiYWxhbmNlcwAAAAEAAAATAAAA...",
  "components": [...]
}
```

---

### Stellar.toml Editor

#### POST `/stellar-toml/parse`

Parses and validates stellar.toml content.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/stellar-toml/parse \
  -H "Content-Type: application/json" \
  -d '{
    "content": "VERSION=\"2.0.0\"\nNETWORK_PASSPHRASE=\"Test SDF Network ; September 2015\"",
    "strict": true
  }'
```

**Response (200):**

```json
{
  "parsed": {
    "VERSION": "2.0.0",
    "NETWORK_PASSPHRASE": "Test SDF Network ; September 2015"
  },
  "issues": [],
  "isValid": true
}
```

---

#### POST `/stellar-toml/format`

Formats stellar.toml content.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/stellar-toml/format \
  -H "Content-Type: application/json" \
  -d '{
    "content": "VERSION=\"2.0.0\"\n[DOCUMENTATION]\nORG_NAME=\"Example\"",
    "indent": "spaces",
    "indentSize": 2
  }'
```

**Response (200):**

```json
{
  "formatted": "VERSION = \"2.0.0\"\n\n[DOCUMENTATION]\nORG_NAME = \"Example\""
}
```

---

#### POST `/stellar-toml/validate`

Validates stellar.toml against SEP-1.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/stellar-toml/validate \
  -H "Content-Type: application/json" \
  -d '{
    "content": "VERSION=\"2.0.0\"",
    "level": "strict",
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "isValid": true,
  "issues": [...],
  "summary": {
    "errors": 0,
    "warnings": 1,
    "infos": 0
  }
}
```

---

#### GET `/stellar-toml/template`

Gets a pre-configured template.

**Query Parameters:**

- `type`: `minimal`, `anchor`, `issuer`, or `validator`

**Request:**

```bash
curl "http://localhost:3001/api/v1/stellar-toml/template?type=anchor"
```

**Response (200):**

```json
{
  "template": "VERSION=\"2.0.0\"\n..."
}
```

---

### Sequence Number Planner

#### GET `/sequence-planner/account-sequence`

Gets the current sequence number for an account.

**Query Parameters:**

- `account`: Account address
- `network`: `testnet` or `mainnet`

**Request:**

```bash
curl "http://localhost:3001/api/v1/sequence-planner/account-sequence?account=GABC...&network=testnet"
```

**Response (200):**

```json
{
  "account": "GABC...",
  "currentSequence": "12345",
  "nextSequence": "12346"
}
```

---

#### POST `/sequence-planner/validate-sequence`

Validates a proposed sequence number.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sequence-planner/validate-sequence \
  -H "Content-Type: application/json" \
  -d '{
    "account": "GABC...",
    "proposedSequence": 12346,
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "isValid": true,
  "currentSequence": "12345",
  "nextValidSequence": "12346",
  "gap": 0,
  "issues": ["Sequence number is valid and ready to use"]
}
```

---

#### POST `/sequence-planner/plan`

Plans sequences for multiple transactions with conflict detection.

**Request:**

```bash
curl -X POST http://localhost:3001/api/v1/sequence-planner/plan \
  -H "Content-Type: application/json" \
  -d '{
    "transactions": [
      {
        "id": "payment-1",
        "sourceAccount": "GABC...",
        "description": "Payment transaction"
      }
    ],
    "network": "testnet"
  }'
```

**Response (200):**

```json
{
  "plannedTransactions": [...],
  "conflicts": [],
  "accountSequences": [...],
  "summary": {
    "total": 1,
    "valid": 1,
    "conflicts": 0,
    "warnings": 0
  }
}
```

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "statusCode": 400,
  "message": "Error description",
  "error": "BadRequest"
}
```

Common status codes:

- `200`: Success
- `201`: Created
- `400`: Bad Request (invalid parameters)
- `401`: Unauthorized (authentication required)
- `404`: Not Found
- `500`: Internal Server Error

---

## Rate Limiting

The API enforces rate limiting via throttling:

- Default: 100 requests per 60 seconds per IP
- Configurable via `THROTTLE_LIMIT` and `THROTTLE_TTL` environment variables

Rate limit headers:

- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Time when the limit resets

---

## Support

For API support:

- Documentation: https://docs.savitools.dev
- GitHub Issues: https://github.com/your-org/savitools/issues
- Email: support@savitools.dev
