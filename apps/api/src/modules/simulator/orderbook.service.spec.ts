jest.mock('redis', () => {
  const mockRedisClient = {
    // The service checks `isReady` before issuing commands and `isOpen` before
    // quitting, so the mock has to model connection state (#291).
    isReady: false,
    isOpen: false,
    connect: jest.fn(),
    quit: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    lRange: jest.fn(),
    zAdd: jest.fn(),
    zCard: jest.fn().mockResolvedValue(0),
    zRemRangeByRank: jest.fn(),
    zRemRangeByScore: jest.fn(),
    zRange: jest.fn().mockResolvedValue([]),
    on: jest.fn(),
  };
  return {
    createClient: jest.fn(() => mockRedisClient),
    __mockRedisClient: mockRedisClient,
  };
});

import { BadRequestException } from '@nestjs/common';
import { OrderbookService } from './orderbook.service';
const { __mockRedisClient: mockRedisClient } = jest.requireMock('redis') as {
  __mockRedisClient: Record<string, jest.Mock> & { isReady: boolean; isOpen: boolean };
};

function horizonOrderBookResponse() {
  return {
    bids: [
      { price: '0.1000000', amount: '100.0000000' },
      { price: '0.0990000', amount: '200.0000000' },
      { price: '0.0980000', amount: '50.0000000' },
    ],
    asks: [
      { price: '0.1020000', amount: '150.0000000' },
      { price: '0.1030000', amount: '300.0000000' },
      { price: '0.1040000', amount: '20.0000000' },
    ],
  };
}

const BASE_ACCOUNT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const COUNTER_ACCOUNT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ';

function tradeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '100-0',
    paging_token: '100-0',
    ledger: 100,
    ledger_close_time: '2026-01-10T12:00:00Z',
    trade_type: 'orderbook',
    base_account: BASE_ACCOUNT,
    base_amount: '10.0000000',
    base_asset_type: 'native',
    counter_account: COUNTER_ACCOUNT,
    counter_amount: '1.0000000',
    counter_asset_type: 'credit_alphanum4',
    counter_asset_code: 'USDC',
    counter_asset_issuer: COUNTER_ACCOUNT,
    base_is_seller: true,
    price: { n: '1', d: '10' },
    ...overrides,
  };
}

function horizonRecordsResponse(records: unknown[]) {
  return {
    ok: true,
    json: async () => ({ _embedded: { records } }),
  };
}

describe('OrderbookService', () => {
  let service: OrderbookService;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    // Suites that drive the cached paths directly expect a connected client;
    // the `onModuleInit` suite below flips this back to a cold client.
    mockRedisClient.isReady = true;
    mockRedisClient.isOpen = true;
    service = new OrderbookService({ get: jest.fn(() => 'redis://localhost:6379') } as any);
  });

  afterEach(() => {
    if ((service as any).pollInterval) {
      clearInterval((service as any).pollInterval);
    }
  });

  describe('getOrderbook', () => {
    it('computes spread, mid price, and cumulative levels from Horizon', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => horizonOrderBookResponse(),
      });

      const result = await service.getOrderbook(
        'XLM',
        'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
        'testnet',
      );

      expect(result.bestBid).toBe('0.1000000');
      expect(result.bestAsk).toBe('0.1020000');
      expect(result.midPrice).toBe('0.1010000');
      expect(result.spread).toBe('0.0020000');

      // spreadBps = (0.102 - 0.100) / 0.101 * 10000
      const expectedBps = Math.round(((0.102 - 0.1) / 0.101) * 10000 * 100) / 100;
      expect(result.spreadBps).toBeCloseTo(expectedBps, 2);

      expect(result.bids).toHaveLength(3);
      expect(result.bids[0].cumulativeAmount).toBe('100.0000000');
      expect(result.bids[1].cumulativeAmount).toBe('300.0000000');
      expect(result.bids[2].cumulativeAmount).toBe('350.0000000');
      expect(result.bids[2].cumulativePercent).toBe(100);

      expect(result.asks).toHaveLength(3);
      expect(result.asks[0].cumulativeAmount).toBe('150.0000000');
      expect(result.asks[1].cumulativeAmount).toBe('450.0000000');
      expect(result.asks[2].cumulativeAmount).toBe('470.0000000');

      expect(mockRedisClient.zAdd).toHaveBeenCalledWith(
        'orderbook:active_pairs:testnet',
        [
          expect.objectContaining({
            value: expect.stringContaining('XLM|USDC'),
          }),
        ],
      );
    });

    it('gives a low liquidity score for a thin book', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.10', amount: '1' }],
          asks: [
            { price: '0.11', amount: '1' },
            { price: '5.00', amount: '10000' },
          ],
        }),
      });

      const result = await service.getOrderbook('XLM', 'USDC:ISSUER', 'testnet');
      expect(result.liquidityScore).toBeLessThan(20);
    });

    it('gives a high liquidity score for a deep, tight book', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [
            { price: '0.100', amount: '1000' },
            { price: '0.0995', amount: '1000' },
          ],
          asks: [
            { price: '0.101', amount: '1000' },
            { price: '0.1015', amount: '1000' },
          ],
        }),
      });

      const result = await service.getOrderbook('XLM', 'USDC:ISSUER', 'testnet');
      expect(result.liquidityScore).toBeGreaterThan(70);
    });

    it('throws for an invalid asset string', async () => {
      (service as any).redisClient = mockRedisClient;
      await expect(service.getOrderbook('NOTVALID', 'XLM', 'testnet')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('keeps the Horizon status when the order book error body is not JSON', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => '<html>temporarily unavailable</html>',
      });

      await expect(service.getOrderbook('XLM', 'USDC:ISSUER', 'testnet')).rejects.toThrow(
        'Horizon error (503): <html> temporarily unavailable</html>',
      );
    });
  });

  describe('getHistory', () => {
    it('returns reversed mid-price snapshots from Redis', async () => {
      (service as any).redisClient = mockRedisClient;
      const entries = [
        JSON.stringify({ timestamp: 3, midPrice: '0.12' }),
        JSON.stringify({ timestamp: 2, midPrice: '0.11' }),
        JSON.stringify({ timestamp: 1, midPrice: '0.10' }),
      ];
      mockRedisClient.lRange.mockResolvedValue(entries);

      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');

      expect(result).toHaveLength(3);
      expect(result[0].timestamp).toBe(1);
      expect(result[2].timestamp).toBe(3);
    });

    it('returns empty array on Redis error', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.lRange.mockRejectedValue(new Error('Redis down'));

      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');
      expect(result).toEqual([]);
    });

    it('returns empty array when Redis is not connected', async () => {
      (service as any).redisClient = undefined;
      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');
      expect(result).toEqual([]);
    });

    // ── #285: the sampler's key and this lookup must agree ───────────────────

    it('looks up history under the canonical key for either native spelling', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.lRange.mockReset();
      const entries = [JSON.stringify({ timestamp: 1, midPrice: '0.10' })];
      mockRedisClient.lRange.mockResolvedValue(entries);

      await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');
      expect(mockRedisClient.lRange).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.lRange).toHaveBeenNthCalledWith(
        1,
        'orderbook:history:testnet:XLM|USDC:ISSUER',
        0,
        expect.any(Number),
      );

      // The spelling earlier versions wrote into the active-pair set resolves to
      // the same key, so both land on one read.
      mockRedisClient.lRange.mockClear();
      await service.getHistory('native', 'USDC:ISSUER', 'testnet');
      expect(mockRedisClient.lRange).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.lRange).toHaveBeenNthCalledWith(
        1,
        'orderbook:history:testnet:XLM|USDC:ISSUER',
        0,
        expect.any(Number),
      );
    });

    it('registers the polled pair under the canonical key the sampler uses', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => horizonOrderBookResponse(),
      });

      await service.getOrderbook('XLM', `USDC:${COUNTER_ACCOUNT}`, 'testnet');

      expect(mockRedisClient.zAdd).toHaveBeenCalledWith('orderbook:active_pairs:testnet', [
        { score: expect.any(Number), value: `XLM|USDC:${COUNTER_ACCOUNT}` },
      ]);
    });

    it('still serves history written under the legacy native|… key', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.lRange.mockReset();
      mockRedisClient.lRange
        .mockResolvedValueOnce([])
        .mockResolvedValue([JSON.stringify({ timestamp: 1, midPrice: '0.09' })]);

      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');

      expect(mockRedisClient.lRange).toHaveBeenNthCalledWith(
        1,
        'orderbook:history:testnet:XLM|USDC:ISSUER',
        0,
        expect.any(Number),
      );
      expect(mockRedisClient.lRange).toHaveBeenNthCalledWith(
        2,
        'orderbook:history:testnet:native|USDC:ISSUER',
        0,
        expect.any(Number),
      );
      expect(result).toEqual([{ timestamp: 1, midPrice: '0.09' }]);
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    beforeEach(() => {
      mockRedisClient.isReady = false;
      mockRedisClient.isOpen = false;
      mockRedisClient.connect.mockImplementation(async () => {
        mockRedisClient.isReady = true;
        mockRedisClient.isOpen = true;
      });
    });

    it('connects to Redis, seeds the default pair, and polls', async () => {
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      mockRedisClient.zCard.mockResolvedValue(1);
      mockRedisClient.zRange.mockResolvedValue([
        'XLM|USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
      ]);
      mockRedisClient.lPush.mockResolvedValue(undefined);
      mockRedisClient.lTrim.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => horizonOrderBookResponse(),
      });

      await service.onModuleInit();

      expect(mockRedisClient.connect).toHaveBeenCalled();
      expect(mockRedisClient.zAdd).toHaveBeenCalled();
      expect(mockRedisClient.lPush).toHaveBeenCalled();
    });

    it('retries a failed connection on the next tick instead of degrading for the process lifetime', async () => {
      mockRedisClient.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      mockRedisClient.zRange.mockResolvedValue([]);

      await service.onModuleInit();

      // Nothing could be written while Redis was down...
      expect(mockRedisClient.zAdd).not.toHaveBeenCalled();
      // ...but the poller is running, so the next tick retries.
      expect((service as any).pollInterval).toBeDefined();

      await (service as any).pollActivePairs();

      expect(mockRedisClient.connect).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.zRange).toHaveBeenCalled();
      expect(mockRedisClient.isReady).toBe(true);
    });

    it('says out loud that polling is degraded when Redis is unavailable at boot', async () => {
      mockRedisClient.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const errorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);

      await service.onModuleInit();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('degraded'));
    });

    it('clears interval and quits Redis on destroy', async () => {
      (service as any).redisClient = mockRedisClient;
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      (service as any).pollInterval = setInterval(() => {}, 60000);
      mockRedisClient.isOpen = true;

      await service.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(mockRedisClient.quit).toHaveBeenCalled();
    });

    it('does not quit a client that never opened', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.quit.mockClear();
      mockRedisClient.isOpen = false;

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();

      expect(mockRedisClient.quit).not.toHaveBeenCalled();
    });
  });

  describe('getTrades (#212)', () => {
    const pair = { selling: 'XLM', buying: 'USDC:ISSUER' };

    it('returns mapped trade rows with ledger, close time, assets, amounts, accounts, side, and type', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        horizonRecordsResponse([
          tradeRecord({ id: '200-0', paging_token: '200-0', ledger: 200, trade_type: 'liquidity_pool' }),
        ]),
      );

      const result = await service.getTrades({ ...pair, network: 'testnet' });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0]).toEqual({
        id: '200-0',
        pagingToken: '200-0',
        operationId: '200',
        ledger: 200,
        closeTime: '2026-01-10T12:00:00Z',
        tradeType: 'liquidity_pool',
        baseAsset: 'XLM',
        quoteAsset: `USDC:${COUNTER_ACCOUNT}`,
        price: '0.1000000',
        baseAmount: '10.0000000',
        quoteAmount: '1.0000000',
        buyer: COUNTER_ACCOUNT,
        seller: BASE_ACCOUNT,
        side: 'sell',
      });
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.limit).toBe(50);
    });

    it('queries mainnet Horizon when network is mainnet', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(horizonRecordsResponse([]));
      global.fetch = fetchSpy;

      await service.getTrades({ ...pair, network: 'mainnet' });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://horizon.stellar.org/trades'),
        expect.anything(),
      );
    });

    it('returns an empty tape when Horizon has no trades', async () => {
      global.fetch = jest.fn().mockResolvedValue(horizonRecordsResponse([]));

      const result = await service.getTrades({ ...pair, network: 'testnet' });

      expect(result.trades).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('applies the side filter server-side across pages', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          horizonRecordsResponse([
            tradeRecord({ id: '1-0', paging_token: '1-0', base_is_seller: false }),
            tradeRecord({ id: '1-1', paging_token: '1-1', base_is_seller: false }),
          ]),
        )
        .mockResolvedValueOnce(
          horizonRecordsResponse([
            tradeRecord({ id: '2-0', paging_token: '2-0', base_is_seller: true }),
            tradeRecord({ id: '2-1', paging_token: '2-1', base_is_seller: true }),
          ]),
        );
      global.fetch = fetchMock;

      const result = await service.getTrades({ ...pair, network: 'testnet', limit: 2, side: 'sell' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.trades).toHaveLength(2);
      expect(result.trades.every((t) => t.side === 'sell')).toBe(true);
      expect(result.nextCursor).toBe('2-1');
      expect(result.hasMore).toBe(true);
    });

    it('applies the account filter server-side', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        horizonRecordsResponse([
          tradeRecord({ id: '1-0', paging_token: '1-0', base_account: 'GOTHER', counter_account: 'GELSE' }),
          tradeRecord({ id: '1-1', paging_token: '1-1', base_is_seller: false, base_account: BASE_ACCOUNT, counter_account: COUNTER_ACCOUNT }),
        ]),
      );

      const result = await service.getTrades({
        ...pair,
        network: 'testnet',
        limit: 5,
        account: BASE_ACCOUNT,
      });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].id).toBe('1-1');
      expect(result.trades[0].seller).toBe(COUNTER_ACCOUNT);
      expect(result.trades[0].buyer).toBe(BASE_ACCOUNT);
    });

    it('applies the time window server-side and ends the scan when the window closes', async () => {
      const inWindowSeconds = Math.floor(Date.parse('2026-01-10T12:00:00Z') / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        horizonRecordsResponse([
          tradeRecord({ id: '1-0', paging_token: '1-0', ledger_close_time: '2026-01-10T12:00:00Z' }),
          tradeRecord({ id: '1-1', paging_token: '1-1', ledger_close_time: '2026-01-10T11:00:00Z' }),
        ]),
      );

      const result = await service.getTrades({
        ...pair,
        network: 'testnet',
        limit: 10,
        order: 'desc',
        startTime: inWindowSeconds - 60,
        endTime: inWindowSeconds + 60,
      });

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].id).toBe('1-0');
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('returns a stable cursor when the page limit is reached', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        horizonRecordsResponse([
          tradeRecord({ id: '1-0', paging_token: '1-0' }),
          tradeRecord({ id: '1-1', paging_token: '1-1' }),
        ]),
      );

      const result = await service.getTrades({ ...pair, network: 'testnet', limit: 2 });

      expect(result.trades).toHaveLength(2);
      expect(result.nextCursor).toBe('1-1');
      expect(result.hasMore).toBe(true);
      expect(result.truncated).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('bounds the scan to a fixed number of Horizon pages', async () => {
      const page = () =>
        horizonRecordsResponse([
          tradeRecord({ id: 'a', paging_token: 'a', base_is_seller: false }),
          tradeRecord({ id: 'b', paging_token: 'b', base_is_seller: false }),
          tradeRecord({ id: 'c', paging_token: 'c', base_is_seller: false }),
          tradeRecord({ id: 'd', paging_token: 'd', base_is_seller: false }),
          tradeRecord({ id: 'e', paging_token: 'e', base_is_seller: false }),
        ]);
      const fetchMock = jest
        .fn()
        .mockResolvedValue(page())
        .mockResolvedValue(page())
        .mockResolvedValue(page())
        .mockResolvedValue(page())
        .mockResolvedValue(page());
      global.fetch = fetchMock;

      const result = await service.getTrades({
        ...pair,
        network: 'testnet',
        limit: 5,
        side: 'sell',
      });

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(result.trades).toEqual([]);
      expect(result.truncated).toBe(true);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('e');
    });

    it('returns 400 for an invalid asset filter (filter-error state)', async () => {
      await expect(
        service.getTrades({ selling: 'NOTVALID', buying: 'XLM', network: 'testnet' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns 400 when Horizon is unavailable', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout',
        text: async () => 'upstream timeout',
      });

      await expect(
        service.getTrades({ ...pair, network: 'testnet' }),
      ).rejects.toThrow('Horizon error (504)');
    });
  });

  describe('getQuote (#213)', () => {
    const pair = { selling: 'XLM', buying: 'USDC:ISSUER' };

    function mockBook(book: ReturnType<typeof horizonOrderBookResponse>) {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => book });
    }

    it('fills a buy completely at the best ask with zero price impact', async () => {
      mockBook(horizonOrderBookResponse());

      const result = await service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '100' });

      expect(result.status).toBe('filled');
      expect(result.filledAmount).toBe('100.0000000');
      expect(result.unfilledAmount).toBe('0.0000000');
      expect(result.averagePrice).toBe('0.1020000');
      expect(result.worstPrice).toBe('0.1020000');
      expect(result.bestPrice).toBe('0.1020000');
      expect(result.cost).toBe('10.2000000');
      expect(result.priceImpactBps).toBe(0);
      expect(result.estimatedFee).toBe('100');
      expect(result.levelsConsumed).toBe(1);
    });

    it('walks multiple ask levels, returns a partial fill, and computes exact bps impact', async () => {
      mockBook({
        bids: [],
        asks: [
          { price: '0.1020000', amount: '150.0000000' },
          { price: '0.1030000', amount: '300.0000000' },
        ],
      });

      const result = await service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '500' });

      expect(result.status).toBe('partial');
      expect(result.filledAmount).toBe('450.0000000');
      expect(result.unfilledAmount).toBe('50.0000000');
      expect(result.averagePrice).toBe('0.1026666');
      expect(result.worstPrice).toBe('0.1030000');
      expect(result.bestPrice).toBe('0.1020000');
      expect(result.cost).toBe('46.2000000');
      // (0.1026666 - 0.1020000) / 0.1020000 * 10000 = 65.35... -> 65
      expect(result.priceImpactBps).toBe(65);
      expect(result.levelsConsumed).toBe(2);
      expect(result.estimatedFee).toBe('100');
    });

    it('never fills beyond available depth', async () => {
      mockBook(horizonOrderBookResponse());

      const result = await service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '9999' });

      expect(result.status).toBe('partial');
      expect(result.filledAmount).toBe('470.0000000');
      expect(result.unfilledAmount).toBe('9529.0000000');
      expect(result.levelsConsumed).toBe(3);
    });

    it('walks bids in descending price order for a sell', async () => {
      mockBook(horizonOrderBookResponse());

      const result = await service.getQuote({ ...pair, network: 'testnet', side: 'sell', amount: '250' });

      expect(result.status).toBe('filled');
      expect(result.filledAmount).toBe('250.0000000');
      expect(result.unfilledAmount).toBe('0.0000000');
      expect(result.averagePrice).toBe('0.0994000');
      expect(result.bestPrice).toBe('0.1000000');
      expect(result.worstPrice).toBe('0.0990000');
      expect(result.cost).toBe('24.8500000');
      // (0.1000000 - 0.0994000) / 0.1000000 * 10000 = 60
      expect(result.priceImpactBps).toBe(60);
      expect(result.levelsConsumed).toBe(2);
    });

    it('aggregates repeating decimals exactly with BigInt fixed-point math', async () => {
      mockBook({
        bids: [],
        asks: [{ price: '0.3333333', amount: '3.0000000' }],
      });

      const result = await service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '3' });

      expect(result.status).toBe('filled');
      expect(result.filledAmount).toBe('3.0000000');
      expect(result.averagePrice).toBe('0.3333333');
      expect(result.cost).toBe('0.9999999');
      expect(result.priceImpactBps).toBe(0);
    });

    it('returns an explicit unfilled result when the side has no depth', async () => {
      mockBook({ bids: [], asks: [] });

      const result = await service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '10' });

      expect(result.status).toBe('unfilled');
      expect(result.filledAmount).toBe('0.0000000');
      expect(result.unfilledAmount).toBe('10.0000000');
      expect(result.averagePrice).toBeNull();
      expect(result.worstPrice).toBeNull();
      expect(result.priceImpactBps).toBeNull();
      expect(result.estimatedFee).toBe('0');
      expect(result.levelsConsumed).toBe(0);
    });

    it('rejects a nonpositive amount', async () => {
      mockBook(horizonOrderBookResponse());

      await expect(
        service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '0' }),
      ).rejects.toThrow('positive');
    });

    it('rejects an amount with more than 7 fractional digits', async () => {
      mockBook(horizonOrderBookResponse());

      await expect(
        service.getQuote({ ...pair, network: 'testnet', side: 'buy', amount: '1.12345678' }),
      ).rejects.toThrow('Invalid decimal');
    });
  });
});
