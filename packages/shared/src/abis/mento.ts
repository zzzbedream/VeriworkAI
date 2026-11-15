import { parseAbi } from 'viem';

/** Mento GoodDollarExchangeProvider: `currentPrice(G_DOLLAR_EXCHANGE_ID)` = USDm per G$ scaled by 1e18. */
export const mentoExchangeProviderAbi = parseAbi([
  'function currentPrice(bytes32 exchangeId) view returns (uint256)',
]);

/** Mento Broker quote (the swap itself goes through @goodsdks/good-reserve). */
export const mentoBrokerAbi = parseAbi([
  'function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut)',
]);
