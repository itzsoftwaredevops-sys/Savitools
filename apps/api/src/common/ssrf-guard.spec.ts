import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  assertPublicHostname,
  assertRelativePath,
  assertSafeDestination,
  assertSafeWebhookDestination,
  isForbiddenIp,
} from './ssrf-guard';

describe('isForbiddenIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.5.5',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata endpoint
    '240.0.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])('flags private/internal address %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '203.0.113.10', '2606:4700:4700::1111'])(
    'allows public address %s',
    (ip) => {
      expect(isForbiddenIp(ip)).toBe(false);
    },
  );
});

describe('assertPublicHostname', () => {
  beforeEach(() => lookupMock.mockReset());

  it('rejects an IP literal that is private without resolving it', async () => {
    await expect(assertPublicHostname('127.0.0.1')).rejects.toThrow(BadRequestException);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows an IP literal that is public', async () => {
    await expect(assertPublicHostname('8.8.8.8')).resolves.toBeUndefined();
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHostname('api.example.com')).resolves.toBeUndefined();
  });

  it('rejects a hostname that resolves to a private address (DNS rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicHostname('metadata.internal-rebind.example')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects when any resolved record is private, even with other public ones', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(assertPublicHostname('multi-a-record.example')).rejects.toThrow(BadRequestException);
  });

  it('wraps a DNS resolution failure in a BadGatewayException', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicHostname('does-not-resolve.example')).rejects.toThrow(
      BadGatewayException,
    );
  });
});

describe('assertSafeWebhookDestination', () => {
  beforeEach(() => lookupMock.mockReset());

  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeWebhookDestination(new URL('ftp://example.com/x'))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a private destination', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(
      assertSafeWebhookDestination(new URL('https://internal.example.com/hook')),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows a public https destination', async () => {
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(
      assertSafeWebhookDestination(new URL('https://example.com/hook')),
    ).resolves.toBeUndefined();
  });
});

describe('assertSafeDestination', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  const allowedOrigins = ['https://api.provider.com'];

  it('allows a URL on an allowed origin', async () => {
    await expect(
      assertSafeDestination(new URL('https://api.provider.com/v1/wallets'), allowedOrigins),
    ).resolves.toBeUndefined();
  });

  it('rejects a URL whose origin is not allowlisted', async () => {
    await expect(
      assertSafeDestination(new URL('https://evil.com/v1/wallets'), allowedOrigins),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a disallowed scheme even on an allowlisted host', async () => {
    await expect(
      assertSafeDestination(new URL('ftp://api.provider.com/x'), allowedOrigins),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when the allowlisted host resolves to a private IP', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      assertSafeDestination(new URL('https://api.provider.com/v1/wallets'), allowedOrigins),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('assertRelativePath', () => {
  it('accepts a plain relative path', () => {
    expect(() => assertRelativePath('/v1/wallets')).not.toThrow();
  });

  it.each([
    'https://evil.com/steal',
    'http://evil.com/steal',
    '//evil.com/steal',
    'evil.com/steal',
    'v1/wallets',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '\\\\evil.com/steal',
    '/..\\evil.com',
  ])('rejects absolute or protocol-relative path %s', (path) => {
    expect(() => assertRelativePath(path)).toThrow(BadRequestException);
  });
});

describe('single implementation', () => {
  it('is the only place in the API that defines the private-IP logic', () => {
    // A second copy of this table is how the webhook/playground guards drifted
    // apart before. Fail the build instead of rediscovering the fork later.
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.ts') || path.endsWith('.spec.ts')) continue;
        if (path.endsWith(join('common', 'ssrf-guard.ts'))) continue;
        const source = readFileSync(path, 'utf8');
        if (/FORBIDDEN_IPV4_RANGES|function isForbiddenIp/.test(source)) {
          offenders.push(path.replace(join(__dirname, '..') + '/', ''));
        }
      }
    };

    walk(join(__dirname, '..'));

    expect(offenders).toEqual([]);
  });
});
