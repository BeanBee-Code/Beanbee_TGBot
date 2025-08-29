import { ethers } from "hardhat";
import { network } from "hardhat";

async function main() {
  // Your deployed SecureBeanBeeRouter contract address
  const SECURE_ROUTER_ADDRESS = "0x44Fda37507bBDc2DbcC8Ba825D2cc7A0f01c3B4a";
  
  // PancakeSwap V3 Router address to whitelist
  const PANCAKESWAP_V3_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";

  console.log(`\nAdding router to whitelist on ${network.name}...`);
  console.log(`Contract Address: ${SECURE_ROUTER_ADDRESS}`);
  console.log(`Router to Add: ${PANCAKESWAP_V3_ROUTER} (PancakeSwap V3)`);

  // Get the contract instance
  const SecureBeanBeeRouter = await ethers.getContractFactory("SecureBeanBeeRouter");
  const secureBeanBeeRouter = SecureBeanBeeRouter.attach(SECURE_ROUTER_ADDRESS);

  // Check if router is already whitelisted
  const isWhitelisted = await secureBeanBeeRouter.whitelistedRouters(PANCAKESWAP_V3_ROUTER);
  
  if (isWhitelisted) {
    console.log("\n✅ Router is already whitelisted!");
    return;
  }

  // Add the router to whitelist
  console.log("\nAdding router to whitelist...");
  const tx = await secureBeanBeeRouter.addRouter(PANCAKESWAP_V3_ROUTER);
  
  console.log(`Transaction hash: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  
  const receipt = await tx.wait();
  console.log(`Transaction confirmed in block: ${receipt.blockNumber}`);

  // Verify the router was added
  const isNowWhitelisted = await secureBeanBeeRouter.whitelistedRouters(PANCAKESWAP_V3_ROUTER);
  
  if (isNowWhitelisted) {
    console.log("\n✅ SUCCESS: PancakeSwap V3 Router has been whitelisted!");
  } else {
    console.log("\n❌ ERROR: Router was not whitelisted. Please check the transaction.");
  }

  // Display all whitelisted routers (optional)
  console.log("\n=== Current Whitelisted Routers ===");
  const knownRouters = [
    { address: "0x10ED43C718714eb63d5aA57B78B54704E256024E", name: "PancakeSwap V2" },
    { address: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", name: "PancakeSwap V3" },
    { address: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8", name: "BiSwap" }
  ];

  for (const router of knownRouters) {
    const whitelisted = await secureBeanBeeRouter.whitelistedRouters(router.address);
    if (whitelisted) {
      console.log(`✅ ${router.name}: ${router.address}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});