import { describe, expect, it } from 'vitest';
import * as shared from '../src/index';
import {
  agentStatusFromOnchain,
  AgentStatus,
  CampaignStatus,
  EpochStatus,
  GasTopUpStatus,
  GasTopUpStatusSchema,
  OnchainAgentStatus,
  Role,
  RoleSchema,
} from '../src/enums';

describe('enum mirrors', () => {
  it('keys equal values (same shape as the generated Prisma enums)', () => {
    for (const mirror of [Role, CampaignStatus, EpochStatus, AgentStatus, GasTopUpStatus]) {
      for (const [key, value] of Object.entries(mirror)) expect(key).toBe(value);
    }
    expect(Object.values(GasTopUpStatus)).toEqual(['REQUESTED', 'SENT', 'FAILED']);
    expect(RoleSchema.safeParse('ADMIN').success).toBe(true);
    expect(GasTopUpStatusSchema.safeParse('DONE').success).toBe(false);
  });

  it('maps on-chain agent statuses', () => {
    expect(agentStatusFromOnchain(OnchainAgentStatus.None)).toBeNull();
    expect(agentStatusFromOnchain(OnchainAgentStatus.Active)).toBe('ACTIVE');
    expect(agentStatusFromOnchain(4n)).toBe('WITHDRAWN');
    expect(() => agentStatusFromOnchain(5)).toThrow(RangeError);
  });
});

describe('package barrel', () => {
  it('re-exports every module', () => {
    for (const name of [
      'CELO_CHAIN_ID',
      'GOODDOLLAR_CELO',
      'splitFee',
      'weekStart',
      'computeIdentityExpiry',
      'buildEpochTree',
      'aggregateAllocations',
      'evaluateQaConsensus',
      'isFiveDayEligible',
      'Season5MetricsSchema',
      'API_ROUTES',
      'decodeKnownError',
      'formatGDollar',
      'veriWorkCoreAbi',
      'agentRegistryAbi',
      'gDollarAbi',
      'identityAbi',
      'ubiSchemeAbi',
      'faucetAbi',
      'engagementRewardsAbi',
      'mentoExchangeProviderAbi',
      'toJsonValue',
      'canonicalJson',
      'parseTaskJsonl',
      'createTelegramLinkToken',
      'retentionRate',
    ]) {
      expect(shared).toHaveProperty(name);
    }
  });
});
