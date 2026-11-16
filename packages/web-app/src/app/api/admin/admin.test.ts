import { createSubmission, getUser, grantRole } from '@veriwork/database';
import { gDollars } from '@veriwork/shared/amounts';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { AdminOverviewSchema, AdminRoleChangeResponseSchema, AdminUserRolesSchema } from '@/lib/api/admin-schemas';
import type { ServerDeps } from '@/server/deps';
import {
  createAdminOverviewHandler,
  createAdminRoleChangeHandler,
  createAdminRolesHandler,
} from '@/server/handlers/admin';
import { seedPublishedBatch, seedUser } from '@/test-utils/pipeline-seed';
import {
  apiRequest,
  fakeCoreReader,
  readEnvelope,
  sessionCookieFor,
  setupTestDb,
  testDeps,
  type FakeCoreReaderOptions,
} from '@/test-utils/server';

const prisma = setupTestDb();
const ADMIN = '0x4e5a7b9f7f66c208bdded352356b33a3a634ad6d' as Address;
const MEMBER = '0x3000000000000000000000000000000000000030' as Address;
const WORKER = '0x1000000000000000000000000000000000000010' as Address;

function deps(chain: FakeCoreReaderOptions = { admins: [ADMIN] }): ServerDeps {
  const reader = fakeCoreReader(chain);
  return testDeps(prisma, { chain: () => reader });
}

async function getOverview(wallet: Address | null, options?: FakeCoreReaderOptions): Promise<Response> {
  const cookie = wallet === null ? undefined : await sessionCookieFor(wallet);
  return createAdminOverviewHandler(deps(options))(apiRequest('/api/admin/overview', { method: 'GET', origin: null, cookie }));
}

async function changeRole(body: unknown, options: { wallet?: Address; origin?: string } = {}): Promise<Response> {
  const cookie = await sessionCookieFor(options.wallet ?? ADMIN);
  return createAdminRoleChangeHandler(deps())(apiRequest('/api/admin/roles', { body, cookie, origin: options.origin }));
}

async function seedAdmin(): Promise<void> {
  await seedUser(prisma, ADMIN);
  await grantRole(prisma, ADMIN, 'ADMIN');
}

describe('admin gating (DEFAULT_ADMIN_ROLE on VeriWorkCore, read on every request)', () => {
  it('refuses anonymous visitors, other wallets, an unreadable chain and unconfigured deployments', async () => {
    expect((await getOverview(null)).status).toBe(401);
    const member = await getOverview(MEMBER);
    expect([member.status, (await readEnvelope(member)).error?.code]).toEqual([403, 'FORBIDDEN']);
    const offline = await getOverview(ADMIN, { admins: [ADMIN], unavailable: true });
    expect([offline.status, (await readEnvelope(offline)).error?.code]).toEqual([503, 'IDENTITY_UNAVAILABLE']);
    const unconfigured = await getOverview(ADMIN, { admins: [ADMIN], core: null });
    expect((await readEnvelope(unconfigured)).error?.code).toBe('FEATURE_DISABLED');
    const notAdmin = await changeRole({ address: MEMBER, role: 'REVIEWER', granted: true }, { wallet: MEMBER });
    expect((await readEnvelope(notAdmin)).error?.code).toBe('FORBIDDEN');
    const lookup = await createAdminRolesHandler(deps())(
      apiRequest(`/api/admin/roles?address=${MEMBER}`, { method: 'GET', origin: null, cookie: await sessionCookieFor(MEMBER) }),
    );
    expect(lookup.status).toBe(403);
  });
});

describe('GET /api/admin/overview', () => {
  it('shows open campaigns with their progress, active batches, open work and the last week settled', async () => {
    const { campaign, batchId, itemIds } = await seedPublishedBatch(prisma, { items: 2, pilot: true });
    await seedUser(prisma, WORKER, '0x1100000000000000000000000000000000000011' as Address);
    await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: WORKER,
      workerRoot: '0x1100000000000000000000000000000000000011',
      isTrial: false,
      correction: { labels: ['neutral'] },
    });
    await prisma.epoch.create({ data: { id: 2966, status: 'POSTED', totalWei: gDollars(130n).toString() } });

    const data = AdminOverviewSchema.parse((await readEnvelope(await getOverview(ADMIN))).data);
    expect(data.campaigns).toEqual([
      expect.objectContaining({
        id: campaign.id,
        status: 'FUNDED',
        qaProfile: 'PILOT',
        progress: expect.objectContaining({ items: 2, drafted: 2, inReview: 1, batches: { IN_HUMAN_REVIEW: 1 } }),
      }),
    ]);
    expect(data.batches).toEqual([
      expect.objectContaining({
        id: batchId,
        status: 'IN_HUMAN_REVIEW',
        frozenAt: null,
        readiness: { totalItems: 2, acceptedItems: 0, closedItems: 0, openSubmissions: 1, deadlinePassed: false, ready: false },
      }),
    ]);
    expect(data.openSubmissions).toBe(1);
    expect(data.lastEpoch).toMatchObject({ id: 2966, status: 'POSTED', totalWei: gDollars(130n).toString() });
  });
});

describe('/api/admin/roles', () => {
  it('looks up the roles of a wallet', async () => {
    await seedUser(prisma, MEMBER);
    const handler = createAdminRolesHandler(deps());
    const cookie = await sessionCookieFor(ADMIN);
    const known = await handler(apiRequest(`/api/admin/roles?address=${MEMBER}`, { method: 'GET', origin: null, cookie }));
    expect(AdminUserRolesSchema.parse((await readEnvelope(known)).data)).toEqual({ address: MEMBER, known: true, roles: ['WORKER'] });
    const unknown = await handler(apiRequest(`/api/admin/roles?address=${WORKER}`, { method: 'GET', origin: null, cookie }));
    expect((await readEnvelope(unknown)).data).toEqual({ address: WORKER, known: false, roles: [] });
    const invalid = await handler(apiRequest('/api/admin/roles?address=0x123', { method: 'GET', origin: null, cookie }));
    expect((await readEnvelope(invalid)).error?.code).toBe('VALIDATION_FAILED');
  });

  it('grants and revokes REVIEWER and QA, idempotently', async () => {
    await seedAdmin();
    await seedUser(prisma, MEMBER);
    const granted = AdminRoleChangeResponseSchema.parse(
      (await readEnvelope(await changeRole({ address: MEMBER, role: 'REVIEWER', granted: true }))).data,
    );
    expect(granted).toEqual({ address: MEMBER, roles: ['WORKER', 'REVIEWER'], changed: true });
    const again = await readEnvelope(await changeRole({ address: MEMBER, role: 'REVIEWER', granted: true }));
    expect(again.data).toMatchObject({ changed: false });
    await changeRole({ address: MEMBER, role: 'QA', granted: true });
    const revoked = await readEnvelope(await changeRole({ address: MEMBER, role: 'REVIEWER', granted: false }));
    expect(revoked.data).toEqual({ address: MEMBER, roles: ['WORKER', 'QA'], changed: true });
    expect((await getUser(prisma, MEMBER))?.roles).toEqual(['WORKER', 'QA']);
  });

  it('explains unknown wallets, a missing admin record and invalid requests', async () => {
    await seedUser(prisma, MEMBER);
    const noRecord = await changeRole({ address: MEMBER, role: 'QA', granted: true });
    expect([noRecord.status, (await readEnvelope(noRecord)).error?.code]).toEqual([403, 'NOT_ELIGIBLE']);
    await seedAdmin();
    const unknown = await changeRole({ address: WORKER, role: 'QA', granted: true });
    expect([unknown.status, (await readEnvelope(unknown)).error?.code]).toEqual([404, 'NOT_FOUND']);
    const adminRole = await changeRole({ address: MEMBER, role: 'ADMIN', granted: true });
    expect((await readEnvelope(adminRole)).error?.code).toBe('VALIDATION_FAILED');
    const crossSite = await changeRole({ address: MEMBER, role: 'QA', granted: true }, { origin: 'https://evil.example' });
    expect((await readEnvelope(crossSite)).error?.code).toBe('BAD_ORIGIN');
  });
});
