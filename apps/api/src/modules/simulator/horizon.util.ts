import { BadRequestException } from '@nestjs/common';

export interface ParsedAsset {
  type: string;
  code?: string;
  issuer?: string;
}

const HORIZON_URLS: Record<string, string> = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

export function getHorizonUrl(network: string): string {
  const url = HORIZON_URLS[network];
  if (!url) {
    throw new BadRequestException(
      `Invalid network: "${network}". Use "testnet" or "mainnet"`,
    );
  }
  return url;
}

export function parseAssetParams(assetString: string): ParsedAsset {
  if (assetString === 'XLM') {
    return { type: 'native' };
  }
  const parts = assetString.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new BadRequestException(
      `Invalid asset format: "${assetString}". Use "XLM" or "CODE:ISSUER"`,
    );
  }
  const code = parts[0];
  const issuer = parts[1];
  const type = code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
  return { type, code, issuer };
}

const MAX_ERROR_DETAIL_LENGTH = 300;

function normalizeDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_ERROR_DETAIL_LENGTH
    ? `${normalized.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : normalized;
}

function extractErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const candidate = record.detail ?? record.message ?? record.error;
        if (typeof candidate === 'string') return normalizeDetail(candidate);
        if (Array.isArray(candidate)) {
          return normalizeDetail(candidate.filter((item) => typeof item === 'string').join(', '));
        }
        if (candidate && typeof candidate === 'object') {
          return normalizeDetail(JSON.stringify(candidate));
        }
      }
      return normalizeDetail(trimmed);
    } catch {
      return normalizeDetail(trimmed);
    }
  }

  return normalizeDetail(trimmed);
}

function horizonStatus(response: Response): string {
  return typeof response.status === 'number' ? String(response.status) : 'unknown';
}

function horizonError(message: string, upstreamStatus: number | undefined): BadRequestException {
  return Object.assign(new BadRequestException(message), { upstreamStatus });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchFromHorizon(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const status = horizonStatus(response);

  if (!response.ok) {
    let body = '';
    if (typeof response.text === 'function') {
      try {
        body = await response.text();
      } catch {
        body = '';
      }
    }
    const detail =
      extractErrorDetail(body) ||
      (typeof response.statusText === 'string' ? response.statusText.trim() : '');
    throw horizonError(`Horizon error (${status}): ${detail || `HTTP ${status}`}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    throw horizonError(`Horizon returned a non-JSON response (HTTP ${status})`, response.status);
  }
}
