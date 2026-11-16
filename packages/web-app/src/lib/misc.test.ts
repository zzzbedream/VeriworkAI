import { act, renderHook } from '@testing-library/react';
import type { Address, PublicClient, WalletClient } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFaceVerificationLink,
  FACE_VERIFICATION_RETURN_PARAM,
  faceVerificationReturnUrl,
} from './identity/face-verification';
import { createSignInMessage, issuedAtForNonce, SIGN_IN_MESSAGE_TTL_MS } from './siwe/message';
import { CLOCK_TICK_MS, useNowSeconds } from './time/clock';

const generateFVLink = vi.fn<(popup: boolean, url: string, chain: number) => Promise<string>>();
const constructed = vi.fn();

vi.mock('@goodsdks/citizen-sdk', () => ({
  SupportedChains: { CELO: 42220 },
  IdentitySDK: class {
    constructor(options: unknown) {
      constructed(options);
    }
    generateFVLink = generateFVLink;
  },
}));

describe('createSignInMessage', () => {
  it('builds an EIP-4361 message bound to the page and chain, valid for 10 minutes', () => {
    const issuedAt = new Date('2026-11-16T12:00:00.000Z');
    const message = createSignInMessage({
      address: '0x68dcf65c7abae41a53b686efe44889f8bf93b277',
      chainId: 42220,
      nonce: 'a1b2c3d4e5f60718',
      domain: 'veriworkai.vercel.app',
      uri: 'https://veriworkai.vercel.app',
      statement: 'Sign in to VeriWork AI.',
      issuedAt,
    });
    const fields = parseSiweMessage(message);
    expect(fields).toMatchObject({
      address: '0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277',
      chainId: 42220,
      domain: 'veriworkai.vercel.app',
      nonce: 'a1b2c3d4e5f60718',
      uri: 'https://veriworkai.vercel.app',
      version: '1',
      statement: 'Sign in to VeriWork AI.',
    });
    expect(fields.expirationTime?.getTime()).toBe(issuedAt.getTime() + SIGN_IN_MESSAGE_TTL_MS);
  });
});

describe('issuedAtForNonce', () => {
  it('dates the message by the server: nonce expiry minus its 10-minute lifetime', () => {
    const deviceClock = new Date('2031-01-01T00:00:00.000Z');
    expect(issuedAtForNonce('2026-11-16T12:10:00.000Z', deviceClock).toISOString()).toBe('2026-11-16T12:00:00.000Z');
  });

  it('falls back to the device clock without a usable server time', () => {
    const deviceClock = new Date('2026-11-16T12:00:00.000Z');
    expect(issuedAtForNonce(undefined, deviceClock)).toBe(deviceClock);
    expect(issuedAtForNonce('not a date', deviceClock)).toBe(deviceClock);
  });
});

describe('face verification link', () => {
  it('returns to /verify with our own marker parameter', () => {
    expect(faceVerificationReturnUrl('https://veriworkai.vercel.app')).toBe(
      `https://veriworkai.vercel.app/verify?${FACE_VERIFICATION_RETURN_PARAM}=1`,
    );
  });

  it('loads the SDK on demand and asks for a redirect-mode link on Celo', async () => {
    generateFVLink.mockResolvedValue('https://goodid.gooddollar.org/?lz=abc');
    const account = '0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277' as Address;
    const link = await createFaceVerificationLink({
      account,
      publicClient: {} as PublicClient,
      walletClient: {} as WalletClient,
      callbackUrl: 'https://app.test/verify?fv=1',
    });
    expect(link).toBe('https://goodid.gooddollar.org/?lz=abc');
    expect(constructed).toHaveBeenCalledWith(expect.objectContaining({ account, env: 'production' }));
    expect(generateFVLink).toHaveBeenCalledWith(false, 'https://app.test/verify?fv=1', 42220);
  });
});

describe('useNowSeconds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks while subscribed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    const { result, unmount } = renderHook(() => useNowSeconds());
    expect(result.current).toBe(1_794_830_400);
    act(() => {
      vi.advanceTimersByTime(CLOCK_TICK_MS);
    });
    expect(result.current).toBe(1_794_830_400 + CLOCK_TICK_MS / 1_000);
    unmount();
  });
});
