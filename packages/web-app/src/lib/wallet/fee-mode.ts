import { useSyncExternalStore } from 'react';
import { paysFeesInStablecoin } from './accounts';

function subscribe(): () => void {
  // The injected wallet does not change while the page is open.
  return () => undefined;
}

function injectedPaysInStablecoin(): boolean {
  return paysFeesInStablecoin((window as { readonly ethereum?: unknown }).ethereum);
}

/** `true` inside MiniPay or Valora (network fees in a stablecoin); `false` on the server and elsewhere. */
export function useStablecoinFees(): boolean {
  return useSyncExternalStore(subscribe, injectedPaysInStablecoin, () => false);
}
