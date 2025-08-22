// Universal webhook notifier - works in Deno + Node.js  
declare const Deno: any;

export class WebhookNotifier {
  private static webhookUrl = typeof Deno !== 'undefined' 
    ? Deno.env.get('DISCORD_WEBHOOK_URL')
    : process.env.DISCORD_WEBHOOK_URL;

  private static async send(message: string): Promise<void> {
    if (!this.webhookUrl) return;
    
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: null,
          embeds: [{
            description: `\`\`\`\n${message}\n\`\`\``,
            color: 2105893,
            footer: { text: "backend" }
          }],
          avatar_url: "https://i.imgur.com/kS75lkx.png"
        })
      });
    } catch (error) {
      console.error('Webhook notification failed:', error);
    }
  }

  // 4 Essential Methods Only
  static async started(service: string, details: string) {
    await this.send(`🚀 ${service} started: ${details}`);
  }

  static async completed(service: string, results: string) {
    await this.send(`✅ ${service} completed: ${results}`);
  }

  static async error(service: string, error: string) {
    await this.send(`❌ ${service} error: ${error}`);
  }

  static async alert(message: string) {
    await this.send(`⚠️ ${message}`);
  }
} 