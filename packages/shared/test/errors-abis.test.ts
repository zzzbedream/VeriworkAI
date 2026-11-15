import {
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToBytes,
  toEventSelector,
  toFunctionSelector,
  type Abi,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { GOODDOLLAR_CELO } from '../src/addresses';
import {
  engagementAppClaimTypedData,
  engagementRewardsAbi,
  ENGAGEMENT_APP_CLAIM_TYPES,
  ENGAGEMENT_USER_CLAIM_TYPES,
} from '../src/abis/engagementRewards';
import { faucetAbi } from '../src/abis/faucet';
import { gDollarAbi, PERMIT_TYPES } from '../src/abis/gDollar';
import { agentRegistryAbi, veriWorkCoreAbi } from '../src/abis/generated';
import { identityAbi } from '../src/abis/identity';
import { mentoBrokerAbi, mentoExchangeProviderAbi } from '../src/abis/mento';
import { ubiSchemeAbi } from '../src/abis/ubiScheme';
import {
  decodeKnownError,
  errorKey,
  extractRevertData,
  G_DOLLAR_BLOCKED_SELECTOR,
  G_DOLLAR_PAUSED_SELECTOR,
  KNOWN_ERROR_KEYS,
  KNOWN_ERRORS_ABI,
} from '../src/errors';
import {
  contractRoleName,
  DEFAULT_ADMIN_ROLE,
  GUARDIAN_ROLE,
  OPERATOR_ROLE,
  SPONSOR_ROLE,
} from '../src/roles';
import { AGENT_CONSENT_TYPES, agentConsentTypedData } from '../src/agent-consent';

function functionNames(abi: Abi): string[] {
  return abi.flatMap((item) => (item.type === 'function' ? [item.name] : []));
}

describe('decodeKnownError', () => {
  it('maps G$ admin errors to stable keys with the verified selectors', () => {
    expect(toFunctionSelector('function SUPER_GOODDOLLAR_PAUSED()')).toBe(G_DOLLAR_PAUSED_SELECTOR);
    expect(toFunctionSelector('function SUPER_GOODDOLLAR_BLOCKED()')).toBe(
      G_DOLLAR_BLOCKED_SELECTOR,
    );
    expect(decodeKnownError('0x7f66be17')).toEqual({
      key: 'G_DOLLAR_PAUSED',
      name: 'SUPER_GOODDOLLAR_PAUSED',
      selector: '0x7f66be17',
      args: [],
    });
    expect(decodeKnownError('0xE7D0C09E')?.key).toBe('G_DOLLAR_BLOCKED');
  });

  it('decodes every VeriWorkCore / AgentRegistry custom error with arguments', () => {
    const account = getAddress('0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a');
    const data = encodeErrorResult({
      abi: veriWorkCoreAbi,
      errorName: 'NotVerifiedHuman',
      args: [account],
    });
    expect(decodeKnownError(data)).toEqual({
      key: 'NOT_VERIFIED_HUMAN',
      name: 'NotVerifiedHuman',
      selector: data.slice(0, 10),
      args: [account],
    });
    const batch = encodeErrorResult({
      abi: veriWorkCoreAbi,
      errorName: 'InvalidBatchStatus',
      args: [`0x${'11'.repeat(32)}`, 2, 3],
    });
    expect(decodeKnownError(batch)?.key).toBe('INVALID_BATCH_STATUS');
    const errorNames = [...veriWorkCoreAbi, ...agentRegistryAbi].flatMap((item) =>
      item.type === 'error' ? [item.name] : [],
    );
    for (const name of errorNames) expect(KNOWN_ERROR_KEYS).toContain(errorKey(name));
  });

  it('decodes Error(string) and Panic(uint256)', () => {
    const reason =
      '0x08c379a0' + encodeAbiParameters([{ type: 'string' }], ['Invalid app signature']).slice(2);
    expect(decodeKnownError(reason)).toMatchObject({
      key: 'REVERTED_WITH_REASON',
      args: ['Invalid app signature'],
    });
    const panic = '0x4e487b71' + encodeAbiParameters([{ type: 'uint256' }], [0x11n]).slice(2);
    expect(decodeKnownError(panic)).toMatchObject({ key: 'PANIC', args: [0x11n] });
  });

  it('finds revert data inside nested viem / RPC error objects', () => {
    const nested = {
      name: 'CallExecutionError',
      cause: { name: 'RpcRequestError', error: { data: '0x7f66be17' } },
    };
    expect(extractRevertData(nested)).toBe('0x7f66be17');
    expect(decodeKnownError(nested)?.key).toBe('G_DOLLAR_PAUSED');
    expect(decodeKnownError({ cause: { raw: '0xe7d0c09e' } })?.key).toBe('G_DOLLAR_BLOCKED');
  });

  it('returns null for unknown or missing data', () => {
    expect(decodeKnownError('0xdeadbeef')).toBeNull();
    expect(decodeKnownError('0x12')).toBeNull();
    expect(decodeKnownError('nope')).toBeNull();
    expect(decodeKnownError(null)).toBeNull();
    expect(decodeKnownError(42)).toBeNull();
    expect(decodeKnownError({ message: 'no data' })).toBeNull();
    const deep = Array.from({ length: 12 }).reduce<unknown>(
      (inner) => ({ cause: inner }),
      '0x7f66be17',
    );
    expect(decodeKnownError(deep)).toBeNull();
  });

  it('derives stable keys from Solidity names', () => {
    expect(errorKey('RollingOutflowLimitExceeded')).toBe('ROLLING_OUTFLOW_LIMIT_EXCEEDED');
    expect(errorKey('ERC20InsufficientBalance')).toBe('ERC20_INSUFFICIENT_BALANCE');
    expect(errorKey('AccessControlUnauthorizedAccount')).toBe(
      'ACCESS_CONTROL_UNAUTHORIZED_ACCOUNT',
    );
    expect(errorKey('SUPER_TOKEN_TRANSFER_TO_ZERO_ADDRESS')).toBe(
      'SUPER_TOKEN_TRANSFER_TO_ZERO_ADDRESS',
    );
    expect(errorKey('SF_TOKEN_MOVE_INSUFFICIENT_BALANCE')).toBe('G_DOLLAR_INSUFFICIENT_BALANCE');
  });

  it('has no duplicate error signatures', () => {
    const signatures = KNOWN_ERRORS_ABI.map(
      (error) => `${error.name}(${error.inputs.map((i) => i.type).join(',')})`,
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe('handwritten ABIs', () => {
  it('cover the functions the worker and web app call', () => {
    expect(functionNames(gDollarAbi)).toEqual(
      expect.arrayContaining([
        'balanceOf',
        'transfer',
        'permit',
        'nonces',
        'DOMAIN_SEPARATOR',
        'paused',
        'isBlocked',
      ]),
    );
    expect(functionNames(identityAbi)).toEqual(
      expect.arrayContaining([
        'getWhitelistedRoot',
        'isWhitelisted',
        'identities',
        'reverifyDaysOptions',
        'authenticationPeriod',
        'connectedAccounts',
      ]),
    );
    expect(functionNames(ubiSchemeAbi)).toEqual(
      expect.arrayContaining(['claim', 'lastClaimed', 'periodStart', 'currentDay', 'dailyUbi']),
    );
    expect(functionNames(faucetAbi)).toEqual(expect.arrayContaining(['canTop', 'topWallet']));
    expect(functionNames(engagementRewardsAbi)).toEqual(
      expect.arrayContaining([
        'nonContractAppClaim',
        'appClaim',
        'registeredApps',
        'userRegistrations',
      ]),
    );
    expect(functionNames(mentoExchangeProviderAbi)).toEqual(['currentPrice']);
    expect(functionNames(mentoBrokerAbi)).toEqual(['getAmountOut']);
  });

  it('event topics match the verified on-chain values', () => {
    const ubiClaimed = ubiSchemeAbi.find(
      (item) => item.type === 'event' && item.name === 'UBIClaimed',
    );
    expect(ubiClaimed && toEventSelector(ubiClaimed)).toBe(
      '0x89ed24731df6b066e4c5186901fffdba18cd9a10f07494aff900bdee260d1304',
    );
    const whitelistedAdded = identityAbi.find(
      (item) => item.type === 'event' && item.name === 'WhitelistedAdded',
    );
    expect(whitelistedAdded && toEventSelector(whitelistedAdded)).toBe(
      '0xee1504a83b6d4a361f4c1dc78ab59bfa30d6a3b6612c403e86bb01ef2984295f',
    );
    const connected = identityAbi.find(
      (item) => item.type === 'event' && item.name === 'AccountConnected',
    );
    expect(connected && toEventSelector(connected)).toBe(
      '0x18f7736ef54539debd9afd3c9500b106e12ae7c70e685f5a5efd727b1ce1d54c',
    );
  });

  it('typed-data type strings match the verified EngagementRewards typehashes', () => {
    const appClaim = ENGAGEMENT_APP_CLAIM_TYPES.AppClaim.map(
      (field) => `${field.type} ${field.name}`,
    ).join(',');
    const userClaim = ENGAGEMENT_USER_CLAIM_TYPES.Claim.map(
      (field) => `${field.type} ${field.name}`,
    ).join(',');
    expect(keccak256(stringToBytes(`AppClaim(${appClaim})`))).toBe(
      '0x3f939797bbee504ef25a922a8408fbdcebc4752f31f0d6c8ea42babea9f5e8dd',
    );
    expect(keccak256(stringToBytes(`Claim(${userClaim})`))).toBe(
      '0xcfeeafde86c38dcd27e7f3574225bf6be8c78e4aa28ebc85bc2989e109c15c1b',
    );
    const permit = PERMIT_TYPES.Permit.map((field) => `${field.type} ${field.name}`).join(',');
    expect(permit).toBe(
      'address owner,address spender,uint256 value,uint256 nonce,uint256 deadline',
    );
  });

  it('builds hashable AppClaim typed data on the production domain', () => {
    const typedData = engagementAppClaimTypedData(
      {
        app: GOODDOLLAR_CELO.gDollar,
        user: GOODDOLLAR_CELO.identity,
        validUntilBlock: 82_846_550n,
      },
      GOODDOLLAR_CELO.engagementRewards.production,
    );
    expect(typedData.domain).toEqual({
      name: 'EngagementRewards',
      version: '1.0',
      chainId: 42220,
      verifyingContract: GOODDOLLAR_CELO.engagementRewards.production,
    });
    expect(hashTypedData(typedData)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('placeholder contract ABIs parse and expose the settlement entry points', () => {
    expect(functionNames(veriWorkCoreAbi)).toEqual(
      expect.arrayContaining([
        'settleEpoch',
        'claim',
        'claimMany',
        'depositStakeWithPermit',
        'markConsensus',
      ]),
    );
    expect(functionNames(agentRegistryAbi)).toEqual(
      expect.arrayContaining(['registerAgentWithPermit', 'isActiveAgent']),
    );
    expect(parseAbi(['error PermitFailed(uint256 allowance, uint256 required)'])).toHaveLength(1);
  });
});

describe('contract roles and agent consent', () => {
  it('role hashes are keccak256 of the role names', () => {
    expect(GUARDIAN_ROLE).toBe(keccak256(stringToBytes('GUARDIAN_ROLE')));
    expect(OPERATOR_ROLE).toBe(keccak256(stringToBytes('OPERATOR_ROLE')));
    expect(SPONSOR_ROLE).toBe(keccak256(stringToBytes('SPONSOR_ROLE')));
    expect(DEFAULT_ADMIN_ROLE).toBe(`0x${'00'.repeat(32)}`);
    expect(contractRoleName(SPONSOR_ROLE.toUpperCase().replace('0X', '0x'))).toBe('SPONSOR_ROLE');
    expect(contractRoleName('0x1234')).toBeNull();
  });

  it('a missing SPONSOR_ROLE decodes as SPONSOR_NOT_APPROVED, other roles keep the generic key', () => {
    const account = getAddress('0x1111111111111111111111111111111111111111');
    const sponsor = encodeErrorResult({
      abi: veriWorkCoreAbi,
      errorName: 'AccessControlUnauthorizedAccount',
      args: [account, SPONSOR_ROLE],
    });
    expect(decodeKnownError(sponsor)?.key).toBe('SPONSOR_NOT_APPROVED');
    expect(KNOWN_ERROR_KEYS).toContain('SPONSOR_NOT_APPROVED');
    const operator = encodeErrorResult({
      abi: veriWorkCoreAbi,
      errorName: 'AccessControlUnauthorizedAccount',
      args: [account, OPERATOR_ROLE],
    });
    expect(decodeKnownError(operator)?.key).toBe('ACCESS_CONTROL_UNAUTHORIZED_ACCOUNT');
  });

  it('builds AgentConsent typed data on the registry domain', () => {
    const typedData = agentConsentTypedData(
      {
        owner: GOODDOLLAR_CELO.identity,
        metadataHash: `0x${'ab'.repeat(32)}`,
        deadline: 1_794_830_400n,
      },
      GOODDOLLAR_CELO.faucet,
      11142220,
    );
    expect(typedData.domain).toEqual({
      name: 'VeriWork AgentRegistry',
      version: '1',
      chainId: 11142220,
      verifyingContract: GOODDOLLAR_CELO.faucet,
    });
    const fields = AGENT_CONSENT_TYPES.AgentConsent.map(
      (field) => `${field.type} ${field.name}`,
    ).join(',');
    expect(fields).toBe('address owner,bytes32 metadataHash,uint256 deadline');
    expect(hashTypedData(typedData)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(agentConsentTypedData(typedData.message, GOODDOLLAR_CELO.faucet).domain.chainId).toBe(
      42220,
    );
  });
});
