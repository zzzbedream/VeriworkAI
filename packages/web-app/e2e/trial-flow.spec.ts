import { expect, test, type Page } from '@playwright/test';
import { createPrisma, type PrismaClient } from '@veriwork/database';
import { resetDatabase } from '@veriwork/database/testing';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { seedPublishedBatch } from '../src/test-utils/pipeline-seed';
import { E2E_CHAIN_ID, E2E_DATABASE_URL_ENV } from './support/env';
import { injectMockWallet } from './support/mock-wallet';

let prisma: PrismaClient;

test.beforeAll(() => {
  const url = process.env[E2E_DATABASE_URL_ENV];
  if (url === undefined || url === '') throw new Error(`${E2E_DATABASE_URL_ENV} is not set (run through the Playwright global setup)`);
  prisma = createPrisma(url);
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.beforeEach(async ({ page, request }) => {
  // No real RPC traffic in E2E runs.
  await page.route(/forno\.celo/, (route) => route.abort());
  await request.post('/api/e2e/identity', { data: { reset: true } });
  await resetDatabase(prisma);
  // A funded campaign whose batch is published, with an AI draft on every item.
  await seedPublishedBatch(prisma, { items: 4 });
});

function countRequests(page: Page, path: string): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path) count += 1;
  });
  return () => count;
}

async function doTrialTask(page: Page, banner: string): Promise<void> {
  await expect(page.getByText(banner)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI draft' })).toBeVisible();
  await page.getByRole('radio', { name: 'neutral' }).check();
  await page.getByRole('button', { name: 'Send my correction' }).click();
  await expect(page.getByRole('heading', { name: 'Saved!' })).toBeVisible();
}

test('a new user does 2 free trial tasks, sees the saved earnings, and the 3rd action opens the GoodID modal', async ({ page }) => {
  const worker = privateKeyToAccount(generatePrivateKey());
  await injectMockWallet(page, [worker], E2E_CHAIN_ID);
  const meCalls = countRequests(page, '/api/me');

  await page.goto('/work');
  await expect(page.getByRole('heading', { level: 1, name: 'Work on a task' })).toBeVisible();
  // Anonymous visitors never call /api/me (no session cookie, no 401 in the console).
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a wallet' }).getByRole('button', { name: 'E2E Wallet' }).click();
  await expect(page.getByRole('banner').getByRole('status')).toContainText('Not verified');
  expect(meCalls()).toBe(0);

  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await doTrialTask(page, 'Free trial · task 1 of 2 · earnings saved for you');
  await expect(page.getByText('100 G$ saved for you so far.')).toBeVisible();

  await page.getByRole('button', { name: 'Next task' }).click();
  await doTrialTask(page, 'Free trial · task 2 of 2 · earnings saved for you');
  await expect(page.getByText('Free trial · 2 of 2 done · earnings saved for you')).toBeVisible();
  await expect(page.getByText('200 G$ saved for you so far.')).toBeVisible();

  // The 3rd action opens "Verify you're a real person" instead of a third task.
  await page.getByRole('button', { name: 'Next task' }).click();
  const modal = page.getByRole('dialog', { name: "Verify you're a real person" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('1 minute, face check by GoodDollar');
  await expect(modal.getByRole('link', { name: 'Open the verification page' })).toHaveAttribute('href', '/verify');

  // The server agrees: no third trial task for this wallet, and both tasks are saved with their reward.
  const next = await page.request.get('/api/tasks/next');
  expect(next.status()).toBe(409);
  expect(await next.json()).toMatchObject({ ok: false, error: { code: 'VERIFICATION_REQUIRED' } });
  const session = await prisma.trialSession.findUnique({ where: { walletAddress: worker.address.toLowerCase() } });
  expect(session?.tasksCompleted).toBe(2);
  expect(session?.escrowedWei.toFixed(0)).toBe((200n * 10n ** 18n).toString());

  // A reload keeps the trial done: the session survives and the wallet reconnects (the wagmi cookie
  // restores a plain connector first, which must never crash the page).
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a wallet' }).getByRole('button', { name: 'E2E Wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Free trial complete' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep working' }).click();
  await expect(page.getByRole('dialog', { name: "Verify you're a real person" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
