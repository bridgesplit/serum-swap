"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAssociatedTokenAddress = exports.getVaultOwnerAndNonce = exports.SWAP_PID = exports.DEX_PID = void 0;
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
// Serum DEX program id on devnet.
exports.DEX_PID = new web3_js_1.PublicKey('DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY');
// Swap program id on devnet.
exports.SWAP_PID = new web3_js_1.PublicKey('ziR2PGyshLYwLsGsH5hXH5rkZTf6GNJ6RzvX23v52iY');
// Return the program derived address used by the serum DEX to control token
// vaults.
async function getVaultOwnerAndNonce(marketPublicKey, dexProgramId = exports.DEX_PID) {
    const nonce = new bn_js_1.default(0);
    while (nonce.toNumber() < 255) {
        try {
            const vaultOwner = await web3_js_1.PublicKey.createProgramAddress([marketPublicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)], dexProgramId);
            return [vaultOwner, nonce];
        }
        catch (e) {
            nonce.iaddn(1);
        }
    }
    throw new Error('Unable to find nonce');
}
exports.getVaultOwnerAndNonce = getVaultOwnerAndNonce;
// Returns an associated token address for spl tokens.
async function getAssociatedTokenAddress(associatedProgramId, programId, mint, owner) {
    return (await web3_js_1.PublicKey.findProgramAddress([owner.toBuffer(), programId.toBuffer(), mint.toBuffer()], associatedProgramId))[0];
}
exports.getAssociatedTokenAddress = getAssociatedTokenAddress;
//# sourceMappingURL=utils.js.map