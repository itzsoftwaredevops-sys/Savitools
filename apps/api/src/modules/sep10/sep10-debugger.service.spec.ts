import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Sep10DebuggerService } from './sep10-debugger.service';
import {
  Keypair,
  Networks,
  Transaction,
  Operation,
  Account,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import axios from 'axios';

// Mock only the request methods the service calls. A bare jest.mock('axios')
// automocks axios.create() too, which breaks the Stellar SDK at import time
// (its Horizon client calls axios.create().interceptors on load).
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = Object.assign(Object.create(actual.default ?? actual), {
    get: jest.fn(),
    post: jest.fn(),
    isAxiosError: jest.fn((err: unknown) => actual.isAxiosError(err)),
  });
  return {
    __esModule: true,
    ...actual,
    default: mocked,
    get: mocked.get,
    post: mocked.post,
    isAxiosError: mocked.isAxiosError,
  };
});
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Sep10DebuggerService', () => {
  let service: Sep10DebuggerService;
  let serverKeypair: Keypair;
  let clientKeypair: Keypair;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [Sep10DebuggerService],
    }).compile();

    service = module.get<Sep10DebuggerService>(Sep10DebuggerService);
    serverKeypair = Keypair.random();
    clientKeypair = Keypair.random();

    jest.clearAllMocks();
  });

  describe('fetchChallenge', () => {
    it('should fetch and parse a valid challenge', async () => {
      const stellarToml = `WEB_AUTH_ENDPOINT="https://anchor.example.com/auth"`;
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());

      mockedAxios.get
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: stellarToml,
          headers: {},
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { transaction: challengeTransaction.toEnvelope().toXDR('base64') },
          headers: {},
        });

      const result = await service.fetchChallenge({
        domain: 'https://anchor.example.com',
        account: clientKeypair.publicKey(),
        network: 'testnet',
      });

      expect(result.challenge).toBeDefined();
      expect(result.challenge.operations).toHaveLength(1);
      expect(result.challenge.operations[0].type).toBe('manageData');
      expect(result.httpDiagnostics).toBeDefined();
      expect(result.validationChecks).toBeDefined();
    });

    it('should handle missing WEB_AUTH_ENDPOINT in stellar.toml', async () => {
      const stellarToml = `FEDERATION_SERVER="https://anchor.example.com/federation"`;

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: stellarToml,
        headers: {},
      });

      await expect(
        service.fetchChallenge({
          domain: 'https://anchor.example.com',
          account: clientKeypair.publicKey(),
          network: 'testnet',
        }),
      ).rejects.toThrow('No WEB_AUTH_ENDPOINT found in stellar.toml');
    });

    it('should handle network errors with diagnostics', async () => {
      const error = new Error('Network Error');
      Object.assign(error, {
        isAxiosError: true,
        config: { method: 'get', url: 'https://anchor.example.com/.well-known/stellar.toml' },
        response: { status: 500, statusText: 'Internal Server Error', data: 'Error', headers: {} },
      });

      mockedAxios.get.mockRejectedValueOnce(error);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(
        service.fetchChallenge({
          domain: 'https://anchor.example.com',
          account: clientKeypair.publicKey(),
          network: 'testnet',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('redacts authorization header from request diagnostics', async () => {
      const stellarToml = `WEB_AUTH_ENDPOINT="https://anchor.example.com/auth"`;
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());

      mockedAxios.get
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: stellarToml,
          // Response carries a sensitive header that should be redacted
          headers: { authorization: 'Bearer anchor-internal-token' },
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { transaction: challengeTransaction.toEnvelope().toXDR('base64') },
          headers: { authorization: 'Bearer challenge-token', 'content-type': 'application/json' },
        });

      const result = await service.fetchChallenge({
        domain: 'https://anchor.example.com',
        account: clientKeypair.publicKey(),
        network: 'testnet',
      });

      // The raw token must not appear anywhere in the diagnostics
      const diagnosticsJson = JSON.stringify(result.httpDiagnostics);
      expect(diagnosticsJson).not.toContain('Bearer anchor-internal-token');
      expect(diagnosticsJson).not.toContain('Bearer challenge-token');
      expect(result.httpDiagnostics.response.headers['authorization']).toBe('[REDACTED]');
    });

    it('redacts proxy-authorization from response diagnostics', async () => {
      const stellarToml = `WEB_AUTH_ENDPOINT="https://anchor.example.com/auth"`;
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());

      mockedAxios.get
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: stellarToml,
          headers: {},
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { transaction: challengeTransaction.toEnvelope().toXDR('base64') },
          headers: { 'proxy-authorization': 'Basic dXNlcjpwYXNz' },
        });

      const result = await service.fetchChallenge({
        domain: 'https://anchor.example.com',
        account: clientKeypair.publicKey(),
        network: 'testnet',
      });

      expect(result.httpDiagnostics.response.headers['proxy-authorization']).toBe('[REDACTED]');
      expect(JSON.stringify(result.httpDiagnostics)).not.toContain('dXNlcjpwYXNz');
    });
  });

  describe('validateChallenge', () => {
    it('should validate a correct challenge', async () => {
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());
      challengeTransaction.sign(serverKeypair);

      const result = await service.validateChallenge({
        challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        serverAccountId: serverKeypair.publicKey(),
        clientAccountId: clientKeypair.publicKey(),
        network: 'testnet',
      });

      expect(result.challenge).toBeDefined();
      expect(result.validationChecks).toBeDefined();

      const networkCheck = result.validationChecks.find(
        (check) => check.name === 'Network Passphrase',
      );
      expect(networkCheck?.passed).toBe(true);

      const sourceAccountCheck = result.validationChecks.find(
        (check) => check.name === 'Source Account',
      );
      expect(sourceAccountCheck?.passed).toBe(true);
    });

    it('should detect invalid server signature', async () => {
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());
      const wrongKeypair = Keypair.random();
      challengeTransaction.sign(wrongKeypair); // Sign with wrong keypair

      const result = await service.validateChallenge({
        challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        serverAccountId: serverKeypair.publicKey(),
        clientAccountId: clientKeypair.publicKey(),
        network: 'testnet',
      });

      const signatureCheck = result.validationChecks.find(
        (check) => check.name === 'Server Signature Validation',
      );
      expect(signatureCheck?.passed).toBe(false);
    });

    it('should validate home domain', async () => {
      const homeDomain = 'client.example.com';
      const challengeTransaction = createValidChallenge(
        serverKeypair,
        clientKeypair.publicKey(),
        homeDomain,
      );
      challengeTransaction.sign(serverKeypair);

      const result = await service.validateChallenge({
        challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        serverAccountId: serverKeypair.publicKey(),
        clientAccountId: clientKeypair.publicKey(),
        network: 'testnet',
        homeDomain,
      });

      const domainCheck = result.validationChecks.find(
        (check) => check.name === 'Home Domain Validation',
      );
      expect(domainCheck?.passed).toBe(true);
    });

    it('should detect wrong network passphrase', async () => {
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());
      challengeTransaction.sign(serverKeypair);

      const result = await service.validateChallenge({
        challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        serverAccountId: serverKeypair.publicKey(),
        clientAccountId: clientKeypair.publicKey(),
        network: 'mainnet', // Challenge was created for testnet
      });

      const networkCheck = result.validationChecks.find(
        (check) => check.name === 'Network Passphrase',
      );
      expect(networkCheck?.passed).toBe(false);
    });
  });

  describe('signChallenge', () => {
    it('should sign a challenge and redact secrets', async () => {
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());

      const result = await service.signChallenge({
        challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        clientKeypair: clientKeypair.secret(),
      });

      expect(result.signedXdr).toBeDefined();
      expect(result.signatures).toHaveLength(1);
      expect(result.redactionNotice).toContain('redacted');

      // Verify the transaction is actually signed
      const signedTransaction = new Transaction(result.signedXdr, Networks.TESTNET);
      expect(signedTransaction.signatures).toHaveLength(1);
    });

    it('should support client domain signing', async () => {
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());
      const clientDomainKeypair = Keypair.random();

      const result = await service.signChallenge({
        challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        clientKeypair: clientKeypair.secret(),
        clientDomainKeypair: clientDomainKeypair.secret(),
      });

      expect(result.signatures).toHaveLength(2);

      const signedTransaction = new Transaction(result.signedXdr, Networks.TESTNET);
      expect(signedTransaction.signatures).toHaveLength(2);
    });

    it('should handle invalid secret keys', async () => {
      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());

      await expect(
        service.signChallenge({
          challengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
          clientKeypair: 'INVALID_SECRET',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('exchangeToken', () => {
    it('should exchange token and redact sensitive data', async () => {
      const stellarToml = `WEB_AUTH_ENDPOINT="https://anchor.example.com/auth"`;
      const mockToken =
        'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJhbmNob3IuZXhhbXBsZS5jb20iLCJzdWIiOiJHQUFBQUFBQSIsImlhdCI6MTYzMDUyNjQwMCwiZXhwIjoxNjMwNTMwMDAwfQ.signature';

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: stellarToml,
        headers: {},
      });

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { token: mockToken },
        headers: {},
      });

      const challengeTransaction = createValidChallenge(serverKeypair, clientKeypair.publicKey());
      challengeTransaction.sign(clientKeypair);

      const result = await service.exchangeToken({
        signedChallengeXdr: challengeTransaction.toEnvelope().toXDR('base64'),
        domain: 'https://anchor.example.com',
      });

      expect(result.token).toBe('[REDACTED_FOR_SECURITY]');
      expect(result.decodedClaims).toBeDefined();
      expect(result.decodedClaims.iss).toBe('anchor.example.com');
      expect(result.httpDiagnostics).toBeDefined();
      expect(result.httpDiagnostics.request.body.transaction).toBe('[REDACTED_XDR]');
      expect(result.redactionNotice).toContain('redacted');
    });

    it('should handle token exchange failures', async () => {
      const stellarToml = `WEB_AUTH_ENDPOINT="https://anchor.example.com/auth"`;

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: stellarToml,
        headers: {},
      });

      const error = new Error('Unauthorized');
      Object.assign(error, {
        isAxiosError: true,
        config: { method: 'post', url: 'https://anchor.example.com/auth' },
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: { error: 'Invalid signature' },
          headers: {},
        },
      });

      mockedAxios.post.mockRejectedValueOnce(error);
      mockedAxios.isAxiosError.mockReturnValueOnce(true);

      await expect(
        service.exchangeToken({
          signedChallengeXdr: 'invalid_xdr',
          domain: 'https://anchor.example.com',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // Helper function to create a valid SEP-10 challenge
  function createValidChallenge(
    serverKeypair: Keypair,
    clientAccountId: string,
    homeDomain?: string,
  ): Transaction {
    const serverAccount = new Account(serverKeypair.publicKey(), '0');
    const now = Math.floor(Date.now() / 1000);
    const transaction = new TransactionBuilder(serverAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      timebounds: {
        minTime: now - 300, // 5 minutes ago
        maxTime: now + 300, // 5 minutes from now
      },
    });

    // Add manage_data operation
    const dataName = homeDomain ? `${homeDomain} auth` : 'anchor.example.com auth';
    const randomBytes = Buffer.from(
      Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)),
    );

    transaction.addOperation(
      Operation.manageData({
        name: dataName,
        value: randomBytes,
        source: clientAccountId,
      }),
    );

    return transaction.build();
  }
});
