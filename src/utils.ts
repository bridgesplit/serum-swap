import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';

// Serum DEX program id on devnet.
export const DEX_PID = new PublicKey(
  'DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY',
);

// Swap program id on devnet.
export const SWAP_PID = new PublicKey(
  'ziR2PGyshLYwLsGsH5hXH5rkZTf6GNJ6RzvX23v52iY',
);

// Return the program derived address used by the serum DEX to control token
// vaults.
export async function getVaultOwnerAndNonce(
  marketPublicKey: PublicKey,
  dexProgramId: PublicKey = DEX_PID,
) {
  const nonce = new BN(0);
  while (nonce.toNumber() < 255) {
    try {
      const vaultOwner = await PublicKey.createProgramAddress(
        [marketPublicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
        dexProgramId,
      );
      return [vaultOwner, nonce];
    } catch (e) {
      nonce.iaddn(1);
    }
  }
  throw new Error('Unable to find nonce');
}

// Returns an associated token address for spl tokens.
export async function getAssociatedTokenAddress(
  associatedProgramId: PublicKey,
  programId: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  return (
    await PublicKey.findProgramAddress(
      [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
      associatedProgramId,
    )
  )[0];
}
