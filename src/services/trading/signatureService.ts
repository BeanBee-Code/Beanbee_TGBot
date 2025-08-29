import { ethers } from 'ethers';
import { createLogger } from '@/utils/logger';

const logger = createLogger('signature-service');

// Contract address and chain configuration
const SECURE_ROUTER_ADDRESS = '0x8372Ec5Da575D4c637dfaA33a22DF96406D7d1F4';
const CHAIN_ID = 56; // BSC Mainnet

// EIP-712 Domain
const DOMAIN = {
    name: 'VerifiedSwapRouter',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: SECURE_ROUTER_ADDRESS as `0x${string}`
};

// Type definitions for EIP-712
const EXECUTE_SWAP_PERMIT_TYPES = {
    ExecuteSwapPermit: [
        { name: 'user', type: 'address' },
        { name: 'router', type: 'address' },
        { name: 'calldata_', type: 'bytes' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
    ]
};

const EXECUTE_TOKEN_SWAP_PERMIT_TYPES = {
    ExecuteTokenSwapPermit: [
        { name: 'user', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'router', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'calldata_', type: 'bytes' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
    ]
};

export class SignatureService {
    private signer: ethers.Wallet;
    private provider: ethers.JsonRpcProvider;
    private routerContract: ethers.Contract;

    constructor() {
        // Get signer private key from environment
        const signerPrivateKey = process.env.SIGNER_PRIVATE_KEY;
        if (!signerPrivateKey) {
            throw new Error('SIGNER_PRIVATE_KEY not found in environment variables');
        }

        // Initialize provider and signer
        this.provider = new ethers.JsonRpcProvider(
            process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/'
        );
        this.signer = new ethers.Wallet(signerPrivateKey, this.provider);

        // Initialize router contract for reading nonces
        const routerAbi = [
            'function userNonces(address user) view returns (uint256)',
            'function signerAddress() view returns (address)'
        ];
        this.routerContract = new ethers.Contract(
            SECURE_ROUTER_ADDRESS,
            routerAbi,
            this.provider
        );

        logger.info('Signature service initialized', {
            signerAddress: this.signer.address,
            routerAddress: SECURE_ROUTER_ADDRESS
        });
    }

    /**
     * Get the current nonce for a user
     */
    async getUserNonce(userAddress: string): Promise<bigint> {
        try {
            const nonce = await this.routerContract.userNonces(userAddress);
            return nonce;
        } catch (error) {
            logger.error('Failed to get user nonce', { 
                userAddress, 
                error: error instanceof Error ? error.message : String(error) 
            });
            throw error;
        }
    }

    /**
     * Generate EIP-712 signature for executeSwap (BNB to token)
     */
    async generateSwapSignature(
        userAddress: string,
        routerAddress: string,
        calldata: string,
        deadlineMinutes: number = 20
    ): Promise<{ signature: string; deadline: number; nonce: string }> {
        try {
            // Get current nonce
            const nonce = await this.getUserNonce(userAddress);
            
            // Calculate deadline (current time + deadlineMinutes)
            const deadline = Math.floor(Date.now() / 1000) + (deadlineMinutes * 60);

            // Create the typed data
            const message = {
                user: userAddress,
                router: routerAddress,
                calldata_: calldata,
                nonce: nonce.toString(),
                deadline: deadline
            };

            // Sign the typed data
            const signature = await this.signer.signTypedData(
                DOMAIN,
                EXECUTE_SWAP_PERMIT_TYPES,
                message
            );

            logger.info('Swap signature generated', {
                userAddress,
                nonce: nonce.toString(),
                deadline
            });

            return {
                signature,
                deadline,
                nonce: nonce.toString()
            };
        } catch (error) {
            logger.error('Failed to generate swap signature', {
                userAddress,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Generate EIP-712 signature for executeTokenSwap (token to BNB)
     */
    async generateTokenSwapSignature(
        userAddress: string,
        tokenAddress: string,
        routerAddress: string,
        amount: string,
        calldata: string,
        deadlineMinutes: number = 20
    ): Promise<{ signature: string; deadline: number; nonce: string }> {
        try {
            // Get current nonce
            const nonce = await this.getUserNonce(userAddress);
            
            // Calculate deadline
            const deadline = Math.floor(Date.now() / 1000) + (deadlineMinutes * 60);

            // Create the typed data
            const message = {
                user: userAddress,
                token: tokenAddress,
                router: routerAddress,
                amount: amount,
                calldata_: calldata,
                nonce: nonce.toString(),
                deadline: deadline
            };

            // Sign the typed data
            const signature = await this.signer.signTypedData(
                DOMAIN,
                EXECUTE_TOKEN_SWAP_PERMIT_TYPES,
                message
            );

            logger.info('Token swap signature generated', {
                userAddress,
                tokenAddress,
                amount,
                nonce: nonce.toString(),
                deadline
            });

            return {
                signature,
                deadline,
                nonce: nonce.toString()
            };
        } catch (error) {
            logger.error('Failed to generate token swap signature', {
                userAddress,
                tokenAddress,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Verify that the signer address matches the contract's signer
     */
    async verifySignerAddress(): Promise<boolean> {
        try {
            const contractSigner = await this.routerContract.signerAddress();
            const isValid = contractSigner.toLowerCase() === this.signer.address.toLowerCase();
            
            if (!isValid) {
                logger.error('Signer address mismatch', {
                    expected: contractSigner,
                    actual: this.signer.address
                });
            }
            
            return isValid;
        } catch (error) {
            logger.error('Failed to verify signer address', {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    }
}

// Export singleton instance
export const signatureService = new SignatureService();