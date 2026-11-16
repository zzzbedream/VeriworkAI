import { decodeErrorResult, isHex, parseAbi, type Abi, type Hex } from 'viem';
import { gDollarAbi } from './abis/gDollar';
import { agentRegistryAbi, veriWorkCoreAbi } from './abis/generated';
import { SPONSOR_ROLE } from './roles';

type AbiError = Extract<Abi[number], { readonly type: 'error' }>;

/** Errors raised by libraries the contracts use, kept even if an ABI snapshot omits them. */
const LIBRARY_ERRORS_ABI = parseAbi([
  'error PermitFailed(uint256 allowance, uint256 required)',
  // TokenTransfers: every G$ movement is at par; a transfer fee of either kind reverts it.
  'error SenderFeeNotSupported(uint256 spent, uint256 amount)',
  'error ReceiverFeeNotSupported(uint256 received, uint256 amount)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC2612ExpiredSignature(uint256 deadline)',
  'error ERC2612InvalidSigner(address signer, address owner)',
]);

/** Stable keys that differ from the SCREAMING_SNAKE form of the Solidity error name. */
const KEY_OVERRIDES: Readonly<Record<string, string>> = {
  SUPER_GOODDOLLAR_PAUSED: 'G_DOLLAR_PAUSED',
  SUPER_GOODDOLLAR_BLOCKED: 'G_DOLLAR_BLOCKED',
  SUPER_GOODDOLLAR_FEE_EXCEEDS_BALANCE: 'G_DOLLAR_FEE_EXCEEDS_BALANCE',
  SF_TOKEN_MOVE_INSUFFICIENT_BALANCE: 'G_DOLLAR_INSUFFICIENT_BALANCE',
  SF_TOKEN_BURN_INSUFFICIENT_BALANCE: 'G_DOLLAR_INSUFFICIENT_BALANCE',
  Error: 'REVERTED_WITH_REASON',
  Panic: 'PANIC',
};

export const G_DOLLAR_PAUSED_SELECTOR = '0x7f66be17';
export const G_DOLLAR_BLOCKED_SELECTOR = '0xe7d0c09e';

function isErrorItem(item: Abi[number]): item is AbiError {
  return item.type === 'error';
}

function signatureOf(item: AbiError): string {
  return `${item.name}(${item.inputs.map((input) => input.type).join(',')})`;
}

function uniqueErrors(abis: readonly Abi[]): readonly AbiError[] {
  const errors = abis.flatMap((abi) => abi.filter(isErrorItem));
  return errors.filter(
    (error, index) =>
      errors.findIndex((other) => signatureOf(other) === signatureOf(error)) === index,
  );
}

/** Every custom error we can decode: G$, VeriWorkCore, AgentRegistry (incl. inherited OZ errors). */
export const KNOWN_ERRORS_ABI: readonly AbiError[] = uniqueErrors([
  gDollarAbi,
  veriWorkCoreAbi,
  agentRegistryAbi,
  LIBRARY_ERRORS_ABI,
]);

/** `NotVerifiedHuman` -> `NOT_VERIFIED_HUMAN`, `SUPER_GOODDOLLAR_PAUSED` -> `G_DOLLAR_PAUSED`. */
export function errorKey(errorName: string): string {
  const override = KEY_OVERRIDES[errorName];
  if (override !== undefined) return override;
  if (/^[A-Z0-9_]+$/.test(errorName)) return errorName;
  return errorName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/** `fundCampaign` without SPONSOR_ROLE: "sponsor not approved yet" for the B2B portal. */
export const SPONSOR_NOT_APPROVED = 'SPONSOR_NOT_APPROVED';

/** Stable key of every known custom error, plus `REVERTED_WITH_REASON`, `PANIC` and role-specific keys. */
export const KNOWN_ERROR_KEYS: readonly string[] = Array.from(
  new Set([
    ...KNOWN_ERRORS_ABI.map((error) => errorKey(error.name)),
    'REVERTED_WITH_REASON',
    'PANIC',
    SPONSOR_NOT_APPROVED,
  ]),
);

/** Like `errorKey`, but a missing SPONSOR_ROLE gets its own key. */
function decodedKey(errorName: string, args: readonly unknown[]): string {
  const neededRole = args[1];
  if (
    errorName === 'AccessControlUnauthorizedAccount' &&
    typeof neededRole === 'string' &&
    neededRole.toLowerCase() === SPONSOR_ROLE
  ) {
    return SPONSOR_NOT_APPROVED;
  }
  return errorKey(errorName);
}

export interface DecodedKnownError {
  /** Stable key for i18n and API error mapping. */
  readonly key: string;
  readonly name: string;
  readonly selector: Hex;
  readonly args: readonly unknown[];
  /**
   * The same arguments by their Solidity parameter name (e.g. `EpochNotSettleable` gives `epochId`,
   * `settleableFrom`, `settleableUntil`), so callers never depend on argument positions.
   */
  readonly namedArgs: Readonly<Record<string, unknown>>;
}

function namedArgsOf(item: AbiError, args: readonly unknown[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    item.inputs.flatMap((input, index) =>
      input.name === undefined || input.name === '' ? [] : [[input.name, args[index]]],
    ),
  );
}

const MAX_WALK_DEPTH = 8;

function revertDataOf(value: unknown, depth: number): Hex | null {
  if (typeof value === 'string')
    return isHex(value, { strict: true }) && value.length >= 10 ? value : null;
  if (value === null || typeof value !== 'object' || depth > MAX_WALK_DEPTH) return null;
  const record = value as Readonly<Record<string, unknown>>;
  for (const field of ['raw', 'data', 'cause', 'error']) {
    const found = revertDataOf(record[field], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Finds revert data in a hex string or a (viem / RPC) error object, following `raw`, `data`,
 * `cause` and `error` members.
 */
export function extractRevertData(value: unknown): Hex | null {
  return revertDataOf(value, 0);
}

/** Decodes revert data (or an error carrying it) into a stable key; `null` when unknown. */
export function decodeKnownError(value: unknown): DecodedKnownError | null {
  const raw = extractRevertData(value);
  if (raw === null) return null;
  const data = raw.toLowerCase() as Hex;
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERRORS_ABI, data });
    const selector = data.slice(0, 10) as Hex;
    const args: readonly unknown[] = decoded.args ?? [];
    return {
      key: decodedKey(decoded.errorName, args),
      name: decoded.errorName,
      selector,
      args,
      namedArgs: namedArgsOf(decoded.abiItem, args),
    };
  } catch {
    // Unknown selector or malformed arguments: the caller shows a generic message.
    return null;
  }
}
