// COPIED EXACTLY FROM _shared/failure-monitor.ts
// Universal failure monitoring - tracks API failures and sends alerts
const failureCounts = new Map<string, number>();

export class FailureMonitor {
  static async recordFailure(apiName: string): Promise<void> {
    const count = (failureCounts.get(apiName) || 0) + 1;
    failureCounts.set(apiName, count);
    
    // Alert on 3rd consecutive failure
    if (count >= 3) {
      const { WebhookNotifier } = await import('./discord.ts');
      WebhookNotifier.alert(`${apiName} API failed: ${count} consecutive failures`);
    }
  }
  
  static recordSuccess(apiName: string): void {
    failureCounts.delete(apiName); // Reset counter on success
  }
}