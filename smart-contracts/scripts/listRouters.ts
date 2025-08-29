import { ethers } from "hardhat";
import { network } from "hardhat";

async function main() {
  const SECURE_ROUTER_ADDRESS = "0x44Fda37507bBDc2DbcC8Ba825D2cc7A0f01c3B4a";

  console.log(`\nChecking whitelisted routers on ${network.name}...`);
  console.log(`Contract Address: ${SECURE_ROUTER_ADDRESS}`);

  // Get the contract instance
  const SecureBeanBeeRouter = await ethers.getContractFactory("SecureBeanBeeRouter");
  const secureBeanBeeRouter = SecureBeanBeeRouter.attach(SECURE_ROUTER_ADDRESS);

  // List of known routers to check
  const routers = [
    { address: "0x10ED43C718714eb63d5aA57B78B54704E256024E", name: "PancakeSwap V2" },
    { address: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", name: "PancakeSwap V3" },
    { address: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8", name: "BiSwap" },
    { address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", name: "SushiSwap" }
  ];

  console.log("\n=== Whitelisted Routers ===");
  let whitelistedCount = 0;

  for (const router of routers) {
    const isWhitelisted = await secureBeanBeeRouter.whitelistedRouters(router.address);
    if (isWhitelisted) {
      console.log(`✅ ${router.name}: ${router.address}`);
      whitelistedCount++;
    } else {
      console.log(`❌ ${router.name}: ${router.address} (not whitelisted)`);
    }
  }

  console.log(`\nTotal Whitelisted Routers: ${whitelistedCount}`);

  // Get contract owner
  const owner = await secureBeanBeeRouter.owner();
  console.log(`\nContract Owner: ${owner}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});