import type { SupportedChainId } from '@veriwork/shared/chain';
import type { Address } from 'viem';
import type { Dictionary } from '@/i18n/dictionaries';
import { interpolate } from '@/i18n/interpolate';
import { addressExplorerUrl, goodDollarContracts } from '@/lib/config/chain';

type Props = {
  readonly t: Dictionary;
  readonly chainId: SupportedChainId;
  readonly core: Address | null;
  readonly agentRegistry: Address | null;
};

interface ContractRow {
  readonly name: string;
  readonly description: string | null;
  readonly address: Address | null;
}

/** Live contract addresses (VeriWork from env, GoodDollar from @veriwork/shared) with Blockscout links. */
export function ContractList({ t, chainId, core, agentRegistry }: Props) {
  const goodDollar = goodDollarContracts(chainId);
  const rows: readonly ContractRow[] = [
    { name: t.demo.contracts.core, description: t.demo.contracts.coreDescription, address: core },
    { name: t.demo.contracts.registry, description: t.demo.contracts.registryDescription, address: agentRegistry },
    { name: t.demo.contracts.gDollar, description: null, address: goodDollar?.gDollar ?? null },
    { name: t.demo.contracts.identity, description: null, address: goodDollar?.identity ?? null },
    { name: t.demo.contracts.ubi, description: null, address: goodDollar?.ubiScheme ?? null },
  ];
  return (
    <ul className="grid gap-3">
      {rows.map((row) => {
        const href = row.address === null ? null : addressExplorerUrl(chainId, row.address);
        return (
          <li key={row.name} className="rounded-xl border border-rule bg-paper-raised p-4">
            <p className="font-semibold">
              {row.name}
              {row.description !== null ? <span className="font-normal text-ink-soft"> · {row.description}</span> : null}
            </p>
            {row.address === null ? (
              <p className="mt-1 text-ink-soft">{t.common.notConfigured}</p>
            ) : href === null ? (
              <p className="mt-1 font-mono text-sm break-all">{row.address}</p>
            ) : (
              <a
                className="mt-1 inline-block font-mono text-sm break-all text-verified underline underline-offset-4"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {row.address}{' '}
                <span className="sr-only">{`— ${interpolate(t.demo.viewOnExplorer, { name: row.name })} ${t.common.newTab}`}</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
