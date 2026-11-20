import { BadRequestException } from '@nestjs/common';
import { fetchFromHorizon } from './horizon.util';

const HORIZON_URL = 'https://horizon-testnet.stellar.org/order_book';

describe('fetchFromHorizon', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the parsed payload for a successful JSON response', async () => {
    const payload = { bids: [], asks: [] };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(payload),
    });

    await expect(fetchFromHorizon(HORIZON_URL)).resolves.toEqual(payload);
  });

  it('keeps the upstream status when an error body is plain text', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: jest.fn().mockResolvedValue('upstream maintenance'),
    });

    await expect(fetchFromHorizon(HORIZON_URL)).rejects.toThrow(
      'Horizon error (503): upstream maintenance',
    );
  });

  it('uses a JSON error detail without losing the upstream status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: jest.fn().mockResolvedValue(JSON.stringify({ detail: 'rate limit reached' })),
    });

    const error = (await fetchFromHorizon(HORIZON_URL).catch(
      (caught) => caught,
    )) as BadRequestException & { upstreamStatus: number };

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('429');
    expect(error.message).toContain('rate limit reached');
    expect(error.upstreamStatus).toBe(429);
  });

  it('falls back to status text when the error body cannot be read', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 504,
      statusText: 'Gateway Timeout',
      text: jest.fn().mockRejectedValue(new Error('body stream failed')),
    });

    await expect(fetchFromHorizon(HORIZON_URL)).rejects.toThrow(
      'Horizon error (504): Gateway Timeout',
    );
  });

  it('reports the status for a non-JSON successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
    });

    await expect(fetchFromHorizon(HORIZON_URL)).rejects.toThrow(
      'Horizon returned a non-JSON response (HTTP 200)',
    );
  });
});
