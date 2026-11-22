import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { WebhookMethod } from './webhook-method';

export type { WebhookMethod } from './webhook-method';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';

/**
 * API origin (without the `/api` suffix) for the few transports that cannot go
 * through `apiFetch` — currently the Socket.IO stream used by the Monitor
 * dashboard. Components must import this instead of reading
 * `process.env.NEXT_PUBLIC_API_URL` or hard-coding a host, so the API origin
 * stays in one place and the route-contract guard can keep it that way.
 */
export const API_ORIGIN = API_URL.replace(/\/api\/?$/, '');

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  fluxaTenantId: string | null;
}

interface ApiErrorBody {
  message?: string | string[];
  error?: string;
  /** Machine-readable rejection reason, e.g. CLAWBACK_NOT_ENABLED. */
  code?: string;
  /** Correlation id from the API exception envelope. */
  requestId?: string | null;
}

export type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'server'
  | 'unknown';

export interface ApiErrorOptions {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  cause?: unknown;
}

/**
 * Typed failure shared by every `apiFetch` caller.
 *
 * `message` is already safe to render: it comes from the API envelope (or a
 * client-side fallback), never from a raw response body. `requestId` is the
 * server correlation id and can be shown to support without leaking payloads.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = 'ApiError';
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable =
      options.kind === 'network' || options.kind === 'timeout' || options.kind === 'server';
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Default client-side deadline for an API request. */
export const DEFAULT_API_TIMEOUT_MS = 20_000;

export function classifyHttpStatus(status: number): ApiErrorKind {
  if (status === 408 || status === 504) return 'timeout';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}

function readMessage(body: ApiErrorBody, response: Response): string {
  if (Array.isArray(body.message)) return body.message.join(', ');
  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message;
  }
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  return response.statusText || `HTTP ${response.status}`;
}

function readRequestId(body: ApiErrorBody, response: Response): string | undefined {
  if (typeof body.requestId === 'string' && body.requestId.trim()) {
    return body.requestId;
  }
  const header = response.headers?.get?.('x-request-id');
  return header?.trim() || undefined;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  return new ApiError({
    kind: classifyHttpStatus(response.status),
    status: response.status,
    message: readMessage(body, response),
    code: typeof body.code === 'string' ? body.code : undefined,
    requestId: readRequestId(body, response),
  });
}

/** Normalise anything thrown by a transport into the shared taxonomy. */
export function normalizeApiError(error: unknown, fallback = 'Something went wrong'): ApiError {
  if (error instanceof ApiError) return error;

  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return new ApiError({
      kind: 'timeout',
      message: 'The request timed out. Please try again.',
      cause: error,
    });
  }

  if (error instanceof Error) {
    const text = `${error.name}: ${error.message}`;
    if (/timeout|timed out|abort/i.test(text)) {
      return new ApiError({
        kind: 'timeout',
        message: 'The request timed out. Please try again.',
        cause: error,
      });
    }
    if (
      error.name === 'NetworkError' ||
      /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(text)
    ) {
      return new ApiError({
        kind: 'network',
        message: 'Could not reach the API. Check your connection and try again.',
        cause: error,
      });
    }
    return new ApiError({
      kind: 'unknown',
      message: error.message || fallback,
      cause: error,
    });
  }

  return new ApiError({ kind: 'unknown', message: fallback, cause: error });
}

/** Render a typed error, including the safe server correlation id if present. */
export function apiErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const normalized = normalizeApiError(error, fallback);
  const message = normalized.message || fallback;
  return normalized.requestId ? `${message} (Request ID: ${normalized.requestId})` : message;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export interface ApiRequestInit extends RequestInit {
  /** Per-request deadline; defaults to `DEFAULT_API_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_API_TIMEOUT_MS, signal, ...requestInit } = init;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const headers = new Headers(requestInit.headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (!headers.has('x-request-id')) {
      headers.set('x-request-id', globalThis.crypto.randomUUID());
    }

    const response = await fetch(`${API_URL}/v1${path}`, {
      ...requestInit,
      credentials: 'include',
      signal: controller.signal,
      headers,
    });

    return await parseJson<T>(response);
  } catch (error) {
    if (timedOut) {
      throw new ApiError({
        kind: 'timeout',
        message: `The request timed out after ${timeoutMs}ms. Please try again.`,
        cause: error,
      });
    }
    throw normalizeApiError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadCsv(path: string, filename: string): Promise<void> {
  /**
   * Shared download helper: fetches an authenticated endpoint that responds
   * with a file attachment and triggers a browser download. Used by the monitor
   * CSV export and the inspector transaction export (see Savitura/Savitools#195).
   */
  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1${path}`, {
      credentials: 'include',
    });
  } catch (error) {
    throw normalizeApiError(error);
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function register(email: string, password: string) {
  return apiFetch<{ userId: string; message: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function verifyEmail(token: string) {
  return apiFetch<{ user: AuthUser }>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function login(email: string, password: string) {
  return apiFetch<{ user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function requestPasswordReset(email: string) {
  return apiFetch<{ message: string }>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(token: string, password: string) {
  return apiFetch<{ message: string }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

export async function logout() {
  return apiFetch<{ success: boolean }>('/auth/logout', { method: 'POST' });
}

export async function refreshSession() {
  return apiFetch<{ user?: AuthUser; authenticated?: false }>('/auth/refresh', {
    method: 'POST',
  });
}

export async function getCurrentUser() {
  return apiFetch<{ user: AuthUser | null }>('/auth/me');
}

export async function connectFluxa(apiKey: string) {
  return apiFetch<{ user: AuthUser }>('/auth/fluxa', {
    method: 'POST',
    body: JSON.stringify({ apiKey, confirmLink: true }),
  });
}

/* ─── Connected accounts ─────────────────────────────────────────────────── */

export interface ConnectedAccount {
  id: string;
  provider: string;
  connectedAt: string;
}

export async function listConnectedAccounts() {
  return apiFetch<ConnectedAccount[]>('/auth/connect');
}

export async function beginFluxaOAuth() {
  return apiFetch<{ redirectUrl: string }>('/auth/connect/fluxa', {
    method: 'POST',
  });
}

export async function disconnectProvider(provider: string) {
  return apiFetch<{ success: boolean }>(`/auth/connect/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
}

/* ─── API Key Vault ──────────────────────────────────────────────────────── */

export type VaultKeyProvider = 'fluxa' | 'crowdpay' | 'custom';

export interface VaultKey {
  id: string;
  name: string;
  provider: VaultKeyProvider;
  createdAt: string;
}

export async function listVaultKeys() {
  return apiFetch<VaultKey[]>('/vault/keys');
}

export async function createVaultKey(name: string, provider: VaultKeyProvider, key: string) {
  return apiFetch<VaultKey>('/vault/keys', {
    method: 'POST',
    body: JSON.stringify({ name, provider, key }),
  });
}

export async function deleteVaultKey(id: string) {
  return apiFetch<{ success: boolean }>(`/vault/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/* ─── Sessions ───────────────────────────────────────────────────────────── */

export interface Session {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export async function listSessions() {
  return apiFetch<Session[]>('/auth/sessions');
}

export async function revokeSession(id: string) {
  return apiFetch<{ success: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/* ─── Passkeys (WebAuthn) ────────────────────────────────────────────────── */

export interface PasskeyCredentialSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function reauthenticate(password: string) {
  return apiFetch<{ reauthToken: string; expiresIn: number }>('/auth/reauthenticate', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function beginPasskeyRegistration(reauthToken: string) {
  return apiFetch<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/auth/passkeys/register/options',
    {
      method: 'POST',
      body: JSON.stringify({ reauthToken }),
    },
  );
}

export async function verifyPasskeyRegistration(input: {
  reauthToken: string;
  name: string;
  registrationResponse: RegistrationResponseJSON;
  transports?: string[];
}) {
  return apiFetch<{
    passkey: { id: string; name: string; createdAt: string };
  }>('/auth/passkeys/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function beginPasskeyLogin(email?: string) {
  return apiFetch<{
    options: PublicKeyCredentialRequestOptionsJSON;
    allowCredentials?: Array<{ id: string }>;
  }>('/auth/passkeys/login/options', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function verifyPasskeyLogin(assertionResponse: AuthenticationResponseJSON) {
  return apiFetch<{ user: AuthUser }>('/auth/passkeys/login', {
    method: 'POST',
    body: JSON.stringify({ assertionResponse }),
  });
}

export async function listPasskeys() {
  return apiFetch<PasskeyCredentialSummary[]>('/auth/passkeys');
}

export async function renamePasskey(id: string, name: string, reauthToken: string) {
  return apiFetch<{ success: boolean }>(`/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, reauthToken }),
  });
}

export async function revokePasskey(id: string, reauthToken: string) {
  return apiFetch<{ success: boolean }>(`/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ reauthToken }),
  });
}

export type WorkspaceTool = 'sandbox' | 'inspector' | 'webhooks' | 'composer';

export async function getWorkspace(tool: WorkspaceTool) {
  return apiFetch<{ tool: WorkspaceTool; data: Record<string, unknown> }>(`/workspaces/${tool}`);
}

export async function saveWorkspace(tool: WorkspaceTool, data: Record<string, unknown>) {
  return apiFetch<{ tool: WorkspaceTool; data: Record<string, unknown> }>(`/workspaces/${tool}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

/* ─── Contracts ─────────────────────────────────────────────────────────── */

export interface DeployedContract {
  contractId: string;
  wasmHash: string;
  deployedAt: string;
  network: string;
}

interface DeployResult {
  contractId: string;
  wasmHash: string;
  txHash: string;
}

interface InvokeResult {
  result: unknown;
  txHash: string;
}

interface ContractInfo {
  contractId: string;
  wasmHash: string;
  network: string;
}

async function apiFetchFormData<T>(path: string, formData: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1${path}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
  } catch (error) {
    throw normalizeApiError(error);
  }

  return parseJson<T>(response);
}

export async function deployContract(formData: FormData) {
  return apiFetchFormData<DeployResult>('/contracts/deploy', formData);
}

export async function invokeContract(contractId: string, functionName: string, args: unknown[]) {
  return apiFetch<InvokeResult>(`/contracts/${contractId}/invoke`, {
    method: 'POST',
    body: JSON.stringify({ functionName, args }),
  });
}

export async function getContractInfo(contractId: string) {
  return apiFetch<ContractInfo>(`/contracts/${contractId}/info`);
}

export interface AbiMethodArg {
  name: string;
  type: string;
}

export interface AbiMethod {
  name: string;
  arguments: AbiMethodArg[];
  returnType: string;
}

export interface AbiEventTopic {
  name: string;
  indexed: boolean;
}

export interface AbiEvent {
  name: string;
  arguments: AbiMethodArg[];
  topics: AbiEventTopic[];
}

export interface AbiCatalogEntry {
  id: string;
  contractId: string;
  wasmId?: string;
  network: string;
  name?: string;
  methods: AbiMethod[];
  events: AbiEvent[];
  attachedAt: string;
}

export async function attachContractAbi(
  contractId: string,
  schema: unknown,
  options?: { wasmId?: string; network?: 'testnet' | 'mainnet'; name?: string },
) {
  return apiFetch<AbiCatalogEntry>(`/contracts/${contractId}/abi`, {
    method: 'POST',
    body: JSON.stringify({ schema, ...options }),
  });
}

export async function getContractAbi(contractId: string, wasmId?: string) {
  const query = wasmId ? `?wasmId=${encodeURIComponent(wasmId)}` : '';
  return apiFetch<AbiCatalogEntry>(`/contracts/${contractId}/abi${query}`);
}

export async function encodeContractAbiArguments(
  contractId: string,
  functionName: string,
  args: unknown[],
) {
  return apiFetch<
    Array<{
      name: string;
      type: string;
      xdrBase64: string;
      decoded: { type: string; value: unknown };
    }>
  >(`/contracts/${contractId}/abi/${encodeURIComponent(functionName)}/encode`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  });
}

/* ─── Playground ─────────────────────────────────────────────────────────── */

export type PlaygroundProvider = 'fluxa' | 'crowdpay' | 'custom';

export interface PlaygroundApiKey {
  id: string;
  label: string;
  provider: PlaygroundProvider;
  maskedKey: string;
  createdAt: string;
}

export interface PlaygroundProxyRequest {
  provider: PlaygroundProvider;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PlaygroundProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

export async function fetchPlaygroundSpec(provider: PlaygroundProvider) {
  return apiFetch<{
    provider: PlaygroundProvider;
    spec: Record<string, unknown>;
  }>(`/playground/spec/${provider}`);
}

export async function proxyPlaygroundRequest(dto: PlaygroundProxyRequest) {
  return apiFetch<PlaygroundProxyResult>('/playground/proxy', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export async function savePlaygroundApiKey(
  provider: PlaygroundProvider,
  label: string,
  apiKey: string,
) {
  return apiFetch<{ id: string; label: string; provider: PlaygroundProvider }>('/playground/keys', {
    method: 'POST',
    body: JSON.stringify({ provider, label, apiKey }),
  });
}

export async function listPlaygroundApiKeys() {
  return apiFetch<PlaygroundApiKey[]>('/playground/keys');
}

export async function deletePlaygroundApiKey(id: string) {
  return apiFetch<{ success: boolean }>(`/playground/keys/${id}`, {
    method: 'DELETE',
  });
}

/* ─── Simulator ──────────────────────────────────────────────────────────── */

export type Direction = 'strict_send' | 'strict_receive';
export type AssetType = 'native' | 'credit_alphanum4' | 'credit_alphanum12';
export type NetworkChoice = 'mainnet' | 'testnet';

export interface NetworkStatusResult {
  timestamp: number;
  network: NetworkChoice;
  passphrase: string;
  ledger: {
    sequence: number;
    closeTime: string;
    secondsSinceClose: number;
    avgCloseTime: number;
  };
  fees: {
    baseFee: { min: number; mode: number; max: number };
    percentiles: { p10: number; p50: number; p90: number; p99: number };
  };
  latency: number;
}

export interface NetworkHistoryBucket {
  timestamp: number;
  sampledAt: string;
  ok: boolean;
  latencyMs: number | null;
  sampleCount: number;
  errorCount: number;
}

export interface NetworkHistorySummary {
  uptimePercent: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  outageCount: number;
  sampleCount: number;
}

export interface NetworkHistoryResult {
  network: NetworkChoice;
  from: string;
  to: string;
  bucketSeconds: number;
  summary: NetworkHistorySummary;
  samples: NetworkHistoryBucket[];
}

export async function getNetworkStatus(network: NetworkChoice = 'mainnet') {
  return apiFetch<NetworkStatusResult>(`/network/status?network=${network}`);
}

export async function getNetworkHistory(network: NetworkChoice = 'mainnet', windowMinutes = 60) {
  const to = new Date();
  const from = new Date(to.getTime() - windowMinutes * 60 * 1000);
  const params = new URLSearchParams({
    network,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  return apiFetch<NetworkHistoryResult>(`/network/status/history?${params.toString()}`);
}

export interface NetworkProfile {
  id: string;
  ownerId: string;
  name: string;
  horizonUrl: string;
  networkPassphrase: string;
  friendbotUrl?: string | null;
  isDefault: boolean;
}

export interface NetworkProfileInput {
  name: string;
  horizonUrl: string;
  networkPassphrase: string;
  friendbotUrl?: string | null;
  isDefault?: boolean;
}

export interface NetworkProfileExport extends Omit<NetworkProfileInput, 'name'> {
  /** Present on exports written after the versioned contract landed. */
  schemaVersion?: number;
  /** Legacy exports could omit the display name. */
  name?: string;
}

export interface NetworkPassphraseVerificationResult {
  match: boolean;
  actualPassphrase: string;
}

export async function listNetworkProfiles() {
  return apiFetch<NetworkProfile[]>('/network/profiles');
}

export async function createNetworkProfile(input: NetworkProfileInput) {
  return apiFetch<NetworkProfile>('/network/profiles', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateNetworkProfile(id: string, input: Partial<NetworkProfileInput>) {
  return apiFetch<NetworkProfile>(`/network/profiles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteNetworkProfile(id: string) {
  return apiFetch<{ success: boolean }>(`/network/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function setDefaultNetworkProfile(id: string) {
  return apiFetch<NetworkProfile>(`/network/profiles/${encodeURIComponent(id)}/default`, {
    method: 'PUT',
  });
}

export async function verifyNetworkPassphrase(
  horizonUrl: string,
  expectedPassphrase?: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return apiFetch<NetworkPassphraseVerificationResult>('/network/profiles/verify', {
    method: 'POST',
    body: JSON.stringify({ horizonUrl, expectedPassphrase }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export async function exportNetworkProfile(id: string) {
  return apiFetch<NetworkProfileExport>(`/network/profiles/${encodeURIComponent(id)}/export`);
}

export async function importNetworkProfile(profile: NetworkProfileExport) {
  return apiFetch<NetworkProfile>('/network/profiles/import', {
    method: 'POST',
    body: JSON.stringify(profile),
  });
}

export interface SimulatedAsset {
  type: AssetType;
  code?: string;
  issuer?: string;
  label: string;
}

export interface SimulatedPath {
  source_asset: SimulatedAsset;
  destination_asset: SimulatedAsset;
  source_amount: string;
  destination_amount: string;
  path: SimulatedAsset[];
  effective_rate: string;
  estimated_fee: string;
  recommended_slippage: number;
  hops: number;
}

export interface FindPathsResponse {
  paths: SimulatedPath[];
  direction: Direction;
}

export interface FindPathsParams {
  direction: Direction;
  source_asset_type: AssetType;
  source_asset_code?: string;
  source_asset_issuer?: string;
  amount: string;
  destination_asset_type: AssetType;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  network?: NetworkChoice;
}

export interface EstimateResult {
  destination_min?: string;
  send_max?: string;
  source_amount: string;
  destination_amount: string;
  path: SimulatedAsset[];
}

export interface EstimateParams {
  direction: Direction;
  amount: string;
  source_asset: { type: AssetType; code?: string; issuer?: string };
  destination_asset: { type: AssetType; code?: string; issuer?: string };
  path_assets?: Array<{ type: AssetType; code?: string; issuer?: string }>;
  slippage_percent: number;
  network?: NetworkChoice;
}

export async function findSimulatorPaths(params: FindPathsParams) {
  const searchParams = new URLSearchParams();
  searchParams.set('direction', params.direction);
  searchParams.set('source_asset_type', params.source_asset_type);
  searchParams.set('amount', params.amount);
  searchParams.set('destination_asset_type', params.destination_asset_type);
  if (params.source_asset_code) searchParams.set('source_asset_code', params.source_asset_code);
  if (params.source_asset_issuer)
    searchParams.set('source_asset_issuer', params.source_asset_issuer);
  if (params.destination_asset_code)
    searchParams.set('destination_asset_code', params.destination_asset_code);
  if (params.destination_asset_issuer)
    searchParams.set('destination_asset_issuer', params.destination_asset_issuer);
  if (params.network) searchParams.set('network', params.network);

  return apiFetch<FindPathsResponse>(`/simulator/paths?${searchParams.toString()}`);
}

export async function estimateSlippage(params: EstimateParams) {
  return apiFetch<EstimateResult>('/simulator/estimate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/* ─── Order Book ────────────────────────────────────────────────────────── */

export interface OrderbookLevel {
  price: string;
  amount: string;
  cumulativeAmount: string;
  cumulativePercent: number;
}

export interface OrderbookResult {
  selling: string;
  buying: string;
  network: NetworkChoice;
  spread: string;
  spreadBps: number;
  midPrice: string;
  bestBid: string;
  bestAsk: string;
  liquidityScore: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  lastUpdated: number;
}

export interface MidPriceSnapshot {
  timestamp: number;
  midPrice: string;
}

export async function getOrderbook(
  selling: string,
  buying: string,
  network: NetworkChoice = 'testnet',
) {
  const params = new URLSearchParams({ selling, buying, network });
  return apiFetch<OrderbookResult>(`/simulator/orderbook?${params.toString()}`);
}

export async function getOrderbookHistory(
  selling: string,
  buying: string,
  network: NetworkChoice = 'testnet',
) {
  const params = new URLSearchParams({ selling, buying, network });
  return apiFetch<MidPriceSnapshot[]>(`/simulator/orderbook/history?${params.toString()}`);
}

/* ─── Trade tape (Savitura/Savitools#212) ──────────────────────────────── */

export interface TradeRow {
  id: string;
  pagingToken: string;
  operationId: string | null;
  ledger: number | null;
  closeTime: string | null;
  tradeType: string;
  baseAsset: string;
  quoteAsset: string;
  price: string;
  baseAmount: string;
  quoteAmount: string;
  buyer: string;
  seller: string;
  side: 'buy' | 'sell';
}

export interface TradeTapeResult {
  selling: string;
  buying: string;
  network: NetworkChoice;
  order: 'asc' | 'desc';
  limit: number;
  cursor: string | null;
  trades: TradeRow[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  lastUpdated: number;
}

export interface GetTradesParams {
  selling: string;
  buying: string;
  network?: NetworkChoice;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  side?: 'buy' | 'sell';
  account?: string;
  startTime?: number;
  endTime?: number;
}

export async function getTrades(params: GetTradesParams) {
  const query = new URLSearchParams();
  query.set('selling', params.selling);
  query.set('buying', params.buying);
  if (params.network) query.set('network', params.network);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.order) query.set('order', params.order);
  if (params.side) query.set('side', params.side);
  if (params.account) query.set('account', params.account);
  if (params.startTime !== undefined) query.set('startTime', String(params.startTime));
  if (params.endTime !== undefined) query.set('endTime', String(params.endTime));
  return apiFetch<TradeTapeResult>(`/simulator/trades?${query.toString()}`);
}

/* ─── Order fill quote (Savitura/Savitools#213) ────────────────────────── */

export type QuoteStatus = 'filled' | 'partial' | 'unfilled';

export interface OrderQuoteResult {
  selling: string;
  buying: string;
  network: NetworkChoice;
  side: 'buy' | 'sell';
  requestedAmount: string;
  filledAmount: string;
  unfilledAmount: string;
  status: QuoteStatus;
  averagePrice: string | null;
  worstPrice: string | null;
  bestPrice: string | null;
  cost: string;
  priceImpactBps: number | null;
  estimatedFee: string;
  levelsConsumed: number;
  lastUpdated: number;
}

export interface OrderQuoteParams {
  selling: string;
  buying: string;
  side: 'buy' | 'sell';
  amount: string;
  network?: NetworkChoice;
}

export async function getOrderQuote(params: OrderQuoteParams) {
  return apiFetch<OrderQuoteResult>('/simulator/orderbook/quote', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/* ─── LP Pool Quote (Savitura/Savitools#LP) ─────────────────────────────── */

export type PoolQuoteScenario = 'deposit' | 'withdrawal';

export interface PoolQuoteParams {
  scenario: PoolQuoteScenario;
  network?: NetworkChoice;
  /** Explicit Horizon pool ID (hex, 64 chars). Takes precedence over assetA/B. */
  poolId?: string;
  /** Asset A in canonical order. "XLM" or "CODE:ISSUER". Required when poolId is absent. */
  assetA?: string;
  /** Asset B in canonical order. "XLM" or "CODE:ISSUER". Required when poolId is absent. */
  assetB?: string;
  // deposit inputs
  amountA?: string;
  amountB?: string;
  // withdrawal inputs
  shares?: string;
  withdrawAmountA?: string;
}

export interface PoolQuoteAsset {
  asset: string;
  reserve: string;
}

interface PoolQuoteBase {
  poolId: string;
  network: string;
  scenario: PoolQuoteScenario;
  assetA: PoolQuoteAsset;
  assetB: PoolQuoteAsset;
  totalShares: string;
  feePct: string;
  spotPriceAperB: string;
  spotPriceBperA: string;
  priceImpactBps: string;
}

export interface DepositQuoteResult extends PoolQuoteBase {
  scenario: 'deposit';
  depositA: string;
  depositB: string;
  sharesOut: string;
  minSharesOut: string;
  composerHint: {
    operation: 'liquidityPoolDeposit';
    poolId: string;
    maxAmountA: string;
    maxAmountB: string;
    minPrice: string;
    maxPrice: string;
  };
}

export interface WithdrawalQuoteResult extends PoolQuoteBase {
  scenario: 'withdrawal';
  sharesToBurn: string;
  reserveAOut: string;
  reserveBOut: string;
  minReserveAOut: string;
  minReserveBOut: string;
  composerHint: {
    operation: 'liquidityPoolWithdraw';
    poolId: string;
    amount: string;
    minAmountA: string;
    minAmountB: string;
  };
}

export type PoolQuoteResult = DepositQuoteResult | WithdrawalQuoteResult;

export async function getPoolQuote(params: PoolQuoteParams): Promise<PoolQuoteResult> {
  return apiFetch<PoolQuoteResult>('/simulator/pool/quote', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/* ─── Webhooks ──────────────────────────────────────────────────────────── */

export interface WebhookTemplate {
  provider: 'crowdpay' | 'fluxa';
  eventType: string;
  description: string;
  schema: Record<string, string>;
  samplePayload: Record<string, unknown>;
}

export interface WebhookSendRequest {
  endpointUrl: string;
  eventType: string;
  payload?: Record<string, unknown>;
  secret?: string;
  method?: WebhookMethod;
  headers?: Record<string, string>;
  repeatCount?: number;
  repeatIntervalMs?: number;
}

/**
 * The timestamp and bytes a delivery was signed over, as reported by the API.
 * Lets the UI recompute the identical signature instead of guessing at the
 * payload serialisation.
 */
export interface WebhookSignatureInfo {
  timestamp: string;
  body: string;
  signature: string;
}

export interface PayloadDiff {
  added?: Record<string, unknown>;
  modified?: Record<string, { from: unknown; to: unknown }>;
  removed?: Record<string, unknown>;
  previousAttemptId?: string;
}

export interface WebhookHistoryEntry {
  id: string;
  eventType: string;
  endpointUrl: string;
  method?: string;
  payload: Record<string, unknown>;
  requestHeaders: Record<string, string>;
  statusCode?: number | null;
  responseStatus?: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string;
  latencyMs: number;
  timestamp: number;
  error?: string;
  repeatIndex?: number;
  signature?: WebhookSignatureInfo;
  legacySignature?: boolean;
  payloadDiff?: PayloadDiff;
}

export interface WebhookSigningStatus {
  enabled: boolean;
  algorithm: 'hmac-sha256';
  signatureHeader: string;
  timestampHeader: string;
  replayWindowSeconds: number;
  signedPayloadFormat: string;
  signatureFormat: string;
  signedPayloadEncoding: 'utf-8';
  maxSkewSeconds: number;
  perRequestSecretSupported: boolean;
}

export async function fetchWebhookTemplates() {
  return apiFetch<WebhookTemplate[]>('/webhooks/templates');
}

/** Public: reports the wire format receivers should implement, never a secret. */
export async function fetchWebhookSigningStatus() {
  return apiFetch<WebhookSigningStatus>('/webhooks/signing');
}

export async function saveWebhookTemplate(template: WebhookTemplate) {
  return apiFetch<WebhookTemplate>('/webhooks/templates', {
    method: 'POST',
    body: JSON.stringify(template),
  });
}

export async function sendWebhook(dto: WebhookSendRequest) {
  return apiFetch<WebhookHistoryEntry | WebhookHistoryEntry[]>('/webhooks/send', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export interface WebhookHistoryPage {
  items: WebhookHistoryEntry[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPage: number | null;
  previousPage: number | null;
}

/**
 * Fetch one page of history. The API returns the shared pagination envelope;
 * the bare-array branch keeps older deployments (and existing callers) working
 * while they roll forward.
 */
export async function fetchWebhookHistoryPage(page = 1, limit = 25): Promise<WebhookHistoryPage> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  const result = await apiFetch<WebhookHistoryPage | WebhookHistoryEntry[]>(
    `/webhooks/history?${params.toString()}`,
  );
  if (Array.isArray(result)) {
    const start = (page - 1) * limit;
    const items = result.slice(start, start + limit);
    const total = result.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    return {
      items,
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && totalPages > 0,
      nextPage: page < totalPages ? page + 1 : null,
      previousPage: page > 1 && totalPages > 0 ? page - 1 : null,
    };
  }
  return result;
}

export async function fetchWebhookHistory(options?: { page?: number; limit?: number }) {
  if (!options?.page && !options?.limit) {
    const result = await apiFetch<WebhookHistoryPage | WebhookHistoryEntry[]>('/webhooks/history');
    return Array.isArray(result) ? result : result.items;
  }
  const data = await fetchWebhookHistoryPage(options.page, options.limit);
  return data.items;
}

export async function replayWebhook(id: string) {
  return apiFetch<WebhookHistoryEntry>(`/webhooks/replay/${id}`, {
    method: 'POST',
  });
}

/* ─── Wallet ─────────────────────────────────────────────────────────────── */

export interface GenerateKeypairResult {
  publicKey: string;
  secretKey: string;
}

export interface FundResult {
  publicKey: string;
  funded: boolean;
  txHash: string | null;
  startingBalance: string;
}

export interface Balance {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
  balance: string;
  limit?: string;
}

export interface BalancesResult {
  publicKey: string;
  balances: Balance[];
}

export interface SendPaymentResult {
  success: boolean;
  txHash: string;
}

export async function generateKeypair() {
  return apiFetch<GenerateKeypairResult>('/wallet/generate', {
    method: 'POST',
  });
}

export async function fundFromFriendbot(publicKey: string) {
  return apiFetch<FundResult>('/wallet/fund', {
    method: 'POST',
    body: JSON.stringify({ publicKey }),
  });
}

export async function getBalances(publicKey: string) {
  return apiFetch<BalancesResult>(`/wallet/balances?publicKey=${encodeURIComponent(publicKey)}`);
}

export async function sendPayment(signedXdr: string) {
  return apiFetch<SendPaymentResult>('/wallet/payment', {
    method: 'POST',
    body: JSON.stringify({ signedXdr }),
  });
}

/* ─── Sandbox ─────────────────────────────────────────────────────────────── */

export interface SandboxAccountDetails {
  publicKey: string;
  sequenceNumber: string;
  balances: Balance[];
  signers: Array<{ publicKey: string; weight: number }>;
  thresholds: {
    lowThreshold: number;
    medThreshold: number;
    highThreshold: number;
  };
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
  };
  network?: string;
}

export interface SandboxFundResult {
  publicKey: string;
  funded: boolean;
  txHash: string | null;
  confirmationStatus: string;
  startingBalance: string;
  network?: string;
}

export interface SandboxResetResult {
  publicKey: string;
  reset: boolean;
  network: string;
  startingBalance: string;
  txHash: string | null;
  message: string;
}

export interface SandboxPaymentResult {
  success: boolean;
  txHash: string;
  feeCharged: string; // Fixed: was number, server returns string
  resultCode: string;
  destination: string;
  /** Underlying G… account a muxed destination pays into. */
  destinationAccount?: string;
  /** 64-bit payment ID when `destination` is an M… muxed address. */
  muxedId?: string | null;
  asset: string;
  amount: string;
  network?: string;
}

export async function sandboxGenerateKeypair(network: string = 'testnet') {
  return apiFetch<{ publicKey: string; secretKey: string; network: string }>(
    `/sandbox/keypair?network=${encodeURIComponent(network)}`,
    { method: 'POST' },
  );
}

export async function sandboxFund(publicKey: string, network: string = 'testnet') {
  return apiFetch<SandboxFundResult>('/sandbox/fund', {
    method: 'POST',
    body: JSON.stringify({ publicKey, network }),
  });
}

export async function sandboxResetAccount(publicKey: string, network: string = 'testnet') {
  return apiFetch<SandboxResetResult>('/sandbox/reset', {
    method: 'POST',
    body: JSON.stringify({ publicKey, network }),
  });
}

export async function sandboxGetAccount(publicKey: string, network: string = 'testnet') {
  return apiFetch<SandboxAccountDetails>(
    `/sandbox/account/${encodeURIComponent(publicKey)}?network=${encodeURIComponent(network)}`,
  );
}

export async function sandboxSendPayment(
  fromSecret: string,
  toPublicKey: string,
  asset: string,
  amount: string,
  memo?: string,
  network: string = 'testnet',
) {
  return apiFetch<SandboxPaymentResult>('/sandbox/payment', {
    method: 'POST',
    body: JSON.stringify({ fromSecret, toPublicKey, asset, amount, memo, network }),
  });
}

/* ─── Simulator ──────────────────────────────────────────────────────────── */

export interface PathHop {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
}

export interface SimulatorPath {
  sourceAmount: string;
  destinationAmount: string;
  path: PathHop[];
  pathLength: number;
  exchangeRate: string;
}

export interface SimulateStrictSendResult {
  sourceAsset: string;
  sourceAmount: string;
  destAsset: string;
  network: string;
  mode: 'strict_send';
  totalPathsFound: number;
  paths: SimulatorPath[];
  bestPath: SimulatorPath;
  slippagePercent: string;
}

export interface SimulateStrictReceiveResult {
  sourceAsset: string;
  destAsset: string;
  destAmount: string;
  network: string;
  mode: 'strict_receive';
  totalPathsFound: number;
  paths: SimulatorPath[];
  bestPath: SimulatorPath;
  sourceAmountNeeded: string;
  slippagePercent: string;
}

export type SimulatePathResult = SimulateStrictSendResult | SimulateStrictReceiveResult;

export interface SimulateFeeResult {
  network: string;
  operations: number;
  baseFeeStroops: number;
  totalFeeStroops: number;
  totalFeeXlm: string;
  feeChargedPercentiles: {
    p10: string;
    p50: string;
    p90: string;
    p99: string;
  };
  lastLedger: number;
}

export async function simulateStrictSend(dto: {
  sourceAsset: string;
  sourceAmount: string;
  destAsset: string;
  network: string;
}) {
  return apiFetch<SimulateStrictSendResult>('/simulator/path-send', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export async function simulateStrictReceive(dto: {
  sourceAsset: string;
  destAmount: string;
  destAsset: string;
  network: string;
}) {
  return apiFetch<SimulateStrictReceiveResult>('/simulator/path-receive', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export async function simulateFee(operations: number, network: string) {
  return apiFetch<SimulateFeeResult>(`/simulator/fee?operations=${operations}&network=${network}`);
}

/* ─── Path-payment simulation lab (Savitura/Savitools#351) ──────────────── */

export type SlippageDirection = 'strict_send' | 'strict_receive';

export type SlippageVerdict = 'pass' | 'fail' | 'exact';

/** Mirrors `apps/api/src/modules/simulator/slippage-lab.ts`. */
export interface SlippageScenarioOutcome {
  /** Tolerance this row prices, as a percentage. */
  slippagePercent: number;
  /** `destinationMin` (strict send) or `sendMax` (strict receive), to submit. */
  guarantee: string;
  /** The variable leg once the simulated adverse move is applied. */
  adverseAmount: string;
  /** Positive when the tolerance clears the move, negative when it fails. */
  headroom: string;
  headroomPercent: number;
  /** The adverse move this tolerance absorbs, as a percentage. */
  tolerableMovePercent: number;
  verdict: SlippageVerdict;
}

export interface SlippageComparison {
  direction: SlippageDirection;
  guaranteeField: 'destinationMin' | 'sendMax';
  fixedAmount: string;
  quotedVariableAmount: string;
  adverseMovePercent: number;
  adverseVariableAmount: string;
  scenarios: SlippageScenarioOutcome[];
  tightestSlippagePercent: number;
  widestSlippagePercent: number;
  recommendedSlippagePercent: number | null;
  recommendedHeadroomPercent: number | null;
  exceededByEveryScenario: boolean;
  routeDispersionPercent: number | null;
}

export interface PathPaymentLabHop {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
}

export interface PathPaymentLabRoute {
  index: number;
  pathLength: number;
  sourceAmount: string;
  destinationAmount: string;
  exchangeRate: string;
  fixedAmount: string;
  variableAmount: string;
  hops: PathPaymentLabHop[];
}

export interface PathPaymentLabResult {
  network: NetworkChoice;
  direction: SlippageDirection;
  sourceAsset: string;
  destinationAsset: string;
  routeCount: number;
  route: PathPaymentLabRoute;
  comparison: SlippageComparison;
}

export interface PathPaymentLabParams {
  direction: Direction;
  sourceAsset: string;
  destinationAsset: string;
  amount: string;
  /** Tolerances to compare, as percentages. */
  slippageScenarios: number[];
  /** Adverse rate move to simulate, as a percentage. */
  adverseMovePercent?: number;
  /** Which route to simulate, zero-based. Defaults to the best one. */
  routeIndex?: number;
  network?: NetworkChoice;
}

export async function runPathPaymentLab(
  params: PathPaymentLabParams,
): Promise<PathPaymentLabResult> {
  return apiFetch<PathPaymentLabResult>('/simulator/path-payment-lab', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/* ─── Multisig signer-weight and threshold simulator (#352) ─────────────── */

export type MultisigRiskCode =
  | 'THRESHOLD_UNREACHABLE'
  | 'THRESHOLD_ZERO'
  | 'SINGLE_SIGNER_CONTROLS'
  | 'REQUIRES_EVERY_SIGNER'
  | 'REQUIRED_SIGNER_MISSING'
  | 'REQUIRED_SIGNER_UNSIGNED'
  | 'ZERO_WEIGHT_SIGNERS'
  | 'REDUNDANT_SIGNER'
  | 'QUORUM_SINGLE_POINT_OF_FAILURE'
  | 'DUPLICATE_SIGNER'
  | 'THRESHOLD_ABOVE_TOTAL_WEIGHT';

export type MultisigRiskSeverity = 'critical' | 'warning' | 'info';

export type OperationThresholdKind = 'low' | 'medium' | 'high';

export interface MultisigRisk {
  code: MultisigRiskCode;
  severity: MultisigRiskSeverity;
  message: string;
  signers?: string[];
}

export interface MultisigSignerOutcome {
  key: string;
  weight: number;
  signed: boolean;
  required: boolean;
  shareOfTotalPercent: number;
  shareOfThresholdPercent: number;
  controlsAccount: boolean;
  indispensable: boolean;
  redundant: boolean;
}

export interface MultisigThresholdOutcome {
  kind: OperationThresholdKind;
  requiredWeight: number;
  collectedWeight: number;
  deficit: number;
  cleared: boolean;
}

export interface MultisigSimulationResult {
  threshold: number;
  lowThreshold: number;
  mediumThreshold: number;
  highThreshold: number;
  totalWeight: number;
  signedWeight: number;
  deficit: number;
  surplus: number;
  progressPercent: number;
  satisfied: boolean;
  canSubmit: boolean;
  signers: MultisigSignerOutcome[];
  operationThresholds: MultisigThresholdOutcome[];
  outstandingRequiredSigners: string[];
  minimumSignersNeeded: string[] | null;
  minimumSetWeight: number;
  duplicateSigners: string[];
  risks: MultisigRisk[];
  timeBounds: {
    minTime: number | null;
    maxTime: number | null;
    notYetActive: boolean;
    expired: boolean;
    invalid: boolean;
  };
}

export interface MultisigLimits {
  maxSigners: number;
  maxSignerWeight: number;
  maxThreshold: number;
  operationThresholds: { kind: OperationThresholdKind; gates: string }[];
}

export interface MultisigSignerInput {
  key: string;
  weight: number;
  signed: boolean;
  required?: boolean;
}

export interface MultisigSimulateParams {
  threshold: number;
  signers: MultisigSignerInput[];
  lowThreshold?: number;
  highThreshold?: number;
  minTime?: string;
  maxTime?: string;
}

export async function getMultisigLimits(): Promise<MultisigLimits> {
  return apiFetch<MultisigLimits>('/multisig/limits');
}

export async function simulateMultisig(
  params: MultisigSimulateParams,
): Promise<MultisigSimulationResult> {
  return apiFetch<MultisigSimulationResult>('/multisig/simulate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/* ─── Inspector ──────────────────────────────────────────────────────────── */

export interface DecodedEffect {
  type: string;
  account: string;
  [key: string]: string | number | boolean | null;
}

export interface DecodedOperationResult {
  index: number;
  type: string;
  label: string;
  fields: Record<string, string | null>;
  sourceAccount: string | null;
  resultCode: string | null;
  resultExplanation: string | null;
  success: boolean;
  effects: DecodedEffect[];
}

export interface ComposerPayload {
  sourceAccount: string;
  network: string;
  memo?: string;
  operations: Array<Record<string, unknown> & { type: string }>;
}

export interface DecodedEventTopic {
  index: number;
  friendlyName: string | null;
  value: DecodedScVal | null;
  rawHex: string;
}

export interface DecodedSorobanEvent {
  index: number;
  contractId: string | null;
  type: string;
  eventName: string | null;
  signature: string;
  topics: DecodedEventTopic[];
  data: DecodedScVal | null;
  inSuccessfulContractCall: boolean;
  partial: boolean;
}

export interface GroupedSorobanEvents {
  contractId: string | null;
  events: DecodedSorobanEvent[];
}

export interface TransactionEventsResponse {
  hash: string;
  network: string;
  count: number;
  events: DecodedSorobanEvent[];
  grouped: GroupedSorobanEvents[];
}

export interface TransactionBreakdown {
  hash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  sequenceNumber: string;
  feeCharged: string;
  maxFee: string;
  memo: string | null;
  memoType: string;
  timeBounds: { minTime: string | null; maxTime: string | null } | null;
  signatures: string[];
  success: boolean;
  resultCode: string;
  resultExplanation: string;
  operationCount: number;
  operations: DecodedOperationResult[];
  sorobanEvents?: DecodedSorobanEvent[];
  rawJson: Record<string, unknown> | null;
  network: string;
  composerPayload: ComposerPayload | null;
}

export interface TxSummary {
  hash: string;
  createdAt: string;
  operationCount: number;
  feeCharged: string;
  success: boolean;
  resultCode: string;
}

export async function inspectTransaction(hash: string, network: 'testnet' | 'mainnet' = 'testnet') {
  return apiFetch<TransactionBreakdown>(
    `/inspector/tx/${encodeURIComponent(hash)}?network=${network}`,
  );
}

export async function getTransactionEvents(
  hash: string,
  network: 'testnet' | 'mainnet' = 'testnet',
  filter?: { contractId?: string; eventName?: string },
) {
  const params = new URLSearchParams({ network });
  if (filter?.contractId) params.set('contractId', filter.contractId);
  if (filter?.eventName) params.set('eventName', filter.eventName);
  return apiFetch<TransactionEventsResponse>(
    `/inspector/tx/${encodeURIComponent(hash)}/events?${params.toString()}`,
  );
}

export async function getAccountTransactions(
  publicKey: string,
  network: 'testnet' | 'mainnet' = 'testnet',
) {
  return apiFetch<TxSummary[]>(
    `/inspector/account/${encodeURIComponent(publicKey)}/txs?network=${network}`,
  );
}

export async function decodeXdr(xdr: string, network: 'testnet' | 'mainnet' = 'testnet') {
  return apiFetch<TransactionBreakdown>('/inspector/decode-xdr', {
    method: 'POST',
    body: JSON.stringify({ xdr, network }),
  });
}

/* ─── Federation ────────────────────────────────────────────────────────── */

export interface FederationResolveResult {
  stellarAddress: string | null;
  federationAddress: string | null;
  memo: string | null;
  memoType: string | null;
  homeDomain: string | null;
}

export interface TomlAccount {
  PUBLIC_KEY: string;
  NAME?: string;
  HOME_DOMAIN?: string;
  DESCRIPTION?: string;
}

export interface TomlCurrency {
  code: string;
  issuer: string;
  display_decimals?: number;
  name?: string;
  desc?: string;
  conditions?: string;
  image?: string;
  anchor_asset_type?: string;
  anchor_asset?: string;
  redemption_instructions?: string;
  collateral_addresses?: string;
  regulated?: boolean;
  approval_server?: string;
  approval_criteria?: string;
}

export interface TomlValidator {
  PUBLIC_KEY: string;
  NAME?: string;
  HOST?: string;
  HISTORY_URL?: string;
}

export interface TomlDocumentation {
  PRINCIPALS_NAME?: string;
  PRINCIPAL_EMAIL?: string;
  PROJECT_URL?: string;
  OFFICIAL_CHAT?: string;
  OTHER_INFO?: string;
}

export interface TomlResult {
  version: string | null;
  networkPassphrase: string | null;
  federationServer: string | null;
  transferServer: string | null;
  transferServerSep0024: string | null;
  webAuthEndpoint: string | null;
  directPaymentServer: string | null;
  accounts: TomlAccount[];
  currencies: TomlCurrency[];
  validators: TomlValidator[];
  documentation: TomlDocumentation | null;
  fetchLatencyMs: number;
  validationWarnings: string[];
}

export interface HomeDomainValidationResult {
  valid: boolean;
  domain: string;
  issuer: string;
  reason: 'issuer_not_declared' | 'home_domain_mismatch' | null;
}

export interface SepInfo {
  number: number;
  name: string;
  supported: boolean;
  endpoint: string | null;
  probeStatus: 'green' | 'yellow' | 'red' | 'none' | 'timeout'; // Fixed: added 'timeout' member
}

export interface SepResult {
  seps: SepInfo[];
  /** Additive TOML state, so an unavailable or malformed document is not hidden. */
  tomlStatus?: 'available' | 'unavailable' | 'malformed';
}

export async function resolveFederation(address: string) {
  return apiFetch<FederationResolveResult>(
    `/federation/resolve?address=${encodeURIComponent(address)}`,
  );
}

export async function fetchStellarToml(domain: string) {
  return apiFetch<TomlResult>(`/federation/toml?domain=${encodeURIComponent(domain)}`);
}

export async function validateHomeDomain(domain: string, issuer: string) {
  const params = new URLSearchParams({ domain, issuer });
  return apiFetch<HomeDomainValidationResult>(
    `/federation/validate-home-domain?${params.toString()}`,
  );
}

export async function fetchAssetMetadata(domain: string, code: string, issuer: string) {
  const params = new URLSearchParams({ domain, code, issuer });
  return apiFetch<TomlCurrency>(`/federation/asset-metadata?${params.toString()}`);
}

export async function fetchSepSupport(domain: string) {
  return apiFetch<SepResult>(`/federation/sep?domain=${encodeURIComponent(domain)}`);
}

export interface TransferLinkResult {
  sep: string;
  endpoint: string;
  url: string;
  asset: string;
  amount: string;
  warning: string;
}

export async function previewTransferLink(input: {
  domain: string;
  sep: string;
  asset: string;
  amount: string;
  memo?: string;
  callback?: string;
  account?: string;
}) {
  const params = new URLSearchParams({
    domain: input.domain,
    sep: input.sep,
    asset: input.asset,
    amount: input.amount,
  });
  if (input.memo) params.set('memo', input.memo);
  if (input.callback) params.set('callback', input.callback);
  if (input.account) params.set('account', input.account);
  return apiFetch<TransferLinkResult>(`/federation/link-preview?${params.toString()}`);
}

/* ─── Federation server diagnostics (Savitura/Savitools#341) ────────────── */

export type DiagnosticStageName = 'toml' | 'http' | 'forward-lookup' | 'reverse-lookup';

export type DiagnosticFailureKind = 'dns' | 'toml' | 'tls' | 'http' | 'timeout' | 'schema' | 'ssrf';

export interface DiagnosticStage {
  stage: DiagnosticStageName;
  ok: boolean;
  latencyMs?: number;
  error?: DiagnosticFailureKind;
  details: Record<string, unknown>;
  redirectChain?: string[];
}

export interface FederationDiagnosticsReport {
  domain: string;
  checkedAt: string;
  ok: boolean;
  totalLatencyMs: number;
  serverUrl?: string;
  serverStatus?: number | null;
  forwardStatus?: number | null;
  stages: DiagnosticStage[];
  failures: DiagnosticFailureKind[];
}

export async function fetchFederationDiagnostics(domain: string) {
  return apiFetch<FederationDiagnosticsReport>(
    `/federation/diagnostics?domain=${encodeURIComponent(domain)}`,
  );
}

/* ─── Account Relationship Graph ───────────────────────────────────────── */

export type GraphMode = 'signers' | 'offers' | 'payments' | 'all';

export type GraphNodeType = 'account' | 'multisig' | 'anchor' | 'contract';

export interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  metadata: Record<string, unknown>;
}

export type GraphRelationship = 'signs_for' | 'co_signer' | 'offer_match' | 'payment';

export interface GraphEdge {
  source: string;
  target: string;
  relationship: GraphRelationship;
  metadata: Record<string, unknown>;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootAccount: string;
  depth: number;
  mode: GraphMode;
  nodeCount: number;
  edgeCount: number;
  /** True when a traversal limit stopped the graph early (#260). */
  truncated?: boolean;
  truncatedBy?: 'node_limit' | 'horizon_request_limit' | null;
  horizonRequests?: number;
  limits?: { maxDepth: number; maxNodes: number; maxHorizonRequests: number };
}

export interface GraphQuery {
  rootAccount: string;
  depth: number;
  mode: GraphMode;
  network: 'testnet' | 'mainnet';
}

export async function buildAccountGraph(query: GraphQuery) {
  return apiFetch<GraphResult>('/transaction/graph', {
    method: 'POST',
    body: JSON.stringify(query),
  });
}

/* ─── Contract Events ───────────────────────────────────────────────────── */

export interface DecodedScVal {
  type: string;
  value: unknown;
  raw: string;
}

export interface DecodedContractEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  pagingToken: string;
  inSuccessfulContractCall: boolean;
  txHash: string;
  contractId: string | null;
  topic: DecodedScVal[];
  value: DecodedScVal;
  matchedCriteria?: string[];
}

export interface ContractEventsResult {
  events: DecodedContractEvent[];
  latestLedger: number;
  cursor: string;
  count: number;
}

export interface ContractEventsQuery {
  contractId: string;
  network?: NetworkChoice;
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit?: number;
  type?: 'contract' | 'system' | 'diagnostic';
}

export interface ReplayEventResult {
  index: number;
  eventId: string | null;
  statusCode: number | null;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReplaySummary {
  delivered: number;
  failed: number;
  results: ReplayEventResult[];
  secret?: string;
}

export const CONTRACT_EVENTS_MAX_LIMIT = 200;

export async function getContractEvents(query: ContractEventsQuery) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });

  return apiFetch<ContractEventsResult>(`/contracts/events?${params.toString()}`);
}

/**
 * Server-side filtering. The UI filters locally via `lib/contract-events.ts`
 * for instant feedback; this exists for programmatic consumers and to verify
 * the two implementations agree.
 */
export async function filterContractEvents(events: DecodedContractEvent[], criteria: unknown[]) {
  return apiFetch<{ events: DecodedContractEvent[]; count: number }>('/contracts/events/filter', {
    method: 'POST',
    body: JSON.stringify({ events, criteria }),
  });
}

export async function replayContractEvents(
  webhookUrl: string,
  events: DecodedContractEvent[],
  secret?: string,
) {
  return apiFetch<ReplaySummary>('/contracts/events/replay', {
    method: 'POST',
    body: JSON.stringify({ webhookUrl, events, ...(secret ? { secret } : {}) }),
  });
}

/* ─── Asset Control (Savitura/Savitools#81) ─────────────────────────────── */

export interface AssetControlFlags {
  asset: { code: string; issuer: string };
  account: string;
  authorizationRequired: boolean;
  authorizationRevocable: boolean;
  authorizationClawbackEnabled: boolean;
  authorizationImmutable: boolean;
}

export interface AssetTrustline {
  account: string;
  balance: string;
  limit: string | null;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  clawbackEnabled: boolean;
}

export interface AssetTrustlinesResult {
  asset: { code: string; issuer: string };
  total: number;
  fetched: number;
  pages: number;
  truncated: boolean;
  trustlines: AssetTrustline[];
}

export interface AssetTrustlineFilters {
  authorized?: boolean;
  clawbackEnabled?: boolean;
  minBalance?: number;
  maxBalance?: number;
  account?: string;
}

export interface AssetAccountFlagsInput {
  authorizationRequired?: boolean;
  authorizationRevocable?: boolean;
  authorizationClawbackEnabled?: boolean;
  authorizationImmutable?: boolean;
}

export interface AssembledAssetOperation {
  xdr: string;
  network: 'testnet';
  networkPassphrase: string;
  sourceAccount: string;
  sequence: string;
  operationType: 'setTrustlineFlags' | 'clawback' | 'setOptions';
  operation: Record<string, unknown>;
  summary: string;
  unsigned: true;
}

function assetPath(code: string, issuer: string, suffix: string): string {
  return `/wallet/asset/${encodeURIComponent(code)}/${encodeURIComponent(issuer)}/${suffix}`;
}

export async function getAssetControlFlags(code: string, issuer: string) {
  return apiFetch<AssetControlFlags>(assetPath(code, issuer, 'flags'));
}

export async function getAssetTrustlines(
  code: string,
  issuer: string,
  filters: AssetTrustlineFilters = {},
) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  const query = params.toString();

  return apiFetch<AssetTrustlinesResult>(
    `${assetPath(code, issuer, 'trustlines')}${query ? `?${query}` : ''}`,
  );
}

export async function buildSetTrustlineFlagsXdr(
  code: string,
  issuer: string,
  input: {
    account: string;
    flags: {
      authorized?: boolean;
      authorizedToMaintainLiabilities?: boolean;
    };
  },
) {
  return apiFetch<AssembledAssetOperation>(assetPath(code, issuer, 'set-flags'), {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function buildClawbackXdr(
  code: string,
  issuer: string,
  input: { account: string; amount: string },
) {
  return apiFetch<AssembledAssetOperation>(assetPath(code, issuer, 'clawback'), {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function buildAccountFlagsXdr(
  code: string,
  issuer: string,
  input: AssetAccountFlagsInput,
) {
  return apiFetch<AssembledAssetOperation>(assetPath(code, issuer, 'account-flags'), {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Build a Transaction Composer link that prefills the matching operation.
 * The composer reads these params in its URL-prefill effect, so the XDR the
 * Asset Control workstation just showed can be rebuilt, signed and submitted
 * without retyping any field (acceptance criterion 6).
 */
export function assetControlComposerLink(input: {
  operationType: 'setTrustlineFlags' | 'clawback' | 'setOptions';
  code: string;
  issuer: string;
  account?: string;
  amount?: string;
  flags?: {
    authorized?: boolean;
    authorizedToMaintainLiabilities?: boolean;
  };
  setFlags?: number;
  clearFlags?: number;
}): string {
  const params = new URLSearchParams();
  if (input.operationType === 'clawback') {
    params.set('prefillOp', 'clawback');
    params.set('from', input.account ?? '');
    params.set('amount', input.amount ?? '');
  } else if (input.operationType === 'setTrustlineFlags') {
    params.set('prefillOp', 'set_trustline_flags');
    params.set('trustor', input.account ?? '');
    if (input.flags?.authorized !== undefined) {
      params.set('authorize', String(input.flags.authorized));
    }
    if (input.flags?.authorizedToMaintainLiabilities !== undefined) {
      params.set(
        'authorizeToMaintainLiabilities',
        String(input.flags.authorizedToMaintainLiabilities),
      );
    }
  } else {
    params.set('prefillOp', 'set_options');
    params.set('setFlags', String(input.setFlags ?? 0));
    params.set('clearFlags', String(input.clearFlags ?? 0));
  }

  params.set('assetCode', input.code);
  params.set('assetIssuer', input.issuer);

  return `/composer?${params.toString()}`;
}

// ─── Soroban RPC console (Savitura/Savitools#358) ────────────────────────

export type SorobanRpcNetwork = 'testnet' | 'mainnet';

export type SorobanRpcParamType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

/** One named parameter of a whitelisted method, as served by the API. */
export interface SorobanRpcParamSpec {
  name: string;
  type: SorobanRpcParamType;
  required: boolean;
  description: string;
  example?: unknown;
  itemType?: 'string' | 'integer';
  /** RegExp source the value must match (hashes, envelopes…). */
  pattern?: string;
  patternHint?: string;
  /** Closed set of accepted values — rendered as a select. */
  enum?: string[];
  min?: number;
  max?: number;
  maxItems?: number;
}

export interface SorobanRpcMethodSpec {
  name: string;
  summary: string;
  description: string;
  params: SorobanRpcParamSpec[];
}

export interface SorobanRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface SorobanRpcExecuteResult {
  method: string;
  network: SorobanRpcNetwork;
  tookMs: number;
  result?: unknown;
  error?: SorobanRpcError;
}

/** Read-only catalog + JSON schema for every method the console can call. */
export async function listSorobanRpcMethods() {
  return apiFetch<{ methods: SorobanRpcMethodSpec[] }>('/soroban-rpc/methods');
}

export async function getSorobanRpcMethod(method: string) {
  return apiFetch<SorobanRpcMethodSpec>(`/soroban-rpc/methods/${method}`);
}

/* ─── Liquidity Pools ─────────────────────────────────────────────────────── */

export interface PoolDetails {
  poolId: string;
  network: string;
  assetA: string;
  assetB: string;
  reserveA: string;
  reserveB: string;
  totalShares: string;
  feePct: string;
  totalTrustlines: number;
  type: string;
  spotPriceAperB: string;
  spotPriceBperA: string;
}

export interface ShareValueResult {
  poolId: string;
  network: string;
  shares: string;
  valueA: string;
  valueB: string;
  totalValueUsd?: string;
  sharePercentage: string;
  assetA: string;
  assetB: string;
}

export interface WatchedPoolItem {
  id: string;
  poolId: string;
  network: string;
  assetA: string;
  assetB: string;
  label: string | null;
  createdAt: string;
}

export async function searchPools(
  assetA: string,
  assetB: string,
  network: NetworkChoice = 'testnet',
) {
  const params = new URLSearchParams({ assetA, assetB, network });
  return apiFetch<PoolDetails[]>(`/liquidity-pools/search?${params}`);
}

export async function getPoolDetails(poolId: string, network: NetworkChoice = 'testnet') {
  const params = new URLSearchParams({ poolId, network });
  return apiFetch<PoolDetails>(`/liquidity-pools/details?${params}`);
}

export async function calculateShareValue(dto: {
  poolId: string;
  shares: string;
  network?: NetworkChoice;
}) {
  return apiFetch<ShareValueResult>('/liquidity-pools/share-value', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export async function watchPool(dto: {
  poolId: string;
  assetA: string;
  assetB: string;
  label?: string;
  network?: NetworkChoice;
}) {
  return apiFetch<WatchedPoolItem>('/liquidity-pools/watch', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export async function unwatchPool(id: string) {
  return apiFetch<void>('/liquidity-pools/unwatch', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export async function getWatchedPools() {
  return apiFetch<WatchedPoolItem[]>('/liquidity-pools/watched');
}

/**
 * Invoke one whitelisted method. The API validates `params` against the
 * method schema and only ever forwards the call to its configured endpoint;
 * write methods such as `sendTransaction` are not exposed.
 */
export async function executeSorobanRpc(input: {
  method: string;
  params?: Record<string, unknown>;
  network?: SorobanRpcNetwork;
}) {
  return apiFetch<SorobanRpcExecuteResult>('/soroban-rpc/execute', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
