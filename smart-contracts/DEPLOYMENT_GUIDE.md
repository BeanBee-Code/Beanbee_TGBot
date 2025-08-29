# SecureBeanBeeRouter Deployment Guide

## Contract Overview
The SecureBeanBeeRouter (VerifiedSwapRouter) is a secure routing contract that executes swaps with signature verification to prevent unauthorized use.

## Prerequisites

1. **Fund your deployer wallet** with BNB for gas fees:
   - Testnet: Get free BNB from [BSC Testnet Faucet](https://testnet.binance.org/faucet-smart)
   - Mainnet: Transfer BNB to your deployer address
   - Required: ~0.1 BNB for deployment and initial setup

2. **Configure environment variables** in `.env`:
   ```bash
   # Required for deployment
   BSC_TESTNET_PRIVATE_KEY=your_private_key_here
   BSC_MAINNET_PRIVATE_KEY=your_mainnet_key_here  # Only for mainnet
   
   # Optional: Specify a different signer address (defaults to deployer)
   SIGNER_ADDRESS=0x...  # Address that will sign swap permits
   
   # For contract verification
   BSCSCAN_API_KEY=your_bscscan_api_key_here
   ```

## Deployment Steps

### 1. Deploy to BSC Testnet
```bash
npx hardhat run scripts/deploySecureRouter.ts --network bscTestnet
```

### 2. Deploy to BSC Mainnet
```bash
npx hardhat run scripts/deploySecureRouter.ts --network bscMainnet
```

### 3. Verify Contract on BscScan
After deployment, verify your contract:
```bash
# For testnet
npx hardhat verify --network bscTestnet CONTRACT_ADDRESS "SIGNER_ADDRESS"

# For mainnet
npx hardhat verify --network bscMainnet CONTRACT_ADDRESS "SIGNER_ADDRESS"
```

## Post-Deployment Configuration

### 1. Add Additional Routers (if needed)
The deployment script automatically whitelists PancakeSwap. To add more routers:

```javascript
// Using ethers.js
const router = await ethers.getContractAt("VerifiedSwapRouter", CONTRACT_ADDRESS);
await router.addRouter("0x...new_router_address");
```

### 2. Update Signer Address (if needed)
```javascript
await router.setSignerAddress("0x...new_signer_address");
```

## Current Deployment Status

✅ **Local Hardhat Network**: Successfully deployed
- Address: `0xDCc6A00eA83689Cdc4A06c445a8404531a24B8Cb`
- PancakeSwap Router whitelisted

⏳ **BSC Testnet**: Awaiting deployment
- Deployer address: `0xa8FB745067c4894edA0179190D0e8476251B3f92`
- **Action Required**: Fund this address with testnet BNB

⏳ **BSC Mainnet**: Not yet deployed

## Contract Addresses

| Network | Contract Address | Status |
|---------|-----------------|--------|
| Hardhat Local | 0xDCc6A00eA83689Cdc4A06c445a8404531a24B8Cb | ✅ Deployed |
| BSC Testnet | TBD | ⏳ Pending |
| BSC Mainnet | TBD | ⏳ Pending |

## Integration with Backend

After deployment, update your backend configuration:

1. Set the contract address in your environment
2. Configure the signer private key for generating permits
3. Ensure the signer address matches the one set in the contract

## Security Considerations

1. **Signer Key Security**: Keep the signer private key secure and never expose it
2. **Router Whitelisting**: Only whitelist trusted DEX routers
3. **Signature Expiry**: Set appropriate deadlines for signatures
4. **Nonce Management**: The contract handles replay protection automatically

## Testing the Deployment

Test your deployment with a simple swap:
```javascript
// Example test script
const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
const nonce = await router.userNonces(userAddress);
// Generate signature on backend...
await router.executeSwap(routerAddress, calldata, deadline, signature, { value: swapAmount });
```

## Troubleshooting

- **Insufficient funds error**: Fund your deployer wallet with BNB
- **Router not whitelisted**: Use `addRouter()` to whitelist DEX routers
- **Invalid signature**: Ensure signer address matches and signature is properly formatted
- **Signature expired**: Check deadline timestamp is in the future