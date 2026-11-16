import type { Address, PublicClient, WalletClient } from 'viem';

/** Marker we add to the return URL; GoodID's own (base64) callback parameters are ignored. */
export const FACE_VERIFICATION_RETURN_PARAM = 'fv';

export function faceVerificationReturnUrl(appOrigin: string): string {
  return `${appOrigin}/verify?${FACE_VERIFICATION_RETURN_PARAM}=1`;
}

export interface FaceVerificationLinkInput {
  readonly account: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly callbackUrl: string;
}

/**
 * GoodDollar face-verification link in redirect mode (works in mobile in-app browsers). The SDK is
 * loaded only when the user asks for it; it asks the wallet for a free signature first.
 */
export async function createFaceVerificationLink(input: FaceVerificationLinkInput): Promise<string> {
  const { IdentitySDK, SupportedChains } = await import('@goodsdks/citizen-sdk');
  const sdk = new IdentitySDK({
    account: input.account,
    publicClient: input.publicClient,
    walletClient: input.walletClient,
    env: 'production',
  });
  return sdk.generateFVLink(false, input.callbackUrl, SupportedChains.CELO);
}
