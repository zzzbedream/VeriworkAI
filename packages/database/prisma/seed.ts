/**
 * Local / dev seed (`pnpm --filter @veriwork/database db:seed -- <adminWallet>`): creates the given
 * wallet as an ADMIN user. Idempotent. Demo campaign content is loaded by the worker's `seed:demo`.
 */
import 'dotenv/config';
import { createPrisma } from '../src/client';
import { ensureUser, grantRole } from '../src/repositories/users';

async function main(argv: readonly string[]): Promise<void> {
  const admin = argv.find((arg) => /^0x[0-9a-fA-F]{40}$/.test(arg));
  if (admin === undefined) {
    process.stdout.write('Usage: prisma db seed -- <adminWalletAddress>. Nothing seeded.\n');
    return;
  }
  const prisma = createPrisma();
  try {
    const user = await ensureUser(prisma, admin);
    await grantRole(prisma, user.walletAddress, 'ADMIN');
    process.stdout.write(`Seeded ADMIN ${user.walletAddress}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
