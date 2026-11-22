import {
  REDACTED,
  redactString,
  isSensitiveKey,
  redactHeaders,
  redactValue,
  redactUrl,
} from './redaction';

describe('isSensitiveKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'proxy-authorization',
    'Proxy-Authorization',
    'x-api-key',
    'X-API-Key',
    'cookie',
    'set-cookie',
    'x-auth-token',   // matches /token/i
    'x-secret',       // matches /secret/i
    'x-signature',    // matches /signature/i
    'x-private-key',  // matches /private/i and /key/i
    'password',
    'jwt',
  ])('flags %s as sensitive', (header) => {
    expect(isSensitiveKey(header)).toBe(true);
  });

  it.each([
    'content-type',
    'accept',
    'x-request-id',
    'user-agent',
    'host',
    'cache-control',
    'content-length',
  ])('does not flag %s as sensitive', (header) => {
    expect(isSensitiveKey(header)).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('redacts authorization header', () => {
    const result = redactHeaders({
      authorization: 'Bearer eyJ.abc.def',
      'content-type': 'application/json',
    });
    expect(result['authorization']).toBe(REDACTED);
    expect(result['content-type']).toBe('application/json');
  });

  it('redacts Authorization with capital A', () => {
    const result = redactHeaders({ Authorization: 'Bearer token' });
    expect(result['Authorization']).toBe(REDACTED);
  });

  it('redacts proxy-authorization', () => {
    const result = redactHeaders({
      'proxy-authorization': 'Basic dXNlcjpwYXNz',
      accept: '*/*',
    });
    expect(result['proxy-authorization']).toBe(REDACTED);
    expect(result['accept']).toBe('*/*');
  });

  it('redacts x-api-key', () => {
    const result = redactHeaders({ 'x-api-key': 'sk_live_secret123' });
    expect(result['x-api-key']).toBe(REDACTED);
  });

  it('redacts cookie and set-cookie', () => {
    const result = redactHeaders({
      cookie: 'session=abc; token=xyz',
      'set-cookie': 'session=abc; HttpOnly',
    });
    expect(result['cookie']).toBe(REDACTED);
    expect(result['set-cookie']).toBe(REDACTED);
  });

  it('preserves non-sensitive headers', () => {
    const input = {
      'content-type': 'application/json',
      'x-request-id': 'req-abc-123',
      host: 'api.example.com',
    };
    expect(redactHeaders(input)).toEqual(input);
  });

  it('handles an empty headers object', () => {
    expect(redactHeaders({})).toEqual({});
  });

  it('redacts multiple sensitive headers in one object', () => {
    const result = redactHeaders({
      authorization: 'Bearer tok',
      'proxy-authorization': 'Basic dXNlcjpwYXNz',
      'x-api-key': 'sk_live_secret',
      cookie: 'sid=x',
      accept: 'application/json',
    });
    expect(result['authorization']).toBe(REDACTED);
    expect(result['proxy-authorization']).toBe(REDACTED);
    expect(result['x-api-key']).toBe(REDACTED);
    expect(result['cookie']).toBe(REDACTED);
    expect(result['accept']).toBe('application/json');
  });
});

describe('redactString', () => {
  it('redacts a bare JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactString(jwt)).toBe(REDACTED);
  });

  it('redacts a Bearer token header value', () => {
    const result = redactString('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(result).toBe(`Bearer ${REDACTED}`);
  });

  it('redacts a Stellar secret seed', () => {
    // Valid Stellar secret seed pattern: S followed by 55 uppercase base32 characters (A-Z, 2-7)
    const seed = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
    expect(redactString(seed)).toBe(REDACTED);
  });

  it('returns empty string unchanged', () => {
    expect(redactString('')).toBe('');
  });

  it('leaves a plain string without sensitive tokens intact', () => {
    const plain = 'Hello, world!';
    expect(redactString(plain)).toBe(plain);
  });
});

describe('redactValue', () => {
  it('redacts a string value under a sensitive key', () => {
    expect(redactValue('sk_live_abc', 'x-api-key')).toBe(REDACTED);
  });

  it('redacts a string value under authorization key', () => {
    expect(redactValue('Bearer tok', 'authorization')).toBe(REDACTED);
  });

  it('deep-redacts nested objects', () => {
    const input = {
      user: 'alice',
      auth: { authorization: 'Bearer tok', userId: 'u1' },
    };
    const result = redactValue(input) as any;
    expect(result.user).toBe('alice');
    expect(result.auth.authorization).toBe(REDACTED);
    expect(result.auth.userId).toBe('u1');
  });

  it('redacts the whole value when key hint is sensitive (before array traversal)', () => {
    // When a keyHint matches a sensitive pattern, the entire value is replaced,
    // regardless of its type — the key hint takes priority over deep traversal.
    const result = redactValue(['tok1', 'tok2'], 'token');
    expect(result).toBe(REDACTED);
  });

  it('passes through null and undefined', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });
});

describe('redactUrl', () => {
  it('strips query string and fragment', () => {
    expect(redactUrl('https://api.example.com/v1/users?token=abc&page=1')).toBe(
      'https://api.example.com/v1/users',
    );
  });

  it('preserves origin and pathname', () => {
    expect(redactUrl('https://anchor.example.com/auth')).toBe(
      'https://anchor.example.com/auth',
    );
  });

  it('returns a placeholder for unparseable input', () => {
    expect(redactUrl('not a url')).toBe('(unparseable URL)');
  });
});
