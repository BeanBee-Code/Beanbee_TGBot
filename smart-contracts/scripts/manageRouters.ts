import { ethers } from "hardhat";
import { network } from "hardhat";

// Configuration - Update these values
const CONTRACT_ADDRESS = process.env.ROUTER_CONTRACT_ADDRESS || "";
const ACTION = process.env.ACTION || "add"; // "add" or "remove"
const ROUTER_TO_MANAGE = process.env.ROUTER_ADDRESS || "";

async function main() {
  if (!CONTRACT_ADDRESS) {
    throw new Error("Please set ROUTER_CONTRACT_ADDRESS in your .env file");
  }

  console.log(`Managing routers on network: ${network.name}`);
  console.log("Contract address:", CONTRACT_ADDRESS);
  console.log("Action:", ACTION);
  console.log("Router address:", ROUTER_TO_MANAGE);

  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);

  // Get the deployed contract
  const verifiedSwapRouter = await ethers.getContractAt("VerifiedSwapRouter", CONTRACT_ADDRESS);

  // Check current owner
  const owner = await verifiedSwapRouter.owner();
  console.log("Contract owner:", owner);
  
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("Current signer is not the contract owner!");
  }

  // Check if router is currently whitelisted
  const isWhitelisted = await verifiedSwapRouter.whitelistedRouters(ROUTER_TO_MANAGE);
  console.log(`Router ${ROUTER_TO_MANAGE} is currently whitelisted:`, isWhitelisted);

  if (ACTION === "add") {
    if (isWhitelisted) {
      console.log("Router is already whitelisted!");
      return;
    }
    console.log("Adding router to whitelist...");
    const tx = await verifiedSwapRouter.addRouter(ROUTER_TO_MANAGE);
    await tx.wait();
    console.log("✅ Router added successfully!");
  } else if (ACTION === "remove") {
    if (!isWhitelisted) {
      console.log("Router is not whitelisted!");
      return;
    }
    console.log("Removing router from whitelist...");
    const tx = await verifiedSwapRouter.removeRouter(ROUTER_TO_MANAGE);
    await tx.wait();
    console.log("✅ Router removed successfully!");
  } else {
    throw new Error("Invalid ACTION. Use 'add' or 'remove'");
  }

  // Verify the change
  const newStatus = await verifiedSwapRouter.whitelistedRouters(ROUTER_TO_MANAGE);
  console.log(`Router ${ROUTER_TO_MANAGE} whitelist status:`, newStatus);
}

// Example usage:
// ACTION=add ROUTER_ADDRESS=0x13f4EA83D0bd40E75C8222255bc855a974568Dd4 ROUTER_CONTRACT_ADDRESS=0x... npx hardhat run scripts/manageRouters.ts --network bscMainnet

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});