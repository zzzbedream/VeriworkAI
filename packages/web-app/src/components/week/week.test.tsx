import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClaimsResponse, WalletWeekResponse } from '@veriwork/shared/api/claims';
import { GOODDOLLAR_CELO } from '@veriwork/shared/addresses';
import { weekDayStart, weekStart } from '@veriwork/shared/time';
import { getAddress, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, ok } from '@/test-utils/api-mock';
import { fakeSessionApi, identityOf, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { fakePublicClient, fakeWeekChain, type FakeWeekChain } from '@/test-utils/week-chain';
import { WeekPanel } from './WeekPanel';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const CORE = '0xeC9Ea648d5F8C3bcb5E26Bd155dCf27Ed4B51c25';
const WALLET = getAddress('0x68dcf65c7abae41a53b686efe44889f8bf93b277');
const LOWER = WALLET.toLowerCase() as Address;
const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;
const OTHER = '0x3000000000000000000000000000000000000030' as Address;
const G = 10n ** 18n;
const WEEK = 2967;
const SIGNATURE = `0x${'11'.repeat(32)}${'22'.repeat(32)}1c` as const;

function iso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

function weekResponse(dayIndex: number, overrides: Partial<WalletWeekResponse['stake']> = {}): WalletWeekResponse {
  return {
    weekId: WEEK,
    weekStart: iso(weekStart(WEEK)),
    dayIndex,
    nextUbiResetAt: iso(weekDayStart(WEEK, dayIndex) + 86_400),
    days: Array.from({ length: 7 }, (_, day) => ({
      dayIndex: day,
      startsAt: iso(weekDayStart(WEEK, day)),
      ubiClaimed: day < dayIndex,
      taskDone: day === 0,
      active: day <= dayIndex,
    })),
    stake: { windowOpen: dayIndex < 2, deposited: false, amountWei: null, txHash: null, unlocked: dayIndex === 6, slashedWei: null, ...overrides },
    fiveDayBonus: { eligible: false, claimed: false, amountWei: (400n * G).toString() },
  };
}

const NO_CLAIMS: ClaimsResponse = { claims: [], totalClaimableWei: '0' };

function setup(options: { readonly day: number; readonly chain?: Partial<FakeWeekChain>; readonly claims?: ClaimsResponse }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date((weekDayStart(WEEK, options.day) + 3_600) * 1_000));
  const state = fakeWeekChain(options.chain);
  wagmiMock.publicClient = fakePublicClient(state);
  const api = mockApi({ 'GET /api/week': ok(weekResponse(options.day)), 'GET /api/claims': ok(options.claims ?? NO_CLAIMS) });
  renderApp(<WeekPanel />, {
    session: fakeSessionApi(meOf(LOWER)),
    identity: async (address) => identityOf(address, 'verified', { root: ROOT }),
  });
  return { api, state };
}

beforeEach(() => {
  resetWagmiMock();
  vi.stubEnv('NEXT_PUBLIC_VERIWORK_CORE_ADDRESS', CORE);
  wagmiMock.connection.set(connectedTo(WALLET, createFakeProvider()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('WeekPanel', () => {
  it('shows Monday to Sunday with what each day is for and the recorded marks', async () => {
    setup({ day: 2 });
    const strip = await screen.findByRole('list', { name: 'Monday to Sunday' });
    const days = within(strip).getAllByRole('listitem').filter((item) => item.parentElement === strip);
    expect(days.map((day) => within(day).getByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/).textContent)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(days[0]).toHaveTextContent('Weekly deposit');
    expect(days[0]).toHaveTextContent('Daily G$ claimed');
    expect(days[0]).toHaveTextContent('Task done');
    expect(days[2]).toHaveAttribute('aria-current', 'date');
    expect(days[4]).toHaveTextContent('Five-day bonus');
    expect(days[6]).toHaveTextContent('Collect your week');
    expect(await screen.findByText(/The deposit window is closed/)).toBeInTheDocument();
    expect(screen.getByText('1 of 5 workdays with a claim and a task so far.')).toBeInTheDocument();
  });

  it('makes the Monday deposit with one permit signature and one transaction', async () => {
    const user = userEvent.setup();
    setup({ day: 0, chain: { nonce: 4n } });
    wagmiMock.signTypedData.mockResolvedValue(SIGNATURE);
    const button = await screen.findByRole('button', { name: 'Deposit 150 G$' });
    expect(screen.getByText(/One free signature approves exactly this amount/)).toBeInTheDocument();
    await user.click(button);

    expect(await screen.findByText('Deposited! You get it back on Sunday.')).toBeInTheDocument();
    const signed = wagmiMock.signTypedData.mock.calls[0]?.[0] as { domain: unknown; message: Record<string, unknown>; account: Address };
    expect(signed.domain).toEqual({ name: 'GoodDollar', version: '1', chainId: 42220, verifyingContract: GOODDOLLAR_CELO.gDollar });
    expect(signed.message).toMatchObject({ owner: WALLET, spender: CORE, value: 150n * G, nonce: 4n });
    expect(signed.account).toBe(WALLET);
    expect(wagmiMock.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: CORE,
        functionName: 'depositStakeWithPermit',
        args: [150n * G, signed.message.deadline, 28, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
        account: WALLET,
        chainId: 42220,
      }),
    );
    expect(screen.getByRole('link', { name: /View the transaction on Blockscout/ })).toHaveAttribute(
      'href',
      `https://celo.blockscout.com/tx/0x${'ab'.repeat(32)}`,
    );
  });

  it('explains a deposit already made and one made from another wallet of the same person', async () => {
    setup({
      day: 1,
      chain: { stakes: { [`${WEEK}:${ROOT}`]: { account: OTHER, amount: 150n * G, slashed: 0n, withdrawn: false } } },
    });
    expect(await screen.findByText("Another wallet of yours already made this week's deposit.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deposit/ })).not.toBeInTheDocument();
  });

  it('says so when the live state cannot be read, instead of "nothing to collect"', async () => {
    setup({ day: 0, chain: { failBasics: true } });
    expect(await screen.findAllByText("We couldn't load your week.", undefined, { timeout: 5_000 })).toHaveLength(2);
    expect(screen.queryByText('Nothing to collect right now.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deposit/ })).not.toBeInTheDocument();
  });

  it('asks for more G$ when the wallet cannot cover the deposit', async () => {
    setup({ day: 0, chain: { balance: 20n * G } });
    expect(await screen.findByText('You need 150 G$ in this wallet. You have 20 G$.')).toBeInTheDocument();
  });

  it('collects the week, explains a forfeited trial part and takes back the unlocked deposit', async () => {
    const user = userEvent.setup();
    const claims: ClaimsResponse = {
      claims: [
        {
          epochId: 2966,
          amountWei: (120n * G).toString(),
          trialAmountWei: (100n * G).toString(),
          proof: [`0x${'01'.repeat(32)}`],
          breakdown: { tasks: (120n * G).toString(), reviews: '0', qa: '0', bonus: '0' },
          status: 'CLAIMABLE',
          claimableAt: '2026-11-15T00:00:00.000Z',
          expiresAt: '2027-01-14T00:00:00.000Z',
          claimedTxHash: null,
        },
      ],
      totalClaimableWei: (120n * G).toString(),
    };
    setup({
      day: 6,
      claims,
      chain: {
        trialWallet: OTHER,
        stakes: { [`${WEEK}:${ROOT}`]: { account: WALLET, amount: 150n * G, slashed: 0n, withdrawn: false } },
      },
    });
    expect(await screen.findByText('20 G$ is ready to collect.')).toBeInTheDocument();
    expect(screen.getByText(/were already paid to another wallet of yours \(0x3000…0030\)/)).toBeInTheDocument();
    expect(screen.getByText('Your deposit of 150 G$ can be taken back.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collect 170 G$' }));

    expect(await screen.findByText('Collected! 170 G$ is now in your wallet.')).toBeInTheDocument();
    const calls = wagmiMock.writeContract.mock.calls.map(([call]) => call as { functionName: string; args: readonly unknown[] });
    expect(calls.map((call) => call.functionName)).toEqual(['claimMany', 'withdrawStake']);
    expect(calls[0]?.args).toEqual([[{ epochId: 2966n, amount: 120n * G, trialAmount: 100n * G, proof: [`0x${'01'.repeat(32)}`] }]]);
    expect(calls[1]?.args).toEqual([BigInt(WEEK), ROOT]);
  });

  it('says when there is nothing to collect and when a week is still in its safety delay', async () => {
    setup({
      day: 5,
      claims: {
        claims: [
          {
            epochId: 2967,
            amountWei: (60n * G).toString(),
            trialAmountWei: '0',
            proof: [],
            breakdown: { tasks: (60n * G).toString(), reviews: '0', qa: '0', bonus: '0' },
            status: 'PENDING',
            claimableAt: '2026-11-22T00:30:00.000Z',
            expiresAt: '2027-01-21T00:30:00.000Z',
            claimedTxHash: null,
          },
        ],
        totalClaimableWei: '0',
      },
    });
    expect(await screen.findByText('Nothing to collect right now.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Week 2967: 60 G\$, ready from/)).toBeInTheDocument());
  });
});
