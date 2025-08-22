// Node.js adapter for all shared functions - PRISTINE VERSION  
// Used by Trigger.dev tasks to access shared Keepa and queue processing logic
export { fetchKeepaData, insertProducts, fetchSellerFromKeepa, findNewAsins, saveSellerData } from "./keepa";
export { enqueueProductBatches, claimProductBatches } from "./queue";
export { processProductBatch, type BatchProcessingResult } from "./batch-processor";
export { FailureMonitor } from "./failure-monitor";
export { TokenManager } from "./tokens";
export type { KeepaProduct, InsertResult, AsinComparison } from "./keepa";
export type { BatchRecord, BatchResult, TriggerResult, QueueResponse } from "./queue"; 