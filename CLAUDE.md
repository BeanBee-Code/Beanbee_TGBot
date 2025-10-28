# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

```bash
# Install dependencies
yarn install

# Run in development mode with auto-restart
yarn dev

# Build TypeScript to JavaScript
yarn build

# Run production build
yarn start

# TypeScript type checking
npx tsc --noEmit

# Run tests
yarn test         # Run tests in watch mode
yarn test:run     # Run all tests once
yarn test:coverage # Run tests with coverage report
yarn test:ui      # Run tests with web UI

# Run specific test suites
yarn test:defi    # Test DeFi services
yarn test:wallet  # Test wallet services
yarn test:ai      # Test AI services
```

## Required Environment Variables

Create a `.env` file with these required variables:
- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token from @BotFather
- `PROJECT_ID` - WalletConnect v2 project ID from cloud.walletconnect.com
- `MORALIS_API_KEY` - Moralis API key from moralis.io
- `GOOGLE_GEMINI_API_KEY` - Google Gemini API key for AI services
- `MONGODB_URI` - MongoDB connection string (if not using default localhost)
- `WALLET_ENCRYPTION_KEY` - 32-byte hex string for encrypting trading wallet private keys (auto-generated if not set)
- `REFERRAL_SENDER_PRIVATE_KEY` - Private key for the wallet that sends referral payouts (required for referral withdrawals)
- `LOG_LEVEL` - (Optional) Winston log level: error, warn, info, debug (default: info)
- `TAVILY_API_KEY` - (Optional) Tavily API key for daily BSC news and yield opportunities in summaries
- `COINGECKO_API_KEY` - (Optional) CoinGecko Pro API key for enhanced token holder analysis
- `NODEREAL_API_KEY` - NodeReal API key for opBNB Layer 2 functionality (balances, transactions, token data)
- `HAPI_LABS_API_KEY` - (Optional) HAPI Labs API key for advanced smart contract security screening in rug alerts
- `HAPI_LABS_API_URL` - (Optional) HAPI Labs API URL (default: https://research.hapilabs.one)

### API Server Configuration

- `API_PORT` - (Optional) Port for the API server (default: 3000)
- `API_BASE_URL` - (Optional) Base URL for the API server (default: http://localhost:3000)
- `TELEGRAM_BOT_USERNAME` - (Optional) Your bot username for deep linking (default: bnbcopilot_bot)
- `FRONTEND_URL` - (Optional) Frontend URL for wallet connection (default: https://connect.beanbee.ai)

**Development Note**: For Binance Web3 Wallet functionality to work properly, you need a public HTTPS URL since Telegram doesn't allow localhost URLs in inline keyboard buttons. For development, you can:
1. Use ngrok: `ngrok http 3000` and set `API_BASE_URL=https://your-ngrok-url.ngrok.io`
2. Or use the development fallback where the URL is shown directly for copying

### Optional Gas Optimization Variables

These optional environment variables control gas strategy for trading transactions:
- `GAS_BUFFER_PERCENTAGE` - (Optional) Gas limit buffer percentage to prevent out-of-gas failures (default: 20)
- `GAS_PRICE_MULTIPLIER` - (Optional) Gas price multiplier for competitive execution (default: 1.1)
- `MIN_GAS_PRICE_GWEI` - (Optional) Minimum gas price in Gwei (default: 3)

### Optional Scanner Configuration Variables

These optional environment variables control wallet token scanning behavior:
- `MIN_TOKEN_USD_VALUE` - (Optional) Minimum USD value to include tokens (default: 0.01)
- `MIN_LIQUIDITY_USD` - (Optional) Minimum liquidity in USD for token filtering (default: 1000)
- `MAX_TOKENS_PER_REQUEST` - (Optional) Maximum tokens to analyze per request (default: 50)
- `MAX_TOKENS_PER_MULTI_WALLET_REQUEST` - (Optional) Maximum tokens per wallet in multi-wallet scans (default: 30)
- `TOKEN_BATCH_SIZE` - (Optional) Batch size for token price fetching (default: 10)
- `DELAY_BETWEEN_BATCHES_MS` - (Optional) Delay between price fetch batches in milliseconds (default: 100)
- `ENABLE_LIQUIDITY_FILTER` - (Optional) Enable/disable liquidity filtering with analytics (default: true)
- `REQUIRE_24H_ACTIVITY` - (Optional) Require 24h trading activity (default: true)
- `REQUIRE_UNIQUE_WALLETS` - (Optional) Require multiple unique wallet interactions (default: true)

## Architecture Overview

This is a Telegram bot for BSC (Binance Smart Chain) cryptocurrency trading with the following core components:

### Service Layer (`src/services/`)
- **moralis.ts**: Blockchain data fetching (token prices, wallet balances)
- **pancakeswap/**: DEX integration for token swapping
- **wallet/**: WalletConnect integration and wallet scanning
  - **connect.ts**: WalletConnect wallet connection service
  - **binanceWallet.ts**: Binance Web3 Wallet Provider API integration
- **trading/**: Trading orchestration logic
- **user.ts**: User session and data management
- **ai/geminiService.ts**: Google Gemini AI integration for portfolio analysis
- **defi/**: DeFi protocol detection and yield analysis
- **staking/**: Staking position detection and analysis
- **defiLlama/yieldService.ts**: DeFiLlama API integration for yield data
- **news/tavilyService.ts**: Tavily API integration for BSC news and yield opportunities
- **hapiLabs/**: HAPI Labs smart contract security screening service
- **rugAlerts/**: Rug pull detection with holder analysis, liquidity checks, honeypot detection, and SC security screening

### Telegram Bot Layer (`src/telegram/`)
- **bot.ts**: Main bot class with session management
- **handlers/**: Command, callback, and message handlers
- **menus/**: Interactive menu builders using Telegraf inline keyboards

### API Layer (`src/api/`)
- **server.ts**: Express server for handling Binance Web3 Wallet connections
- **public/**: Static web dApp files for wallet connection interface

### Data Layer
- **MongoDB/Mongoose**: User persistence with Typegoose models
- **Session Management**: In-memory `userSessions` Map for stateful conversations
- **Models**: User, Transaction, TokenPrice, DeFiPosition, PNL, NewsCache
- **Multi-provider Support**: WalletConnect and Binance Web3 Wallet provider tracking

### Logging Infrastructure (`src/utils/logger.ts`)
- **Winston Logger**: Centralized logging with color-coded console output and daily rotating file logs
- **Log Levels**: error, warn, info, debug (configurable via LOG_LEVEL env var)
- **Module-based Loggers**: Each service creates its own child logger with module name
- **Automatic Log Rotation**: Logs rotate daily with 14-day retention for general logs, 30-day for errors
- **Structured Logging**: JSON metadata support and automatic error stack trace capture

### Token Filtering & Dead Token Detection (`src/services/wallet/scanner.ts`)
- **Advanced Liquidity Filtering**: Uses Moralis Token Analytics API to filter out low-liquidity tokens
- **Dead Token Database**: Stores detected dead/inactive tokens in MongoDB to avoid redundant API calls
- **Smart Caching**: Checks known dead tokens before making analytics requests to improve performance
- **Multi-tier Filtering**: Price validation → Liquidity analytics → Dead token storage
- **Configurable Thresholds**: Minimum liquidity ($1000 default), 24h activity requirements, unique wallet interactions

### Dual Wallet Provider Support
- **WalletConnect Integration**: QR code scanning for all compatible wallets (MetaMask, Trust Wallet, etc.)
- **Binance Web3 Wallet**: Direct browser-based connection using Binance Web3 Wallet Provider API
- **Web dApp Interface**: Hosted at `/connect-binance.html` for Binance Wallet connections
- **Provider Tracking**: Database stores wallet connection provider type (`walletconnect` or `binance`)
- **Seamless Experience**: Users can choose between QR code scanning or browser-based connection

### HAPI Labs Smart Contract Security Screening (`src/services/hapiLabs/`)
- **Professional Security Analysis**: Integrates HAPI Labs API for advanced smart contract vulnerability detection
- **25+ Security Checks**: Detects reentrancy, vulnerable withdrawals, approval vulnerabilities, blacklisting, mintable/pausable/upgradable patterns, transfer fees, cooldowns, mixer usage, owner scams, and more
- **Risk Categorization**: Categorizes findings as Critical, High, Medium, Low, or Informational
- **Intelligent Caching**: MongoDB-based caching with 7-day TTL to minimize API calls (SCSecurityCache model)
- **Graceful Degradation**: Falls back to basic honeypot detection if HAPI Labs API is unavailable
- **Safety Score Integration**: Contributes 15 points to the 100-point safety score in rug alerts
- **Detailed Reporting**: Displays critical vulnerabilities, high-risk patterns, medium issues, and positive features
- **BSC Support**: Currently supports BSC chain with extensible design for other chains

## Key Architectural Patterns

1. **Session-Based State Management**: User interactions are tracked through a global `userSessions` Map, enabling multi-step workflows for wallet connection and trading.

2. **Menu-Driven Interface**: All user interactions flow through structured menus defined in `src/telegram/menus/`, using Telegraf's inline keyboard system.

3. **Service Separation**: Business logic is isolated in service modules, keeping the Telegram handlers focused on user interaction.

4. **TypeScript-First**: Strict typing throughout with path aliases (`@/*` → `src/*`).

5. **AI-Powered Features**: Integration with Google Gemini for natural language portfolio queries and yield tips.

## Testing Framework

The project uses **Vitest** as the testing framework with comprehensive coverage:

### Test Coverage
- **54 Passing Tests** covering all core functionality
- **100% Pass Rate** with no failing tests
- **Test Categories**: Database models, services, utilities, integrations
- **Coverage Areas**: Moralis API, token pricing, P&L calculations, user management, transaction history

### Test Structure
- **Unit Tests**: Located in `src/tests/` following the same structure as the source code
- **Mocks**: Centralized mocks in `src/tests/mocks/` for external dependencies (Moralis, database, logger)
- **Integration Tests**: Located in `src/tests/integration/` for API interactions
- **Test Utilities**: Helper functions in `src/tests/setup.ts` with crypto polyfills

### Technical Configuration
- **Vitest Config**: `vitest.config.ts` with TypeScript path aliases and SWC plugin
- **Decorator Support**: Uses `unplugin-swc` for Typegoose decorator metadata
- **Database Separation**: Automatic test/production database switching based on NODE_ENV
- **Mock System**: Comprehensive mocking for external services and blockchain interactions

### Key Testing Patterns
1. **Mock External Services**: All external APIs (Moralis, blockchain, etc.) are properly mocked
2. **Database Isolation**: Test and production databases are separate (`bnbcopilot-test` vs `bnbcopilot-prod`)
3. **Service Layer Testing**: Each service is tested in isolation with dependency injection
4. **Type Safety**: Full TypeScript support with strict typing and path aliases

### Running Tests
```bash
# Run all tests once
yarn test:run

# Run tests in watch mode
yarn test

# Run with coverage
yarn test:coverage

# Run specific test files
yarn test:run src/tests/services/moralis.test.ts
```

### Writing New Tests
1. Create test files with `.test.ts` extension
2. Import necessary mocks before the code under test
3. Use descriptive test names following the pattern: "should [expected behavior] when [condition]"
4. Mock external dependencies to ensure tests are deterministic

### Test Environment
- Tests run in Node.js environment
- Environment variables are loaded from `.env.test`
- Crypto polyfills are automatically provided for WalletConnect testing

## Deployment Notes

### Node.js Version Requirement
The application requires Node.js 18+ for proper crypto polyfill support. The crypto.webcrypto API is used for WalletConnect functionality.

### Environment-Specific Issues
If you encounter `crypto.getRandomValues must be defined` error in production:
- Ensure Node.js version is 18 or higher
- The crypto polyfill is already implemented in src/index.ts
- For containerized deployments, use a Node.js 18+ base image

### TypeScript Path Aliases
The project uses path aliases configured in two files:
- **tsconfig.json**: Maps `@/*` to `src/*` for development
- **tsconfig-paths.json**: Maps `@/*` to `dist/*` for production
- Production start script uses `TS_NODE_PROJECT=tsconfig-paths.json` to resolve paths correctly

## Code Standards

Per RULES.md:
- Implement structured error handling with specific failure modes
- Include concise docstrings for all functions
- Verify preconditions before critical operations
- Follow KISS, YAGNI, and SOLID principles
- Never hardcode credentials or sensitive data

## Development Workflow

1. Always run `npx tsc --noEmit` to check for TypeScript issues before committing
2. Use the development server (`yarn dev`) which includes hot-reloading via nodemon
3. Test wallet connectivity features with actual WalletConnect integration
4. Verify Telegram bot responses in a test bot instance before production deployment
5. Monitor MongoDB connections during development
6. Check logs in `logs/` directory for debugging (logs are gitignored)
7. Use `LOG_LEVEL=debug` for verbose logging during development

## Critical Implementation Notes

- The application requires all three core environment variables (TELEGRAM_BOT_TOKEN, PROJECT_ID, MORALIS_API_KEY) to start
- WalletConnect requires crypto polyfill which is initialized at the top of src/index.ts
- Bot instance conflicts are handled with clear error messages - only one instance can run at a time
- Graceful shutdown handlers are implemented for SIGINT and SIGTERM signals