/**
 * @jest-environment node
 */
import {
  ApiError,
  apiErrorMessage,
  apiFetch,
  classifyHttpStatus,
  normalizeApiError,
} from '@/lib/api';

const fetchMock = jest.fn();

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('API error taxonomy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('classifies network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(apiFetch('/network')).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'network',
      retryable: true,
    });
  });

  it('sends a generated request id and preserves a caller-provided id', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await apiFetch('/correlated');

    const [, generatedInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const generatedId = new Headers(generatedInit.headers).get('x-request-id');
    expect(generatedId).toMatch(/^[0-9a-f-]{36}$/);

    await apiFetch('/correlated', {
      headers: { 'x-request-id': 'trace-from-caller' },
    });

    const [, suppliedInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(suppliedInit.headers).get('x-request-id')).toBe('trace-from-caller');
  });

  it('classifies timeouts from the request deadline', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    await expect(apiFetch('/slow', { timeoutMs: 5 })).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'timeout',
    });
  });

  it('classifies unauthorized responses and keeps safe correlation details', async () => {
    fetchMock.mockResolvedValue(
      response(
        401,
        {
          message: 'Authentication required',
          code: 'UNAUTHORIZED',
          requestId: 'req-401',
          secret: 'should-never-be-echoed',
        },
        { 'x-request-id': 'header-ignored-when-body-present' },
      ),
    );

    const error = await apiFetch('/private').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: 'unauthorized',
      status: 401,
      code: 'UNAUTHORIZED',
      requestId: 'req-401',
      retryable: false,
    });
    expect(apiErrorMessage(error)).toBe('Authentication required (Request ID: req-401)');
    expect(apiErrorMessage(error)).not.toContain('should-never-be-echoed');
  });

  it('classifies validation responses and joins Nest message arrays', async () => {
    fetchMock.mockResolvedValue(
      response(400, {
        message: ['email must be an email', 'password is too short'],
        error: 'Bad Request',
      }),
    );

    await expect(apiFetch('/validation')).rejects.toMatchObject({
      kind: 'validation',
      status: 400,
      message: 'email must be an email, password is too short',
    });
  });

  it('classifies server errors and falls back to the response request-id header', async () => {
    fetchMock.mockResolvedValue(
      response(503, { message: 'Service unavailable' }, { 'x-request-id': 'edge-request-7' }),
    );

    await expect(apiFetch('/upstream')).rejects.toMatchObject({
      kind: 'server',
      status: 503,
      requestId: 'edge-request-7',
      retryable: true,
    });
  });

  it('maps all HTTP categories used by callers', () => {
    expect(classifyHttpStatus(401)).toBe('unauthorized');
    expect(classifyHttpStatus(400)).toBe('validation');
    expect(classifyHttpStatus(422)).toBe('validation');
    expect(classifyHttpStatus(408)).toBe('timeout');
    expect(classifyHttpStatus(504)).toBe('timeout');
    expect(classifyHttpStatus(500)).toBe('server');
    expect(classifyHttpStatus(502)).toBe('server');
  });

  it('normalises unknown thrown values without leaking their contents', () => {
    const normalised = normalizeApiError({ token: 'secret-token' }, 'Safe fallback');

    expect(normalised).toBeInstanceOf(ApiError);
    expect(normalised.kind).toBe('unknown');
    expect(normalised.message).toBe('Safe fallback');
  });
});
