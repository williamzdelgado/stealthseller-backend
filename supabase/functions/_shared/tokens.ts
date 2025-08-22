interface TokenState {
  id: string;
  current_tokens: number;
  max_tokens: number;
  tokens_per_minute: number;
  last_refill: string;
  is_circuit_breaker_open: boolean;
  circuit_breaker_reason: string | null;
  last_updated: string;
}

export class TokenManager {
  private static instances = new Map<string, TokenManager>(); // Support multiple Supabase clients
  private supabase: any;
  private clientKey: string;

  private constructor(supabase: any, clientKey: string) {
    this.supabase = supabase;
    this.clientKey = clientKey;
  }

  static getInstance(supabase: any): TokenManager {
    // Create unique key for each Supabase client to avoid cross-run contamination
    const clientKey = `${supabase.supabaseUrl}_${supabase.supabaseKey}`;
    
    if (!this.instances.has(clientKey)) {
      this.instances.set(clientKey, new TokenManager(supabase, clientKey));
    }
    return this.instances.get(clientKey)!;
  }

  // Add method to clean up instances if needed (for warm start safety)
  static clearInstances(): void {
    this.instances.clear();
  }

  async getCurrentTokenState(): Promise<TokenState> {
    const { data: tokenState, error } = await this.supabase
      .from('keepa_token_state')
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to fetch token state: ${error.message}`);
    }

    return tokenState;
  }

  async consumeTokens(amount: number, batchId: string): Promise<boolean> {
    const { data: tokenState, error } = await this.supabase
      .from('keepa_token_state')
      .select('current_tokens, is_circuit_breaker_open')
      .single();

    if (error) {
      throw new Error(`Failed to fetch token state: ${error.message}`);
    }

    if (tokenState.is_circuit_breaker_open) {
      return false;
    }

    if (tokenState.current_tokens < amount) {
      return false;
    }

    // Atomic token consumption
    const { error: updateError } = await this.supabase
      .from('keepa_token_state')
      .update({
        current_tokens: tokenState.current_tokens - amount,
        last_updated: new Date().toISOString()
      })
      .eq('current_tokens', tokenState.current_tokens) // Optimistic locking
      .single();

    return !updateError;
  }

  async refillTokens(): Promise<void> {
    const tokenState = await this.getCurrentTokenState();
    
    const now = new Date();
    const lastRefill = new Date(tokenState.last_refill);
    const elapsedMinutes = (now.getTime() - lastRefill.getTime()) / (1000 * 60);
    const tokensToAdd = Math.floor(elapsedMinutes * tokenState.tokens_per_minute);
    
    if (tokensToAdd > 0) {
      const newTokens = Math.min(tokenState.max_tokens, tokenState.current_tokens + tokensToAdd);
      
      const { error } = await this.supabase
        .from('keepa_token_state')
        .update({
          current_tokens: newTokens,
          last_refill: now.toISOString(),
          last_updated: now.toISOString()
        })
        .eq('id', tokenState.id);

      if (error) {
        throw new Error(`Failed to refill tokens: ${error.message}`);
      }
    }
  }

  async isCircuitBreakerOpen(): Promise<boolean> {
    const tokenState = await this.getCurrentTokenState();
    return tokenState.is_circuit_breaker_open;
  }

  async openCircuitBreaker(reason: string): Promise<void> {
    const { error } = await this.supabase
      .from('keepa_token_state')
      .update({
        is_circuit_breaker_open: true,
        circuit_breaker_reason: reason,
        last_updated: new Date().toISOString()
      })
      .single();

    if (error) {
      throw new Error(`Failed to open circuit breaker: ${error.message}`);
    }
  }

  async closeCircuitBreaker(): Promise<void> {
    const { error } = await this.supabase
      .from('keepa_token_state')
      .update({
        is_circuit_breaker_open: false,
        circuit_breaker_reason: null,
        last_updated: new Date().toISOString()
      })
      .single();

    if (error) {
      throw new Error(`Failed to close circuit breaker: ${error.message}`);
    }
  }

  async trackFailure(batchId: string, reason: string, tokensCost: number): Promise<void> {
    const { error } = await this.supabase
      .from('product_batches')
      .update({
        failure_reason: reason,
        tokens_wasted: tokensCost,
        failure_timestamp: new Date().toISOString()
      })
      .eq('id', batchId);

    if (error) {
      throw new Error(`Failed to track failure: ${error.message}`);
    }
  }
} 