import { ethers } from "hardhat";
import { network } from "hardhat";

async function main() {
  console.log(`Deploying SecureBeanBeeRouter (VerifiedSwapRouter) to network: ${network.name}`);

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Check account balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "BNB");

  // The signer address that will authorize swaps
  // In production, this should be your backend server's signer address
  // For testing, we'll use a different account or you can specify one
  const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS || deployer.address;
  
  console.log("Using signer address:", SIGNER_ADDRESS);

  // Deploy the VerifiedSwapRouter contract
  const VerifiedSwapRouter = await ethers.getContractFactory("VerifiedSwapRouter");
  const verifiedSwapRouter = await VerifiedSwapRouter.deploy(SIGNER_ADDRESS);

  await verifiedSwapRouter.waitForDeployment();
  const routerAddress = await verifiedSwapRouter.getAddress();

  console.log(`VerifiedSwapRouter deployed to: ${routerAddress}`);

  // Add PancakeSwap router to whitelist
  let pancakeRouterAddress: string;
  
  if (network.name === "bscMainnet") {
    pancakeRouterAddress = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
  } else if (network.name === "bscTestnet") {
    pancakeRouterAddress = "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3";
  } else {
    // For local testing on hardhat fork
    pancakeRouterAddress = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
  }

  console.log("Adding PancakeSwap router to whitelist:", pancakeRouterAddress);
  
  const tx = await verifiedSwapRouter.addRouter(pancakeRouterAddress);
  await tx.wait();
  
  console.log("PancakeSwap router whitelisted successfully!");

  // Print deployment summary
  console.log("\n=== Deployment Summary ===");
  console.log("Network:", network.name);
  console.log("VerifiedSwapRouter Address:", routerAddress);
  console.log("Owner Address:", deployer.address);
  console.log("Signer Address:", SIGNER_ADDRESS);
  console.log("Whitelisted Router:", pancakeRouterAddress);
  console.log("========================\n");

  // Instructions for verification
  if (network.name === "bscMainnet" || network.name === "bscTestnet") {
    console.log("To verify the contract on BscScan, run:");
    console.log(`npx hardhat verify --network ${network.name} ${routerAddress} "${SIGNER_ADDRESS}"`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});