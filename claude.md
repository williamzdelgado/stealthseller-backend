---
description: Use when writing console.log statements in edge functions
globs:
  - "**/*.ts"
  - "**/*.js"
alwaysApply: false
---

# Console Logging Standards

## [CRITICAL] Log Format Structure
- Use request ID prefix for all logs: `[${requestId}]`
- Follow pattern: `[requestId] <emoji> <action> <optional_detail>`
- Never exceed 7 words unless error message

**TEST:** Every log must start with [requestId] and contain emoji indicator

**CORRECT:** `console.log(\`[${requestId}] 💾 Checking seller history...\`)`

**INCORRECT:** `console.log("Checking database for seller data")`

## [CRITICAL] Duplicate Prevention
- Never duplicate console.log statements in same function
- Check for duplicate logging before adding new logs
- Use single log point per operation

**TEST:** Grep for duplicate console.log lines should return zero

**CORRECT:** Single `console.log(\`[${requestId}] ⏱️ Seller lookup: ${ms}ms\`)`

**INCORRECT:** Multiple identical logs in different code paths

## [IMPORTANT] Timing Logs
- Always specify WHAT is being timed
- Use format: `⏱️ <specific_action>: <ms>ms`
- Never use generic "DB query" or "API call"

**TEST:** Timing logs must identify specific operation

**CORRECT:** `console.log(\`[${requestId}] ⏱️ Seller lookup: ${ms}ms\`)`

**INCORRECT:** `console.log(\`[${requestId}] ⏱️ DB query took ${ms}ms\`)`

## [IMPORTANT] Length Requirements
- Keep logs 3-5 words for status updates
- Add numeric details where helpful (counts, IDs)
- Expand only for errors or critical branches

**TEST:** Standard logs should be scannable at a glance

**CORRECT:** `console.log(\`[${requestId}] 🆕 Found ${count} new ASINs\`)`

**INCORRECT:** `console.log(\`[${requestId}] 🆕 New ASINs have been detected in the seller's catalog after comparison\`)`

## [IMPORTANT] Emoji Indicators
- 💾 Database operations
- ⏱️ Performance timing
- 🎯 External API calls
- ✅ Success states
- ❌ Errors/failures
- 🔄 Refresh/update operations
- 🆕 New entity detection
- 🔍 Search/comparison operations
- 📊 Statistics/counts
- 🚀 Process initiation

**TEST:** Each log type uses consistent emoji

**CORRECT:** `console.log(\`[${requestId}] 💾 Saving seller data...\`)`

**INCORRECT:** `console.log(\`[${requestId}] 🎉 Saving seller data...\`)`

## [IMPORTANT] Comparison Logs
- Show both sides of comparisons with numbers
- Use format: `X known vs Y current`
- Include counts for clarity

**TEST:** Comparison logs must show both values

**CORRECT:** `console.log(\`[${requestId}] 🔍 Comparing ASINs: ${knownAsins.length} known vs ${currentAsinList.length} current\`)`

**INCORRECT:** `console.log(\`[${requestId}] 🔍 Comparing ${currentAsinList.length} ASINs...\`)`

## [PREFERRED] Error Logging
- Always use console.error for errors
- Include full error object after message
- Keep error description concise

**TEST:** Errors use console.error not console.log

**CORRECT:** `console.error(\`[${requestId}] ❌ Database error:\`, fetchError)`

**INCORRECT:** `console.log(\`[${requestId}] Error occurred in database\`)`

## [PREFERRED] Progressive Detail
- Start requests with simple entry log
- Add detail as branches diverge
- End with completion time

**TEST:** Log flow tells complete story

**CORRECT:**
```
[k1hn1] 🚀 Request started
[k1hn1] 💾 Checking seller history...
[k1hn1] ✅ Checked 2h ago
[k1hn1] ⚡ Completed: 45ms
```

**INCORRECT:** Random detailed logs without context

## Examples of Complete Log Flow

### CORRECT - New Seller Flow:
```javascript
console.log(`[${requestId}] 🚀 Request started`)
console.log(`[${requestId}] 💾 Checking seller history...`)
console.log(`[${requestId}] 🆕 New seller detected`)
console.log(`[${requestId}] 🎯 Calling Keepa API...`)
console.log(`[${requestId}] ⏱️ Keepa fetch: 347ms`)
console.log(`[${requestId}] 💾 Saving seller data...`)
console.log(`[${requestId}] ✅ Completed: 423ms`)
```

### INCORRECT - Vague Flow:
```javascript
console.log("Starting process")
console.log("Checking database")
console.log("Database query completed")
console.log("Making API call")
console.log("Updating database")
console.log("Process complete")
```

**DO NOT USE:** Generic descriptions, missing request IDs, no timing metrics, duplicate statements

---

This file serves as the reference for all logging standards. Add it to the project root so it's always available for context.