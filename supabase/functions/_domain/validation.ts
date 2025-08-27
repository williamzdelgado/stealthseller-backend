import { SELLER_ID_PATTERN, ASIN_PATTERN, DOMAINS, LIMITS } from './constants.ts';

export function validateSellerId(sellerId: string): { valid: boolean; error?: string } {
  if (!sellerId) {
    return { valid: false, error: 'Seller ID is required' };
  }
  
  if (typeof sellerId !== 'string') {
    return { valid: false, error: 'Seller ID must be a string' };
  }
  
  const trimmed = sellerId.trim();
  
  if (trimmed.length < 13 || trimmed.length > 15) {
    return { valid: false, error: 'Seller ID must be 13-15 characters' };
  }
  
  if (!SELLER_ID_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Seller ID must be alphanumeric (A-Z, 0-9)' };
  }
  
  return { valid: true };
}

export function validateDomain(domain: number | undefined): { valid: boolean; domain: number; error?: string } {
  if (domain === undefined || domain === null) {
    return { valid: true, domain: LIMITS.DEFAULT_DOMAIN };
  }
  
  if (typeof domain !== 'number') {
    return { valid: false, domain: LIMITS.DEFAULT_DOMAIN, error: 'Domain must be a number' };
  }
  
  if (!DOMAINS.includes(domain)) {
    return { 
      valid: false, 
      domain: LIMITS.DEFAULT_DOMAIN, 
      error: `Invalid domain. Valid domains are: ${DOMAINS.join(', ')}` 
    };
  }
  
  return { valid: true, domain };
}

export function validateAsinFormat(asin: string): boolean {
  if (!asin || typeof asin !== 'string') {
    return false;
  }
  
  return ASIN_PATTERN.test(asin.trim());
}

export function validateAsinList(asins: string[]): { valid: boolean; invalidAsins: string[]; error?: string } {
  if (!Array.isArray(asins)) {
    return { valid: false, invalidAsins: [], error: 'ASINs must be an array' };
  }
  
  if (asins.length === 0) {
    return { valid: false, invalidAsins: [], error: 'ASIN list is empty' };
  }
  
  const invalidAsins = asins.filter(asin => !validateAsinFormat(asin));
  
  if (invalidAsins.length > 0) {
    return { 
      valid: false, 
      invalidAsins,
      error: `Invalid ASIN format for ${invalidAsins.length} items` 
    };
  }
  
  return { valid: true, invalidAsins: [] };
}

export function isValidProductCount(count: number): boolean {
  return count > 0 && count <= LIMITS.MAX_NEW_PRODUCTS;
}

export function validateBatchSize(size: number): boolean {
  return size > 0 && size <= LIMITS.MAX_BATCH_SIZE;
}

export function validateTokenCount(tokens: number): boolean {
  return tokens >= 0 && tokens <= LIMITS.KEEPA.BUCKET_SIZE;
}

export function validateUserId(userId: string | undefined): { valid: boolean; error?: string } {
  if (!userId) {
    return { valid: false, error: 'User ID is required' };
  }
  
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidPattern.test(userId)) {
    return { valid: false, error: 'Invalid user ID format' };
  }
  
  return { valid: true };
}

export function validatePriority(priority: string): boolean {
  return priority === 'HIGH' || priority === 'LOW';
}

export function validateJobType(jobType: string): boolean {
  return jobType === 'TIME_MACHINE' || jobType === 'MONITORING';
}

export function validateBatchType(batchType: string): boolean {
  return ['NEW_ASINS', 'FULL_REFRESH', 'INCREMENTAL'].includes(batchType);
}