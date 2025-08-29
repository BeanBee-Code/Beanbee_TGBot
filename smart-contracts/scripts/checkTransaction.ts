import { ethers } from "hardhat";
import { network } from "hardhat";

async function main() {
  const txHash = "0x9dc3678743534749860643d5ffcf85ad120899a2b7c0d7d8dfd975cbe66e35dc";
  const SECURE_ROUTER_ADDRESS = "0x44Fda37507bBDc2DbcC8Ba825D2cc7A0f01c3B4a";
  const PANCAKESWAP_V3_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";

  console.log(`\nChecking transaction on ${network.name}...`);
  console.log(`Transaction Hash: ${txHash}`);

  const provider = ethers.provider;
  
  // Get transaction receipt
  const receipt = await provider.getTransactionReceipt(txHash);
  
  if (!receipt) {
    console.log("Transaction not found!");
    return;
  }

  console.log(`\n=== Transaction Details ===`);
  console.log(`Status: ${receipt.status === 1 ? "✅ Success" : "❌ Failed"}`);
  console.log(`Block Number: ${receipt.blockNumber}`);
  console.log(`Gas Used: ${receipt.gasUsed.toString()}`);
  
  // Get the contract instance
  const SecureBeanBeeRouter = await ethers.getContractFactory("SecureBeanBeeRouter");
  const secureBeanBeeRouter = SecureBeanBeeRouter.attach(SECURE_ROUTER_ADDRESS);

  // Check current owner
  console.log(`\n=== Contract Information ===`);
  const owner = await secureBeanBeeRouter.owner();
  console.log(`Contract Owner: ${owner}`);
  
  // Get the signer address
  const [signer] = await ethers.getSigners();
  console.log(`Current Signer: ${signer.address}`);
  
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("\n❌ ERROR: You are not the owner of the contract!");
    console.log("Only the owner can add routers to the whitelist.");
    return;
  }

  // Check if router is whitelisted
  const isWhitelisted = await secureBeanBeeRouter.whitelistedRouters(PANCAKESWAP_V3_ROUTER);
  console.log(`\nPancakeSwap V3 Router Whitelisted: ${isWhitelisted ? "✅ Yes" : "❌ No"}`);

  // Parse events from the transaction
  console.log(`\n=== Transaction Events ===`);
  if (receipt.logs && receipt.logs.length > 0) {
    for (const log of receipt.logs) {
      try {
        const parsedLog = secureBeanBeeRouter.interface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });
        if (parsedLog) {
          console.log(`Event: ${parsedLog.name}`);
          console.log(`Args:`, parsedLog.args);
        }
      } catch (e) {
        // Not an event from our contract
      }
    }
  } else {
    console.log("No events emitted");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});