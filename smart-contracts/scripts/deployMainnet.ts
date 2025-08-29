import { ethers } from "hardhat";
import { network } from "hardhat";

async function main() {
  // Ensure we're on mainnet
  if (network.name !== "bscMainnet") {
    throw new Error("This script is for BSC Mainnet only! Current network: " + network.name);
  }

  console.log("🚀 Deploying SecureBeanBeeRouter to BSC MAINNET");
  console.log("================================================\n");

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  // Check account balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "BNB");
  
  // Ensure sufficient balance (recommended 0.1 BNB)
  const minBalance = ethers.parseEther("0.01");
  if (balance < minBalance) {
    throw new Error(`Insufficient balance! Need at least 0.05 BNB, have ${ethers.formatEther(balance)} BNB`);
  }

  // The signer address that will authorize swaps
  const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS || deployer.address;
  console.log("Signer address:", SIGNER_ADDRESS);
  console.log("\n================================================");

  // Deploy the VerifiedSwapRouter contract
  console.log("\n📝 Deploying VerifiedSwapRouter contract...");
  const VerifiedSwapRouter = await ethers.getContractFactory("VerifiedSwapRouter");
  const verifiedSwapRouter = await VerifiedSwapRouter.deploy(SIGNER_ADDRESS);

  await verifiedSwapRouter.waitForDeployment();
  const routerAddress = await verifiedSwapRouter.getAddress();

  console.log("✅ VerifiedSwapRouter deployed to:", routerAddress);

  // Whitelist routers
  const routers = [
    {
      name: "PancakeSwap V2",
      address: "0x10ED43C718714eb63d5aA57B78B54704E256024E"
    },
    {
      name: "PancakeSwap V3",
      address: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"
    }
  ];

  console.log("\n📋 Whitelisting DEX routers...");
  
  for (const router of routers) {
    console.log(`   Adding ${router.name}: ${router.address}`);
    const tx = await verifiedSwapRouter.addRouter(router.address);
    await tx.wait();
    console.log(`   ✅ ${router.name} whitelisted`);
  }

  // Print deployment summary
  console.log("\n================================================");
  console.log("🎉 DEPLOYMENT SUCCESSFUL!");
  console.log("================================================");
  console.log("\n📊 Deployment Summary:");
  console.log("----------------------");
  console.log("Network:                BSC Mainnet");
  console.log("Contract Address:      ", routerAddress);
  console.log("Owner Address:         ", deployer.address);
  console.log("Signer Address:        ", SIGNER_ADDRESS);
  console.log("\nWhitelisted Routers:");
  for (const router of routers) {
    console.log(`  - ${router.name}: ${router.address}`);
  }
  console.log("\n================================================");

  // Verification instructions
  console.log("\n📝 Next Steps:");
  console.log("1. Save the contract address:", routerAddress);
  console.log("2. Update your backend configuration with this address");
  console.log("3. Verify the contract on BscScan:");
  console.log(`   npx hardhat verify --network bscMainnet ${routerAddress} "${SIGNER_ADDRESS}"`);
  console.log("\n⚠️  IMPORTANT: Keep your signer private key secure!");
  console.log("================================================\n");
}

main().catch((error) => {
  console.error("❌ Deployment failed!");
  console.error(error);
  process.exitCode = 1;
});