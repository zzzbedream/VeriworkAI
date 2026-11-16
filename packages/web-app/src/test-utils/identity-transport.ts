import { identityAbi } from '@veriwork/shared/abis/identity';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { celo } from 'viem/chains';

export interface IdentityRecordFixture {
  readonly dateAuthenticated: bigint;
  readonly status: number;
  readonly authCount: number;
}

/** On-chain IdentityV4 state served by the mocked transport (keys are lowercase addresses). */
export interface IdentityFixture {
  readonly roots?: Readonly<Record<string, Address | 'revert'>>;
  readonly records?: Readonly<Record<string, IdentityRecordFixture | 'revert'>>;
  readonly connected?: Readonly<Record<string, Address>>;
  /** `reverifyDaysOptions(index)`; a missing index reverts like the real dynamic array. */
  readonly reverifyDays?: readonly number[];
}

interface SubcallResult {
  readonly success: boolean;
  readonly returnData: Hex;
}

const REVERTED: SubcallResult = { success: false, returnData: '0x' };

function ok(returnData: Hex): SubcallResult {
  return { success: true, returnData };
}

function key(address: unknown): string {
  return String(address).toLowerCase();
}

function answer(fixture: IdentityFixture, callData: Hex): SubcallResult {
  const call = decodeFunctionData({ abi: identityAbi, data: callData });
  switch (call.functionName) {
    case 'getWhitelistedRoot': {
      const root = fixture.roots?.[key(call.args[0])] ?? zeroAddress;
      if (root === 'revert') return REVERTED;
      return ok(encodeFunctionResult({ abi: identityAbi, functionName: 'getWhitelistedRoot', result: root }));
    }
    case 'identities': {
      const record = fixture.records?.[key(call.args[0])] ?? { dateAuthenticated: 0n, status: 0, authCount: 0 };
      if (record === 'revert') return REVERTED;
      return ok(
        encodeFunctionResult({
          abi: identityAbi,
          functionName: 'identities',
          result: [record.dateAuthenticated, 0n, '', 0n, record.status, record.authCount],
        }),
      );
    }
    case 'connectedAccounts': {
      const linked = fixture.connected?.[key(call.args[0])] ?? zeroAddress;
      return ok(encodeFunctionResult({ abi: identityAbi, functionName: 'connectedAccounts', result: linked }));
    }
    case 'reverifyDaysOptions': {
      const days = fixture.reverifyDays?.[Number(call.args[0])];
      if (days === undefined) return REVERTED;
      return ok(encodeFunctionResult({ abi: identityAbi, functionName: 'reverifyDaysOptions', result: days }));
    }
    default:
      return REVERTED;
  }
}

export interface IdentityTestClient {
  readonly client: Pick<PublicClient, 'multicall'>;
  /** Number of `eth_call` round trips served so far. */
  readonly ethCalls: () => number;
}

/** A real viem client whose transport answers Multicall3 `aggregate3` calls from a fixture. */
export function createIdentityTestClient(
  fixture: IdentityFixture,
  options: { readonly failTransport?: boolean; readonly failFromCall?: number } = {},
): IdentityTestClient {
  let calls = 0;
  const client = createPublicClient({
    chain: celo,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (options.failTransport === true) throw new Error('RPC unavailable');
        if (method === 'eth_chainId') return '0xa4ec';
        if (method !== 'eth_call') throw new Error(`Unexpected RPC method ${method}`);
        calls += 1;
        if (options.failFromCall !== undefined && calls >= options.failFromCall) throw new Error('RPC unavailable');
        const [request] = params as readonly [{ readonly data: Hex }];
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: request.data });
        if (decoded.functionName !== 'aggregate3') throw new Error(`Unexpected multicall ${decoded.functionName}`);
        const results = decoded.args[0].map((subcall) => answer(fixture, subcall.callData));
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
      },
    }),
  });
  return { client: client as unknown as Pick<PublicClient, 'multicall'>, ethCalls: () => calls };
}
