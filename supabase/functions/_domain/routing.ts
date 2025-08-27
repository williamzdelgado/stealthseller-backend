import { LIMITS } from './constants.ts';

export interface RoutingDecision {
  route: 'edge' | 'queue' | 'skip';
  reason: string;
  threshold: number;
}

export function shouldUseQueue(
  productCount: number,
  tokenPercent?: number,
  recentUsage?: number
): RoutingDecision {
  if (productCount <= 0) {
    return {
      route: 'skip',
      reason: 'No products to process',
      threshold: 0
    };
  }
  
  if (productCount > LIMITS.MAX_NEW_PRODUCTS) {
    return {
      route: 'skip',
      reason: `Exceeds maximum limit of ${LIMITS.MAX_NEW_PRODUCTS} products`,
      threshold: LIMITS.MAX_NEW_PRODUCTS
    };
  }
  
  let dynamicThreshold = LIMITS.EDGE_THRESHOLD;
  const reasons: string[] = [];
  
  if (tokenPercent !== undefined) {
    if (tokenPercent < 30) {
      dynamicThreshold = 20;
      reasons.push('Low token availability (<30%)');
    } else if (tokenPercent > 80) {
      dynamicThreshold = 75;
      reasons.push('High token availability (>80%)');
    }
  }
  
  if (recentUsage !== undefined && recentUsage > 2000) {
    dynamicThreshold = Math.min(dynamicThreshold, 20);
    reasons.push('Heavy recent usage (>2000 tokens/hour)');
  }
  
  if (productCount > dynamicThreshold) {
    return {
      route: 'queue',
      reason: reasons.length > 0 
        ? `Queue processing: ${reasons.join(', ')}` 
        : `Product count (${productCount}) exceeds threshold (${dynamicThreshold})`,
      threshold: dynamicThreshold
    };
  }
  
  return {
    route: 'edge',
    reason: `Edge processing: Product count (${productCount}) within threshold (${dynamicThreshold})`,
    threshold: dynamicThreshold
  };
}

export function getProcessingRoute(
  productCount: number,
  hasActiveBatch: boolean
): 'edge' | 'queue' | 'skip' {
  if (productCount <= 0) {
    return 'skip';
  }
  
  if (hasActiveBatch) {
    return 'queue';
  }
  
  const decision = shouldUseQueue(productCount);
  return decision.route;
}

export function calculateDynamicThreshold(
  tokenFillPercent: number,
  baseThreshold: number = LIMITS.EDGE_THRESHOLD
): number {
  if (tokenFillPercent < 20) {
    return Math.floor(baseThreshold * 0.2);
  }
  
  if (tokenFillPercent < 40) {
    return Math.floor(baseThreshold * 0.4);
  }
  
  if (tokenFillPercent < 60) {
    return Math.floor(baseThreshold * 0.6);
  }
  
  if (tokenFillPercent < 80) {
    return baseThreshold;
  }
  
  return Math.floor(baseThreshold * 1.5);
}

export function shouldThrottleUser(
  userTokenUsage: number,
  systemTokenPercent: number
): boolean {
  if (systemTokenPercent < 30 && userTokenUsage > 1000) {
    return true;
  }
  
  if (userTokenUsage > 5000) {
    return true;
  }
  
  return false;
}

export function getRoutingPriority(
  isNewUser: boolean,
  productCount: number,
  hasActiveBatch: boolean
): 'HIGH' | 'LOW' {
  if (isNewUser && productCount <= 50) {
    return 'HIGH';
  }
  
  if (hasActiveBatch) {
    return 'LOW';
  }
  
  if (productCount <= 20) {
    return 'HIGH';
  }
  
  return 'LOW';
}

export function estimateQueueDelay(
  queueLength: number,
  avgProcessingTime: number = 5000
): number {
  return queueLength * avgProcessingTime;
}

export function shouldDeferProcessing(
  tokenPercent: number,
  queueLength: number
): boolean {
  if (tokenPercent < 20 && queueLength > 10) {
    return true;
  }
  
  if (queueLength > 100) {
    return true;
  }
  
  return false;
}

export function getOptimalProcessingTime(): { hour: number; reason: string } {
  const now = new Date();
  const hour = now.getUTCHours();
  
  if (hour >= 2 && hour <= 6) {
    return {
      hour: hour,
      reason: 'Low usage period (2-6 AM UTC)'
    };
  }
  
  if (hour >= 14 && hour <= 18) {
    return {
      hour: 3,
      reason: 'Defer to low usage period'
    };
  }
  
  return {
    hour: hour,
    reason: 'Normal processing hours'
  };
}