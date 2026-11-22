import * as fs from 'fs';
import * as path from 'path';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BoundedTtlMap } from '../../common/bounded-ttl-map';
import { InjectRepository } from '@nestjs/typeorm';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { Repository } from 'typeorm';
import { SaveApiKeyDto } from './dto/save-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { ListHistoryDto } from './dto/list-history.dto';
import { ApiKey, ApiKeyProvider } from './entities/api-key.entity';
import { PlaygroundHistory } from './entities/playground-history.entity';
import { ProxyRequestDto } from './dto/proxy-request.dto';
import { AuthService } from '../auth/auth.service';
import {
  assertRelativePath,
  assertSafeDestination,
  MAX_SAFE_REDIRECTS,
} from '../../common/ssrf-guard';
import { EncryptionService, ENCRYPTION_PURPOSES } from '../../common/encryption.service';
import { redactHeaders } from '../../common/redaction';

interface CachedSpec {
  spec: Record<string, unknown>;
  fetchedAt: number;
}

/**
 * One entry per provider, plus headroom for the custom-provider origin split.
 * A stale copy outlives its freshness window (see `specCache`).
 */
const MAX_CACHED_SPECS = 32;
const CACHED_SPEC_STALE_WINDOWS = 10;

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

export type DiffChangeType = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffEntry {
  path: string;
  type: DiffChangeType;
  before?: unknown;
  after?: unknown;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const SPEC_SALT = 'savitools-playground-spec-cache';

/** Default playground spec cache TTL (1 hour). */
export const DEFAULT_SPEC_TTL_MS = 3_600_000;
/** Maximum number of history entries retained per user. */
export const PLAYGROUND_HISTORY_LIMIT = 50;

/** Maximum response size in bytes (10MB) */
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

/**
 * Parse `PLAYGROUND_SPEC_TTL_MS` into a number. Env values are strings, so a
 * raw `get<number>()` would silently yield `NaN`. An absent value falls back to
 * the default; anything else must be a positive integer (startup validation
 * rejects invalid values at boot, and this throws as a defensive backstop).
 */
export function parseSpecTtlMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_SPEC_TTL_MS;
  }

  const invalid = (): never => {
    throw new Error(
      `PLAYGROUND_SPEC_TTL_MS must be a positive integer number of milliseconds (received "${raw}")`,
    );
  };

  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : invalid();
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      return invalid();
    }
    const parsed = Number(trimmed);
    return parsed > 0 ? parsed : invalid();
  }

  return invalid();
}

/**
 * Keep only the newest `keep` history rows for `userId` in a single bounded
 * statement. Uses `DELETE ... WHERE id NOT IN (SELECT ... ORDER BY created_at
 * DESC LIMIT keep)` instead of a full `count()`, and is correct for users with
 * fewer than, exactly, or more than `keep` entries. Returns the number of rows
 * deleted.
 */
export async function prunePlaygroundHistory(
  repository: Repository<PlaygroundHistory>,
  userId: string,
  keep: number = PLAYGROUND_HISTORY_LIMIT,
): Promise<number> {
  // Subquery selecting the ids to keep. Built with a SELECT builder and embedded
  // into the DELETE; the shared `:userId` parameter is registered on the delete
  // builder below.
  const newestIds = repository
    .createQueryBuilder('history')
    .select('history.id')
    .where('history.userId = :userId', { userId })
    .orderBy('history.createdAt', 'DESC')
    .addOrderBy('history.id', 'DESC')
    .limit(keep)
    .getQuery();

  const result = await repository
    .createQueryBuilder()
    .delete()
    .from(PlaygroundHistory)
    .where('user_id = :userId', { userId })
    .andWhere(`id NOT IN (${newestIds})`)
    .setParameter('userId', userId)
    .execute();

  return result.affected ?? 0;
}

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger(PlaygroundService.name);
  /**
   * Provider OpenAPI documents, keyed by provider. The freshness window is
   * `specTtlMs` and is checked per read; the map itself is bounded and keeps a
   * stale copy for a few windows, which is what the refresh-failure fallback
   * below serves (Savitura/Savitools#291).
   */
  private readonly specCache: BoundedTtlMap<string, CachedSpec>;
  private readonly specTtlMs: number;

  /**
   * Compute a display mask for an API key: first 8 chars + '...' + last 4 chars.
   * Extracted to a single helper to avoid duplication and ensure consistency.
   */
  private static maskApiKey(plaintext: string): string {
    if (plaintext.length <= 12) {
      return plaintext; // Too short to mask meaningfully
    }
    return plaintext.slice(0, 8) + '...' + plaintext.slice(-4);
  }

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeysRepository: Repository<ApiKey>,
    @InjectRepository(PlaygroundHistory)
    private readonly historyRepository: Repository<PlaygroundHistory>,
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly encryptionService: EncryptionService,
  ) {
    this.specTtlMs = parseSpecTtlMs(this.configService.get('PLAYGROUND_SPEC_TTL_MS'));
    this.specCache = new BoundedTtlMap({
      maxEntries: MAX_CACHED_SPECS,
      ttlMs: this.specTtlMs * CACHED_SPEC_STALE_WINDOWS,
    });
  }

  async getSpec(provider: ApiKeyProvider): Promise<Record<string, unknown>> {
    const cached = this.specCache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < this.specTtlMs) {
      return cached.spec;
    }

    const baseUrl = this.getProviderBaseUrl(provider);
    if (!baseUrl) {
      const bundled = this.loadBundledSpec(provider);
      if (bundled) {
        this.specCache.set(provider, { spec: bundled, fetchedAt: Date.now() });
        return bundled;
      }
      throw new BadRequestException(`${provider} API URL is not configured`);
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/openapi.json`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        if (cached) {
          this.logger.warn(`Failed to refresh ${provider} spec, serving stale cache`);
          return cached.spec;
        }
        const bundled = this.loadBundledSpec(provider);
        if (bundled) {
          this.specCache.set(provider, { spec: bundled, fetchedAt: Date.now() });
          return bundled;
        }
        throw new BadGatewayException(
          `Failed to fetch ${provider} OpenAPI spec: ${response.status}`,
        );
      }

      const spec = (await response.json()) as Record<string, unknown>;
      this.specCache.set(provider, { spec, fetchedAt: Date.now() });
      return spec;
    } catch (error) {
      if (cached) {
        this.logger.warn(`Error refreshing ${provider} spec, serving stale cache: ${error}`);
        return cached.spec;
      }
      const bundled = this.loadBundledSpec(provider);
      if (bundled) {
        this.specCache.set(provider, { spec: bundled, fetchedAt: Date.now() });
        return bundled;
      }
      throw new BadGatewayException(`Failed to fetch ${provider} OpenAPI spec`);
    }
  }

  private loadBundledSpec(provider: ApiKeyProvider): Record<string, unknown> | null {
    try {
      const specName = provider.toLowerCase();
      const candidates = [
        path.join(__dirname, '..', 'sdkgen', 'specs', `${specName}.json`),
        path.join(__dirname, 'modules', 'sdkgen', 'specs', `${specName}.json`),
        path.join(
          process.cwd(),
          'apps',
          'api',
          'src',
          'modules',
          'sdkgen',
          'specs',
          `${specName}.json`,
        ),
        path.join(
          process.cwd(),
          'apps',
          'api',
          'dist',
          'modules',
          'sdkgen',
          'specs',
          `${specName}.json`,
        ),
      ];
      for (const specPath of candidates) {
        if (fs.existsSync(specPath)) {
          return JSON.parse(fs.readFileSync(specPath, 'utf8'));
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to load bundled spec for ${provider}: ${error}`);
    }
    return null;
  }

  async proxyRequest(userId: string, dto: ProxyRequestDto): Promise<ProxyResult> {
    let baseUrl: string | null;
    let key: ApiKey | null;

    if (dto.provider === ApiKeyProvider.CUSTOM) {
      key = await this.findUserKey(userId, dto.provider);
      if (!key) {
        throw new NotFoundException(
          `No ${dto.provider} API key stored. Save one in Playground → Key Manager or the Vault first.`,
        );
      }
      baseUrl = this.getProviderBaseUrl(dto.provider, { providerOrigin: key.providerOrigin });
      if (!baseUrl) {
        throw new BadRequestException(`${dto.provider} provider origin is not configured`);
      }
    } else {
      baseUrl = this.getProviderBaseUrl(dto.provider);
      if (!baseUrl) {
        if (dto.provider === ApiKeyProvider.FLUXA) {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: {
              mock: true,
              provider: 'fluxa',
              message: 'Fluxa API is not hosted publicly yet. This is a local sandbox response.',
              path: dto.path,
              method: dto.method,
              timestamp: new Date().toISOString(),
            },
            latencyMs: 12,
          };
        }
        throw new BadRequestException(`${dto.provider} API URL is not configured`);
      }

      key = await this.findUserKey(userId, dto.provider);
      if (!key) {
        // Fall back to the vault / connected accounts for key injection
        const vaultKey = await this.authService.resolveKey(userId, dto.provider);
        if (!vaultKey) {
          throw new NotFoundException(
            `No ${dto.provider} API key stored. Save one in Playground → Key Manager or the Vault first.`,
          );
        }
        return this.executeProxyRequest(userId, dto, vaultKey, baseUrl);
      }
    }

    if (!baseUrl) {
      throw new BadRequestException(`${dto.provider} API URL is not configured`);
    }

    const decryptedKey = await this.decryptAndUpgrade(userId, key!);
    return this.executeProxyRequest(userId, dto, decryptedKey, baseUrl);
  }

  private async executeProxyRequest(
    userId: string,
    dto: ProxyRequestDto,
    apiKey: string,
    baseUrl: string,
  ): Promise<ProxyResult> {
    assertRelativePath(dto.path);

    const url = new URL(dto.path, baseUrl);
    if (dto.query) {
      for (const [key, value] of Object.entries(dto.query)) {
        url.searchParams.set(key, value);
      }
    }

    const allowedOrigins = [new URL(baseUrl).origin];
    await assertSafeDestination(url, allowedOrigins);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...dto.headers,
    };
    delete headers.authorization;

    if (dto.body && dto.method !== 'GET' && dto.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
    }

    const start = Date.now();

    let response: Response;
    let target = url;
    try {
      const requestInit = {
        method: dto.method.toUpperCase(),
        headers: {
          ...headers,
          Authorization: `Bearer ${apiKey}`,
        },
        body:
          dto.body && dto.method !== 'GET' && dto.method !== 'HEAD'
            ? JSON.stringify(dto.body)
            : undefined,
        signal: AbortSignal.timeout(30_000),
        redirect: 'manual' as const,
      };

      response = await fetch(target.toString(), requestInit);

      let hops = 0;
      while (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.has('location')
      ) {
        if (++hops > MAX_SAFE_REDIRECTS) {
          throw new BadGatewayException(`Too many redirects from ${dto.provider}`);
        }

        const location = response.headers.get('location')!;
        target = new URL(location, target);
        await assertSafeDestination(target, allowedOrigins);

        response = await fetch(target.toString(), {
          ...requestInit,
          // Redirects for non-GET/HEAD methods should be re-issued as GET
          // per the 303 spec, and it's the safer default for the rest too.
          method: response.status === 303 ? 'GET' : requestInit.method,
          body: response.status === 303 ? undefined : requestInit.body,
        });
      }
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadGatewayException(`Request to ${dto.provider} failed: ${error}`);
    }

    const latencyMs = Date.now() - start;

    // Check response size before reading body
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new BadGatewayException(
        `Response from ${dto.provider} exceeds maximum size limit (${MAX_RESPONSE_SIZE} bytes)`,
      );
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let body: unknown;
    const contentType = response.headers.get('content-type') ?? '';

    try {
      if (contentType.includes('application/json')) {
        // Read response with size limit
        const text = await this.readResponseWithLimit(response, MAX_RESPONSE_SIZE);
        body = JSON.parse(text);
      } else {
        body = await this.readResponseWithLimit(response, MAX_RESPONSE_SIZE);
      }
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }
      throw new BadGatewayException(`Failed to read response from ${dto.provider}: ${error}`);
    }

    this.logger.log(
      `[proxy] ${dto.provider} ${dto.method} ${dto.path} → ${response.status} (${latencyMs}ms)`,
    );

    await this.recordHistory(userId, dto, {
      status: response.status,
      headers: responseHeaders,
      body,
      latencyMs,
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body,
      latencyMs,
    };
  }

  /**
   * Read response body with size limit enforcement.
   * Throws BadGatewayException if response exceeds MAX_RESPONSE_SIZE.
   */
  private async readResponseWithLimit(response: Response, maxSize: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      return '';
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        if (value) {
          totalSize += value.length;

          if (totalSize > maxSize) {
            reader.cancel();
            throw new BadGatewayException(`Response exceeds maximum size limit (${maxSize} bytes)`);
          }

          chunks.push(value);
        }
      }

      // Combine all chunks into a single Uint8Array
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Decode as UTF-8 text
      return new TextDecoder().decode(combined);
    } finally {
      reader.releaseLock();
    }
  }

  private async recordHistory(
    userId: string,
    dto: ProxyRequestDto,
    result: ProxyResult,
  ): Promise<void> {
    try {
      const scrubHeaders = (headers: Record<string, string> | null | undefined) => {
        if (!headers) return null;
        return redactHeaders(headers);
      };

      const entry = this.historyRepository.create({
        userId,
        provider: dto.provider,
        method: dto.method.toUpperCase(),
        path: dto.path,
        query: dto.query ?? null,
        requestHeaders: scrubHeaders(dto.headers),
        requestBody: dto.body ?? null,
        responseStatus: result.status,
        responseHeaders: scrubHeaders(result.headers) as Record<string, string>,
        responseBody: result.body,
        latencyMs: result.latencyMs,
      });
      await this.historyRepository.save(entry);

      // Keep only the newest PLAYGROUND_HISTORY_LIMIT entries for this user in a
      // single bounded statement: no full-table count, and correct whether the
      // user has fewer than, exactly, or more than the limit.
      await prunePlaygroundHistory(this.historyRepository, userId);
    } catch (error) {
      this.logger.warn(`Failed to record playground history: ${error}`);
    }
  }

  async listHistory(
    userId: string,
    query: ListHistoryDto,
  ): Promise<{ items: PlaygroundHistory[]; total: number }> {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;

    const [items, total] = await this.historyRepository.findAndCount({
      where: {
        userId,
        ...(query.provider ? { provider: query.provider } : {}),
      },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total };
  }

  async getHistoryEntry(id: string, userId: string): Promise<PlaygroundHistory> {
    const entry = await this.historyRepository.findOne({ where: { id, userId } });
    if (!entry) {
      throw new NotFoundException('History entry not found');
    }
    return entry;
  }

  async diffHistory(idA: string, idB: string, userId: string): Promise<DiffEntry[]> {
    const [entryA, entryB] = await Promise.all([
      this.getHistoryEntry(idA, userId),
      this.getHistoryEntry(idB, userId),
    ]);

    return diffValues(entryA.responseBody, entryB.responseBody, '$');
  }

  async saveKey(
    userId: string,
    dto: SaveApiKeyDto,
  ): Promise<{ id: string; label: string; provider: ApiKeyProvider }> {
    const existing = await this.apiKeysRepository.findOne({
      where: { userId, provider: dto.provider, label: dto.label },
    });

    if (existing) {
      throw new BadRequestException(
        `A key with label "${dto.label}" already exists for ${dto.provider}`,
      );
    }

    const { encrypted, iv, authTag } = this.encryptionService.encryptForUser(
      userId,
      dto.apiKey,
      ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
    );

    const key = this.apiKeysRepository.create({
      userId,
      provider: dto.provider,
      label: dto.label,
      encryptedKey: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      // Persist the mask up front so the list endpoints never decrypt a key
      // that was created after this change.
      maskedKey: PlaygroundService.maskApiKey(dto.apiKey),
      keyPreview: PlaygroundService.maskApiKey(dto.apiKey),
    });

    const saved = await this.apiKeysRepository.save(key);
    return { id: saved.id, label: saved.label, provider: saved.provider };
  }

  async listKeys(userId: string): Promise<
    Array<{
      id: string;
      label: string;
      provider: ApiKeyProvider;
      maskedKey: string;
      createdAt: Date;
    }>
  > {
    const keys = await this.apiKeysRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    // Use Promise.allSettled so one undecryptable key doesn't break the entire listing
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        // The mask is resolved by `maskFor`, which is the single reader of the
        // `maskedKey` column: it serves the stored mask when there is one and
        // otherwise pays exactly one decrypt and persists the mask.
        return {
          id: key.id,
          label: key.label,
          provider: key.provider,
          maskedKey: await this.maskFor(userId, key),
          createdAt: key.createdAt,
        };
      }),
    );

    // Return only fulfilled results, filtering out rejected ones
    return results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          id: string;
          label: string;
          provider: ApiKeyProvider;
          maskedKey: string;
          createdAt: Date;
        }> => result.status === 'fulfilled',
      )
      .map((result) => result.value);
  }

  async deleteKey(id: string, userId: string): Promise<void> {
    const key = await this.apiKeysRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (key.userId !== userId) {
      throw new ForbiddenException("Cannot delete another user's API key");
    }
    await this.apiKeysRepository.remove(key);
  }

  async importProvider(
    userId: string,
    dto: { name: string; openApiJson: unknown; origin: string; apiKey: string },
  ): Promise<{
    id: string;
    name: string;
    provider: ApiKeyProvider;
    maskedKey: string;
    createdAt: Date;
  }> {
    // Validate the OpenAPI document
    const spec = dto.openApiJson as Record<string, unknown>;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new BadRequestException('Invalid OpenAPI document: must be a JSON object');
    }
    if (!spec.paths) {
      throw new BadRequestException('Invalid OpenAPI document: missing "paths" object');
    }

    // Encrypt the API key
    const { encrypted, iv, authTag } = this.encryptionService.encryptForUser(
      userId,
      dto.apiKey,
      ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
    );

    const key = this.apiKeysRepository.create({
      userId,
      provider: ApiKeyProvider.CUSTOM,
      label: dto.name,
      encryptedKey: encrypted,
      iv,
      authTag,
      keyVersion: 2,
      keyPreview: PlaygroundService.maskApiKey(dto.apiKey),
      providerOrigin: dto.origin,
      openApiSpec: spec,
      maskedKey: maskApiKey(dto.apiKey),
    });

    const saved = await this.apiKeysRepository.save(key);
    return {
      id: saved.id,
      name: saved.label,
      provider: saved.provider,
      maskedKey: saved.keyPreview!,
      createdAt: saved.createdAt,
    };
  }

  async listProviders(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      provider: ApiKeyProvider;
      origin: string | null;
      hasSpec: boolean;
      maskedKey: string;
      createdAt: Date;
    }>
  > {
    const keys = await this.apiKeysRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    // Use Promise.allSettled to prevent one bad key from breaking the entire listing
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        // Same single reader as `listKeys`; see the note there.
        return {
          id: key.id,
          name: key.label,
          provider: key.provider,
          origin: key.providerOrigin,
          hasSpec: !!key.openApiSpec,
          maskedKey: await this.maskFor(userId, key),
          createdAt: key.createdAt,
        };
      }),
    );

    // Return only fulfilled results
    return results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          id: string;
          name: string;
          provider: ApiKeyProvider;
          origin: string | null;
          hasSpec: boolean;
          maskedKey: string;
          createdAt: Date;
        }> => result.status === 'fulfilled',
      )
      .map((result) => result.value);
  }

  async renameProvider(
    id: string,
    userId: string,
    dto: { name: string },
  ): Promise<{ id: string; name: string; provider: ApiKeyProvider }> {
    const key = await this.apiKeysRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (key.userId !== userId) {
      throw new ForbiddenException("Cannot rename another user's API key");
    }
    key.label = dto.name;
    const saved = await this.apiKeysRepository.save(key);
    return { id: saved.id, name: saved.label, provider: saved.provider };
  }

  async deleteProvider(id: string, userId: string): Promise<void> {
    const key = await this.apiKeysRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (key.userId !== userId) {
      throw new ForbiddenException("Cannot delete another user's API key");
    }
    await this.apiKeysRepository.remove(key);
  }

  async updateKey(
    id: string,
    userId: string,
    dto: UpdateApiKeyDto,
  ): Promise<{ id: string; label: string; provider: ApiKeyProvider }> {
    const key = await this.apiKeysRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (key.userId !== userId) {
      throw new ForbiddenException("Cannot update another user's API key");
    }

    if (dto.label !== undefined) {
      key.label = dto.label;
    }

    if (dto.apiKey !== undefined) {
      const { encrypted, iv, authTag } = this.encryptionService.encryptForUser(
        userId,
        dto.apiKey,
        ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
      );
      key.encryptedKey = encrypted;
      key.iv = iv;
      key.authTag = authTag;
      key.keyVersion = 2;
      // Refresh both mask columns: `maskedKey` is what `maskFor` reads, and
      // leaving a stale one behind would show a previous key's mask.
      key.maskedKey = PlaygroundService.maskApiKey(dto.apiKey);
      key.keyPreview = key.maskedKey;
    }

    const saved = await this.apiKeysRepository.save(key);
    return { id: saved.id, label: saved.label, provider: saved.provider };
  }

  private async findUserKey(userId: string, provider: ApiKeyProvider): Promise<ApiKey | null> {
    return this.apiKeysRepository.findOne({
      where: { userId, provider },
      order: { createdAt: 'DESC' },
    });
  }

  private getProviderBaseUrl(
    provider: ApiKeyProvider,
    key?: { providerOrigin: string | null },
  ): string | null {
    if (provider === ApiKeyProvider.CUSTOM) {
      return key?.providerOrigin ?? null;
    }
    switch (provider) {
      case ApiKeyProvider.FLUXA:
        return this.configService.get<string>('FLUXA_API_URL') ?? null;
      case ApiKeyProvider.CROWDPAY:
        return (
          this.configService.get<string>('CROWDPAY_API_URL') ?? 'https://crowdpay.up.railway.app'
        );
    }
  }

  /** Legacy scheme (pre-encryption-centralization): a single global key derived
   *  from JWT_SECRET, shared across every user. Kept only to decrypt rows that
   *  have not yet been upgraded — see {@link decryptAndUpgrade}. */
  private legacyDeriveKey(): Buffer {
    const secret = this.configService.getOrThrow<string>('JWT_SECRET');
    return pbkdf2Sync(secret, SPEC_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  private legacyDecrypt(encrypted: string, ivHex: string, authTagHex: string): string {
    const key = this.legacyDeriveKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * The display mask for a stored key.
   *
   * Rows written before the `maskedKey` column existed have no mask; they pay
   * for exactly one decrypt (which also re-encrypts legacy material and, on that
   * path, persists the mask in the same update) and every later read is
   * decrypt-free. This is what keeps the list endpoints O(1) decrypts instead of
   * O(keys per request).
   */
  private async maskFor(userId: string, key: ApiKey): Promise<string> {
    if (key.maskedKey) {
      return key.maskedKey;
    }

    const plaintext = await this.decryptAndUpgrade(userId, key);
    if (key.maskedKey) {
      return key.maskedKey;
    }

    const masked = maskApiKey(plaintext);
    await this.apiKeysRepository.update(key.id, { maskedKey: masked });
    key.maskedKey = masked;
    return masked;
  }

  /**
   * Decrypt an API key, transparently re-encrypting it under the new
   * per-user, purpose-bound scheme if it is still on the legacy global key.
   * Idempotent and safe to retry: once a row is `keyVersion: 2` this is a
   * no-op read.
   */
  private async decryptAndUpgrade(userId: string, key: ApiKey): Promise<string> {
    if (key.keyVersion === 2) {
      return this.encryptionService.decryptForUser(
        userId,
        { encrypted: key.encryptedKey, iv: key.iv, authTag: key.authTag },
        ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
      );
    }

    const plaintext = this.legacyDecrypt(key.encryptedKey, key.iv, key.authTag);

    const upgraded = this.encryptionService.encryptForUser(
      userId,
      plaintext,
      ENCRYPTION_PURPOSES.PLAYGROUND_API_KEY,
    );
    const masked = maskApiKey(plaintext);
    await this.apiKeysRepository.update(key.id, {
      encryptedKey: upgraded.encrypted,
      iv: upgraded.iv,
      authTag: upgraded.authTag,
      keyVersion: 2,
      // The plaintext is in hand here, so the mask rides along with the
      // re-encryption instead of costing a decrypt on the next list call.
      maskedKey: masked,
    });
    key.maskedKey = masked;

    return plaintext;
  }
}

/** `first8...last4` of the plaintext — the only part of a stored key we display. */
export function maskApiKey(plaintext: string): string {
  return plaintext.slice(0, 8) + '...' + plaintext.slice(-4);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
      )
    );
  }

  return false;
}

export function diffValues(before: unknown, after: unknown, path = '$'): DiffEntry[] {
  if (deepEqual(before, after)) {
    return [{ path, type: 'unchanged' }];
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const entries: DiffEntry[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (hasBefore && !hasAfter) {
        entries.push({ path: childPath, type: 'removed', before: before[key] });
      } else if (!hasBefore && hasAfter) {
        entries.push({ path: childPath, type: 'added', after: after[key] });
      } else {
        entries.push(...diffValues(before[key], after[key], childPath));
      }
    }
    return entries;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const entries: DiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= before.length) {
        entries.push({ path: childPath, type: 'added', after: after[i] });
      } else if (i >= after.length) {
        entries.push({ path: childPath, type: 'removed', before: before[i] });
      } else {
        entries.push(...diffValues(before[i], after[i], childPath));
      }
    }
    return entries;
  }

  return [{ path, type: 'changed', before, after }];
}
