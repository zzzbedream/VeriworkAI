import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encodeAbiParameters, encodeEventTopics, type Address, type Log } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/en';
import { es } from '@/i18n/es';
import { ubiClaimAbi, type ClaimTx, type ClaimView } from '@/lib/claim/ubi-claim';
import { identityOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { ClaimCard } from './ClaimCard';
import { ClaimCardView } from './ClaimCardView';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const UBI = '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1' as Address;
const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;
const DAILY = 127_169_379_478_452_067_934n;
const NEXT_RESET = 1_794_916_800; // 2026-11-17T12:00:00Z

function viewOf(view: ClaimView, tx: ClaimTx = { phase: 'idle' }, extra: { lowCelo?: boolean; url?: string | null } = {}) {
  const onClaim = vi.fn();
  render(
    <ClaimCardView
      t={en}
      locale="en"
      view={view}
      tx={tx}
      lowCelo={extra.lowCelo ?? false}
      isBusy={tx.phase === 'checking' || tx.phase === 'confirm' || tx.phase === 'pending'}
      transactionUrl={extra.url ?? null}
      onClaim={onClaim}
      action={<button type="button">Connect wallet</button>}
    />,
  );
  return onClaim;
}

describe('ClaimCardView', () => {
  it('offers the exact daily amount with a claim button', async () => {
    const user = userEvent.setup();
    const onClaim = viewOf({ kind: 'claimable', amount: DAILY });
    expect(screen.getByRole('heading', { name: "Claim today's G$" })).toBeInTheDocument();
    expect(screen.getByText('127.16 G$ is ready for you today.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Claim 127.16 G$' }));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it('says when today was already claimed and when the next claim opens', () => {
    viewOf({ kind: 'claimed', nextAt: NEXT_RESET });
    expect(screen.getByText('You already claimed today. Next claim: Nov 17, 2026, 12:00 UTC.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Claim/ })).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: 'unsupported' }, 'The daily G$ claim is available on Celo mainnet.'],
    [{ kind: 'needsVerification' }, 'Verify first to claim your daily G$.'],
    [{ kind: 'checkingIdentity' }, 'Checking your verification…'],
    [{ kind: 'identityUnknown' }, "The Celo network didn't answer. This is not a problem with your account."],
    [{ kind: 'loading' }, "Checking today's claim…"],
    [{ kind: 'loadFailed' }, "We couldn't load today's claim."],
    [{ kind: 'empty', nextAt: NEXT_RESET }, 'Nothing to claim right now. Next claim: Nov 17, 2026, 12:00 UTC.'],
  ] as const)('renders %o', (view, text) => {
    viewOf(view);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('renders the connect or switch action when needed', () => {
    viewOf({ kind: 'needsWallet' });
    expect(screen.getByText('Connect your wallet to claim.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
  });

  it('walks through confirm and pending, then links the transaction', () => {
    viewOf({ kind: 'claimable', amount: DAILY }, { phase: 'confirm' });
    expect(screen.getByText('Confirm in your wallet…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim 127.16 G$' })).toBeDisabled();
  });

  it('celebrates a successful claim with a Blockscout link', () => {
    viewOf(
      { kind: 'claimed', nextAt: NEXT_RESET },
      { phase: 'success', amount: DAILY, hash: '0xabc' },
      { url: 'https://celo.blockscout.com/tx/0xabc' },
    );
    expect(screen.getByText(/Claimed! 127.16 G\$ is now in your wallet./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /View the transaction on Blockscout/ });
    expect(link).toHaveAttribute('href', 'https://celo.blockscout.com/tx/0xabc');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each([
    ['rejected', 'You cancelled the claim in your wallet.'],
    ['failed', "The claim didn't go through. Please try again."],
    ['notVerified', 'Your verification is not active, so nothing was sent.'],
    ['accountChanged', 'Your wallet account changed. Please try again.'],
    ['alreadyClaimed', 'This verified person already claimed today.'],
  ] as const)('explains the %s failure', (reason, text) => {
    viewOf({ kind: 'claimable', amount: DAILY }, { phase: 'error', reason });
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });

  it('adds the plain-language CELO note when the wallet is low', () => {
    viewOf({ kind: 'claimable', amount: DAILY }, { phase: 'error', reason: 'notEnoughCelo' }, { lowCelo: true });
    expect(screen.getByRole('alert')).toHaveTextContent('You need a little more CELO for the network fee');
    expect(screen.getByText(/free CELO top-up from GoodDollar/)).toBeInTheDocument();
    expect(screen.queryByText(/\bgas\b/i)).not.toBeInTheDocument();
  });

  it('formats amounts for Spanish', () => {
    render(
      <ClaimCardView
        t={es}
        locale="es"
        view={{ kind: 'claimable', amount: DAILY }}
        tx={{ phase: 'success', amount: null, hash: '0xabc' }}
        lowCelo={false}
        isBusy={false}
        transactionUrl={null}
        onClaim={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reclamar 127,16 G$' })).toBeInTheDocument();
    expect(screen.getByText('¡Listo! Tus G$ diarios ya están en tu billetera.')).toBeInTheDocument();
  });
});

function claimLog(amount: bigint): Log {
  return {
    address: UBI,
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    topics: encodeEventTopics({ abi: ubiClaimAbi, eventName: 'UBIClaimed', args: { claimer: ACCOUNT } }) as Log['topics'],
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  };
}

describe('ClaimCard', () => {
  beforeEach(() => {
    resetWagmiMock();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'ethereum');
  });

  it('lets MiniPay pay the fee in a stablecoin: no CELO fees, no CELO check, no CELO note', async () => {
    const user = userEvent.setup();
    Object.assign(window, { ethereum: { isMiniPay: true } });
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(0n),
      estimateContractGas: vi.fn().mockResolvedValue(316_000n),
      getBlock: vi.fn(),
      getBalance: vi.fn().mockResolvedValue(0n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [claimLog(DAILY)] }),
    };
    wagmiMock.publicClient = publicClient;
    wagmiMock.reads.data = [0n, DAILY];
    wagmiMock.balance.data = { value: 0n };
    renderApp(<ClaimCard />, { identity: async (address) => identityOf(address, 'verified') });

    await user.click(await screen.findByRole('button', { name: 'Claim 127.16 G$' }));
    expect(await screen.findByText(/Claimed! 127.16 G\$ is now in your wallet./)).toBeInTheDocument();
    const [request] = wagmiMock.writeContract.mock.calls[0] ?? [];
    expect(request).toMatchObject({ functionName: 'claim', gas: 395_000n });
    expect(request).not.toHaveProperty('maxFeePerGas');
    expect(publicClient.getBalance).not.toHaveBeenCalled();
    expect(screen.queryByText(/free CELO top-up/)).not.toBeInTheDocument();
  });

  it('claims from the connected wallet with explicit gas and reports the amount', async () => {
    const user = userEvent.setup();
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(0n),
      estimateContractGas: vi.fn().mockResolvedValue(316_000n),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 200_000_000_000n }),
      getBalance: vi.fn().mockResolvedValue(10n ** 18n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [claimLog(DAILY)] }),
    };
    wagmiMock.publicClient = publicClient;
    wagmiMock.reads.data = [0n, DAILY];
    wagmiMock.balance.data = { value: 10n ** 17n };
    renderApp(<ClaimCard />, { identity: async (address) => identityOf(address, 'verified') });

    await user.click(await screen.findByRole('button', { name: 'Claim 127.16 G$' }));
    expect(await screen.findByText(/Claimed! 127.16 G\$ is now in your wallet./)).toBeInTheDocument();
    expect(wagmiMock.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: UBI,
        functionName: 'claim',
        chainId: 42220,
        gas: 395_000n,
        maxFeePerGas: 402_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
      }),
    );
    expect(screen.getByText(/free CELO top-up/)).toBeInTheDocument();
    await waitFor(() => expect(wagmiMock.reads.refetch).toHaveBeenCalled());
  });

  it('asks to switch network on another chain', async () => {
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider(), 1));
    renderApp(<ClaimCard />, { identity: async (address) => identityOf(address, 'verified') });
    expect(await screen.findByText('Switch to Celo to claim.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Celo' })).toBeInTheDocument();
  });
});
