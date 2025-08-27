import { KEEPA, LIMITS } from './constants.ts';

export function calculateTokensNeeded(productCount: number): number {
  return productCount * KEEPA.TOKENS_PER_PRODUCT;
}

export function calculateSellerTokens(): number {
  return KEEPA.TOKENS_PER_SELLER;
}

export function hasEnoughTokens(needed: number, available: number): boolean {
  return available >= needed;
}

export function estimateProcessingTime(tokensNeeded: number, currentTokens: number): number {
  if (currentTokens >= tokensNeeded) {
    return 0;
  }
  
  const tokensDeficit = tokensNeeded - currentTokens;
  const minutesNeeded = Math.ceil(tokensDeficit / KEEPA.REGEN_RATE);
  
  return minutesNeeded;
}

export function getTokenFillPercentage(available: number): number {
  return (available / KEEPA.BUCKET_SIZE) * 100;
}

export function shouldStopProcessing(available: number): boolean {
  return available < LIMITS.MIN_TOKENS;
}

export function estimateBatchTokenUsage(batchSize: number): number {
  return calculateTokensNeeded(batchSize);
}

export function canProcessBatch(batchSize: number, availableTokens: number): boolean {
  const needed = estimateBatchTokenUsage(batchSize);
  return hasEnoughTokens(needed, availableTokens);
}

export function getOptimalBatchSize(availableTokens: number, maxBatchSize: number = LIMITS.BATCH_SIZE): number {
  const maxProductsWithTokens = Math.floor(availableTokens / KEEPA.TOKENS_PER_PRODUCT);
  return Math.min(maxProductsWithTokens, maxBatchSize);
}

export function calculateTokenRegenTime(targetTokens: number, currentTokens: number): Date {
  if (currentTokens >= targetTokens) {
    return new Date();
  }
  
  const tokensNeeded = targetTokens - currentTokens;
  const minutesNeeded = Math.ceil(tokensNeeded / KEEPA.REGEN_RATE);
  
  const regenTime = new Date();
  regenTime.setMinutes(regenTime.getMinutes() + minutesNeeded);
  
  return regenTime;
}

export function getTokenUsageStats(usedTokens: number, duration: number): {
  tokensPerMinute: number;
  efficiency: number;
  sustainableRate: number;
} {
  const tokensPerMinute = duration > 0 ? usedTokens / (duration / 60000) : 0;
  const efficiency = tokensPerMinute / KEEPA.REGEN_RATE;
  const sustainableRate = Math.floor(KEEPA.REGEN_RATE / KEEPA.TOKENS_PER_PRODUCT);
  
  return {
    tokensPerMinute,
    efficiency,
    sustainableRate
  };
}