import {
  agentRegistryAbi,
  faucetAbi,
  G_DOLLAR_PERMIT_DOMAIN,
  gDollarAbi,
  GUARDIAN_ROLE,
  identityAbi,
  mentoExchangeProviderAbi,
  PERMIT_TYPES,
  ubiSchemeAbi,
} from '@veriwork/shared';
import {
  domainSeparator,
  recoverTypedDataAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { FakeRevert, revert, type FakeContract, type WriteContext } from './fake-rpc';

const key = (address: string): string => address.toLowerCase();

interface TokenState {
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
  nonces: Map<string, bigint>;
  paused: boolean;
  blocked: Set<string>;
  /** A DOMAIN_SEPARATOR that differs from the permit domain (forces the approve path). */
  domainOverride: Hex | null;
}

/** SuperGoodDollar subset: ERC-20, EIP-2612 permit, `paused`, `isBlocked`. */
export class FakeGDollar implements FakeContract {
  readonly abi: Abi = gDollarAbi;
  state: TokenState = {
    balances: new Map(),
    allowances: new Map(),
    nonces: new Map(),
    paused: false,
    blocked: new Set(),
    domainOverride: null,
  };

  constructor(
    readonly address: Address,
    private readonly chainId: number,
  ) {}

  balanceOf(account: string): bigint {
    return this.state.balances.get(key(account)) ?? 0n;
  }

  mint(account: string, amount: bigint): void {
    this.state.balances.set(key(account), this.balanceOf(account) + amount);
  }

  /** Moves G$ (used by the core fake for pulls and pushes); emits the token's Transfer. */
  move(ctx: WriteContext, from: string, to: string, amount: bigint): void {
    if (this.state.paused) throw new FakeRevert('0x7f66be17');
    if (this.balanceOf(from) < amount) throw new FakeRevert('0x2f4cb941');
    this.state.balances.set(key(from), this.balanceOf(from) - amount);
    this.state.balances.set(key(to), this.balanceOf(to) + amount);
    ctx.emitAs(this.address, this.abi, 'Transfer', { from, to, value: amount });
  }

  spend(owner: string, spender: string, amount: bigint): void {
    const allowance = this.state.allowances.get(`${key(owner)}:${key(spender)}`) ?? 0n;
    if (allowance < amount) throw new FakeRevert('0x08c379a0');
    this.state.allowances.set(`${key(owner)}:${key(spender)}`, allowance - amount);
  }

  domain() {
    return { ...G_DOLLAR_PERMIT_DOMAIN, chainId: this.chainId, verifyingContract: this.address };
  }

  read(functionName: string, args: readonly unknown[]): unknown {
    switch (functionName) {
      case 'balanceOf':
        return this.balanceOf(args[0] as string);
      case 'allowance':
        return (
          this.state.allowances.get(`${key(args[0] as string)}:${key(args[1] as string)}`) ?? 0n
        );
      case 'nonces':
        return this.state.nonces.get(key(args[0] as string)) ?? 0n;
      case 'DOMAIN_SEPARATOR':
        return this.state.domainOverride ?? domainSeparator({ domain: this.domain() });
      case 'paused':
        return this.state.paused;
      case 'isBlocked':
        return this.state.blocked.has(key(args[0] as string));
      default:
        throw new Error(`G$ fake: ${functionName}`);
    }
  }

  async permit(
    owner: Address,
    spender: Address,
    value: bigint,
    deadline: bigint,
    v: number,
    r: Hex,
    s: Hex,
    now: number,
  ): Promise<void> {
    if (deadline < BigInt(now)) throw new FakeRevert('0x62791302');
    const nonce = this.state.nonces.get(key(owner)) ?? 0n;
    const signer = await recoverTypedDataAddress({
      domain: this.domain(),
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: { owner, spender, value, nonce, deadline },
      signature: { r, s, v: BigInt(v) },
    });
    if (key(signer) !== key(owner)) throw new FakeRevert('0x4b800e46');
    this.state.nonces.set(key(owner), nonce + 1n);
    this.state.allowances.set(`${key(owner)}:${key(spender)}`, value);
  }

  async write(functionName: string, args: readonly unknown[], ctx: WriteContext): Promise<void> {
    if (functionName === 'approve') {
      this.state.allowances.set(`${key(ctx.from)}:${key(args[0] as string)}`, args[1] as bigint);
      ctx.emit('Approval', { owner: ctx.from, spender: args[0], value: args[1] });
      return;
    }
    if (functionName === 'transfer')
      return this.move(ctx, ctx.from, args[0] as string, args[1] as bigint);
    throw new Error(`G$ fake write: ${functionName}`);
  }
}

/** IdentityV4: `getWhitelistedRoot` from a map (zero for unverified accounts). */
export class FakeIdentity implements FakeContract {
  readonly abi: Abi = identityAbi;
  state: { roots: Map<string, Address>; reverting: Set<string>; broken: boolean } = {
    roots: new Map(),
    reverting: new Set(),
    broken: false,
  };

  verify(account: Address, root: Address = account): void {
    this.state.roots.set(key(account), root);
  }

  read(functionName: string, args: readonly unknown[]): unknown {
    if (this.state.broken) throw new Error('identity node unavailable');
    if (this.state.reverting.has(key(args[0] as string))) throw new FakeRevert('0x');
    if (functionName === 'getWhitelistedRoot')
      return this.state.roots.get(key(args[0] as string)) ?? zeroAddress;
    throw new Error(`Identity fake: ${functionName}`);
  }

  write(): void {
    throw new Error('Identity fake has no writes');
  }
}

/** UBIScheme: `lastClaimed(root)`. */
export class FakeUbiScheme implements FakeContract {
  readonly abi: Abi = ubiSchemeAbi;
  state: { lastClaimed: Map<string, bigint> } = { lastClaimed: new Map() };

  claimedAt(root: Address, timestamp: number): void {
    this.state.lastClaimed.set(key(root), BigInt(timestamp));
  }

  read(functionName: string, args: readonly unknown[]): unknown {
    if (functionName === 'lastClaimed')
      return this.state.lastClaimed.get(key(args[0] as string)) ?? 0n;
    throw new Error(`UBIScheme fake: ${functionName}`);
  }

  write(): void {
    throw new Error('UBIScheme fake has no writes');
  }
}

/** GoodDollar Faucet: `canTop` (default true) and `topWallet`. */
export class FakeFaucet implements FakeContract {
  readonly abi: Abi = faucetAbi;
  state: { refuse: Set<string>; revertTop: boolean; topped: string[] } = {
    refuse: new Set(),
    revertTop: false,
    topped: [],
  };

  read(functionName: string, args: readonly unknown[]): unknown {
    if (functionName === 'canTop') return !this.state.refuse.has(key(args[0] as string));
    throw new Error(`Faucet fake: ${functionName}`);
  }

  write(functionName: string, args: readonly unknown[], ctx: WriteContext): void {
    if (functionName !== 'topWallet') throw new Error(`Faucet fake write: ${functionName}`);
    if (this.state.revertTop) throw new FakeRevert('0x08c379a0');
    this.state.topped.push(key(args[0] as string));
    ctx.emit('WalletTopped', {
      account: args[0],
      amount: 100n,
      whitelistedRoot: args[0],
      relayerOrWhitelisted: ctx.from,
    });
  }
}

/** Mento exchange provider: a settable `currentPrice`. */
export class FakeMento implements FakeContract {
  readonly abi: Abi = mentoExchangeProviderAbi;
  state: { price: bigint } = { price: 127_480_819_091_162n };

  read(functionName: string): unknown {
    if (functionName === 'currentPrice') return this.state.price;
    throw new Error(`Mento fake: ${functionName}`);
  }

  write(): void {
    throw new Error('Mento fake has no writes');
  }
}

/** AgentRegistry subset the sentinel touches: pause and the breaker views. */
export class FakeRegistry implements FakeContract {
  readonly abi: Abi = agentRegistryAbi;
  state: { paused: boolean; used: bigint; max: bigint; guardians: Set<string> } = {
    paused: false,
    used: 0n,
    max: 10_000n * 10n ** 18n,
    guardians: new Set(),
  };

  read(functionName: string, args: readonly unknown[]): unknown {
    switch (functionName) {
      case 'paused':
        return this.state.paused;
      case 'rollingOutflow':
        return this.state.used;
      case 'maxRollingOutflow':
        return this.state.max;
      case 'hasRole':
        return args[0] === GUARDIAN_ROLE && this.state.guardians.has(key(args[1] as string));
      default:
        throw new Error(`Registry fake: ${functionName}`);
    }
  }

  write(functionName: string, _args: readonly unknown[], ctx: WriteContext): void {
    if (functionName !== 'pause') throw new Error(`Registry fake write: ${functionName}`);
    if (!this.state.guardians.has(key(ctx.from)))
      revert(this.abi, 'AccessControlUnauthorizedAccount', [ctx.from, GUARDIAN_ROLE]);
    if (this.state.paused) revert(this.abi, 'EnforcedPause');
    this.state.paused = true;
    ctx.emit('Paused', { account: ctx.from });
  }
}
