import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContractsTool } from '@/components/tools/contracts-tool';
import { ContractEventsTool } from '@/components/tools/contract-events-tool';
import * as api from '@/lib/api';

jest.mock('@/lib/api', () => ({
  attachContractAbi: jest.fn(),
  deployContract: jest.fn(),
  encodeContractAbiArguments: jest.fn(),
  getContractAbi: jest.fn(),
  invokeContract: jest.fn(),
  getContractInfo: jest.fn(),
  getContractEvents: jest.fn(),
  replayContractEvents: jest.fn(),
}));

describe('Contracts and Contract Events Tools (Issue #603)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  describe('ContractsTool', () => {
    it('renders deployment and ABI diffing sections', () => {
      render(<ContractsTool />);

      expect(screen.getByRole('heading', { name: /Deploy Contract/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /Compare contract ABIs/i })).toBeInTheDocument();
      expect(screen.getByText(/Drop a/i)).toBeInTheDocument();
    });

    it('validates constructor arguments and rejects invalid JSON formats', () => {
      render(<ContractsTool />);

      const argsInput = screen.getByPlaceholderText(/\["GAIH3YPF3Y6\.\.\.", 1234567890\]/);
      const fakeWasm = new File(['wasm-binary-content'], 'test_contract.wasm', { type: 'application/wasm' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(fileInput, { target: { files: [fakeWasm] } });

      // Enter invalid non-array JSON
      fireEvent.change(argsInput, { target: { value: '{"key": "val"}' } });
      const deployBtn = screen.getByRole('button', { name: /Deploy to Testnet/i });
      fireEvent.click(deployBtn);

      expect(screen.getByText(/Args must be a JSON array/i)).toBeInTheDocument();
      expect(api.deployContract).not.toHaveBeenCalled();

      // Enter malformed JSON
      fireEvent.change(argsInput, { target: { value: 'not-valid-json' } });
      expect(screen.getByText(/Invalid JSON/i)).toBeInTheDocument();
    });

    it('diffs two contract ABIs and categorizes breaking and additive changes', () => {
      render(<ContractsTool />);

      const beforeAbi = JSON.stringify({
        methods: [
          { name: 'transfer', arguments: [{ name: 'to', type: 'address' }], returnType: 'bool' },
          { name: 'legacy_call', arguments: [], returnType: 'void' },
        ],
        events: [],
      });

      const afterAbi = JSON.stringify({
        methods: [
          { name: 'transfer', arguments: [{ name: 'to', type: 'address' }], returnType: 'bool' },
          { name: 'mint', arguments: [{ name: 'amount', type: 'i128' }], returnType: 'void' },
        ],
        events: [],
      });

      const [beforeTextarea, afterTextarea] = screen.getAllByPlaceholderText(
        /\{"methods":\[\.\.\.\],"events":\[\.\.\.\]\}/i
      );

      fireEvent.change(beforeTextarea, { target: { value: beforeAbi } });
      fireEvent.change(afterTextarea, { target: { value: afterAbi } });

      const compareBtn = screen.getByRole('button', { name: /^Compare ABIs$/i });
      fireEvent.click(compareBtn);

      expect(screen.getByText(/^breaking$/i)).toBeInTheDocument();
      expect(screen.getByText(/Removed method legacy_call\./i)).toBeInTheDocument();
      expect(screen.getByText(/^additive$/i)).toBeInTheDocument();
      expect(screen.getByText(/Added method mint\./i)).toBeInTheDocument();
    });
  });

  describe('ContractEventsTool', () => {
    const mockEvents: api.DecodedContractEvent[] = [
      {
        id: 'event-001',
        type: 'contract',
        contractId: 'CAAAA1111222233334444555566667777888899990000AAAABBBBCCCCDDDD',
        txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        pagingToken: 'token-001',
        ledger: 10500,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        inSuccessfulContractCall: true,
        topic: [
          {
            type: 'symbol',
            value: 'transfer',
            raw: 'AAAADAAAAHRyYW5zZmVyAAAA',
          },
        ],
        value: {
          type: 'i128',
          value: '10000000',
          raw: 'AAAAAAA',
        },
      },
    ];

    it('queries events stream and renders decoded event cards', async () => {
      (api.getContractEvents as jest.Mock).mockResolvedValue({
        events: mockEvents,
        latestLedger: 10505,
        cursor: 'next-page-cursor',
      });

      render(<ContractEventsTool />);

      const contractInput = screen.getByPlaceholderText(/^C…$/);
      fireEvent.change(contractInput, {
        target: { value: 'CAAAA1111222233334444555566667777888899990000AAAABBBBCCCCDDDD' },
      });

      const fetchBtn = screen.getByRole('button', { name: /^Fetch events$/i });
      fireEvent.click(fetchBtn);

      await waitFor(() => {
        expect(api.getContractEvents).toHaveBeenCalledWith(
          expect.objectContaining({
            contractId: 'CAAAA1111222233334444555566667777888899990000AAAABBBBCCCCDDDD',
            network: 'testnet',
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('transfer')).toBeInTheDocument();
        expect(screen.getByText(/ledger 10500/i)).toBeInTheDocument();
      });
    });

    it('filters events stream using filter criteria', async () => {
      const multiEvents: api.DecodedContractEvent[] = [
        ...mockEvents,
        {
          id: 'event-002',
          type: 'contract',
          contractId: 'CAAAA1111222233334444555566667777888899990000AAAABBBBCCCCDDDD',
          txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          pagingToken: 'token-002',
          ledger: 10502,
          ledgerClosedAt: '2026-01-01T00:00:00Z',
          inSuccessfulContractCall: true,
          topic: [
            {
              type: 'symbol',
              value: 'mint',
              raw: 'AAAA',
            },
          ],
          value: {
            type: 'i128',
            value: '500',
            raw: 'BBBB',
          },
        },
      ];

      (api.getContractEvents as jest.Mock).mockResolvedValue({
        events: multiEvents,
        latestLedger: 10505,
        cursor: null,
      });

      render(<ContractEventsTool />);

      const contractInput = screen.getByPlaceholderText(/^C…$/);
      fireEvent.change(contractInput, {
        target: { value: 'CAAAA1111222233334444555566667777888899990000AAAABBBBCCCCDDDD' },
      });

      fireEvent.click(screen.getByRole('button', { name: /^Fetch events$/i }));

      await waitFor(() => {
        expect(screen.getByText('transfer')).toBeInTheDocument();
        expect(screen.getByText('mint')).toBeInTheDocument();
      });

      // Add filter criterion: topic contains "mint"
      const filterInput = screen.getByPlaceholderText(/transfer, 1000…/i);
      fireEvent.change(filterInput, { target: { value: 'mint' } });

      const addFilterBtn = screen.getByRole('button', { name: /Add filter/i });
      fireEvent.click(addFilterBtn);

      await waitFor(() => {
        expect(screen.getByText('mint')).toBeInTheDocument();
        expect(screen.queryByText(/ledger 10500/i)).not.toBeInTheDocument();
      });
    });

    it('displays error state when event query fails', async () => {
      (api.getContractEvents as jest.Mock).mockRejectedValue(new Error('RPC node connection failed'));

      render(<ContractEventsTool />);

      const contractInput = screen.getByPlaceholderText(/^C…$/);
      fireEvent.change(contractInput, { target: { value: 'CBADCONTRACT' } });

      fireEvent.click(screen.getByRole('button', { name: /^Fetch events$/i }));

      await waitFor(() => {
        expect(screen.getByText(/RPC node connection failed/i)).toBeInTheDocument();
      });
    });
  });
});
