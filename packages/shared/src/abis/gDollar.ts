import { parseAbi } from 'viem';

/** Minimal SuperGoodDollar (G$) ABI: ERC-20, EIP-2612 permit, admin views and its custom errors. */
export const gDollarAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address recipient, uint256 amount) returns (bool)',
  'function transferFrom(address holder, address recipient, uint256 amount) returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function paused() view returns (bool)',
  'function isBlocked(address account) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'error SUPER_GOODDOLLAR_PAUSED()',
  'error SUPER_GOODDOLLAR_BLOCKED()',
  'error SUPER_GOODDOLLAR_FEE_EXCEEDS_BALANCE()',
  'error SF_TOKEN_MOVE_INSUFFICIENT_BALANCE()',
  'error SF_TOKEN_BURN_INSUFFICIENT_BALANCE()',
  'error SUPER_TOKEN_TRANSFER_FROM_ZERO_ADDRESS()',
  'error SUPER_TOKEN_TRANSFER_TO_ZERO_ADDRESS()',
  'error SUPER_TOKEN_TRANSFER_TO_TOKEN_ADDRESS()',
  'error SUPER_TOKEN_NOT_ERC777_TOKENS_RECIPIENT()',
]);

/** EIP-2612 `Permit` typed-data types (G$ domain: see `G_DOLLAR_PERMIT_DOMAIN`). */
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
