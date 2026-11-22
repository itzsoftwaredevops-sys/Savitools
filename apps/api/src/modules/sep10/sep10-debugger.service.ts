import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Transaction, Keypair, Networks, Operation, StrKey } from '@stellar/stellar-sdk';
import axios, { AxiosError } from 'axios';
import { ChallengeRequestDto } from './dto/challenge-request.dto';
import { ValidateChallengeDto } from './dto/validate-challenge.dto';
import { SignChallengeDto } from './dto/sign-challenge.dto';
import { TokenExchangeDto } from './dto/token-exchange.dto';
import { redactHeaders } from '../../common/redaction';

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  details?: any;
}

export interface ChallengeDetails {
  xdr: string;
  hash: string;
  networkPassphrase: string;
  sourceAccount: string;
  sequenceNumber: string;
  fee: string;
  memo?: {
    type: string;
    value?: string;
  };
  timeBounds?: {
    minTime: string;
    maxTime: string;
  };
  operations: {
    type: string;
    sourceAccount?: string;
    homeDomain?: string;
    webAuthDomain?: string;
    dataName?: string;
    dataValue?: string;
  }[];
  signatures: {
    publicKey: string;
    signature: string;
  }[];
}

export interface HttpDiagnostics {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: any;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
    timing: number;
  };
}

@Injectable()
export class Sep10DebuggerService {
  private readonly logger = new Logger(Sep10DebuggerService.name);

  /**
   * Fetch a challenge from an anchor domain
   */
  async fetchChallenge(dto: ChallengeRequestDto): Promise<{
    challenge: ChallengeDetails;
    httpDiagnostics: HttpDiagnostics;
    validationChecks: ValidationCheck[];
  }> {
    const startTime = Date.now();

    try {
      // Normalize domain URL
      const domain = dto.domain.endsWith('/') ? dto.domain.slice(0, -1) : dto.domain;
      const challengeUrl = `${domain}/.well-known/stellar.toml`;

      // First, get stellar.toml to find web auth endpoint
      const tomlResponse = await axios.get(challengeUrl, {
        timeout: 10000,
        headers: { Accept: 'text/plain' },
      });

      const webAuthEndpoint = this.parseWebAuthEndpoint(tomlResponse.data);
      if (!webAuthEndpoint) {
        throw new BadRequestException('No WEB_AUTH_ENDPOINT found in stellar.toml');
      }

      // Prepare challenge request
      const challengeParams: any = { account: dto.account };
      if (dto.homeDomain) challengeParams.home_domain = dto.homeDomain;
      if (dto.clientDomain) challengeParams.client_domain = dto.clientDomain;

      const challengeRequestUrl = `${webAuthEndpoint}?${new URLSearchParams(challengeParams).toString()}`;

      // Make challenge request
      const challengeResponse = await axios.get(challengeRequestUrl, {
        timeout: 10000,
        headers: { Accept: 'application/json' },
      });

      const httpDiagnostics: HttpDiagnostics = {
        request: {
          method: 'GET',
          url: challengeRequestUrl,
          headers: redactHeaders({ Accept: 'application/json' }),
        },
        response: {
          status: challengeResponse.status,
          statusText: challengeResponse.statusText,
          headers: redactHeaders(challengeResponse.headers),
          body: challengeResponse.data,
          timing: Date.now() - startTime,
        },
      };

      const challengeXdr = challengeResponse.data.transaction;
      if (!challengeXdr) {
        throw new BadRequestException('No transaction XDR in challenge response');
      }

      // Parse and analyze challenge
      const challenge = this.parseChallenge(challengeXdr, dto.network || 'testnet');
      const validationChecks = this.validateChallengeStructure(challenge, dto);

      return {
        challenge,
        httpDiagnostics,
        validationChecks,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const httpDiagnostics: HttpDiagnostics = {
          request: {
            method: axiosError.config?.method?.toUpperCase() || 'GET',
            url: axiosError.config?.url || '',
            headers: redactHeaders(axiosError.config?.headers || {}),
          },
          response: {
            status: axiosError.response?.status || 0,
            statusText: axiosError.response?.statusText || 'Network Error',
            headers: redactHeaders(axiosError.response?.headers || {}),
            body: axiosError.response?.data,
            timing: Date.now() - startTime,
          },
        };

        throw new BadRequestException({
          message: `Failed to fetch challenge: ${axiosError.message}`,
          httpDiagnostics,
        });
      }

      this.logger.error('Challenge fetch failed:', error);
      throw new BadRequestException(`Failed to fetch challenge: ${error.message}`);
    }
  }

  /**
   * Validate a challenge transaction against SEP-10 rules
   */
  async validateChallenge(dto: ValidateChallengeDto): Promise<{
    challenge: ChallengeDetails;
    validationChecks: ValidationCheck[];
  }> {
    try {
      const challenge = this.parseChallenge(dto.challengeXdr, dto.network || 'testnet');
      const validationChecks = await this.performSep10Validation(challenge, dto);

      return {
        challenge,
        validationChecks,
      };
    } catch (error) {
      this.logger.error('Challenge validation failed:', error);
      throw new BadRequestException(`Challenge validation failed: ${error.message}`);
    }
  }

  /**
   * Sign a challenge transaction (wallet-based signing)
   */
  async signChallenge(dto: SignChallengeDto): Promise<{
    signedXdr: string;
    signatures: { publicKey: string; signature: string }[];
    redactionNotice: string;
  }> {
    try {
      // Redact secret from logs immediately
      this.logger.log('Signing challenge transaction (secrets redacted)');

      const transaction = new Transaction(dto.challengeXdr, Networks.TESTNET);
      const clientKeypair = Keypair.fromSecret(dto.clientKeypair);

      // Sign with client keypair
      transaction.sign(clientKeypair);

      // Sign with client domain keypair if provided
      if (dto.clientDomainKeypair) {
        const clientDomainKeypair = Keypair.fromSecret(dto.clientDomainKeypair);
        transaction.sign(clientDomainKeypair);
      }

      const signatures = transaction.signatures.map((sig) => ({
        publicKey: sig.hint().toString('hex'),
        signature: sig.signature().toString('base64'),
      }));

      return {
        signedXdr: transaction.toEnvelope().toXDR('base64'),
        signatures,
        redactionNotice: 'Secret keys have been redacted from all logs and responses for security',
      };
    } catch (error) {
      this.logger.error('Challenge signing failed (secrets redacted)');
      throw new BadRequestException(`Challenge signing failed: ${error.message}`);
    }
  }

  /**
   * Exchange signed challenge for JWT token
   */
  async exchangeToken(dto: TokenExchangeDto): Promise<{
    token?: string;
    decodedClaims?: any;
    httpDiagnostics: HttpDiagnostics;
    redactionNotice: string;
  }> {
    const startTime = Date.now();

    try {
      // Normalize domain URL
      const domain = dto.domain.endsWith('/') ? dto.domain.slice(0, -1) : dto.domain;

      // Get web auth endpoint from stellar.toml
      const tomlResponse = await axios.get(`${domain}/.well-known/stellar.toml`);
      const webAuthEndpoint = this.parseWebAuthEndpoint(tomlResponse.data);

      if (!webAuthEndpoint) {
        throw new BadRequestException('No WEB_AUTH_ENDPOINT found in stellar.toml');
      }

      // Exchange token
      const tokenResponse = await axios.post(
        webAuthEndpoint,
        {
          transaction: dto.signedChallengeXdr,
        },
        {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' },
        },
      );

      const httpDiagnostics: HttpDiagnostics = {
        request: {
          method: 'POST',
          url: webAuthEndpoint,
          headers: redactHeaders({ 'Content-Type': 'application/json' }),
          body: { transaction: '[REDACTED_XDR]' },
        },
        response: {
          status: tokenResponse.status,
          statusText: tokenResponse.statusText,
          headers: redactHeaders(tokenResponse.headers),
          body: tokenResponse.data,
          timing: Date.now() - startTime,
        },
      };

      const token = tokenResponse.data.token;
      let decodedClaims;

      if (token) {
        // Decode JWT claims (non-sensitive parts only)
        try {
          const payload = token.split('.')[1];
          const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());

          // Only include non-sensitive claims
          decodedClaims = {
            iss: decoded.iss,
            sub: decoded.sub,
            iat: decoded.iat,
            exp: decoded.exp,
            // Redact any potentially sensitive claims
          };
        } catch (decodeError) {
          this.logger.warn('Failed to decode JWT claims');
        }
      }

      return {
        token: token ? '[REDACTED_FOR_SECURITY]' : undefined,
        decodedClaims,
        httpDiagnostics,
        redactionNotice: 'JWT token has been redacted from response for security',
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const httpDiagnostics: HttpDiagnostics = {
          request: {
            method: 'POST',
            url: axiosError.config?.url || '',
            headers: redactHeaders(axiosError.config?.headers || {}),
            body: { transaction: '[REDACTED_XDR]' },
          },
          response: {
            status: axiosError.response?.status || 0,
            statusText: axiosError.response?.statusText || 'Network Error',
            headers: redactHeaders(axiosError.response?.headers || {}),
            body: axiosError.response?.data,
            timing: Date.now() - startTime,
          },
        };

        throw new BadRequestException({
          message: `Token exchange failed: ${axiosError.message}`,
          httpDiagnostics,
          redactionNotice: 'Sensitive data has been redacted for security',
        });
      }

      this.logger.error('Token exchange failed');
      throw new BadRequestException(`Token exchange failed: ${error.message}`);
    }
  }

  private parseChallenge(challengeXdr: string, network: 'testnet' | 'mainnet'): ChallengeDetails {
    const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
    const transaction = new Transaction(challengeXdr, networkPassphrase);

    const challenge: ChallengeDetails = {
      xdr: challengeXdr,
      hash: transaction.hash().toString('hex'),
      networkPassphrase,
      sourceAccount: transaction.source,
      sequenceNumber: transaction.sequence,
      fee: transaction.fee,
      operations: [],
      signatures: transaction.signatures.map((sig) => ({
        publicKey: sig.hint().toString('hex'),
        signature: sig.signature().toString('base64'),
      })),
    };

    // Parse memo
    if (transaction.memo && transaction.memo.type !== 'none') {
      challenge.memo = {
        type: transaction.memo.type,
        value: transaction.memo.value?.toString(),
      };
    }

    // Parse time bounds
    if (transaction.timeBounds) {
      challenge.timeBounds = {
        minTime: transaction.timeBounds.minTime,
        maxTime: transaction.timeBounds.maxTime,
      };
    }

    // Parse operations
    transaction.operations.forEach((op) => {
      if (op.type === 'manageData') {
        const manageDataOp = op as Operation.ManageData;
        challenge.operations.push({
          type: 'manageData',
          sourceAccount: manageDataOp.source,
          dataName: manageDataOp.name,
          dataValue: manageDataOp.value?.toString('base64'),
        });
      } else if (op.type === 'setOptions') {
        const setOptionsOp = op as Operation.SetOptions;
        challenge.operations.push({
          type: 'setOptions',
          sourceAccount: setOptionsOp.source,
          homeDomain: setOptionsOp.homeDomain,
        });
      }
    });

    return challenge;
  }

  private validateChallengeStructure(
    challenge: ChallengeDetails,
    _request: ChallengeRequestDto,
  ): ValidationCheck[] {
    const checks: ValidationCheck[] = [];

    // Check for manage_data operation
    const manageDataOp = challenge.operations.find((op) => op.type === 'manageData');
    checks.push({
      name: 'Manage Data Operation',
      passed: !!manageDataOp,
      message: manageDataOp
        ? 'Challenge contains required manage_data operation'
        : 'Missing manage_data operation',
      details: manageDataOp,
    });

    // Check sequence number is 0
    checks.push({
      name: 'Sequence Number',
      passed: challenge.sequenceNumber === '0',
      message:
        challenge.sequenceNumber === '0'
          ? 'Sequence number is 0 as required'
          : `Invalid sequence number: ${challenge.sequenceNumber}`,
    });

    // Check time bounds
    const hasTimeBounds = !!challenge.timeBounds;
    checks.push({
      name: 'Time Bounds',
      passed: hasTimeBounds,
      message: hasTimeBounds ? 'Challenge has time bounds' : 'Missing time bounds',
      details: challenge.timeBounds,
    });

    if (hasTimeBounds) {
      const now = Math.floor(Date.now() / 1000);
      const minTime = parseInt(challenge.timeBounds!.minTime);
      const maxTime = parseInt(challenge.timeBounds!.maxTime);

      const isValid = now >= minTime && now <= maxTime;
      checks.push({
        name: 'Time Bounds Validity',
        passed: isValid,
        message: isValid
          ? 'Challenge is within valid time bounds'
          : 'Challenge is outside valid time bounds',
        details: { now, minTime, maxTime },
      });
    }

    // Check server signature
    checks.push({
      name: 'Server Signature',
      passed: challenge.signatures.length > 0,
      message:
        challenge.signatures.length > 0
          ? 'Challenge has server signature'
          : 'Missing server signature',
      details: { signatureCount: challenge.signatures.length },
    });

    return checks;
  }

  private async performSep10Validation(
    challenge: ChallengeDetails,
    dto: ValidateChallengeDto,
  ): Promise<ValidationCheck[]> {
    const checks: ValidationCheck[] = [];

    try {
      // Validate transaction structure
      const transaction = new Transaction(
        dto.challengeXdr,
        dto.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
      );

      // Check network passphrase. The passphrase is not part of the XDR, so
      // the only way to tell which network a challenge was built for is to
      // check which network's transaction hash the server signature covers.
      const expectedNetwork = dto.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
      const otherNetwork = expectedNetwork === Networks.PUBLIC ? Networks.TESTNET : Networks.PUBLIC;
      const signedForNetwork = (passphrase: string): boolean => {
        const sig = challenge.signatures[0]?.signature;
        if (!sig || !StrKey.isValidEd25519PublicKey(dto.serverAccountId)) return false;
        const hash = new Transaction(dto.challengeXdr, passphrase).hash();
        return Keypair.fromPublicKey(dto.serverAccountId).verify(hash, Buffer.from(sig, 'base64'));
      };
      const wrongNetwork = !signedForNetwork(expectedNetwork) && signedForNetwork(otherNetwork);
      checks.push({
        name: 'Network Passphrase',
        passed: !wrongNetwork,
        message: wrongNetwork
          ? `Wrong network passphrase: challenge was signed for ${otherNetwork}, expected ${expectedNetwork}`
          : 'Correct network passphrase',
      });

      // Validate server signature
      const serverKeypair = Keypair.fromPublicKey(dto.serverAccountId);
      const serverSignatureValid = serverKeypair.verify(
        transaction.hash(),
        challenge.signatures[0]
          ? Buffer.from(challenge.signatures[0].signature, 'base64')
          : Buffer.alloc(0),
      );

      checks.push({
        name: 'Server Signature Validation',
        passed: serverSignatureValid,
        message: serverSignatureValid ? 'Server signature is valid' : 'Invalid server signature',
      });

      // Validate source account
      checks.push({
        name: 'Source Account',
        passed: challenge.sourceAccount === dto.serverAccountId,
        message:
          challenge.sourceAccount === dto.serverAccountId
            ? 'Source account matches server account'
            : 'Source account does not match server account',
      });

      // Validate home domain if provided
      if (dto.homeDomain) {
        const manageDataOp = challenge.operations.find((op) => op.type === 'manageData');
        const domainMatch = manageDataOp?.dataName === `${dto.homeDomain} auth`;

        checks.push({
          name: 'Home Domain Validation',
          passed: domainMatch,
          message: domainMatch ? 'Home domain matches' : 'Home domain does not match',
          details: { expected: dto.homeDomain, found: manageDataOp?.dataName },
        });
      }

      // Validate web auth domain if provided
      if (dto.webAuthDomain) {
        const setOptionsOp = challenge.operations.find((op) => op.type === 'setOptions');
        const webAuthDomainMatch = setOptionsOp?.homeDomain === dto.webAuthDomain;

        checks.push({
          name: 'Web Auth Domain Validation',
          passed: webAuthDomainMatch,
          message: webAuthDomainMatch
            ? 'Web auth domain matches'
            : 'Web auth domain does not match',
          details: { expected: dto.webAuthDomain, found: setOptionsOp?.homeDomain },
        });
      }
    } catch (error) {
      checks.push({
        name: 'Transaction Parsing',
        passed: false,
        message: `Failed to parse transaction: ${error.message}`,
      });
    }

    return checks;
  }

  private parseWebAuthEndpoint(stellarToml: string): string | null {
    const lines = stellarToml.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('WEB_AUTH_ENDPOINT')) {
        const match = trimmed.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/);
        return match ? match[1] : null;
      }
    }
    return null;
  }

}
