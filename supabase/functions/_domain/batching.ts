import { LIMITS } from './constants.ts';

export function calculateBatchCount(totalProducts: number, maxBatchSize: number = LIMITS.BATCH_SIZE): number {
  if (totalProducts <= 0 || maxBatchSize <= 0) {
    return 0;
  }
  
  return Math.ceil(totalProducts / maxBatchSize);
}

export function splitIntoBatches<T>(items: T[], maxSize: number = LIMITS.BATCH_SIZE): T[][] {
  if (!Array.isArray(items) || items.length === 0 || maxSize <= 0) {
    return [];
  }
  
  const batches: T[][] = [];
  
  for (let i = 0; i < items.length; i += maxSize) {
    batches.push(items.slice(i, i + maxSize));
  }
  
  return batches;
}

export function shouldProcessInBatches(count: number): boolean {
  return count > LIMITS.EDGE_THRESHOLD;
}

export function getBatchSizeForProducts(productCount: number): number {
  if (productCount <= LIMITS.EDGE_FUNCTION_LIMIT) {
    return productCount;
  }
  
  if (productCount <= LIMITS.BATCH_SIZE) {
    return productCount;
  }
  
  return LIMITS.BATCH_SIZE;
}

export function estimateBatchProcessingTime(
  batchCount: number, 
  avgTimePerBatch: number = 5000
): number {
  return batchCount * avgTimePerBatch;
}

export function createBatchRanges(
  totalItems: number, 
  batchSize: number
): Array<{ start: number; end: number; size: number }> {
  if (totalItems <= 0 || batchSize <= 0) {
    return [];
  }
  
  const ranges: Array<{ start: number; end: number; size: number }> = [];
  
  for (let start = 0; start < totalItems; start += batchSize) {
    const end = Math.min(start + batchSize, totalItems);
    ranges.push({
      start,
      end,
      size: end - start
    });
  }
  
  return ranges;
}

export function optimizeBatchSize(
  itemCount: number,
  constraints: {
    maxBatchSize?: number;
    minBatchSize?: number;
    targetBatches?: number;
  } = {}
): number {
  const {
    maxBatchSize = LIMITS.BATCH_SIZE,
    minBatchSize = 1,
    targetBatches = 10
  } = constraints;
  
  if (itemCount <= 0) {
    return 0;
  }
  
  if (itemCount <= maxBatchSize) {
    return itemCount;
  }
  
  const idealSize = Math.ceil(itemCount / targetBatches);
  
  if (idealSize < minBatchSize) {
    return minBatchSize;
  }
  
  if (idealSize > maxBatchSize) {
    return maxBatchSize;
  }
  
  return idealSize;
}

export function distributeBatchesEvenly(
  totalItems: number,
  workerCount: number
): Array<{ workerId: number; items: number; startIndex: number; endIndex: number }> {
  if (totalItems <= 0 || workerCount <= 0) {
    return [];
  }
  
  const itemsPerWorker = Math.ceil(totalItems / workerCount);
  const distribution: Array<{ workerId: number; items: number; startIndex: number; endIndex: number }> = [];
  
  for (let i = 0; i < workerCount; i++) {
    const startIndex = i * itemsPerWorker;
    
    if (startIndex >= totalItems) {
      break;
    }
    
    const endIndex = Math.min(startIndex + itemsPerWorker, totalItems);
    
    distribution.push({
      workerId: i,
      items: endIndex - startIndex,
      startIndex,
      endIndex
    });
  }
  
  return distribution;
}

export function isBatchComplete(processed: number, total: number): boolean {
  return processed >= total && total > 0;
}

export function getBatchProgress(processed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  
  return Math.min(100, Math.round((processed / total) * 100));
}