export const LIMITS = {
  MAX_NEW_PRODUCTS: 3000,
  EDGE_THRESHOLD: 50,
  ROUTING_THRESHOLD: 50,
  BATCH_SIZE: 100,
  MIN_TOKENS: 7000,
  KEEPA_API_BATCH_SIZE: 10,
  EDGE_FUNCTION_LIMIT: 50,
  MAX_BATCH_SIZE: 100,
  DEFAULT_DOMAIN: 1,
} as const;

export const KEEPA = {
  TOKENS_PER_PRODUCT: 7,
  TOKENS_PER_SELLER: 10,
  BUCKET_SIZE: 15000,
  REGEN_RATE: 250,
  BASE_URL: 'https://api.keepa.com',
} as const;

export const DOMAINS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11] as const;

export const KEEPA_DOMAINS: Record<number, string> = {
  1: 'amazon.com',
  2: 'amazon.co.uk',
  3: 'amazon.de',
  4: 'amazon.fr',
  5: 'amazon.co.jp',
  6: 'amazon.ca',
  8: 'amazon.it',
  9: 'amazon.es',
  10: 'amazon.in',
  11: 'amazon.com.mx',
} as const;

export const BATCH_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
} as const;

export const BATCH_PRIORITY = {
  HIGH: 'HIGH',
  LOW: 'LOW',
} as const;

export const JOB_TYPE = {
  TIME_MACHINE: 'TIME_MACHINE',
  MONITORING: 'MONITORING',
} as const;

export const BATCH_TYPE = {
  NEW_ASINS: 'NEW_ASINS',
  FULL_REFRESH: 'FULL_REFRESH',
  INCREMENTAL: 'INCREMENTAL',
} as const;

export const ERROR_TYPES = {
  TRANSIENT: 'TRANSIENT',
  HARD: 'HARD',
} as const;

export const ROUTING_DECISIONS = {
  EDGE: 'edge',
  QUEUE: 'queue',
  SKIP: 'skip',
} as const;

export const SELLER_ID_PATTERN = /^[A-Z0-9]{13,15}$/;
export const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

export const CACHE_DURATION = {
  SELLER: 24 * 60 * 60 * 1000,
  PRODUCT: 7 * 24 * 60 * 60 * 1000,
} as const;