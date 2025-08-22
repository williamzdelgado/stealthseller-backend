# StealthSeller Backend

Backend services, edge functions, and background jobs for StealthSeller - the Amazon seller monitoring platform.

## Architecture Overview

This repository contains all backend components of StealthSeller:

- **Supabase Edge Functions** - API endpoints for real-time operations
- **Trigger.dev Jobs** - Background processing and scheduled tasks
- **Database Schema** - Migrations and triggers
- **Development Tools** - Cursor AI rules and configurations

## Directory Structure

```
├── .cursor/rules/           # Cursor AI development rules
├── supabase/
│   ├── functions/          # Edge functions (API endpoints)
│   ├── migrations/         # Database schema migrations
│   └── config.toml         # Supabase configuration
├── trigger/
│   ├── index.ts           # Trigger.dev main entry point
│   ├── keepa-discovery.ts # Keepa API discovery jobs
│   └── product-batches.ts # Product batch processing
├── docs/                   # Backend documentation
└── scripts/               # Utility scripts
```

## Edge Functions

Located in `supabase/functions/`:

- `seller-lookup/` - Validate and fetch seller information from Keepa API
- `product-processing/` - Process product data and handle limits
- `stripe-*` - Payment processing and webhooks
- `debug-db-enums/` - Database debugging utilities

## Trigger.dev Jobs

Located in `trigger/`:

- **Keepa Discovery** - Background seller and product discovery
- **Product Batches** - Batch processing of large product datasets
- **Scheduled Tasks** - Periodic maintenance and updates

## Development Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start Supabase locally:**
   ```bash
   supabase start
   ```

4. **Deploy edge functions:**
   ```bash
   supabase functions deploy --project-ref your-project-ref
   ```

5. **Run Trigger.dev development:**
   ```bash
   npx trigger.dev@latest dev
   ```

## Deployment

### Edge Functions
```bash
supabase functions deploy --project-ref nlydrzszwijdbuzgnxzp
```

### Trigger.dev Jobs
```bash
npx trigger.dev@latest deploy
```

## Engineering Philosophy

Following StealthSeller's core principles:

- **Simple, boring solutions** over complex architectures
- **Evidence-based decisions** - Real user impact, not theoretical problems
- **Surgical precision** - If not broken and not requested, leave it alone
- **Security first** - Security isn't a feature, it's a requirement

## Related Repositories

- [stealthseller-v2](https://github.com/williamzdelgado/stealthseller-v2) - Frontend React application

## Documentation

- [API Documentation](./docs/api/)
- [Deployment Guide](./docs/deployment/)
- [Development Workflow](./docs/development/)

---

*Backend for StealthSeller v2 - Amazon Seller Intelligence Platform*