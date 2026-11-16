import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { E2E_CHAIN_ID } from './support/env';
import { injectMockWallet, switchMockAccount } from './support/mock-wallet';

const IN_180_DAYS = new Date(Date.now() + 180 * 86_400_000).toISOString();

/** Chromium reports blocked scripts, styles and requests as console errors. */
function collectCspViolations(page: Page): readonly string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  return violations;
}

test.beforeEach(async ({ page, request }) => {
  // No real RPC traffic in E2E runs.
  await page.route(/forno\.celo/, (route) => route.abort());
  await request.post('/api/e2e/identity', { data: { reset: true } });
});

test('GoodID badge resets and re-reads when the wallet switches accounts', async ({ page, request }) => {
  const cspViolations = collectCspViolations(page);
  const verified = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  await request.post('/api/e2e/identity', {
    data: { address: verified.address.toLowerCase(), status: 'verified', expiresAt: IN_180_DAYS },
  });
  // A slow answer for the second account makes the "checking" reset observable.
  await request.post('/api/e2e/identity', {
    data: { address: other.address.toLowerCase(), status: 'unverified', delayMs: 2_000 },
  });
  await injectMockWallet(page, [verified, other], E2E_CHAIN_ID);

  await page.goto('/demo');
  const header = page.getByRole('banner');
  await header.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a wallet' }).getByRole('button', { name: 'E2E Wallet' }).click();

  const badge = header.getByRole('status');
  await expect(badge).toContainText('Verified human');

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/^Signed in as 0x/)).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(200);

  await switchMockAccount(page, 1);
  await expect(badge).toContainText('Checking…');
  await expect(badge).not.toContainText('Verified human');
  await expect(badge).toContainText('Not verified');
  // The session belonged to the previous account: it is ended, and sign-in is offered again.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/me')).status()).toBe(401);

  await switchMockAccount(page, 0);
  await expect(badge).toContainText('Verified human');
  expect(cspViolations).toEqual([]);
});

test('pages get a fresh script nonce per request and hydrate under it', async ({ page }) => {
  const cspViolations = collectCspViolations(page);
  const response = await page.goto('/verify');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/);
  expect(policy).toContain("frame-ancestors 'none'");
  const again = await page.request.get('/verify');
  expect(again.headers()['content-security-policy']).not.toBe(policy);

  // The wallet dialog is client-side: it only opens if Next.js' scripts ran with the nonce.
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect a wallet' })).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test('public identity reads are served by the mock reader in the E2E build', async ({ request }) => {
  const response = await request.get('/api/identity?address=0x000000000000000000000000000000000000dead');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(await response.json()).toMatchObject({ ok: true, data: { status: 'unverified' } });
});
