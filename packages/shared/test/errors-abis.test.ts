import {
  concat,
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  stringToBytes,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { GOODDOLLAR_CELO, KNOWN_DEPLOYMENTS } from '../src/addresses';
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
import {
  AGENT_CONSENT_TYPE,
  AGENT_CONSENT_TYPEHASH,
  AGENT_CONSENT_TYPES,
  agentConsentTypedData,
  type AgentConsentMessage,
} from '../src/agent-consent';

function functionNames(abi: Abi): string[] {
  return abi.flatMap((item) => (item.type === 'function' ? [item.name] : []));
}

/** `name(type,...)` of every function or event of an ABI. */
function signatures(abi: Abi, type: 'function' | 'event'): string[] {
  return abi.flatMap((item) =>
    item.type === type ? [`${item.name}(${item.inputs.map((input) => input.type).join(',')})`] : [],
  );
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
      namedArgs: {},
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
      namedArgs: { account },
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

  it('decodes the v2 contract errors with stable keys and named arguments', () => {
    const agent = getAddress('0x1111111111111111111111111111111111111111');
    const cases = [
      {
        abi: veriWorkCoreAbi,
        name: 'EpochNotSettleable',
        args: [2967n, 1_795_262_400n, 1_796_040_000n],
        key: 'EPOCH_NOT_SETTLEABLE',
        named: { epochId: 2967n, settleableFrom: 1_795_262_400n, settleableUntil: 1_796_040_000n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'SenderFeeNotSupported',
        args: [101n, 100n],
        key: 'SENDER_FEE_NOT_SUPPORTED',
        named: { spent: 101n, amount: 100n },
      },
      {
        abi: agentRegistryAbi,
        name: 'ReceiverFeeNotSupported',
        args: [99n, 100n],
        key: 'RECEIVER_FEE_NOT_SUPPORTED',
        named: { received: 99n, amount: 100n },
      },
      {
        abi: agentRegistryAbi,
        name: 'ConsentExpired',
        args: [1_794_830_400n],
        key: 'CONSENT_EXPIRED',
        named: { deadline: 1_794_830_400n },
      },
      {
        abi: agentRegistryAbi,
        name: 'InvalidConsent',
        args: [agent],
        key: 'INVALID_CONSENT',
        named: { agentAddress: agent },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'StakeAmountAboveMax',
        args: [200n, 150n],
        key: 'STAKE_AMOUNT_ABOVE_MAX',
        named: { stakeAmount: 200n, maxAmount: 150n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'ModulePriceAboveMax',
        args: [1n, 10_000n, 100n],
        key: 'MODULE_PRICE_ABOVE_MAX',
        named: { moduleId: 1n, price: 10_000n, maxPrice: 100n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'PlatformFeeAboveMax',
        args: [2_000n, 1_000n],
        key: 'PLATFORM_FEE_ABOVE_MAX',
        named: { feeBps: 2_000n, maxFeeBps: 1_000n },
      },
      {
        abi: agentRegistryAbi,
        name: 'BondAboveMax',
        args: [300n, 250n],
        key: 'BOND_ABOVE_MAX',
        named: { bond: 300n, maxBond: 250n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'EpochTotalTooLarge',
        args: [1_501n, 1_500n],
        key: 'EPOCH_TOTAL_TOO_LARGE',
        named: { total: 1_501n, max: 1_500n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'CampaignFundsLocked',
        args: [1_794_916_800n],
        key: 'CAMPAIGN_FUNDS_LOCKED',
        named: { unlockAt: 1_794_916_800n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'DiscretionaryOutflowLimitExceeded',
        args: [1n, 0n],
        key: 'DISCRETIONARY_OUTFLOW_LIMIT_EXCEEDED',
        named: { requested: 1n, available: 0n },
      },
      {
        abi: agentRegistryAbi,
        name: 'InsufficientSurplus',
        args: [5n, 6n],
        key: 'INSUFFICIENT_SURPLUS',
        named: { available: 5n, required: 6n },
      },
      {
        abi: veriWorkCoreAbi,
        name: 'InvalidRecipient',
        args: [agent],
        key: 'INVALID_RECIPIENT',
        named: { recipient: agent },
      },
      {
        abi: agentRegistryAbi,
        name: 'AgentHasNoBond',
        args: [agent],
        key: 'AGENT_HAS_NO_BOND',
        named: { agentAddress: agent },
      },
      { abi: agentRegistryAbi, name: 'ZeroAmount', args: [], key: 'ZERO_AMOUNT', named: {} },
    ] as const;
    for (const item of cases) {
      const data = encodeErrorResult({
        abi: item.abi as Abi,
        errorName: item.name,
        args: [...item.args],
      });
      expect(decodeKnownError(data)).toEqual({
        key: item.key,
        name: item.name,
        selector: data.slice(0, 10),
        args: [...item.args],
        namedArgs: item.named,
      });
      expect(KNOWN_ERROR_KEYS).toContain(item.key);
    }
    // EpochNotSettleable gained a third argument, so its selector changed.
    expect(toFunctionSelector('function EpochNotSettleable(uint256,uint256,uint256)')).toBe(
      '0xb57a85eb',
    );
  });

  it('no longer knows the errors v2 removed (old selectors decode to null)', () => {
    const removed = [
      'function NoSurplus()',
      'function FeeOnTransferNotSupported()',
      'function EpochNotSettleable(uint256,uint256)',
    ];
    expect(removed.map((signature) => toFunctionSelector(signature))).toEqual([
      '0xc0ef17d3',
      '0x9bfa3c17',
      '0xa4c1c158',
    ]);
    expect(decodeKnownError('0xc0ef17d3')).toBeNull();
    expect(decodeKnownError('0x9bfa3c17')).toBeNull();
    const twoArgs =
      '0xa4c1c158' +
      encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [2967n, 1n]).slice(2);
    expect(decodeKnownError(twoArgs)).toBeNull();
    for (const key of ['NO_SURPLUS', 'FEE_ON_TRANSFER_NOT_SUPPORTED'])
      expect(KNOWN_ERROR_KEYS).not.toContain(key);
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

  it('generated contract ABIs are v2: caller caps, consent, partial sweeps, epoch cancel', () => {
    expect(signatures(veriWorkCoreAbi, 'function')).toEqual(
      expect.arrayContaining([
        'settleEpoch(uint256,bytes32,bytes32[],uint256)',
        'claim(uint256,uint256,uint256,bytes32[])',
        'markConsensus(bytes32,uint128,bytes32)',
        'depositStake(uint256)',
        'depositStakeWithPermit(uint256,uint256,uint8,bytes32,bytes32)',
        'purchaseModule(uint256,uint256)',
        'purchaseModuleWithPermit(uint256,uint256,uint256,uint8,bytes32,bytes32)',
        'fundCampaign(bytes32,uint256,uint16)',
        'fundCampaignWithPermit(bytes32,uint256,uint16,uint256,uint8,bytes32,bytes32)',
        'sweepSurplus(address,uint256)',
        'cancelEpoch(uint256)',
        'trialWalletOf(address)',
        'remainingDiscretionaryCapacity()',
      ]),
    );
    // The v1 entry points are gone (their selectors would revert against v2).
    expect(signatures(veriWorkCoreAbi, 'function')).not.toEqual(
      expect.arrayContaining(['depositStake()']),
    );
    expect(signatures(veriWorkCoreAbi, 'event')).toEqual(
      expect.arrayContaining([
        'TrialRewardForfeited(uint256,address,address,uint256)',
        'EpochCancelled(uint256,uint256)',
      ]),
    );
    expect(signatures(agentRegistryAbi, 'function')).toEqual(
      expect.arrayContaining([
        'registerAgent(address,bytes32,uint256,uint256,bytes)',
        'registerAgentWithPermit(address,bytes32,uint256,bytes,uint256,uint256,uint8,bytes32,bytes32)',
        'consentDigest(address,bytes32,uint256)',
        'AGENT_CONSENT_TYPEHASH()',
        'sweepSurplus(address,uint256)',
        'isActiveAgent(address)',
      ]),
    );
    expect(signatures(agentRegistryAbi, 'event')).toEqual(
      expect.arrayContaining(['SurplusSwept(address,uint256)']),
    );
    expect(functionNames(veriWorkCoreAbi)).toContain('claimMany');
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

  it('AgentConsent digest equals the Solidity EIP-712 encoding and recovers the agent key', async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const registry = GOODDOLLAR_CELO.faucet;
    const message = {
      owner: GOODDOLLAR_CELO.identity,
      metadataHash: keccak256(stringToBytes('{"name":"VeriWork AI"}')),
      deadline: 1_794_830_400n,
    } as const;
    expect(AGENT_CONSENT_TYPE).toBe(
      'AgentConsent(address owner,bytes32 metadataHash,uint256 deadline)',
    );
    expect(AGENT_CONSENT_TYPEHASH).toBe(keccak256(stringToBytes(AGENT_CONSENT_TYPE)));
    // keccak256(abi.encode(TYPEHASH, owner, metadataHash, deadline)), as the contract hashes it.
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
        [AGENT_CONSENT_TYPEHASH, message.owner, message.metadataHash, message.deadline],
      ),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          keccak256(
            stringToBytes(
              'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
            ),
          ),
          keccak256(stringToBytes('VeriWork AgentRegistry')),
          keccak256(stringToBytes('1')),
          42220n,
          registry,
        ],
      ),
    );
    const typedData = agentConsentTypedData(message, registry);
    expect(hashTypedData(typedData)).toBe(
      keccak256(concat(['0x1901', domainSeparator, structHash])),
    );
    const signature = await agent.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(agent.address);
  });

  it('AgentConsent digest equals AgentRegistry.consentDigest (vectors read from the contract)', () => {
    // Read with `cast call <registry> "consentDigest(address,bytes32,uint256)"`: from the compiled
    // AgentRegistry deployed on a local chain with chainId 42220 (first contract of the default
    // deployer), and from the live mainnet registry. Their eip712Domain() is
    // ("VeriWork AgentRegistry", "1", 42220, <registry>) and AGENT_CONSENT_TYPEHASH() the value below.
    const localRegistry = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
    const mainnetRegistry = KNOWN_DEPLOYMENTS[42220]?.agentRegistry;
    expect(mainnetRegistry).toBe('0x7D251CB1C4321cEff128F265CA17a2F65F85F05E');
    expect(AGENT_CONSENT_TYPEHASH).toBe(
      '0xcc356a28737e085929e62598e2a51654abbf0a4d952171d5a53dc72b361f3ab6',
    );
    const message = {
      owner: getAddress('0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a'),
      metadataHash: keccak256(stringToBytes('{"name":"VeriWork AI","model":"claude-opus-5-5"}')),
      deadline: 1_794_830_400n,
    } as const;
    expect(message.metadataHash).toBe(
      '0xbb11b02da120e7b582b7cd70a5db1e0f4ff43275f9b9a4f735723c7a0fa2c383',
    );
    const digest = (consent: AgentConsentMessage, registry: Address) =>
      hashTypedData(agentConsentTypedData(consent, registry));
    expect(digest(message, localRegistry)).toBe(
      '0x0a70b7bf11a85362ffaa7373d743ae8c6f88fca59e6daa2f856f9fd3fd79a758',
    );
    expect(digest(message, mainnetRegistry ?? localRegistry)).toBe(
      '0x6f146ba7e5eed661fca44a14c1a627ba3d1bf6567bd3fd83402371c203aa14db',
    );
    const zero = {
      owner: getAddress('0x0000000000000000000000000000000000000001'),
      metadataHash: `0x${'00'.repeat(32)}`,
      deadline: 0n,
    } as const;
    expect(digest(zero, localRegistry)).toBe(
      '0xfeefeecd55ed7e2833182548338acde7f105f38ac46cba3419aad98cd1b1fb29',
    );
  });
});
