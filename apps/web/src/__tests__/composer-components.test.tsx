import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { XdrPreview } from '@/components/tools/composer/xdr-preview';
import { SimulateResult } from '@/components/tools/composer/simulate-result';
import { FeeBumpPanel } from '@/components/tools/composer/fee-bump-panel';
import { OperationPalette } from '@/components/tools/composer/operation-palette';
import { OperationList } from '@/components/tools/composer/operation-list';
import { ComposerToolbar } from '@/components/tools/composer/composer-toolbar';
import { validatePreconditions } from '@/components/tools/composer/preconditions-panel';
import { NetworkProvider } from '@/lib/network-context';
import * as composerApi from '@/lib/composer-api';
import type { OperationManifestEntry, SimulateTransactionResult } from '@/lib/composer-api';

jest.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children }: any) => <div>{children}</div>,
  Droppable: ({ children }: any) => children({ draggableProps: {}, innerRef: null }, {}),
  Draggable: ({ children }: any) =>
    children(
      {
        draggableProps: { style: {} },
        dragHandleProps: {},
        innerRef: null,
      },
      { isDragging: false }
    ),
}));

jest.mock('@/lib/composer-api', () => {
  const actual = jest.requireActual('@/lib/composer-api');
  return {
    ...actual,
    buildFeeBump: jest.fn(),
    inspectFeeBump: jest.fn(),
  };
});

describe('Composer Subcomponents (Issue #600)', () => {
  describe('XdrPreview', () => {
    it('renders placeholder when xdr is null', () => {
      render(<XdrPreview xdr={null} />);
      expect(screen.getByText(/XDR will appear here/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy xdr/i })).toBeDisabled();
    });

    it('renders xdr and handles copying to clipboard', async () => {
      const mockClipboard = jest.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: mockClipboard },
      });

      render(<XdrPreview xdr="AAAAAGTESTXDR==" />);
      expect(screen.getByText('AAAAAGTESTXDR==')).toBeInTheDocument();

      const copyBtn = screen.getByRole('button', { name: /copy xdr/i });
      expect(copyBtn).not.toBeDisabled();

      fireEvent.click(copyBtn);
      expect(mockClipboard).toHaveBeenCalledWith('AAAAAGTESTXDR==');

      await waitFor(() => {
        expect(screen.getByText(/copied/i)).toBeInTheDocument();
      });
    });

    it('displays building indicator when loading is true', () => {
      render(<XdrPreview xdr="AAAAAGTESTXDR==" loading={true} />);
      expect(screen.getByText('building…')).toBeInTheDocument();
    });
  });

  describe('SimulateResult', () => {
    it('renders empty state when result is null and not loading', () => {
      render(<SimulateResult result={null} loading={false} error={null} />);
      expect(screen.getByText(/preview the result on Horizon/i)).toBeInTheDocument();
    });

    it('renders loading skeleton when loading is true', () => {
      const { container } = render(<SimulateResult result={null} loading={true} error={null} />);
      expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
    });

    it('renders error state and retry button on failure', () => {
      const onRetry = jest.fn();
      render(<SimulateResult result={null} loading={false} error="Transaction rejected by Horizon" onRetry={onRetry} />);

      expect(screen.getByText('Simulation failed')).toBeInTheDocument();
      expect(screen.getAllByText('Transaction rejected by Horizon')[0]).toBeInTheDocument();

      const retryBtn = screen.getByRole('button', { name: /retry simulation/i });
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('renders successful simulation metrics', () => {
      const res: SimulateTransactionResult = {
        success: true,
        fee: '100',
        hash: '0123456789abcdef',
        operationResults: ['op_success'],
      };

      render(<SimulateResult result={res} loading={false} error={null} />);
      expect(screen.getByText('Simulation succeeded')).toBeInTheDocument();
      expect(screen.getByText('100 stroops')).toBeInTheDocument();
      expect(screen.getByText('0123456789abcdef')).toBeInTheDocument();
      expect(screen.getByText('op_success')).toBeInTheDocument();
    });
  });

  describe('OperationPalette', () => {
    const mockOps: OperationManifestEntry[] = [
      { type: 'payment', label: 'Payment', description: 'Send assets to another account' },
      { type: 'create_account', label: 'Create Account', description: 'Create and fund a new account' },
    ];

    it('renders available operations and handles selection', () => {
      const onAdd = jest.fn();
      render(<OperationPalette operations={mockOps} onAdd={onAdd} />);

      expect(screen.getByText('Payment')).toBeInTheDocument();
      expect(screen.getByText('Create Account')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Payment'));
      expect(onAdd).toHaveBeenCalledWith('payment');

      fireEvent.click(screen.getByText('Create Account'));
      expect(onAdd).toHaveBeenCalledWith('create_account');
    });
  });

  describe('OperationList', () => {
    it('renders empty state when operations list is empty', () => {
      render(
        <OperationList
          operations={[]}
          selectedId={null}
          onSelect={jest.fn()}
          onRemove={jest.fn()}
          onReorder={jest.fn()}
        />
      );
      expect(screen.getByText('Transaction is empty')).toBeInTheDocument();
    });

    it('renders operations and triggers select and remove callbacks', () => {
      const onSelect = jest.fn();
      const onRemove = jest.fn();
      const ops = [
        { id: 'op-1', type: 'payment', fields: {} },
        { id: 'op-2', type: 'create_account', fields: {} },
      ];

      const { container } = render(
        <OperationList
          operations={ops}
          selectedId="op-1"
          onSelect={onSelect}
          onRemove={onRemove}
          onReorder={jest.fn()}
        />
      );

      expect(screen.getByText('payment')).toBeInTheDocument();
      expect(screen.getByText('create account')).toBeInTheDocument();

      // Click select
      fireEvent.click(screen.getByText('create account'));
      expect(onSelect).toHaveBeenCalledWith('op-2');

      // Click remove
      const deleteBtn = container.querySelector('#remove-op-op-1');
      expect(deleteBtn).not.toBeNull();
      fireEvent.click(deleteBtn!);
      expect(onRemove).toHaveBeenCalledWith('op-1');
    });
  });

  describe('FeeBumpPanel', () => {
    it('toggles open/close and validates required inputs before building', async () => {
      const onResult = jest.fn();
      render(<FeeBumpPanel network="testnet" onResult={onResult} />);

      // Closed initially
      expect(screen.queryByPlaceholderText(/AAAA/)).not.toBeInTheDocument();

      // Click to toggle open
      const toggleBtn = screen.getByRole('button', { name: /Fee Bump/i });
      fireEvent.click(toggleBtn);

      expect(screen.getByPlaceholderText(/AAAA/)).toBeInTheDocument();

      // Click build without required inputs
      const buildBtn = screen.getByRole('button', { name: /^Build Fee Bump$/i });
      fireEvent.click(buildBtn);

      expect(screen.getByText(/Inner XDR, fee source, and base fee are all required/i)).toBeInTheDocument();
      expect(onResult).not.toHaveBeenCalled();
    });

    it('successfully calls buildFeeBump and triggers onResult', async () => {
      const onResult = jest.fn();
      const mockResult: composerApi.FeeBumpResult = {
        xdr: 'AAAAAFEEBUMP==',
        feeSource: 'GBFEE',
        baseFee: '5000',
        innerHash: 'innertxhash1234567890',
        hash: 'outertxhash1234567890',
        fee: 5000,
        operationCount: 1,
      };
      (composerApi.buildFeeBump as jest.Mock).mockResolvedValue(mockResult);

      render(<FeeBumpPanel network="testnet" onResult={onResult} />);
      fireEvent.click(screen.getByRole('button', { name: /Fee Bump/i }));

      const innerXdrInput = screen.getByPlaceholderText(/AAAA/);
      const feeSourceInput = screen.getByPlaceholderText(/pays the bumped fee/i);

      fireEvent.change(innerXdrInput, { target: { value: 'AAAAAINNER==' } });
      fireEvent.change(feeSourceInput, { target: { value: 'GBFEESOURCEKEY' } });

      const buildBtn = screen.getByRole('button', { name: /^Build Fee Bump$/i });
      fireEvent.click(buildBtn);

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(mockResult);
      });
    });
  });

  describe('ComposerToolbar', () => {
    it('renders op count and triggers simulate and sign/submit', () => {
      const onSimulate = jest.fn();
      const onSignSubmit = jest.fn();

      render(
        <NetworkProvider>
          <ComposerToolbar
            xdr="AAAAATEST=="
            opCount={3}
            onSimulate={onSimulate}
            onSignSubmit={onSignSubmit}
            simulating={false}
            submitting={false}
            submitResult={null}
          />
        </NetworkProvider>
      );

      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('ops')).toBeInTheDocument();

      const simBtn = screen.getByRole('button', { name: /simulate/i });
      fireEvent.click(simBtn);
      expect(onSimulate).toHaveBeenCalledTimes(1);

      const signBtn = screen.getByRole('button', { name: /sign & submit/i });
      fireEvent.click(signBtn);
      expect(onSignSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('validatePreconditions', () => {
    it('validates none, time_bounds, and ledger_bounds correctly', () => {
      expect(validatePreconditions('none', {})).toBeNull();

      expect(validatePreconditions('time_bounds', { minTime: '', maxTime: '' })).toBe('minTime is required');
      expect(validatePreconditions('time_bounds', { minTime: '100', maxTime: '' })).toBe('maxTime is required');
      expect(validatePreconditions('time_bounds', { minTime: '200', maxTime: '100' })).toBe(
        'minTime must be less than or equal to maxTime'
      );
      expect(validatePreconditions('time_bounds', { minTime: '100', maxTime: '200' })).toBeNull();

      expect(validatePreconditions('ledger_bounds', { minLedger: '', maxLedger: '' })).toBe('minLedger is required');
      expect(validatePreconditions('ledger_bounds', { minLedger: '500', maxLedger: '200' })).toBe(
        'minLedger must be less than or equal to maxLedger'
      );
      expect(validatePreconditions('ledger_bounds', { minLedger: '200', maxLedger: '500' })).toBeNull();
    });
  });
});
