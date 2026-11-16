import 'server-only';
import { veriWorkCoreAbi } from '@veriwork/shared/abis/generated/veriWorkCore';
import { DEFAULT_ADMIN_ROLE } from '@veriwork/shared/roles';
import { MODULE_IDS } from '@veriwork/shared/tokenomics';
import type { Address, PublicClient } from 'viem';

type CoreClient = Pick<PublicClient, 'readContract' | 'multicall'>;

/** Celo did not answer: the caller must fail closed (never treat it as "no"). */
export class ChainReadUnavailable extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ChainReadUnavailable';
  }
}

/** Server-side VeriWorkCore reads (admin gating, module ownership). */
export interface CoreReader {
  /** VeriWorkCore address of this deployment, `null` when it is not configured. */
  readonly core: Address | null;
  /** `hasRole(DEFAULT_ADMIN_ROLE, account)`; throws `ChainReadUnavailable` when Celo cannot be read. */
  isAdmin(account: Address): Promise<boolean>;
  /** Upskill modules owned by the human `root` (`hasModule`); empty when unknown or unreadable (listing only). */
  ownedModules(root: Address): Promise<readonly number[]>;
  /**
   * `hasModule(root, moduleId)` for a paying action: throws `ChainReadUnavailable` when Celo cannot be
   * read (never "no"), `false` without a deployment.
   */
  ownsModule(root: Address, moduleId: number): Promise<boolean>;
}

export function createCoreReader(client: CoreClient, core: Address | null): CoreReader {
  return {
    core,
    async isAdmin(account) {
      if (core === null) return false;
      try {
        return await client.readContract({
          address: core,
          abi: veriWorkCoreAbi,
          functionName: 'hasRole',
          args: [DEFAULT_ADMIN_ROLE, account],
        });
      } catch (error: unknown) {
        throw new ChainReadUnavailable('VeriWorkCore role read failed', { cause: error });
      }
    },
    async ownedModules(root) {
      if (core === null) return [];
      try {
        const results = await client.multicall({
          allowFailure: true,
          contracts: MODULE_IDS.map(
            (moduleId) =>
              ({ address: core, abi: veriWorkCoreAbi, functionName: 'hasModule', args: [root, BigInt(moduleId)] }) as const,
          ),
        });
        return MODULE_IDS.filter((_, index) => {
          const result = results[index];
          return result?.status === 'success' && result.result === true;
        });
      } catch {
        // Module-gated campaigns are simply not offered while Celo cannot be read.
        return [];
      }
    },
    async ownsModule(root, moduleId) {
      if (core === null) return false;
      try {
        return await client.readContract({
          address: core,
          abi: veriWorkCoreAbi,
          functionName: 'hasModule',
          args: [root, BigInt(moduleId)],
        });
      } catch (error: unknown) {
        throw new ChainReadUnavailable('VeriWorkCore module read failed', { cause: error });
      }
    },
  };
}
