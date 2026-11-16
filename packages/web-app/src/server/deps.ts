import 'server-only';
import type { PrismaClient } from '@veriwork/database';
import { getPublicConfig } from '@/lib/config/public-env';
import { createCoreReader, type CoreReader } from './chain/core-reader';
import { getServerPublicClient } from './chain/public-client';
import { loadServerConfig, type ServerConfig } from './config';
import { getDb } from './db';
import { getIdentityReader } from './identity/registry';
import type { IdentityReader } from './identity/types';
import { sessionKeyFromSecret } from './session/token';
import { siweVerifierFor, type SiweSignatureVerifier } from './siwe/validate';

/** Everything a route handler needs, resolved lazily per request (nothing is read at import time). */
export interface ServerDeps {
  readonly db: () => PrismaClient;
  readonly config: () => ServerConfig;
  readonly sessionKey: () => Uint8Array;
  readonly identity: () => IdentityReader;
  readonly verifySiwe: () => SiweSignatureVerifier;
  /** VeriWorkCore reads (admin role, modules) over the server RPCs. */
  readonly chain: () => CoreReader;
  readonly now: () => Date;
}

export const defaultDeps: ServerDeps = {
  db: getDb,
  config: () => loadServerConfig(),
  sessionKey: () => sessionKeyFromSecret(process.env.SESSION_SECRET),
  identity: getIdentityReader,
  verifySiwe: () => siweVerifierFor(getServerPublicClient(loadServerConfig())),
  chain: () => createCoreReader(getServerPublicClient(loadServerConfig()), getPublicConfig().contracts.core),
  now: () => new Date(),
};
