import { getAddress, isAddress, type Address } from 'viem';

/** Minimal EIP-1193 event surface (MetaMask, MiniPay, WalletConnect providers all implement it). */
export interface EventfulProvider {
  on(event: 'accountsChanged', listener: (accounts: unknown) => void): unknown;
  removeListener(event: 'accountsChanged', listener: (accounts: unknown) => void): unknown;
}

export function isEventfulProvider(value: unknown): value is EventfulProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly on?: unknown; readonly removeListener?: unknown };
  return typeof candidate.on === 'function' && typeof candidate.removeListener === 'function';
}

export function lowerAddress(value: string | undefined | null): Address | null {
  return value !== undefined && value !== null && isAddress(value, { strict: false })
    ? (value.toLowerCase() as Address)
    : null;
}

/** First account of an `accountsChanged` payload (lowercase), `null` for an empty or invalid list. */
export function firstAccount(accounts: unknown): Address | null {
  if (!Array.isArray(accounts)) return null;
  const [first] = accounts as readonly unknown[];
  return typeof first === 'string' ? lowerAddress(first) : null;
}

export function checksum(address: Address | null): Address | null {
  return address === null ? null : getAddress(address);
}

/** A raw `accountsChanged` event that has not been reflected by wagmi yet. */
export interface AccountOverride {
  /** Account the wallet reported (lowercase, `null` = no account / locked). */
  readonly address: Address | null;
  /** wagmi's address when the event arrived. */
  readonly basis: Address | null;
}

/**
 * The tracked account: a raw `accountsChanged` event is authoritative in both directions and wins
 * immediately; once wagmi's own address moves on, wagmi is the source of truth again.
 */
export function trackedAddress(wagmiAddress: Address | null, override: AccountOverride | null): Address | null {
  return override !== null && override.basis === wagmiAddress ? override.address : wagmiAddress;
}

interface InjectedFlags {
  readonly isMiniPay?: boolean;
  readonly isValora?: boolean;
  readonly isRabby?: boolean;
  readonly isMetaMask?: boolean;
}

/** Display name of a plain `window.ethereum` wallet, or `null` when the flags say nothing. */
export function injectedWalletName(provider: unknown): string | null {
  if (typeof provider !== 'object' || provider === null) return null;
  const flags = provider as InjectedFlags;
  if (flags.isMiniPay === true) return 'MiniPay';
  if (flags.isValora === true) return 'Valora';
  if (flags.isRabby === true) return 'Rabby';
  if (flags.isMetaMask === true) return 'MetaMask';
  return null;
}

export function isMiniPay(provider: unknown): boolean {
  return injectedWalletName(provider) === 'MiniPay';
}

/**
 * MiniPay and Valora pay network fees in a stablecoin the user holds (Celo fee abstraction) and pick
 * the fee currency and price themselves; other wallets pay in CELO.
 */
export function paysFeesInStablecoin(provider: unknown): boolean {
  const name = injectedWalletName(provider);
  return name === 'MiniPay' || name === 'Valora';
}
