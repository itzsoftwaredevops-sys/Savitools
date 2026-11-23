import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorTool } from '@/components/tools/inspector-tool';
import { GraphTool } from '@/components/tools/graph-tool';
import * as api from '@/lib/api';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockGet = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  useSearchParams: () => ({
    get: mockGet,
  }),
}));

jest.mock('@/lib/network-context', () => ({
  useNetwork: () => ({ network: 'testnet' }),
}));

jest.mock('@/components/command-palette', () => ({
  useCommandPalette: () => ({
    registerContextActions: jest.fn(() => jest.fn()),
  }),
  ShortcutBadge: () => null,
}));

jest.mock('@/hooks/use-example-onboarding', () => ({
  useExampleOnboarding: jest.fn(),
}));

jest.mock('@/lib/onboarding', () => ({
  markStepComplete: jest.fn(),
}));

jest.mock('@/lib/recent-items', () => ({
  addRecentItem: jest.fn(),
}));

jest.mock('@/lib/api', () => ({
  decodeXdr: jest.fn(),
  inspectTransaction: jest.fn(),
  getAccountTransactions: jest.fn(),
  downloadCsv: jest.fn(),
  buildAccountGraph: jest.fn(),
}));

jest.mock('d3', () => {
  const createSelection = (elements: Element[]) => {
    return {
      selectAll: (selector: string) => {
        if (selector === '*') {
          return {
            remove: () => {
              elements.forEach((el) => {
                el.innerHTML = '';
              });
            },
          };
        }
        return {
          data: (dataItems: any[]) => ({
            enter: () => ({
              append: (tag: string) => {
                const created: Element[] = [];
                elements.forEach((parent) => {
                  dataItems.forEach((d) => {
                    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
                    (child as any).__data__ = d;
                    parent.appendChild(child);
                    created.push(child);
                  });
                });
                return createSelection(created);
              },
            }),
          }),
        };
      },
      append: (tag: string) => {
        const created: Element[] = [];
        elements.forEach((parent) => {
          const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
          (child as any).__data__ = (parent as any).__data__;
          parent.appendChild(child);
          created.push(child);
        });
        return createSelection(created);
      },
      attr: function (name: string, value: any) {
        elements.forEach((el) => {
          const val = typeof value === 'function' ? value((el as any).__data__) : value;
          el.setAttribute(name, String(val));
        });
        return this;
      },
      style: function (name: string, value: any) {
        elements.forEach((el) => {
          const val = typeof value === 'function' ? value((el as any).__data__) : value;
          (el as HTMLElement).style?.setProperty(name, String(val));
        });
        return this;
      },
      text: function (value: any) {
        elements.forEach((el) => {
          const val = typeof value === 'function' ? value((el as any).__data__) : value;
          el.textContent = String(val);
        });
        return this;
      },
      call: function (fn: any) {
        if (typeof fn === 'function') {
          fn(this);
        }
        return this;
      },
      on: function (event: string, handler: any) {
        elements.forEach((el) => {
          el.addEventListener(event, (e) => {
            handler(e, (el as any).__data__);
          });
        });
        return this;
      },
    };
  };

  return {
    select: (el: any) => {
      const element = el && el.nodeType ? el : (el && el[0]) || document.createElement('div');
      return createSelection([element]);
    },
    forceSimulation: () => ({
      force: jest.fn().mockReturnThis(),
      on: jest.fn().mockReturnThis(),
      stop: jest.fn(),
      alphaTarget: jest.fn().mockReturnThis(),
      restart: jest.fn(),
    }),
    forceLink: () => ({
      id: jest.fn().mockReturnThis(),
      distance: jest.fn().mockReturnThis(),
      strength: jest.fn().mockReturnThis(),
    }),
    forceManyBody: () => ({
      strength: jest.fn().mockReturnThis(),
    }),
    forceCenter: () => ({}),
    forceCollide: () => ({}),
    drag: () => ({
      on: jest.fn().mockReturnThis(),
    }),
    zoom: () => ({
      scaleExtent: jest.fn().mockReturnThis(),
      on: jest.fn().mockReturnThis(),
    }),
  };
});

describe('Inspector and Graph Tools (Issue #604)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReturnValue(null);
  });

  describe('InspectorTool', () => {
    const mockTxBreakdown: api.TransactionBreakdown = {
      hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ledger: 1024,
      createdAt: '2026-01-01T00:00:00Z',
      sourceAccount: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
      sequenceNumber: '1001',
      feeCharged: '100',
      maxFee: '200',
      memo: 'test memo',
      memoType: 'text',
      timeBounds: null,
      signatures: ['sig1'],
      success: true,
      resultCode: 'tx_success',
      resultExplanation: 'All operations succeeded',
      operationCount: 1,
      operations: [
        {
          index: 0,
          type: 'payment',
          label: 'Payment',
          sourceAccount: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
          fields: {
            destination: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
            amount: '50.0000000 XLM',
          },
          resultCode: 'op_success',
          resultExplanation: null,
          success: true,
          effects: [],
        },
      ],
      sorobanEvents: [],
      rawJson: null,
      network: 'testnet',
      composerPayload: null,
    };

    it('renders initial empty state with input prompt', () => {
      render(<InspectorTool />);

      expect(
        screen.getByPlaceholderText(/Transaction hash, Stellar address \(G…\), or raw XDR/i)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Inspect/i })).toBeInTheDocument();
    });

    it('inspects a 64-char transaction hash and displays breakdown details', async () => {
      (api.inspectTransaction as jest.Mock).mockResolvedValue(mockTxBreakdown);

      render(<InspectorTool />);

      const input = screen.getByPlaceholderText(/Transaction hash, Stellar address \(G…\), or raw XDR/i);
      fireEvent.change(input, {
        target: { value: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      });

      const inspectBtn = screen.getByRole('button', { name: /Inspect/i });
      fireEvent.click(inspectBtn);

      await waitFor(() => {
        expect(api.inspectTransaction).toHaveBeenCalledWith(
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          'testnet'
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Payment')).toBeInTheDocument();
        expect(screen.getByText('50.0000000 XLM')).toBeInTheDocument();
        expect(screen.getByText('Operations (1)')).toBeInTheDocument();
      });
    });

    it('decodes raw base64 XDR envelope and displays operations and Soroban event details', async () => {
      const xdrString =
        'AAAAAgAAAAA9Qc1w+uR8w0Wj95+qK3sJg8j4b1c7m2xK9L2O8tW4YgAAAGQAABc3AAACkAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

      const xdrBreakdown: api.TransactionBreakdown = {
        ...mockTxBreakdown,
        operations: [
          {
            index: 0,
            type: 'invokeHostFunction',
            label: 'Invoke Host Function',
            sourceAccount: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
            fields: {
              contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
              functionName: 'transfer',
              authEntries: '1 authorized credential',
            },
            resultCode: 'op_success',
            resultExplanation: null,
            success: true,
            effects: [],
          },
        ],
        sorobanEvents: [
          {
            index: 0,
            contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
            signature: 'transfer(from: Address, to: Address, amount: i128)',
            topics: [
              {
                index: 0,
                friendlyName: 'transfer',
                value: { type: 'symbol', value: 'transfer', raw: 'AAA=' },
                rawHex: '00010203',
              },
            ],
            data: {
              type: 'i128',
              value: '1000000',
              raw: 'AAAA',
            },
            inSuccessfulContractCall: true,
          },
        ],
      };

      (api.decodeXdr as jest.Mock).mockResolvedValue(xdrBreakdown);

      render(<InspectorTool />);

      const input = screen.getByPlaceholderText(/Transaction hash, Stellar address \(G…\), or raw XDR/i);
      fireEvent.change(input, { target: { value: xdrString } });

      fireEvent.click(screen.getByRole('button', { name: /Inspect/i }));

      await waitFor(() => {
        expect(api.decodeXdr).toHaveBeenCalledWith(xdrString, 'testnet');
      });

      await waitFor(() => {
        expect(screen.getByText('Invoke Host Function')).toBeInTheDocument();
        expect(screen.getByText('1 authorized credential')).toBeInTheDocument();
        expect(screen.getByText(/Soroban Events \(1\/1\)/i)).toBeInTheDocument();
        expect(
          screen.getByText('transfer(from: Address, to: Address, amount: i128)')
        ).toBeInTheDocument();
      });
    });

    it('queries account transactions timeline for Stellar public key and handles selection', async () => {
      const mockTxs: api.TxSummary[] = [
        {
          hash: 'aaaabbbbccccdddd0123456789abcdef0123456789abcdef0123456789abcdef',
          createdAt: '2026-01-01T00:00:00Z',
          operationCount: 2,
          success: true,
          feeCharged: '100',
        },
      ];

      (api.getAccountTransactions as jest.Mock).mockResolvedValue(mockTxs);
      (api.inspectTransaction as jest.Mock).mockResolvedValue(mockTxBreakdown);

      render(<InspectorTool />);

      const address = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ';
      const input = screen.getByPlaceholderText(/Transaction hash, Stellar address \(G…\), or raw XDR/i);
      fireEvent.change(input, { target: { value: address } });

      fireEvent.click(screen.getByRole('button', { name: /Inspect/i }));

      await waitFor(() => {
        expect(api.getAccountTransactions).toHaveBeenCalledWith(address, 'testnet');
      });

      await waitFor(() => {
        expect(screen.getByText('Recent Transactions (1)')).toBeInTheDocument();
        expect(screen.getByText(/2 ops/i)).toBeInTheDocument();
      });

      // Clicking inspect on the transaction row triggers inspectTransaction
      const inspectItem = screen.getByText('Inspect →');
      fireEvent.click(inspectItem);

      await waitFor(() => {
        expect(api.inspectTransaction).toHaveBeenCalledWith(
          'aaaabbbbccccdddd0123456789abcdef0123456789abcdef0123456789abcdef',
          'testnet'
        );
      });
    });

    it('displays error state when lookup fails', async () => {
      (api.inspectTransaction as jest.Mock).mockRejectedValue(
        new Error('Transaction not found on testnet Horizon')
      );

      render(<InspectorTool />);

      const input = screen.getByPlaceholderText(/Transaction hash, Stellar address \(G…\), or raw XDR/i);
      fireEvent.change(input, {
        target: { value: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Inspect/i }));

      await waitFor(() => {
        expect(screen.getByText('Inspection failed')).toBeInTheDocument();
        expect(
          screen.getAllByText(/Transaction not found on testnet Horizon/i)[0]
        ).toBeInTheDocument();
      });
    });
  });

  describe('GraphTool', () => {
    const mockGraphResult: api.GraphResult = {
      nodes: [
        {
          id: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
          label: 'Root Account',
          type: 'account',
          metadata: { signerCount: 2 },
        },
        {
          id: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
          label: 'Signer 1',
          type: 'multisig',
          metadata: { signerCount: 1 },
        },
      ],
      edges: [
        {
          source: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
          target: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
          relationship: 'signs_for',
          metadata: {},
        },
      ],
      rootAccount: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
      depth: 2,
      mode: 'signers',
      nodeCount: 2,
      edgeCount: 1,
      truncated: false,
    };

    it('renders controls and validates empty root account', () => {
      render(<GraphTool />);

      expect(screen.getByPlaceholderText(/GABCDEFGH…/i)).toBeInTheDocument();
      const buildBtn = screen.getByRole('button', { name: /Build graph/i });
      fireEvent.click(buildBtn);

      expect(screen.getByText(/Enter a Stellar public key \(G…\)\./i)).toBeInTheDocument();
      expect(api.buildAccountGraph).not.toHaveBeenCalled();
    });

    it('builds account graph and displays nodes, edges count, and canvas', async () => {
      (api.buildAccountGraph as jest.Mock).mockResolvedValue(mockGraphResult);

      render(<GraphTool />);

      const rootInput = screen.getByPlaceholderText(/GABCDEFGH…/i);
      fireEvent.change(rootInput, {
        target: { value: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Build graph/i }));

      await waitFor(() => {
        expect(api.buildAccountGraph).toHaveBeenCalledWith({
          rootAccount: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
          depth: 2,
          mode: 'signers',
          network: 'testnet',
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/2 nodes · 1 edges/i)).toBeInTheDocument();
        expect(screen.getByRole('img', { name: /Account relationship graph/i })).toBeInTheDocument();
      });
    });

    it('handles graph node selection and opens account details drawer', async () => {
      (api.buildAccountGraph as jest.Mock).mockResolvedValue(mockGraphResult);

      render(<GraphTool />);

      const rootInput = screen.getByPlaceholderText(/GABCDEFGH…/i);
      fireEvent.change(rootInput, {
        target: { value: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Build graph/i }));

      await waitFor(() => {
        expect(screen.getByText(/2 nodes · 1 edges/i)).toBeInTheDocument();
      });

      // Find SVG nodes in the rendered D3 group
      const nodeElements = document.querySelectorAll('.nodes g');
      expect(nodeElements.length).toBeGreaterThan(0);

      // Click the first node
      fireEvent.click(nodeElements[0]);

      await waitFor(() => {
        expect(screen.getByText('Account details')).toBeInTheDocument();
        expect(screen.getByText('GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Use as root/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Rebuild from here/i })).toBeInTheDocument();
      });
    });

    it('highlights shortest path between two nodes', async () => {
      (api.buildAccountGraph as jest.Mock).mockResolvedValue(mockGraphResult);

      render(<GraphTool />);

      const rootInput = screen.getByPlaceholderText(/GABCDEFGH…/i);
      fireEvent.change(rootInput, {
        target: { value: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Build graph/i }));

      await waitFor(() => {
        expect(screen.getByText(/Path highlighter/i)).toBeInTheDocument();
      });

      const fromInput = screen.getByPlaceholderText(/Start public key/i);
      const toInput = screen.getByPlaceholderText(/End public key/i);

      fireEvent.change(fromInput, {
        target: { value: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ' },
      });
      fireEvent.change(toInput, {
        target: { value: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H' },
      });

      const highlightBtn = screen.getByRole('button', { name: /Highlight/i });
      fireEvent.click(highlightBtn);

      await waitFor(() => {
        expect(screen.getByText(/Shortest path has 2 nodes — highlighted in yellow\./i)).toBeInTheDocument();
      });
    });

    it('displays truncation notice when traversal limits are reached', async () => {
      (api.buildAccountGraph as jest.Mock).mockResolvedValue({
        ...mockGraphResult,
        truncated: true,
        truncatedBy: 'node_limit',
        limits: { maxDepth: 3, maxNodes: 50, maxHorizonRequests: 100 },
      });

      render(<GraphTool />);

      const rootInput = screen.getByPlaceholderText(/GABCDEFGH…/i);
      fireEvent.change(rootInput, {
        target: { value: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Build graph/i }));

      await waitFor(() => {
        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.getByText(/Partial graph: the traversal stopped at the 50-node limit/i)).toBeInTheDocument();
      });
    });
  });
});
