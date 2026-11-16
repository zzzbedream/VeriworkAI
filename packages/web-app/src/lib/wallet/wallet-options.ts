import { injectedWalletName } from './accounts';

/** The parts of a wagmi connector the wallet picker needs. */
export interface ConnectorLike {
  readonly id: string;
  readonly uid: string;
  readonly name: string;
  readonly type: string;
  readonly icon?: string | undefined;
}

export interface WalletOption {
  readonly uid: string;
  readonly name: string;
  /** `data:image/...` icon announced by the wallet (EIP-6963), never a remote or script URL. */
  readonly icon: string | null;
}

export interface WalletOptionLabels {
  readonly browserWallet: string;
  readonly walletConnect: string;
}

function safeIcon(icon: string | undefined): string | null {
  return icon !== undefined && icon.startsWith('data:image/') ? icon : null;
}

/**
 * Wallets to offer: every EIP-6963 wallet by its own name; the generic `window.ethereum` connector
 * only when no wallet announced itself (MiniPay and Valora in-app browsers); WalletConnect last.
 */
export function walletOptions(
  connectors: readonly ConnectorLike[],
  injectedProvider: unknown,
  labels: WalletOptionLabels,
): readonly WalletOption[] {
  const announced = connectors
    .filter((connector) => connector.type === 'injected' && connector.id !== 'injected')
    .map((connector) => ({ uid: connector.uid, name: connector.name, icon: safeIcon(connector.icon) }));
  const generic = connectors.find((connector) => connector.id === 'injected');
  const fallbackInjected =
    generic !== undefined && announced.length === 0 && injectedProvider !== undefined && injectedProvider !== null
      ? [{ uid: generic.uid, name: injectedWalletName(injectedProvider) ?? labels.browserWallet, icon: null }]
      : [];
  const walletConnect = connectors
    .filter((connector) => connector.type === 'walletConnect')
    .map((connector) => ({ uid: connector.uid, name: labels.walletConnect, icon: null }));
  return [...announced, ...fallbackInjected, ...walletConnect];
}
