import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SimulatorTool } from '@/components/tools/simulator-tool';
import { OrderbookTool } from '@/components/tools/orderbook-tool';
import * as api from '@/lib/api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/simulator',
}));

jest.mock('@/lib/api', () => ({
  findSimulatorPaths: jest.fn(),
  getPoolQuote: jest.fn(),
  getOrderbook: jest.fn(),
  getOrderbookHistory: jest.fn(),
  getOrderQuote: jest.fn(),
  getTrades: jest.fn(),
}));

jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="recharts-container">{children}</div>,
  AreaChart: ({ children }: any) => <div>{children}</div>,
  Area: () => null,
  LineChart: ({ children }: any) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

describe('Simulator and Orderbook Tools (Issue #602)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('SimulatorTool', () => {
    it('renders simulator inputs and runs path payment simulation', async () => {
      const mockSimulatedPath: api.SimulatedPath = {
        source_asset: { type: 'native', code: 'XLM', label: 'XLM' },
        destination_asset: { type: 'credit_alphanum4', code: 'USDC', issuer: 'GISSUER', label: 'USDC' },
        source_amount: '10.5000000',
        destination_amount: '1.0000000',
        path: [],
        effective_rate: '0.0952',
        estimated_fee: '100',
        recommended_slippage: 0.5,
        hops: 1,
      };

      (api.findSimulatorPaths as jest.Mock).mockResolvedValue({
        paths: [mockSimulatedPath],
        direction: 'strict_send',
      });

      render(<SimulatorTool />);

      expect(screen.getByText('Path Payments')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('10')).toBeInTheDocument();

      const amountInput = screen.getByPlaceholderText('10');
      fireEvent.change(amountInput, { target: { value: '25' } });

      const findBtn = screen.getByRole('button', { name: /find paths/i });
      fireEvent.click(findBtn);

      await waitFor(() => {
        expect(api.findSimulatorPaths).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: '25',
            direction: 'strict_send',
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('10.5000000')).toBeInTheDocument();
        expect(screen.getByText('1.0000000')).toBeInTheDocument();
      });
    });

    it('handles simulation errors gracefully', async () => {
      (api.findSimulatorPaths as jest.Mock).mockRejectedValue(new Error('Horizon pathfinding timeout'));

      render(<SimulatorTool />);

      const amountInput = screen.getByPlaceholderText('10');
      fireEvent.change(amountInput, { target: { value: '50' } });

      const findBtn = screen.getByRole('button', { name: /find paths/i });
      fireEvent.click(findBtn);

      await waitFor(() => {
        expect(screen.getAllByText(/Horizon pathfinding timeout/i)[0]).toBeInTheDocument();
      });
    });

    it('switches to Liquidity Pool tab and requests pool quote', async () => {
      (api.getPoolQuote as jest.Mock).mockResolvedValue({
        scenario: 'deposit',
        poolId: 'pool1234567890abcdef',
        feeBps: 30,
        totalShares: '1000',
        assetA: { asset: 'XLM', reserve: '5000', depositAmount: '100' },
        assetB: { asset: 'USDC', reserve: '5000', depositAmount: '100' },
        sharesReceived: '20',
        shareOfPoolPercent: '2.0',
        minSharesReceived: '19.8',
        priceImpactBps: '5',
      });

      render(<SimulatorTool />);

      const lpTab = screen.getByRole('button', { name: /lp pool quote/i });
      fireEvent.click(lpTab);

      expect(screen.getByText(/Liquidity Pool Quote/i)).toBeInTheDocument();

      const amountAInput = screen.getByPlaceholderText(/e\.g\. 100/i);
      fireEvent.change(amountAInput, { target: { value: '100' } });

      const getQuoteBtn = screen.getByRole('button', { name: /get pool quote/i });
      fireEvent.click(getQuoteBtn);

      await waitFor(() => {
        expect(api.getPoolQuote).toHaveBeenCalled();
        expect(screen.getByText(/Deposit Quote/i)).toBeInTheDocument();
      });
    });
  });

  describe('OrderbookTool', () => {
    const mockOrderbookResult: api.OrderbookResult = {
      selling: 'XLM',
      buying: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      network: 'testnet',
      spread: '0.0010000',
      spreadBps: 8,
      midPrice: '0.1255000',
      bestBid: '0.1250000',
      bestAsk: '0.1260000',
      liquidityScore: 85,
      bids: [
        { price: '0.1250000', amount: '1000.00', cumulativeAmount: 1000, cumulativePercent: 50 },
      ],
      asks: [
        { price: '0.1260000', amount: '800.00', cumulativeAmount: 800, cumulativePercent: 40 },
      ],
      lastUpdated: 1700000000,
    };

    const mockTrade: api.TradeRow = {
      id: 'trade-1',
      pagingToken: 'token-1',
      operationId: 'op-1',
      ledger: 100,
      closeTime: '2026-01-01T00:00:00Z',
      tradeType: 'order_book',
      baseAsset: 'XLM',
      quoteAsset: 'USDC',
      price: '0.1250000',
      baseAmount: '100.0000',
      quoteAmount: '12.5000',
      buyer: 'GBUYER',
      seller: 'GSELLER',
      side: 'buy',
    };

    it('loads orderbook depth, mid-price, and trades on mount', async () => {
      (api.getOrderbook as jest.Mock).mockResolvedValue(mockOrderbookResult);
      (api.getOrderbookHistory as jest.Mock).mockResolvedValue([]);
      (api.getTrades as jest.Mock).mockResolvedValue({
        trades: [mockTrade],
        hasMore: false,
        nextCursor: null,
      });

      render(<OrderbookTool />);

      await waitFor(() => {
        expect(api.getOrderbook).toHaveBeenCalled();
        expect(api.getTrades).toHaveBeenCalled();
        expect(screen.getByText('0.1255000')).toBeInTheDocument();
      });

      expect(screen.getByText('0.0010000')).toBeInTheDocument();
      expect(screen.getByText(/Mid-price \(last 60m\)/i)).toBeInTheDocument();
    });

    it('renders error state when orderbook fetch fails', async () => {
      (api.getOrderbook as jest.Mock).mockRejectedValue(new Error('Failed to reach Horizon node'));
      (api.getOrderbookHistory as jest.Mock).mockResolvedValue([]);
      (api.getTrades as jest.Mock).mockResolvedValue({ trades: [], hasMore: false, nextCursor: null });

      render(<OrderbookTool />);

      await waitFor(() => {
        expect(screen.getAllByText(/Failed to reach Horizon node/i)[0]).toBeInTheDocument();
      });
    });

    it('simulates order fill quote', async () => {
      (api.getOrderbook as jest.Mock).mockResolvedValue(mockOrderbookResult);
      (api.getOrderbookHistory as jest.Mock).mockResolvedValue([]);
      (api.getTrades as jest.Mock).mockResolvedValue({ trades: [], hasMore: false, nextCursor: null });
      (api.getOrderQuote as jest.Mock).mockResolvedValue({
        selling: 'XLM',
        buying: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        network: 'testnet',
        side: 'buy',
        requestedAmount: '10',
        filledAmount: '10',
        unfilledAmount: '0',
        status: 'filled',
        averagePrice: '0.1260000',
        worstPrice: '0.1260000',
        bestPrice: '0.1260000',
        cost: '1.2600000',
        priceImpactBps: 2,
        estimatedFee: '100',
        levelsConsumed: 1,
      });

      render(<OrderbookTool />);

      await waitFor(() => {
        expect(api.getOrderbook).toHaveBeenCalled();
      });

      const quoteBtn = screen.getByRole('button', { name: /estimate/i });
      fireEvent.click(quoteBtn);

      await waitFor(() => {
        expect(api.getOrderQuote).toHaveBeenCalled();
        expect(screen.getByText('1.2600000')).toBeInTheDocument();
      });
    });
  });
});
