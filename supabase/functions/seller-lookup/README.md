# Seller Lookup Edge Function

## Overview

The **seller-lookup** edge function validates Amazon seller IDs and fetches seller information from the Keepa API. It's the main way users discover and add sellers to monitor in the Stealth Seller platform.

## What It Does

- ✅ Validates Amazon seller ID format (13-15 alphanumeric characters)
- 🔍 Checks database cache first (24-hour freshness)  
- 🌐 Calls Keepa API to fetch fresh seller data when needed
- 🧠 **Smart ASIN Router**: Compares fresh ASINs vs existing processed products
- 🚀 **Auto-invokes product-processing** when new ASINs are found
- 💾 Stores seller information in database
- 📊 Extracts similar sellers and top brands for optimization
- ⚡ Returns seller details to frontend (processing happens automatically)

## API Endpoint

```
POST /functions/v1/seller-lookup
```

### Request

```json
{
  "sellerId": "A1EXAMPLE123",
  "domain": 1
}
```

**Parameters:**
- `sellerId` (string, required): Amazon seller ID (13-15 alphanumeric characters)
- `domain` (integer, optional): Keepa domain ID (defaults to user's marketplace preference)
  - `1` = amazon.com
  - `2` = amazon.co.uk  
  - `3` = amazon.de
  - `4` = amazon.fr
  - `5` = amazon.co.jp
  - `6` = amazon.ca
  - `8` = amazon.it
  - `9` = amazon.es
  - `10` = amazon.in
  - `11` = amazon.com.mx

### Response

#### Success (200)
```json
{
  "success": true,
  "data": {
    "sellerId": "A1EXAMPLE123",
    "sellerName": "Example Store",
    "domain": 1,
    "asinCount": 245,
    "recentlyAdded": [],
    "lastCheckedAt": "2025-01-14T10:30:00Z"
  }
}
```

#### Error (400/404/500)
```json
{
  "success": false,
  "error": "Invalid seller ID format (must be 13-15 alphanumeric characters)",
  "suggestion": "Seller found in amazon.co.uk"
}
```

## Smart ASIN Router Logic

The function implements intelligent ASIN detection and automatic product processing:

### New Seller Processing
- **With Snapshot**: Delta processing (only ASINs not in snapshot) - 90%+ token savings
- **Without Snapshot**: Process all ASINs from seller catalog

### Existing Seller Processing  
- **Compares**: Fresh ASIN list vs existing `seller_products` table
- **Processes**: Only truly new ASINs (not already processed)
- **Skips**: If no new ASINs found

### Auto-invoke Flow
```
seller-lookup → Smart ASIN Detection → Auto-invoke product-processing
```

**Example**: 
- Seller has 1000 ASINs total
- 950 already processed 
- 50 new ASINs found
- ✅ Auto-processes only the 50 new ASINs

## Environment Variables

```bash
KEEPA_API_KEY=your_keepa_api_key_here
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

## Keepa API Response Structure

The function processes this actual Keepa API response format:

```json
{
  "sellers": {
    "A33EGCJZUE9VE2": {
      "asinList": [],                    // Array of ASINs (length = product count)
      "businessName": "Texan Trades LLC",
      "competitors": [                   // Array of 10 similar sellers
        {"percent": 18, "sellerId": "ATVPDKIKX0DER"},
        {"percent": 11, "sellerId": "ASENPHF4EV3DQ"}
      ],
      "sellerBrandStatistics": [         // Array of top brands with metrics
        {
          "avg30SalesRank": 33971,
          "brand": "pampers",
          "productCount": 113,
          "productCountWithAmazonOffer": 16
        }
      ],
      "sellerName": "Lone$tar Deal",
      "trackedSince": 6042004,
      "totalStorefrontAsinsCSV": [],
      "domainId": 1,
      "hasFBA": true
    }
  },
  "tokensConsumed": 10,
  "tokensLeft": 29970
}
```

## Database Schema

### Tables Used

- **sellers**: Stores seller information and similar sellers data
- **seller_queries**: Logs all lookup attempts for analytics
- **seller_snapshot_queue**: Queues similar sellers for background processing
- **user_settings**: Gets user's marketplace domain preference

### Key Fields

```sql
-- sellers table
similar_sellers jsonb  -- Competitors data with percent/sellerId
top_brands jsonb      -- Top brands with sales metrics
last_checked_at timestamp -- Cache freshness control
domain integer -- Marketplace domain
asin_count integer -- Calculated from asinList.length
```

## Token Economics

The function implements the Smart ASIN Router to optimize Keepa API costs:

- **Query seller's ASIN list**: 10 tokens (this function)
- **Query each individual ASIN**: 7 tokens per ASIN (product-processing function)
- **Smart routing**: Only processes truly new ASINs

**Example Token Savings:**
- Seller with 1000 ASINs total, 50 new ASINs
- **Without Smart Router**: 1000 × 7 = 7,000 tokens
- **With Smart Router**: 50 × 7 = 350 tokens
- **Savings**: 95% token reduction

## Similar Sellers Extraction

When a seller is looked up, the function:

1. Extracts similar sellers from `sellers.{sellerId}.competitors` (array of 10 items)
2. Extracts top brands from `sellers.{sellerId}.sellerBrandStatistics` (brand performance metrics)
3. Stores competitors in the `similar_sellers` JSON field
4. Stores brand data in the `top_brands` JSON field
5. Gets ASIN count from `sellers.{sellerId}.asinList.length`
6. Queues unknown similar sellers for background ASIN list snapshots

**Note**: This is separate from the delta processing system in product-processing function.

## Usage Examples

### Frontend Integration

```typescript
// React component
const lookupSeller = async (sellerId: string) => {
  const response = await fetch('/functions/v1/seller-lookup', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sellerId })
  });
  
  const result = await response.json();
  
  if (result.success) {
    // Show seller details to user
    console.log(`Found seller: ${result.data.sellerName}`);
    console.log(`Products: ${result.data.asinCount}`);
    
    // Access stored similar sellers and top brands from database
    // similar_sellers: [{percent: 18, sellerId: "ATVPDKIKX0DER"}, ...]
    // top_brands: [{avg30SalesRank: 33971, brand: "pampers", productCount: 113, productCountWithAmazonOffer: 16}, ...]
  } else {
    // Handle error
    console.error(result.error);
  }
};
```

### Error Handling

```typescript
// Handle common error scenarios
if (!result.success) {
  switch (response.status) {
    case 400:
      // Invalid seller ID format
      showError('Please enter a valid Amazon seller ID');
      break;
    case 404:
      // Seller not found
      if (result.suggestion) {
        showError(`Seller not found in your marketplace. ${result.suggestion}`);
      } else {
        showError('Seller not found in any marketplace');
      }
      break;
    case 500:
      // Server error
      showError('Unable to lookup seller. Please try again later.');
      break;
  }
}
```

## Deployment

### Deploy to Staging
```bash
npx supabase functions deploy seller-lookup --project-ref nlydrzszwijdbuzgnxzp
```

### Deploy to Production  
```bash
npx supabase functions deploy seller-lookup --project-ref emjuagvnppbtqonuskeq
```

## Performance Features

- **Database caching**: 24-hour cache prevents unnecessary API calls
- **Module-level clients**: Reused Supabase client for better performance
- **JWT decode optimization**: 100x faster than auth.getUser()
- **Batch operations**: Efficient database queries with minimal round trips

## Related Functions

- **product-processing**: Auto-invoked by this function to process new ASINs
- **seller-details**: Fetches detailed seller information for existing sellers  
- **Background jobs**: Process queued similar sellers for optimization

## Monitoring & Logs

The function logs all operations with request IDs for traceability:

```
[abc123] 🚀 Seller Details request started
[abc123] 💾 Checking database cache for seller: A1EXAMPLE123 domain: 1
[abc123] ✅ Cache HIT - returning cached data
[abc123] ⚡ Request completed from cache in 250ms
```

## Security

- **Authentication required**: All requests must include valid JWT token
- **Rate limiting**: Built-in through Supabase edge functions
- **Input validation**: Strict seller ID format validation
- **SQL injection protection**: Parameterized queries via Supabase client

## Testing

```bash
# Test with curl
curl -X POST \
  'https://nlydrzszwijdbuzgnxzp.supabase.co/functions/v1/seller-lookup' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"sellerId": "A1EXAMPLE123", "domain": 1}'
``` 