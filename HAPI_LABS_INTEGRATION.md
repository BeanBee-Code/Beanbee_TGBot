# HAPI Labs Smart Contract Security Integration

## Overview

Successfully integrated HAPI Labs smart contract security screening into the BeanBee Telegram bot's rug alert system. This enhancement provides professional-grade vulnerability detection for BSC tokens, significantly improving the bot's ability to identify risky or malicious tokens.

## Implementation Summary

### 1. New Service Module (`src/services/hapiLabs/`)
Created a comprehensive HAPI Labs service with:
- **API Client**: Axios-based client for HAPI Labs v2 API
- **Response Processing**: Intelligent categorization of 25+ security checks into Critical, High, Medium, Low, and Informational levels
- **Caching System**: MongoDB-based caching with 7-day TTL to minimize API usage
- **Graceful Degradation**: Falls back to basic analysis if API is unavailable
- **Type Safety**: Full TypeScript interfaces for all API responses

### 2. Database Model (`src/database/models/SCSecurityCache.ts`)
- **Purpose**: Cache smart contract security analysis results
- **Schema**: Stores contract address, chain, security data, and timestamp
- **Indexes**: Compound index on (contractAddress, chain) for fast lookups
- **Auto-Cleanup**: TTL index auto-deletes entries after 7 days

### 3. Token Analyzer Integration (`src/services/rugAlerts/tokenAnalyzer.ts`)
Enhanced the token analysis pipeline:
- **Parallel Execution**: SC screening runs alongside other analyses (holders, liquidity, honeypot, etc.)
- **Safety Score Rebalancing**: Added 15-point SC security category to 100-point safety score system
  - Holders: 15 points
  - Liquidity: 20 points (reduced from 25)
  - Verification: 10 points
  - Ownership: 10 points
  - Trading: 10 points
  - Age: 10 points
  - Honeypot: 10 points (reduced from 15)
  - Diamond Hands: 5 points
  - **SC Security: 15 points (NEW)**
  - Price Deviation: Penalty points
- **Risk Integration**: Critical and high-risk SC issues are added to overall risk factors

### 4. Enhanced Display (`src/services/rugAlerts/index.ts`)
Improved the rug alert reporting with:
- **Natural Summary Enhancement**: Critical SC vulnerabilities are highlighted upfront
- **Dedicated SC Security Section**: Shows risk level, security score, critical vulnerabilities, high-risk patterns, medium issues, and positive features
- **Safety Score Breakdown**: Updated to show SC Security score in detailed breakdown
- **Visual Indicators**: Color-coded emoji indicators for different risk levels

## Security Checks Performed

HAPI Labs analyzes 25+ security aspects:

### Critical Vulnerabilities (15-point deduction each)
- Vulnerable withdrawal functions
- Reentrancy risks
- Approval vulnerabilities
- Owner can abuse approvals
- Vulnerable ownership patterns
- Native token drainage
- Owner previous scams

### High-Risk Patterns (5-point deduction each)
- Upgradable contracts
- Blacklisting mechanisms
- Mintable tokens
- Pausable functionality
- Mixer utilization
- Adjustable maximum supply
- Retrievable ownership

### Medium-Risk Issues (2-point deduction each)
- Transfer fees
- Transfer limits
- Transfer cooldowns
- Centralized balance controls
- Approval restrictions
- Lock mechanisms

### Low-Risk Issues (1-point deduction each)
- Blocking loops
- Interface errors
- External calls
- Airdrop-specific code

## API Configuration

### Environment Variables
```bash
HAPI_LABS_API_KEY=1e83559e-b58a-4681-9511-43243900397f
HAPI_LABS_API_URL=https://research.hapilabs.one  # Optional, defaults to this
```

### API Usage
- **Rate Limit**: 200 calls with provided API key
- **Caching**: Results cached for 7 days to minimize API calls
- **Fallback**: If API fails or quota exceeded, analysis continues without SC screening

## Example Output

### Summary View
```
🚨 CRITICAL SECURITY WARNING: SampleToken (ST) has 2 critical smart
contract vulnerabilities! This token may be unsafe to trade.

The token has a high sell tax of 15%, is heavily concentrated among
top holders, has unlocked liquidity that can be removed, ownership
is not renounced, and shows little to no trading activity.

🚨 High Risk - Multiple red flags detected. Consider avoiding this token.

📊 Key Metrics (BSC Chain):
• Holders: 1,234
• Liquidity: $45.6K
• 24h Volume: $12.3K
• Top 10 Hold: 67.8%
```

### Detailed SC Security Section
```
🛡️ SMART CONTRACT SECURITY
Powered by HAPI Labs Security Screening

🔴 Risk Level: CRITICAL
Security Score: 0/15

🚨 CRITICAL VULNERABILITIES:
  ⚠️ Vulnerable withdrawal
  ⚠️ Owner can abuse approvals

⚠️ High-Risk Patterns:
  • Mintable
  • Pausable
  • Blacklisting

ℹ️ Medium-Risk Issues: 3 detected
```

## Testing

### TypeScript Compilation
✅ All type checks passed with no errors

### Build Process
✅ Production build completed successfully in 4.09s

### Integration Tests
Recommended to test with:
- **Safe Token**: CAKE (0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82)
- **Risky Token**: Any known honeypot or scam token
- **New Token**: Recently launched tokens for security screening

## Architecture Benefits

1. **Non-Blocking**: SC screening runs in parallel, doesn't slow down analysis
2. **Fault Tolerant**: Gracefully handles API failures without breaking rug alerts
3. **Cached**: Smart caching minimizes API calls and improves response times
4. **Extensible**: Easy to add more chains beyond BSC
5. **Transparent**: Clear attribution to HAPI Labs in user-facing messages

## Files Modified/Created

### Created
- `src/services/hapiLabs/index.ts` - HAPI Labs service module
- `src/database/models/SCSecurityCache.ts` - Caching model
- `HAPI_LABS_INTEGRATION.md` - This documentation

### Modified
- `src/services/rugAlerts/tokenAnalyzer.ts` - Added SC screening to analysis pipeline
- `src/services/rugAlerts/index.ts` - Enhanced display with SC security section
- `.env` - Added HAPI Labs API credentials
- `CLAUDE.md` - Updated documentation

## Future Enhancements

1. **Multi-Chain Support**: Extend to other supported chains (Ethereum, Polygon, etc.)
2. **Alert Threshold Tuning**: Fine-tune which issues trigger warnings vs. critical alerts
3. **Historical Tracking**: Track security score changes over time
4. **Batch Analysis**: Analyze multiple tokens in parallel for portfolio screening
5. **Custom Rules**: Allow users to configure security check priorities

## Maintenance Notes

- Monitor API quota usage (200 calls currently available)
- Cache hit rate should be monitored for optimization
- Consider upgrading API plan if hitting rate limits
- Review and update security check categorizations as HAPI Labs evolves

## Support

For issues or questions:
- HAPI Labs API Docs: https://www.hapilabs.one/api/
- BeanBee Bot Issues: https://github.com/BeanBee-Code/Beanbee_TGBot/issues
