import BN from 'bn.js';
import {
  PublicKey,
  Transaction,
  TransactionSignature,
  SYSVAR_RENT_PUBKEY,
  Connection,
} from '@solana/web3.js';
import { Program, Provider } from '@project-serum/anchor';
import {
  Account,
  TransactionInstruction,
  ConfirmOptions,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as base64 from 'base64-js';
import { Market, OpenOrders } from '@project-serum/serum';
import { IDL } from './idl';
import {
  DEX_PID,
  SWAP_PID,
  getVaultOwnerAndNonce,
  getAssociatedTokenAddress,
} from './utils';

/**
 *
 * # Swap
 *
 * A module to swap tokens across USD(x) quoted markets on the Serum DEX,
 * providing a thin wrapper around an
 * [Anchor](https://github.com/project-serum/anchor) generated client in an
 * attempt to abstract away orderbook details.
 *
 * ## Usage
 *
 * ### Create a client
 *
 * ```javascript
 * const client = new Swap(provider, tokenList)
 * ```
 *
 * ### List all token mints to swap
 *
 * ```javascript
 * const tokens = client.tokens();
 * ```
 *
 * ### Get all candidate swap pairs for a given token mint
 *
 * ```javascript
 * const swappableTokens = client.pairs(usdcPublicKey);
 * ```
 *
 * ### Swap one token for another.
 *
 * ```javascript
 * await client.swap({
 *   fromMint,
 *   toMint,
 *   amount,
 * })
 * ```
 *
 * ## Swap Program Basics
 *
 * One should have a basic understanding of the on-chain
 * [Swap](https://github.com/project-serum/swap) program before using the
 * client. Two core APIs are exposed.
 *
 * * [swap](https://github.com/project-serum/swap/blob/master/programs/swap/src/lib.rs#L36) -
 *   swaps two tokens on a single A/B market. This is just an IOC trade at the
 *   BBO that instantly settles.
 * * [swapTransitive](https://github.com/project-serum/swap/blob/master/programs/swap/src/lib.rs#L107) -
 *   swaps two tokens across **two** A/x, B/x markets in the same manner as
 *   `swap`.
 *
 * When swapping to/from a USD(x) token, the swap client will use the `swap` API.
 * When swapping to/from a non-USD(x) token, e.g., wBTC for wETH, the swap
 * client will use the `swapTransitive`API with USD(x) quoted markets to bridge
 * the two tokens.
 *
 * For both APIs, if the number of tokens received from the trade is less than
 * the client provided `minExpectedAmount`, the transaction aborts.
 *
 * Note that if this client package is insufficient, one can always use the
 *  Anchor generated client directly, exposing an API mapping one-to-one to
 * these program instructions. See the
 * [`tests/`](https://github.com/project-serum/swap/blob/master/tests/swap.js)
 * for examples of using the Anchor generated swap client.
 *
 * ## Serum Orderbook Program Basics
 *
 * Additionally, because the Swap program is an on-chain frontend for the Serum
 * DEX, one should also be aware of the basic accounts needed for trading on
 * the Serum DEX.
 *
 * Namely, a wallet must have an "open orders" account for each market the
 * wallet trades on. The "open orders" account is akin to how a wallet
 *  must have an SPL token account to own tokens, except instead of holding
 * tokens, the wallet can make trades on the orderbook.
 *
 * ### Creating Open Orders Accounts
 *
 * When the wallet doesn't have an open orders account already created,
 * the swap client provides two choices.
 *
 * 1. Explicitly open (and close) the open
 *    orders account explicitly via the [[initAccounts]]
 *    (and [[closeAccounts]]) methods.
 * 2. Automatically create the required accounts by preloading the instructions
 *    in the [[swap]] transaction.
 *
 * Note that if the user is swapping between two non-USD(x) tokens, e.g., wBTC
 * for wETH, then the user needs *two* open orders accounts on both wBTC/USD(x)
 * and wETH/USD(x) markets. So if one chooses option two **and** needs to
 * create open orders accounts for both markets, then the transaction
 * is broken up into two (and `Provider.sendAll` is used) to prevent hitting
 * transaction size limits.
 */
export class Swap {
  /**
   * Anchor generated client for the swap program.
   */
  public program: Program;
  swapMarkets: any;

  /**
   * @param provider  The wallet and network context to use for the client.
   */
  constructor(provider: Provider) {
    this.program = new Program(IDL, SWAP_PID, provider);
  }

  /**
   * Executes a swap against the Serum DEX on Solana. When using one should
   * first use `estimate` along with a user defined error tolerance to calculate
   * the `minExpectedSwapAmount`, which provides a lower bound for the number
   * of output tokens received when executing the swap. If, for example,
   * swapping on an illiquid market and the output tokens is less than
   * `minExpectedSwapAmount`, then the transaction will fail in an attempt to
   * prevent an undesireable outcome.
   */
  public async swap(params: SwapParams): Promise<TransactionSignature> {
    const [ixs, signers] = await this.swapIxs(params);
    const tx = new Transaction();
    tx.add(...ixs);
    return this.program.provider.send(tx, signers, params.options);
  }

  /**
   * Returns an estimate for the number of *to*, i.e., output, tokens one would
   * get for the given swap parameters. This is useful to inform the user
   * approximately what will happen if the user executes the swap trade. UIs
   * should use this in conjunction with some bound (e.g. 5%), to prevent users
   * from making unexpected trades.
   */
  public async estimate(params: EstimateSwapParams): Promise<BN> {
    // Build the transaction.
    const [ixs, signers] = await this.swapIxs({
      ...params,
      minExpectedSwapAmount: new BN(1),
    });
    const tx = new Transaction();
    tx.add(...ixs);

    // Simulate it.
    const resp = await this.program.provider.simulate(
      tx,
      signers,
      params.options,
    );
    if (resp === undefined || resp.value.err || !resp.value.logs) {
      throw new Error('Unable to simulate swap');
    }

    // Decode the return value.
    //
    // TODO: Expose the event parsing api in anchor to make this less manual.
    let didSwapEvent = resp.value.logs
      .filter((log) => log.startsWith('Program log: 4ZfIrPLY4R'))
      .map((log) => {
        const logStr = log.slice('Program log: '.length);
        const logArr = Buffer.from(base64.toByteArray(logStr));
        return this.program.coder.events.decode('DidSwap', logArr.slice(8));
      })[0];
    return didSwapEvent.toAmount;
  }

  public async swapIxs(
    params: SwapParams,
  ): Promise<[TransactionInstruction[], Account[]]> {
    let {
      fromMint,
      toMint,
      quoteWallet,
      fromWallet,
      toWallet,
      amount,
      market,
      minExpectedSwapAmount,
      referral,
    } = params;

    // Defaults to .5% error off the estimate, if not provided.
    if (minExpectedSwapAmount === undefined) {
      const estimated = await this.estimate(params);
      minExpectedSwapAmount = estimated.mul(new BN(99.5)).div(new BN(100));
    }

    // If either wallet isn't given, then use the associated token account.
    // Assumes the accounts are already created.
    if (!fromWallet) {
      fromWallet = await getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        fromMint,
        this.program.provider.wallet.publicKey,
      );
    }
    if (!toWallet) {
      toWallet = await getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        toMint,
        this.program.provider.wallet.publicKey,
      );
    }

    // If swapping to/from a USD(x) token, then swap directly on the market.
      return await this.swapDirectIxs({
        coinWallet: toWallet,
        pcWallet: fromWallet,
        baseMint: toMint,
        quoteMint: fromMint,
        side: Side.Bid,
        amount,
        market,
        minExpectedSwapAmount,
        referral,
      });
  }

  private async swapDirectIxs({
    coinWallet,
    pcWallet,
    baseMint,
    quoteMint,
    side,
    amount,
    market,
    minExpectedSwapAmount,
    referral,
  }: {
    coinWallet: PublicKey;
    pcWallet: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    side: SideEnum;
    amount: BN;
    market: Market;
    minExpectedSwapAmount: BN;
    referral?: PublicKey;
  }): Promise<[TransactionInstruction[], Account[]]> {
    const marketClient = await Market.load( this.program.provider.connection, market.address, this.program.provider.opts, DEX_PID);
    const [vaultSigner] = await getVaultOwnerAndNonce(marketClient.address);
    let openOrders = await (async () => {
      let openOrders = await OpenOrders.findForMarketAndOwner(
        this.program.provider.connection,
        marketClient.address,
        this.program.provider.wallet.publicKey,
        DEX_PID,
      );
      // If we have an open orders account use it. It doesn't matter which
      // one we use.
      return openOrders[0] ? openOrders[0].address : undefined;
    })();

    const needsOpenOrders = openOrders === undefined;

    const ixs: TransactionInstruction[] = [];
    const signers: Account[] = [];

    // Create the open orders account, if needed.
    if (needsOpenOrders) {
      const oo = new Account();
      signers.push(oo);
      openOrders = oo.publicKey;
      ixs.push(
        await OpenOrders.makeCreateAccountTransaction(
          this.program.provider.connection,
          marketClient.address,
          this.program.provider.wallet.publicKey,
          oo.publicKey,
          DEX_PID,
        ),
      );
    }
    ixs.push(
      this.program.instruction.swap(side, amount, minExpectedSwapAmount, {
        accounts: {
          market: {
            market: marketClient.address,
            // @ts-ignore
            requestQueue: marketClient._decoded.requestQueue,
            // @ts-ignore
            eventQueue: marketClient._decoded.eventQueue,
            bids: marketClient.bidsAddress,
            asks: marketClient.asksAddress,
            // @ts-ignore
            coinVault: marketClient._decoded.baseVault,
            // @ts-ignore
            pcVault: marketClient._decoded.quoteVault,
            vaultSigner,
            openOrders,
            orderPayerTokenAccount: side.bid ? pcWallet : coinWallet,
            coinWallet: coinWallet,
          },
          pcWallet,
          authority: this.program.provider.wallet.publicKey,
          dexProgram: DEX_PID,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        },
        remainingAccounts: referral && [referral],
      }),
    );

    // TOOD: enable once the DEX supports closing open orders accounts.
    const _enabled = false;
    // If an account was opened for this swap, then close it in the same
    // transaction.
    if (_enabled && needsOpenOrders) {
      ixs.push(
        this.program.instruction.closeAccount({
          accounts: {
            openOrders,
            authority: this.program.provider.wallet.publicKey,
            destination: this.program.provider.wallet.publicKey,
            market: marketClient.address,
            dexProgram: DEX_PID,
          },
        }),
      );
    }

    return [ixs, signers];
  }
  address(connection: Connection, address: any, opts: ConfirmOptions, DEX_PID: PublicKey) {
    throw new Error('Method not implemented.');
  }
}

/**
 * Parameters to initailize swap accounts.
 */
export type InitSwapAccountParams = {
  /**
   * The token to swap from.
   */
  fromMint: PublicKey;
  /**
   * The token tos wap to.
   */
  toMint: PublicKey;
};

/**
 * Parameters to close swap accounts.
 */
export type CloseSwapAccountParams = {
  /**
   * The token to swap from.
   */
  fromMint: PublicKey;
  /**
   * The token tos wap to.
   */
  toMint: PublicKey;
};

/**
 * Parameters to perform a swap.
 */
export type SwapParams = {
  /**
   * Token mint to swap from.
   */
  fromMint: PublicKey;

  /**
   * Token mint to swap to.
   */
  toMint: PublicKey;

  /**
   * Amount of `fromMint` to swap in exchange for `toMint`.
   */
  amount: BN;



  market: Market;


  /**
   * The minimum number of `toMint` tokens one should receive for the swap. This
   * is a safety mechanism to prevent one from performing an unexpecteed trade.
   *
   * If not given, then defaults to 0.05% off the **estimated** amount.
   */
  minExpectedSwapAmount?: BN;

  /**
   * Token account to receive the Serum referral fee. The mint must be in the
   * quote currency of the trade.
   */
  referral?: PublicKey;

  /**
   * Wallet of the quote currency to use in a transitive swap. Should be either
   * a USDC or USDT wallet. If not provided uses an associated token address
   * for the configured provider.
   */
  quoteWallet?: PublicKey;

  /**
   * Wallet for `fromMint`. If not provided, uses an associated token address
   * for the configured provider.
   */
  fromWallet?: PublicKey;

  /**
   * Wallet for `toMint`. If not provided, uses the associated token address
   * for the configured provider.
   */
  toWallet?: PublicKey;


  /**
   * RPC options. If not given the options on the program's provider are used.
   */
  options?: ConfirmOptions;
};

export type EstimateSwapParams = SwapParams;

// Side rust enum used for the program's RPC API.
type SideEnum = any;
const Side = {
  Bid: { bid: {} },
  Ask: { ask: {} },
};
