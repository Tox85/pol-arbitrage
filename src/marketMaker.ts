// src/marketMaker.ts
import { PolyClobClient } from "./clients/polySDK";
import { SignatureType } from "@polymarket/order-utils";
import { MarketFeed } from "./ws/marketFeed";
import { UserFeed, FillEvent } from "./ws/userFeed";
import { PnLTracker } from "./metrics/pnl";
import { 
  USDC_ADDRESS, 
  EXCHANGE_ADDRESS, 
  POLY_PROXY_ADDRESS, 
  RPC_URL,
  MIN_SIZE_SHARES,
  MIN_NOTIONAL_USDC,
  MIN_SPREAD_MULTIPLIER,
  MAX_SPREAD_MULTIPLIER,
  PARITY_THRESHOLD,
  MAX_INVENTORY_YES,
  MAX_INVENTORY_NO,
  INVENTORY_PERSISTENCE_FILE,
  AUTO_ADJUST_NOTIONAL,
  METRICS_LOG_INTERVAL_MS,
  MAX_NOTIONAL_AT_RISK_USDC,
  RECONCILE_INTERVAL_MS,
  INVENTORY_SKEW_LAMBDA,
  ORDER_TTL_MS,
  PRICE_CHANGE_THRESHOLD,
  PROXY_ADDRESS,
  NOTIONAL_PER_ORDER_USDC,
  MAX_SELL_PER_ORDER_SHARES,
  MIN_NOTIONAL_SELL_USDC
} from "./config";
import { rootLog } from "./index";
import { buildAmounts } from "./lib/amounts";
import { calculateSafeSize, calculateSellSize } from "./risk/sizing";
// enforceMinSize - UNUSED (removed)
import { calculateSellSizeShares } from "./lib/round";
// roundPrice, roundSize - UNUSED (removed, using amounts.ts directly)
import { checkBuySolvency, checkSellSolvency } from "./risk/solvency";
import { ensurePostOnly, validateQuotePrices, checkParity } from "./lib/quote-guard";
// readErc20BalanceAllowance - UNUSED (removed, handled in solvency functions)
import { InventoryManager } from "./inventory";
import { AllowanceManager } from "./allowanceManager";
import { OrderCloser } from "./closeOrders";
import { JsonRpcProvider } from "ethers";

// Types locaux pour éviter l'import du SDK officiel
type OrderType = "GTC" | "IOC" | "FOK";
type Side = "BUY" | "SELL";

const log = rootLog.child({ name: "mm" });

// Helper pour convertir en unités Polymarket (6 décimales)
const toUnits = (x: number) => BigInt(Math.round(x * 1e6));

/**
 * Construit un ordre Polymarket avec les bons montants quantifiés.
 * Pour BUY: maker paie USDC, taker livre CTF (shares)
 * Pour SELL: maker livre CTF, taker paie USDC
 * 
 * IMPORTANT: Les montants sont quantifiés AVANT la signature pour garantir la cohérence
 */
function buildOrder(
  side: "BUY" | "SELL",
  tokenId: string,
  price: number, // ex: 0.047
  size: number,  // ex: 21.277 shares
  maker: string, // proxy/funder
  signer: string // EOA
) {
  // Utiliser la nouvelle logique de quantisation correcte
  const { makerAmount, takerAmount, size2, notional5 } = buildAmounts(side, price, size);

  // Générer un salt unique basé sur le timestamp + random pour éviter les collisions
  const uniqueSalt = Date.now() * 1000 + Math.floor(Math.random() * 1000);

  return {
    // champs du PostOrder → cf. docs "Place Single Order"
    salt: uniqueSalt, // Salt unique pour chaque ordre
    maker,                 // proxy/funder
    signer,                // EOA
    taker: "0x0000000000000000000000000000000000000000", // open order
    tokenId,               // ERC1155 id de l'outcome
    makerAmount: makerAmount.toString(),    // Micro-unités (BigInt → string)
    takerAmount: takerAmount.toString(),    // Micro-unités (BigInt → string)
    side,  // STRING "BUY" ou "SELL" pour l'API (pas number !)
    expiration: "0", // GTC order (Good Till Cancel)
    nonce: "0",      // Nonce par défaut
    feeRateBps: "0",
    signatureType: SignatureType.EOA, // 0 = EOA (même avec proxy Polymarket !)
  };
}

export type MarketMakerConfig = {
  targetSpreadCents: number;
  tickImprovement: number;
  notionalPerOrderUsdc: number;
  maxActiveOrders: number;
  replaceCooldownMs: number;
  dryRun: boolean;
  maxInventory: number;
  allowanceThresholdUsdc: number;
  minSizeShares: number;
  minNotionalUsdc: number;
  minSpreadMultiplier: number;
  maxSpreadMultiplier: number;
  autoAdjustNotional: boolean;
  priceChangeThreshold: number;
  maxDistanceFromMid: number;
};

export type MarketInfo = {
  conditionId: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  volume24hrClob?: number | null;
};

export class MarketMaker {
  private config: MarketMakerConfig;
  private clob: PolyClobClient;
  private feed = new MarketFeed();
  private userFeed!: UserFeed; // Initialisé dans start()
  private pnl = new PnLTracker();
  private activeOrders = new Map<string, { 
    bidId?: string; 
    askId?: string; 
    bidPrice?: number; 
    askPrice?: number; 
    bidSize?: number;
    askSize?: number;
    lastMid?: number;
    lastPlaceTime?: number;
  }>();
  private lastReplaceTime = 0;
  private marketInfo: MarketInfo | null = null;
  private lastPlaceTime = 0; // Anti-spam pour les logs
  private provider: JsonRpcProvider;
  private inventory: InventoryManager;
  private allowanceManager: AllowanceManager;
  private orderCloser: OrderCloser;
  private metricsInterval?: NodeJS.Timeout;
  private reconcileInterval?: NodeJS.Timeout;
  private inventorySyncInterval?: NodeJS.Timeout;
  private marketHealthCheckInterval?: NodeJS.Timeout;

  constructor(config: MarketMakerConfig) {
    this.config = config;
    // Utiliser le SDK officiel Polymarket qui gère correctement les proxies
    // Le SDK sait comment signer avec l'EOA pour un proxy Polymarket
    this.clob = new PolyClobClient(
      process.env.PRIVATE_KEY!,
      process.env.CLOB_API_KEY!,
      process.env.CLOB_API_SECRET!,
      process.env.CLOB_PASSPHRASE!,
      "https://clob.polymarket.com",
      process.env.POLY_PROXY_ADDRESS // Utiliser le proxy pour les fonds
    );
    
    // Provider pour les vérifications on-chain
    this.provider = new JsonRpcProvider(RPC_URL);
    
    // Initialiser les nouveaux modules
    this.inventory = new InventoryManager(this.provider, config.maxInventory);
    this.allowanceManager = new AllowanceManager(
      this.clob, 
      this.provider, 
      config.allowanceThresholdUsdc
    );
    this.orderCloser = new OrderCloser(this.clob, this.inventory, this.provider);
  }

  async start(market: MarketInfo) {
    this.marketInfo = market;
    log.info({ market: market.slug }, "🚀 Starting market making");

    // Initialiser UserFeed (fills en temps réel)
    this.userFeed = new UserFeed(
      process.env.CLOB_API_KEY!,
      process.env.CLOB_API_SECRET!,
      process.env.CLOB_PASSPHRASE!,
      this.clob.getAddress() // Signing key = EOA
    );
    
    // CRITIQUE : Configurer les markets AVANT de connecter
    // Le UserFeed enverra ces condition IDs dans le message d'auth
    this.userFeed.setMarkets([market.conditionId]);
    
    // Connecter au WebSocket utilisateur
    this.userFeed.connect();
    
    // Handler pour les fills (MET À JOUR L'INVENTAIRE ICI)
    this.userFeed.onFill((fill: FillEvent) => {
      this.handleFill(fill);
    });
    
    // Handler pour les changements de statut d'ordres
    this.userFeed.onOrder((order) => {
      log.debug({ 
        orderId: order.orderId.substring(0, 16) + '...',
        status: order.status 
      }, `Order status: ${order.status}`);
    });

    // CRITIQUE : Initialiser le solde USDC AVANT toute opération
    log.info("💰 Initializing USDC balance and allowance...");
    await this.allowanceManager.forceUsdcCheck();
    const usdcStatus = this.allowanceManager.getSummary();
    log.info({
      balanceUsdc: usdcStatus.usdcBalance,
      allowanceUsdc: usdcStatus.usdcAllowance,
      threshold: usdcStatus.threshold
    }, "✅ USDC balance initialized");

    // Synchroniser l'inventaire avec les positions réelles on-chain
    log.info("📦 Synchronizing inventory from blockchain...");
    const proxyAddress = POLY_PROXY_ADDRESS;
    await this.inventory.syncFromOnChainReal(market.yesTokenId, proxyAddress);
    await this.inventory.syncFromOnChainReal(market.noTokenId, proxyAddress);
    await this.inventory.saveToFile(INVENTORY_PERSISTENCE_FILE);
    
    log.info({ 
      yesShares: this.inventory.getInventory(market.yesTokenId),
      noShares: this.inventory.getInventory(market.noTokenId)
    }, "✅ Inventory synced");

    // NOUVEAU : Récupérer tick_size et min_order_size depuis CLOB pour chaque token
    const tickYes = await this.clob.getTickSizeForToken(market.yesTokenId);
    const tickNo = await this.clob.getTickSizeForToken(market.noTokenId);
    const minSizeYes = await this.clob.getMinOrderSizeForToken(market.yesTokenId);
    const minSizeNo = await this.clob.getMinOrderSizeForToken(market.noTokenId);
    
    // Initialiser le cache du feed
    this.feed.setTickSize(market.yesTokenId, tickYes);
    this.feed.setTickSize(market.noTokenId, tickNo);
    this.feed.setMinOrderSize(market.yesTokenId, minSizeYes);
    this.feed.setMinOrderSize(market.noTokenId, minSizeNo);
    
    log.info({
      yesToken: { tick: tickYes, minSize: minSizeYes },
      noToken: { tick: tickNo, minSize: minSizeNo }
    }, "📐 Market constraints loaded");

    await this.loadExistingOrders();

    this.feed.subscribe([market.yesTokenId, market.noTokenId], (tokenId, bestBid, bestAsk, tickSize) => {
      this.handlePriceUpdate(tokenId, bestBid, bestAsk, tickSize);
    });

    await this.initializeMarketMaking();
  }

  /**
   * Charge les ordres ouverts existants au démarrage
   * CRITIQUE : Permet de reprendre le tracking si le bot redémarre
   */
  private async loadExistingOrders() {
    if (!this.marketInfo) return;
    
    try {
      const openOrders = await this.orderCloser.getOpenOrders();
      
      if (!openOrders || openOrders.length === 0) {
        log.info("📋 No existing open orders found");
        return;
      }
      
      // Filtrer les ordres de ce marché
      const relevantOrders = openOrders.filter((order: any) => 
        order.asset_id === this.marketInfo!.yesTokenId || 
        order.asset_id === this.marketInfo!.noTokenId
      );
      
      if (relevantOrders.length === 0) {
        log.info("📋 No existing orders for this market");
        return;
      }
      
      log.info({
        total: openOrders.length,
        thisMarket: relevantOrders.length
      }, "📋 Found existing open orders");
      
      // Grouper par tokenId
      const ordersByToken = new Map<string, { bids: any[], asks: any[] }>();
      
      for (const order of relevantOrders) {
        const tokenId = order.asset_id;
        if (!ordersByToken.has(tokenId)) {
          ordersByToken.set(tokenId, { bids: [], asks: [] });
        }
        
        const entry = ordersByToken.get(tokenId)!;
        if (order.side === "BUY") {
          entry.bids.push(order);
        } else {
          entry.asks.push(order);
        }
      }
      
      // Ajouter les ordres à notre tracking
      for (const [tokenId, orders] of ordersByToken.entries()) {
        const tokenSide = tokenId === this.marketInfo.yesTokenId ? 'YES' : 'NO';
        
        // Prendre le premier (le plus récent) de chaque côté
        if (orders.bids.length > 0) {
          const bid = orders.bids[0];
          log.info({
            tokenId: tokenId.substring(0, 20) + '...',
            tokenSide,
            orderId: bid.id,
            side: "BUY",
            price: bid.price,
            size: bid.original_size
          }, "📋 Tracking existing BID order");
          
          const existing = this.activeOrders.get(tokenId) || {};
          this.activeOrders.set(tokenId, {
            ...existing,
            bidId: bid.id,
            bidPrice: parseFloat(bid.price),
            bidSize: parseFloat(bid.original_size),
            lastPlaceTime: Date.now()
          });
        }
        
        if (orders.asks.length > 0) {
          const ask = orders.asks[0];
          log.info({
            tokenId: tokenId.substring(0, 20) + '...',
            tokenSide,
            orderId: ask.id,
            side: "SELL",
            price: ask.price,
            size: ask.original_size
          }, "📋 Tracking existing ASK order");
          
          const existing = this.activeOrders.get(tokenId) || {};
          this.activeOrders.set(tokenId, {
            ...existing,
            askId: ask.id,
            askPrice: parseFloat(ask.price),
            askSize: parseFloat(ask.original_size),
            lastPlaceTime: Date.now()
          });
        }
      }
      
      log.info({
        trackedTokens: this.activeOrders.size,
        totalOrders: relevantOrders.length
      }, "✅ Existing orders loaded into tracking");
      
    } catch (error) {
      log.error({ error }, "❌ Failed to load existing orders");
    }
  }

  private async initializeMarketMaking() {
    if (!this.marketInfo) return;

    try {
      // ATTENDRE que le WebSocket fournisse les vrais prix (pas les données REST corrompues)
      log.info("⏳ Waiting for WebSocket to provide real market prices...");
      
      // Récupérer les prix depuis le WebSocket (source de vérité)
      let wsPricesYes = await this.getWebSocketPrices(this.marketInfo.yesTokenId);
      let wsPricesNo = await this.getWebSocketPrices(this.marketInfo.noTokenId);
      
      // FALLBACK: Si WebSocket timeout, utiliser REST API en dernier recours
      if (!wsPricesYes || !wsPricesNo) {
        log.warn("⚠️ WebSocket timeout, trying REST API as fallback...");
        const { snapshotTop } = await import("./data/book");
        
        if (!wsPricesYes) {
          const snapYesRest = await snapshotTop(this.marketInfo.yesTokenId);
          if (snapYesRest.bestBid && snapYesRest.bestAsk && 
              snapYesRest.bestBid > 0.001 && snapYesRest.bestAsk < 0.999 &&
              snapYesRest.bestBid < snapYesRest.bestAsk) {
            wsPricesYes = { bestBid: snapYesRest.bestBid, bestAsk: snapYesRest.bestAsk };
            log.info({ bestBid: snapYesRest.bestBid, bestAsk: snapYesRest.bestAsk }, "✅ YES prices from REST API");
          }
        }
        
        if (!wsPricesNo) {
          const snapNoRest = await snapshotTop(this.marketInfo.noTokenId);
          if (snapNoRest.bestBid && snapNoRest.bestAsk && 
              snapNoRest.bestBid > 0.001 && snapNoRest.bestAsk < 0.999 &&
              snapNoRest.bestBid < snapNoRest.bestAsk) {
            wsPricesNo = { bestBid: snapNoRest.bestBid, bestAsk: snapNoRest.bestAsk };
            log.info({ bestBid: snapNoRest.bestBid, bestAsk: snapNoRest.bestAsk }, "✅ NO prices from REST API");
          }
        }
      }
      
      if (!wsPricesYes || !wsPricesNo) {
        log.error({ 
          market: this.marketInfo.slug,
          yesToken: this.marketInfo.yesTokenId.substring(0, 20) + '...',
          noToken: this.marketInfo.noTokenId.substring(0, 20) + '...'
        }, "❌ Failed to get real prices from both WebSocket AND REST API - Ce marché est probablement fermé ou inactif");
        
        // Arrêter proprement ce market maker
        await this.stop();
        return;
      }
      
      const snapYes = {
        bestBid: wsPricesYes.bestBid,
        bestAsk: wsPricesYes.bestAsk,
        tickSize: 0.001, // Tick standard Polymarket
        negRisk: false
      };
      
      const snapNo = {
        bestBid: wsPricesNo.bestBid,
        bestAsk: wsPricesNo.bestAsk,
        tickSize: 0.001,
        negRisk: false
      };

      // Calculer la parité YES + NO
      const yesMid = ((snapYes.bestBid || 0) + (snapYes.bestAsk || 1)) / 2;
      const noMid = ((snapNo.bestBid || 0) + (snapNo.bestAsk || 1)) / 2;
      const parity = yesMid + noMid;
      const parityDeviation = Math.abs(parity - 1.0);

      log.info({
        market: this.marketInfo.slug,
        snapYes: { bestBid: snapYes.bestBid, bestAsk: snapYes.bestAsk, tickSize: snapYes.tickSize, mid: yesMid },
        snapNo: { bestBid: snapNo.bestBid, bestAsk: snapNo.bestAsk, tickSize: snapNo.tickSize, mid: noMid },
        parity: parity.toFixed(4),
        parityDeviation: parityDeviation.toFixed(4)
      }, "📊 Initial market snapshot with parity analysis");

      // Stratégie de parité : arbitrer si l'écart est significatif
      if (parityDeviation > PARITY_THRESHOLD) {
        log.info({
          parity,
          deviation: parityDeviation,
          threshold: PARITY_THRESHOLD
        }, "⚖️ Significant parity deviation detected, applying arbitrage strategy");
        
        // Si YES + NO > 1.01, privilégier SELL (les prix sont trop élevés)
        // Si YES + NO < 0.99, privilégier BUY (les prix sont trop bas)
        if (parity > 1.0 + PARITY_THRESHOLD) {
          log.info("📈 Parity > 1.01: Market overpriced, focusing on SELL orders");
        } else if (parity < 1.0 - PARITY_THRESHOLD) {
          log.info("📉 Parity < 0.99: Market underpriced, focusing on BUY orders");
        }
      }

      // Démarrer le market making sur les tokens Yes et No avec stratégie de parité
      await this.startMarketMaking(this.marketInfo.yesTokenId, snapYes, 'YES', snapNo);
      await this.startMarketMaking(this.marketInfo.noTokenId, snapNo, 'NO', snapYes);
      
      // Démarrer les timers de métriques et réconciliation
      this.startPeriodicTasks();
    } catch (error) {
      log.error({ error, market: this.marketInfo.slug }, "❌ Failed to initialize market making");
    }
  }

  /**
   * Démarrer les tâches périodiques (métriques, réconciliation, resync inventaire, health check)
   */
  private startPeriodicTasks() {
    // Logs de métriques toutes les 60s
    this.metricsInterval = setInterval(() => {
      this.pnl.logMetrics();
      this.logCapitalAtRisk();
    }, METRICS_LOG_INTERVAL_MS);
    
    // Réconciliation toutes les 60s
    this.reconcileInterval = setInterval(() => {
      this.reconcileOrders();
    }, RECONCILE_INTERVAL_MS);
    
    // Resync inventaire toutes les 120s (fallback si UserFeed rate des fills)
    this.inventorySyncInterval = setInterval(() => {
      this.resyncInventoryFromBlockchain();
    }, 120_000); // 2 minutes
    
    // Vérification de santé du marché toutes les 3 minutes
    this.marketHealthCheckInterval = setInterval(() => {
      this.checkMarketHealth();
    }, 180_000); // 3 minutes
    
    log.info({ 
      metricsInterval: METRICS_LOG_INTERVAL_MS, 
      reconcileInterval: RECONCILE_INTERVAL_MS,
      inventorySyncInterval: 120_000,
      marketHealthCheckInterval: 180_000
    }, "⏱️ Periodic tasks started");
  }

  /**
   * Vérifie la santé du marché et arrête le trading si le marché devient inactif
   */
  private async checkMarketHealth() {
    if (!this.marketInfo) return;
    
    const tokens = [this.marketInfo.yesTokenId, this.marketInfo.noTokenId];
    let inactiveCount = 0;
    
    for (const tokenId of tokens) {
      const isActive = this.feed.isMarketActive(tokenId, 5 * 60 * 1000); // 5 minutes
      if (!isActive) {
        inactiveCount++;
        log.warn({
          market: this.marketInfo.slug,
          tokenId: tokenId.substring(0, 20) + '...',
          lastUpdate: 'more than 5 minutes ago'
        }, "⚠️ Token inactif détecté");
      }
    }
    
    // Si les 2 tokens sont inactifs, arrêter le market making
    if (inactiveCount === tokens.length) {
      log.error({
        market: this.marketInfo.slug,
        reason: 'Aucune mise à jour de prix depuis plus de 5 minutes'
      }, "❌ Marché devenu inactif - Arrêt du market making");
      
      await this.stop();
    }
  }

  /**
   * Handler pour les fills (appelé depuis UserFeed)
   * C'EST ICI qu'on met à jour l'inventaire réel
   */
  private handleFill(fill: FillEvent) {
    const tokenId = fill.asset;
    const price = parseFloat(fill.price);
    const size = parseFloat(fill.size);
    const fee = parseFloat(fill.fee || "0");
    
    // Mettre à jour l'inventaire RÉEL
    if (fill.side === "BUY") {
      this.inventory.addBuy(tokenId, size);
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        side: "BUY",
        price: price.toFixed(4),
        size: size.toFixed(2),
        newInventory: this.inventory.getInventory(tokenId).toFixed(2)
      }, "📦 Inventory updated (BUY fill)");
    } else {
      this.inventory.addSell(tokenId, size);
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        side: "SELL",
        price: price.toFixed(4),
        size: size.toFixed(2),
        newInventory: this.inventory.getInventory(tokenId).toFixed(2)
      }, "📦 Inventory updated (SELL fill)");
    }
    
    // Sauvegarder l'inventaire
    this.inventory.saveToFile(INVENTORY_PERSISTENCE_FILE);
    
    // Enregistrer le trade dans le PnL
    this.pnl.recordTrade({
      timestamp: fill.timestamp || Date.now(),
      tokenId,
      side: fill.side,
      price,
      size,
      fee,
      orderId: fill.orderId,
      marketSlug: this.marketInfo?.slug
    });
    
    // Forcer refresh de l'allowance USDC (le solde a changé)
    this.allowanceManager.forceUsdcCheck();
    
    // RÉACTIVITÉ POST-FILL : Tenter la jambe opposée
    this.tryQuoteOppositeSide(tokenId, fill.side);
  }
  
  /**
   * Tente de placer la jambe opposée après un fill
   */
  private async tryQuoteOppositeSide(tokenId: string, filledSide: "BUY" | "SELL") {
    if (!this.marketInfo) return;
    
    try {
      // Obtenir les prix actuels depuis le cache
      const lastPrices = this.feed.getLastPrices(tokenId);
      if (!lastPrices) return;
      
      const { bestBid, bestAsk } = lastPrices;
      
      // Vérifier que les prix sont valides
      if (bestBid === null || bestAsk === null) {
        log.warn({ tokenId: tokenId.substring(0, 20) + '...' }, "⚠️ Invalid prices for opposite leg");
        return;
      }
      
      const tokenSide = tokenId === this.marketInfo.yesTokenId ? 'YES' : 'NO';
      
      // Si on vient de BUY, tenter SELL
      if (filledSide === "BUY") {
        const currentInventory = this.inventory.getInventory(tokenId);
        if (currentInventory > 0) {
          const sellSize = calculateSellSizeShares(currentInventory, bestAsk, MAX_SELL_PER_ORDER_SHARES, 5, MIN_NOTIONAL_SELL_USDC);
          if (sellSize && sellSize >= 5) {
            log.info({
              tokenId: tokenId.substring(0, 20) + '...',
              side: "SELL",
              price: bestAsk.toFixed(4),
              size: sellSize.toFixed(2),
              reason: "Post-fill opposite leg"
            }, "🎯 Attempting opposite leg SELL");
            
            // Placer l'ordre SELL (join-only)
            await this.placeOrders(tokenId, { bestBid, bestAsk, tickSize: 0.001 }, tokenSide);
          }
        }
      }
      // Si on vient de SELL, tenter BUY
      else if (filledSide === "SELL") {
        // Calculer le notional requis
        const requiredUsdcMicro = BigInt(Math.floor(NOTIONAL_PER_ORDER_USDC * 1e6));
        
        const canBuy = await checkBuySolvency(
          requiredUsdcMicro,
          USDC_ADDRESS,
          PROXY_ADDRESS,
          EXCHANGE_ADDRESS,
          this.provider
        );
        
        if (canBuy) {
          const buySize = await this.calculateOrderSize(tokenId, bestBid);
          
          // Vérifier dynamiquement le minOrderSize
          let minSize = this.feed.getMinOrderSize(tokenId);
          if (!minSize) minSize = 5; // Fallback
          
          if (buySize && buySize >= minSize) {
            log.info({
              tokenId: tokenId.substring(0, 20) + '...',
              side: "BUY",
              price: bestBid.toFixed(4),
              size: buySize.toFixed(2),
              reason: "Post-fill opposite leg"
            }, "🎯 Attempting opposite leg BUY");
            
            // Placer l'ordre BUY (join-only)
            await this.placeOrders(tokenId, { bestBid, bestAsk, tickSize: 0.001 }, tokenSide);
          }
        }
      }
    } catch (error) {
      log.error({ error, tokenId: tokenId.substring(0, 20) + '...' }, "❌ Error in tryQuoteOppositeSide");
    }
  }

  /**
   * Calcule le notional total à risque (ordres ouverts)
   */
  private getNotionalAtRisk(): number {
    let totalNotionalAtRisk = 0;
    
    for (const [tokenId, orders] of this.activeOrders) {
      if (orders.bidPrice && orders.bidSize) {
        totalNotionalAtRisk += orders.bidPrice * orders.bidSize;
      }
      if (orders.askPrice && orders.askSize) {
        totalNotionalAtRisk += orders.askPrice * orders.askSize;
      }
    }
    
    return totalNotionalAtRisk;
  }

  /**
   * Log le capital actuellement à risque
   */
  private logCapitalAtRisk() {
    const totalNotionalAtRisk = this.getNotionalAtRisk();
    const usdcSummary = this.allowanceManager.getSummary();
    
    log.info({
      notionalAtRisk: totalNotionalAtRisk.toFixed(2),
      maxAllowed: MAX_NOTIONAL_AT_RISK_USDC,
      percentUsed: ((totalNotionalAtRisk / MAX_NOTIONAL_AT_RISK_USDC) * 100).toFixed(1) + '%',
      usdcBalance: usdcSummary.usdcBalance,
      activeOrders: this.activeOrders.size
    }, "💼 Capital at risk");
  }

  /**
   * Réconciliation périodique : vérifie que activeOrders correspond à la réalité
   * CRITIQUE : Interroge l'API REST pour obtenir les VRAIS ordres ouverts
   * et corrige activeOrders si divergence (ordres annulés, remplis, ou placés manuellement)
   */
  private async reconcileOrders() {
    if (!this.marketInfo) return;
    
    try {
      log.debug("🔄 Starting orders reconciliation...");
      
      // Récupérer les ordres ouverts depuis l'API REST (source de vérité)
      const openOrders = await this.orderCloser.getOpenOrders();
      
      if (!openOrders || openOrders.length === 0) {
        log.debug("🔄 No open orders from API, clearing local cache");
        
        // Si l'API dit qu'il n'y a aucun ordre ouvert, nettoyer le cache local
        if (this.activeOrders.size > 0) {
          log.warn({
            localOrders: this.activeOrders.size,
            apiOrders: 0
          }, "⚠️ Divergence detected: local cache has orders but API has none - clearing cache");
          this.activeOrders.clear();
        }
        return;
      }
      
      // Filtrer les ordres de ce marché seulement
      const relevantOrders = openOrders.filter((order: any) => 
        order.asset_id === this.marketInfo!.yesTokenId || 
        order.asset_id === this.marketInfo!.noTokenId
      );
      
      // Créer une map des ordres réels par tokenId
      const realOrdersByToken = new Map<string, { bids: any[], asks: any[] }>();
      
      for (const order of relevantOrders) {
        const tokenId = order.asset_id;
        if (!realOrdersByToken.has(tokenId)) {
          realOrdersByToken.set(tokenId, { bids: [], asks: [] });
        }
        
        const entry = realOrdersByToken.get(tokenId)!;
        if (order.side === "BUY") {
          entry.bids.push(order);
        } else {
          entry.asks.push(order);
        }
      }
      
      // Comparer avec notre cache local et corriger les divergences
      const tokensToCheck = [this.marketInfo.yesTokenId, this.marketInfo.noTokenId];
      
      for (const tokenId of tokensToCheck) {
        const localOrders = this.activeOrders.get(tokenId);
        const realOrders = realOrdersByToken.get(tokenId) || { bids: [], asks: [] };
        
        // Vérifier BID
        if (localOrders?.bidId) {
          const realBid = realOrders.bids.find((o: any) => o.id === localOrders.bidId);
          if (!realBid) {
            log.warn({
              tokenId: tokenId.substring(0, 20) + '...',
              orderId: localOrders.bidId,
              reason: "Order not found in API (filled or cancelled)"
            }, "🔄 Removing stale BID from cache");
            
            // Nettoyer l'ordre du cache
            const updated = { ...localOrders };
            delete updated.bidId;
            delete updated.bidPrice;
            delete updated.bidSize;
            this.activeOrders.set(tokenId, updated);
          }
        }
        
        // Vérifier ASK
        if (localOrders?.askId) {
          const realAsk = realOrders.asks.find((o: any) => o.id === localOrders.askId);
          if (!realAsk) {
            log.warn({
              tokenId: tokenId.substring(0, 20) + '...',
              orderId: localOrders.askId,
              reason: "Order not found in API (filled or cancelled)"
            }, "🔄 Removing stale ASK from cache");
            
            // Nettoyer l'ordre du cache
            const updated = { ...localOrders };
            delete updated.askId;
            delete updated.askPrice;
            delete updated.askSize;
            this.activeOrders.set(tokenId, updated);
          }
        }
        
        // Détecter les ordres qui existent dans l'API mais pas dans notre cache
        // (ordres placés manuellement ou avant le démarrage)
        if (realOrders.bids.length > 0 && !localOrders?.bidId) {
          const newestBid = realOrders.bids[0]; // Prendre le plus récent
          log.info({
            tokenId: tokenId.substring(0, 20) + '...',
            orderId: newestBid.id,
            price: newestBid.price,
            size: newestBid.original_size
          }, "🔄 Found existing BID order not in cache - adding to tracking");
          
          // Ajouter à notre cache
          const existing = this.activeOrders.get(tokenId) || {};
          this.activeOrders.set(tokenId, {
            ...existing,
            bidId: newestBid.id,
            bidPrice: parseFloat(newestBid.price),
            bidSize: parseFloat(newestBid.original_size),
            lastPlaceTime: Date.now()
          });
        }
        
        if (realOrders.asks.length > 0 && !localOrders?.askId) {
          const newestAsk = realOrders.asks[0]; // Prendre le plus récent
          log.info({
            tokenId: tokenId.substring(0, 20) + '...',
            orderId: newestAsk.id,
            price: newestAsk.price,
            size: newestAsk.original_size
          }, "🔄 Found existing ASK order not in cache - adding to tracking");
          
          // Ajouter à notre cache
          const existing = this.activeOrders.get(tokenId) || {};
          this.activeOrders.set(tokenId, {
            ...existing,
            askId: newestAsk.id,
            askPrice: parseFloat(newestAsk.price),
            askSize: parseFloat(newestAsk.original_size),
            lastPlaceTime: Date.now()
          });
        }
      }
      
      log.debug({
        totalOpenOrders: openOrders.length,
        relevantOrders: relevantOrders.length,
        trackedTokens: this.activeOrders.size
      }, "✅ Orders reconciliation completed");
      
    } catch (error) {
      log.error({ error }, "❌ Failed to reconcile orders");
    }
  }

  /**
   * Resync inventaire depuis la blockchain (fallback si UserFeed rate des fills)
   * CRITIQUE : Compare avec l'inventaire local et log les divergences
   */
  private async resyncInventoryFromBlockchain() {
    if (!this.marketInfo) return;
    
    try {
      log.info("🔄 Resyncing inventory from blockchain...");
      
      const tokenIds = [
        this.marketInfo.yesTokenId,
        this.marketInfo.noTokenId
      ];
      
      // Sauvegarder les anciennes valeurs pour comparaison
      const oldInventory = new Map<string, number>();
      for (const tokenId of tokenIds) {
        oldInventory.set(tokenId, this.inventory.getInventory(tokenId));
      }
      
      // Synchroniser depuis la blockchain (source de vérité)
      for (const tokenId of tokenIds) {
        await this.inventory.syncFromOnChainReal(tokenId, POLY_PROXY_ADDRESS);
      }
      
      // Comparer et logger les divergences
      let hasDivergence = false;
      for (const tokenId of tokenIds) {
        const oldValue = oldInventory.get(tokenId) || 0;
        const newValue = this.inventory.getInventory(tokenId);
        const difference = newValue - oldValue;
        
        if (Math.abs(difference) > 0.01) { // Seuil de 0.01 share
          hasDivergence = true;
          const tokenSide = tokenId === this.marketInfo.yesTokenId ? 'YES' : 'NO';
          
          log.warn({
            tokenId: tokenId.substring(0, 20) + '...',
            tokenSide,
            oldShares: oldValue.toFixed(2),
            newShares: newValue.toFixed(2),
            difference: difference.toFixed(2),
            reason: "Divergence between local cache and blockchain"
          }, "⚠️ Inventory divergence detected - corrected from blockchain");
        }
      }
      
      if (!hasDivergence) {
        log.info({
          yesShares: this.inventory.getInventory(this.marketInfo.yesTokenId).toFixed(2),
          noShares: this.inventory.getInventory(this.marketInfo.noTokenId).toFixed(2)
        }, "✅ Inventory in sync with blockchain");
      }
      
      // Sauvegarder l'inventaire corrigé
      await this.inventory.saveToFile(INVENTORY_PERSISTENCE_FILE);
      
      log.info({
        yesShares: this.inventory.getInventory(this.marketInfo.yesTokenId).toFixed(2),
        noShares: this.inventory.getInventory(this.marketInfo.noTokenId).toFixed(2)
      }, "✅ Inventory resync completed from blockchain");
    } catch (error) {
      log.error({ error }, "❌ Failed to resync inventory from blockchain");
    }
  }

  private async startMarketMaking(tokenId: string, snapshot: any, tokenSide: 'YES' | 'NO', otherSnapshot?: any) {
    if (!snapshot.bestBid || !snapshot.bestAsk || !snapshot.tickSize) {
      log.warn({ tokenId, snapshot, tokenSide }, "⚠️ Incomplete snapshot data, skipping market making");
      return;
    }

    log.info({
      market: this.marketInfo?.slug,
      tokenId: tokenId.substring(0, 20) + '...',
      tokenSide,
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      tickSize: snapshot.tickSize
    }, "🚀 Starting market making");

    if (!this.marketInfo) {
      log.error("No market info available");
      return;
    }
    
    // Placer les ordres initiaux avec stratégie de parité
    await this.placeOrders(tokenId, snapshot, tokenSide, otherSnapshot);
  }

  private async handlePriceUpdate(tokenId: string, bestBid: number | null, bestAsk: number | null, tickSize: number) {
    if (!bestBid || !bestAsk || !this.marketInfo) return;

    // FILTRE CRITIQUE: Ignorer les données WebSocket corrompues
    const isCorruptedData = (bestBid === 0.001 && bestAsk === 0.999) || 
                           (bestBid === 0.001 && bestAsk === null) || 
                           (bestBid === null && bestAsk === 0.999);
    
    if (isCorruptedData) return; // Ignorer silencieusement

    const currentOrders = this.activeOrders.get(tokenId);
    const determinedSide = tokenId === this.marketInfo.yesTokenId ? 'YES' : 'NO';
    
    // Vérifier si on a besoin de placer des ordres (manque bidId OU askId)
    const needsBid = !currentOrders?.bidId;
    const needsAsk = !currentOrders?.askId;
    
    if (needsBid || needsAsk) {
      const prices = await this.calculateOrderPrices({ bestBid, bestAsk, tickSize }, determinedSide, tokenId);
      if (prices) {
        await this.placeOrders(tokenId, { bestBid, bestAsk, tickSize }, determinedSide, undefined, {
          placeBuy: needsBid,
          placeSell: needsAsk
        });
      }
      return;
    }

    const spread = bestAsk - bestBid;
    const targetSpread = this.config.targetSpreadCents / 100;

    // Vérifier si nos ordres sont toujours compétitifs
    const shouldReplace = this.shouldReplaceOrders(currentOrders, bestBid, bestAsk, targetSpread);

    if (shouldReplace && this.canReplaceOrders()) {
      await this.replaceOrders(tokenId, { bestBid, bestAsk, tickSize }, determinedSide);
    }
  }

  private shouldReplaceOrders(currentOrders: any, bestBid: number, bestAsk: number, targetSpread: number): boolean {
    // STRATÉGIE AGRESSIVE : Remplacer si on n'est pas EXACTEMENT au best bid/ask
    // Pour maximiser capture de spread, être toujours top-of-book
    const ourBidIsBest = currentOrders.bidPrice && Math.abs(currentOrders.bidPrice - bestBid) < 0.0001;
    const ourAskIsBest = currentOrders.askPrice && Math.abs(currentOrders.askPrice - bestAsk) < 0.0001;
    const notInside = !ourBidIsBest || !ourAskIsBest;
    
    // Remplacer si le mid-price a bougé significativement
    const currentMid = (bestBid + bestAsk) / 2;
    const lastMid = currentOrders.lastMid || currentMid;
    const priceMovement = Math.abs(currentMid - lastMid) >= PRICE_CHANGE_THRESHOLD;
    
    // Remplacer si l'ordre est trop vieux (TTL)
    const orderAge = Date.now() - (currentOrders.lastPlaceTime || 0);
    const orderTooOld = orderAge > ORDER_TTL_MS;
    
    // Log seulement si on va replacer (réduire bruit)
    if (notInside || priceMovement || orderTooOld) {
      log.info({
        ourBid: currentOrders.bidPrice?.toFixed(4),
        mktBid: bestBid.toFixed(4),
        ourAsk: currentOrders.askPrice?.toFixed(4),
        mktAsk: bestAsk.toFixed(4),
        reason: notInside ? 'not_inside' : priceMovement ? 'price_moved' : 'ttl_expired'
      }, "🔄 Replacing");
    }
    
    return notInside || priceMovement || orderTooOld;
  }

  private canReplaceOrders(): boolean {
    const now = Date.now();
    if (now - this.lastReplaceTime < this.config.replaceCooldownMs) {
      return false;
    }
    this.lastReplaceTime = now;
    return true;
  }

  /**
   * Récupère les prix réels depuis le WebSocket (source de vérité)
   * Attend jusqu'à 30 secondes pour obtenir des prix valides
   * UTILISE LE CACHE pour ne PAS écraser le listener principal
   */
  private async getWebSocketPrices(tokenId: string): Promise<{bestBid: number, bestAsk: number} | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        log.warn({ tokenId: tokenId.substring(0, 20) + '...' }, "⏰ Timeout waiting for WebSocket prices");
        resolve(null);
      }, 30000); // 30 secondes max

      // Vérifier périodiquement le cache au lieu de subscribe() qui écrase le listener
      const checkInterval = setInterval(() => {
        const cached = this.feed.getLastPrices(tokenId);
        
        if (cached && cached.bestBid !== null && cached.bestAsk !== null) {
          const { bestBid, bestAsk } = cached;
          
          // Filtrer les données corrompues
          const isCorruptedData = (bestBid === 0.001 && bestAsk === 0.999) || 
                                 (bestBid === 0.001 && bestAsk === null) || 
                                 (bestBid === null && bestAsk === 0.999);
          
          if (isCorruptedData) {
            log.debug({ 
              tokenId: tokenId.substring(0, 20) + '...',
              bestBid, 
              bestAsk 
            }, "Ignoring corrupted cached prices");
            return;
          }

          if (bestBid > 0 && bestAsk < 1 && bestBid < bestAsk) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            log.info({
              tokenId: tokenId.substring(0, 20) + '...',
              bestBid: bestBid.toFixed(4),
              bestAsk: bestAsk.toFixed(4)
            }, "✅ Real WebSocket prices obtained from cache");
            resolve({ bestBid, bestAsk });
          }
        }
      }, 500); // Vérifier toutes les 500ms
    });
  }

  private async placeOrders(tokenId: string, snapshot: any, tokenSide: 'YES' | 'NO', otherSnapshot?: any, options?: { placeBuy?: boolean, placeSell?: boolean }) {
    if (!this.marketInfo) return;

    try {
      // Vérifier le capital à risque AVANT de placer des ordres
      const currentNotionalAtRisk = this.getNotionalAtRisk();
      if (currentNotionalAtRisk >= MAX_NOTIONAL_AT_RISK_USDC) {
        log.warn({
          currentAtRisk: currentNotionalAtRisk.toFixed(2),
          maxAllowed: MAX_NOTIONAL_AT_RISK_USDC,
          tokenId: tokenId.substring(0, 20) + '...'
        }, "⚠️ Max notional at risk reached, skipping order placement");
        return;
      }
      
      // Calculer les prix avec stratégie de parité (pas besoin de fetchLastPrice ici)
      const prices = await this.calculateOrderPrices(snapshot, tokenSide, tokenId, otherSnapshot);
      if (!prices || !prices.bidPrice || !prices.askPrice) {
        log.debug({ 
          tokenId: tokenId.substring(0, 20) + '...',
          tokenSide 
        }, "No valid prices calculated, skipping orders");
        return;
      }

      const { bidPrice, askPrice, parityBias, midPrice } = prices;
      
      // Mémoriser le mid-price pour détecter les mouvements futurs
      const existingOrders = this.activeOrders.get(tokenId) || {};
      this.activeOrders.set(tokenId, { ...existingOrders, lastMid: midPrice });

      // Obtenir l'inventaire actuel et les limites
      const currentInventory = this.inventory.getInventory(tokenId);
      const maxInventory = tokenSide === 'YES' ? MAX_INVENTORY_YES : MAX_INVENTORY_NO;
      
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        currentInventory: currentInventory.toFixed(2),
        maxInventory,
        hasInventory: currentInventory > 0
      }, "📦 Current inventory status");

      // Calculer les tailles séparément pour BUY et SELL avec minOrderSize dynamique
      const buySize = await this.calculateOrderSize(tokenId, bidPrice);
      
      // Pour SELL, récupérer aussi le minOrderSize dynamique
      let minSellShares = this.feed.getMinOrderSize(tokenId);
      if (!minSellShares) {
        minSellShares = await this.clob.getMinOrderSizeForToken(tokenId);
        if (minSellShares) this.feed.setMinOrderSize(tokenId, minSellShares);
        else minSellShares = 5; // Fallback
      }
      
      const sellSize = currentInventory > 0 ? calculateSellSizeShares(currentInventory, askPrice, MAX_SELL_PER_ORDER_SHARES, minSellShares, MIN_NOTIONAL_SELL_USDC) : null;

      log.info({
        slug: this.marketInfo.slug,
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        bidPrice: bidPrice.toFixed(3),
        askPrice: askPrice.toFixed(3),
        buySize: buySize?.toString() || 'null',
        sellSize: sellSize?.toString() || 'null',
        currentInventory,
        maxInventory,
        parityBias
      }, "📝 Calculating order sizes");

      // Vérifications de solvabilité et d'inventaire
      const buyAmounts = buySize ? buildAmounts("BUY", bidPrice, buySize) : null;
      const sellAmounts = sellSize ? buildAmounts("SELL", askPrice, sellSize) : null;
      
      const buySolvent = buyAmounts ? await this.checkBuySolvency(buyAmounts.makerAmount) : false;
      const sellSolvent = sellAmounts ? await this.checkSellSolvency(tokenId, sellAmounts.makerAmount) : false;
      const canBuy = buySize !== null && buySolvent && (currentInventory + (buySize || 0)) <= maxInventory;
      const canSell = sellSize !== null && sellSolvent && currentInventory >= (sellSize || 0);

      // LOGIQUE DE MARKET MAKING : Placer BUY et SELL simultanément
      // Un market maker doit TOUJOURS offrir des deux côtés du marché
      const hasInventory = currentInventory > 0;
      
      // CORRECTION : Placer des ordres BUY même avec inventaire (pour capturer le spread)
      const shouldPlaceBuy = canBuy && (parityBias !== 'SELL') && (options?.placeBuy !== false);
      const shouldPlaceSell = canSell && (parityBias !== 'BUY') && (options?.placeSell !== false);
      
      // DEBUG : Vérifier chaque condition individuellement
      log.debug({
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        canBuy,
        parityBiasNotSELL: parityBias !== 'SELL',
        optionsPlaceBuyNotFalse: options?.placeBuy !== false,
        shouldPlaceBuy,
        canSell,
        parityBiasNotBUY: parityBias !== 'BUY',
        optionsPlaceSellNotFalse: options?.placeSell !== false,
        shouldPlaceSell
      }, "🔍 DEBUG: Order placement conditions breakdown");
      
      // Si on a de l'inventaire, on peut toujours vendre (logique conservée)
      // Mais on peut aussi acheter pour faire du market making complet
      
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        hasInventory,
        currentInventory: currentInventory.toFixed(2),
        shouldPlaceBuy,
        shouldPlaceSell,
        parityBias: parityBias || 'undefined',
        canBuy,
        canSell,
        reason: hasInventory ? 'Priority to SELL (has inventory)' : 'Normal BUY/SELL logic'
      }, "🎯 Order placement decision");

      log.info({
        slug: this.marketInfo.slug,
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        buySolvent,
        sellSolvent,
        canBuy,
        canSell,
        shouldPlaceBuy,
        shouldPlaceSell,
        currentInventory,
        maxInventory,
        parityBias
      }, "🔍 Solvency and inventory checks");

      let buyResp = null;
      let sellResp = null;

      // Placer l'ordre BUY si possible
      if (shouldPlaceBuy) {
        try {
          const maker = this.clob.getMakerAddress();
          const signer = this.clob.getAddress();
          const buyAmounts = buildAmounts("BUY", bidPrice, buySize!);
          const buyOrderData = buildOrder("BUY", tokenId, bidPrice, buySize!, maker, signer);
          
          const buyOrder = {
            deferExec: false,
            order: { ...buyOrderData, signature: "0x" },
            owner: process.env.CLOB_API_KEY!,
            orderType: "GTC" as OrderType
          };

          // LOGS FORENSICS : Capture complète au moment du placement
          log.info({
            event: "place_attempt",
            slug: this.marketInfo.slug,
            tokenId: tokenId.substring(0, 20) + '...',
            tokenSide,
            side: "BUY",
            price: bidPrice.toFixed(4),
            size: buySize,
            notional: (bidPrice * (buySize || 0)).toFixed(5),
            makerAmount: buyAmounts.makerAmount.toString(),
            takerAmount: buyAmounts.takerAmount.toString(),
            currentInventory,
            tickImprovement: this.config.tickImprovement,
            timestamp: new Date().toISOString()
          }, "📤 Placing BUY order (solvent + can buy)");

          buyResp = await this.clob.postOrder(buyOrder);

          if (buyResp && (buyResp.orderId || buyResp.orderID)) {
            const orderId = buyResp.orderId || buyResp.orderID;
            
            // Stocker l'ordre actif (sera mis à jour sur fill via UserFeed)
            const existing = this.activeOrders.get(tokenId) || {};
            this.activeOrders.set(tokenId, { 
              ...existing, 
              bidId: orderId, 
              bidPrice,
              bidSize: buySize!,
              lastPlaceTime: Date.now()
            });
            
            // LOGS FORENSICS : Confirmation du placement
            log.info({ 
              event: "order_ack",
              slug: this.marketInfo.slug,
              tokenId: tokenId.substring(0, 20) + '...',
              tokenSide,
              orderId: orderId,
              side: "BUY",
              bidPrice: bidPrice.toFixed(4),
              size: buySize!,
              notional: (bidPrice * buySize!).toFixed(2),
              timestamp: new Date().toISOString()
            }, "✅ BUY order POSTED (inventory will update on fill)");
          }
        } catch (error) {
          log.error({ error, tokenId: tokenId.substring(0, 20) + '...', tokenSide, side: "BUY" }, "❌ Error placing BUY order");
        }
      } else {
        let reason = "unknown";
        if (!canBuy) {
          reason = "skip BUY (not enough USDC balance/allowance)";
        } else if (options?.placeBuy === false) {
          reason = "skip BUY (options.placeBuy = false - order already exists)";
        } else if (parityBias === 'SELL') {
          reason = "skip BUY (parity bias: SELL)";
        } else if (!shouldPlaceBuy) {
          reason = "skip BUY (shouldPlaceBuy = false, check logic)";
        }
        
        log.warn({
          slug: this.marketInfo.slug,
          tokenSide,
          side: "BUY",
          makerAmount: buyAmounts?.makerAmount.toString() || "0",
          canBuy,
          parityBias: parityBias || 'undefined',
          optionsPlaceBuy: options?.placeBuy,
          shouldPlaceBuy
        }, reason);
      }

      // Placer l'ordre SELL si possible
      if (shouldPlaceSell) {
        try {
          // Vérifier l'approbation ERC-1155 pour l'Exchange
          const { isApprovedForAll } = await import("./lib/erc1155");
          const { EXCHANGE_ADDRESS } = await import("./config");
          
          const isApproved = await isApprovedForAll(
            this.provider,
            this.clob.getMakerAddress(),
            EXCHANGE_ADDRESS
          );
          
          if (!isApproved) {
            log.warn({
              slug: this.marketInfo.slug,
              tokenId: tokenId.substring(0, 20) + '...',
              tokenSide
            }, "⚠️ ERC-1155 not approved for Exchange. Please approve manually on Polymarket or via setApprovalForAll()");
            // On continue quand même car l'approbation peut être faite manuellement
          }
          
          const maker = this.clob.getMakerAddress();
          const signer = this.clob.getAddress();
          const sellAmounts = buildAmounts("SELL", askPrice, sellSize!);
          const sellOrderData = buildOrder("SELL", tokenId, askPrice, sellSize!, maker, signer);
          
          const sellOrder = {
            deferExec: false,
            order: { ...sellOrderData, signature: "0x" },
            owner: process.env.CLOB_API_KEY!,
            orderType: "GTC" as OrderType
          };

          // LOGS FORENSICS : Capture complète au moment du placement
          log.info({
            event: "place_attempt",
            slug: this.marketInfo.slug,
            tokenId: tokenId.substring(0, 20) + '...',
            tokenSide,
            side: "SELL",
            price: askPrice.toFixed(4),
            size: sellSize,
            notional: (askPrice * (sellSize || 0)).toFixed(5),
            makerAmount: sellAmounts.makerAmount.toString(),
            takerAmount: sellAmounts.takerAmount.toString(),
            currentInventory,
            tickImprovement: this.config.tickImprovement,
            timestamp: new Date().toISOString()
          }, "📤 Placing SELL order (solvent + can sell)");

          sellResp = await this.clob.postOrder(sellOrder);

          if (sellResp && (sellResp.orderId || sellResp.orderID)) {
            const orderId = sellResp.orderId || sellResp.orderID;
            
            // Stocker l'ordre actif (sera mis à jour sur fill via UserFeed)
            const existing = this.activeOrders.get(tokenId) || {};
            this.activeOrders.set(tokenId, { 
              ...existing, 
              askId: orderId, 
              askPrice,
              askSize: sellSize!,
              lastPlaceTime: Date.now()
            });
            
            // LOGS FORENSICS : Confirmation du placement
            log.info({ 
              event: "order_ack",
              slug: this.marketInfo.slug,
              tokenId: tokenId.substring(0, 20) + '...',
              tokenSide,
              orderId: orderId,
              side: "SELL",
              askPrice: askPrice.toFixed(4),
              size: sellSize!,
              notional: (askPrice * sellSize!).toFixed(2),
              timestamp: new Date().toISOString()
            }, "✅ SELL order POSTED (inventory will update on fill)");
          }
        } catch (error) {
          log.error({ error, tokenId: tokenId.substring(0, 20) + '...', tokenSide, side: "SELL" }, "❌ Error placing SELL order");
        }
      } else {
        let reason = "unknown";
        if (!canSell) {
          reason = "skip SELL (not enough inventory)";
        } else if (options?.placeSell === false) {
          reason = "skip SELL (options.placeSell = false - order already exists)";
        } else if (parityBias === 'BUY') {
          reason = "skip SELL (parity bias: BUY)";
        } else if (!shouldPlaceSell) {
          reason = "skip SELL (shouldPlaceSell = false, check logic)";
        }
        
        log.warn({
          slug: this.marketInfo.slug,
          tokenSide,
          side: "SELL",
          makerAmount: sellAmounts?.makerAmount.toString() || "0",
          canSell,
          parityBias: parityBias || 'undefined',
          optionsPlaceSell: options?.placeSell,
          shouldPlaceSell
        }, reason);
      }

      if (!buyResp?.success && !sellResp?.success) {
        log.warn({
          slug: this.marketInfo.slug,
          tokenId: tokenId.substring(0, 20) + '...',
          tokenSide
        }, "No orders placed");
      } else {
        log.info({
          slug: this.marketInfo.slug,
          tokenId: tokenId.substring(0, 20) + '...',
          tokenSide,
          buyResp: buyResp?.orderId || buyResp?.orderID || null,
          sellResp: sellResp?.orderId || sellResp?.orderID || null
        }, "✅ Orders placed successfully");
      }

    } catch (error) {
      log.error({ error, tokenId: tokenId.substring(0, 20) + '...', tokenSide }, "❌ Error placing orders");
    }
  }

  /**
   * Vérifie la solvabilité pour un achat (USDC)
   */
  private async checkBuySolvency(requiredAmount: bigint): Promise<boolean> {
    try {
      // UTILISER le cache de AllowanceManager au lieu de relire on-chain
      // Le cache est déjà initialisé au démarrage et mis à jour automatiquement
      const summary = this.allowanceManager.getSummary();
      
      // Convertir le solde de string vers bigint (unités: 1e6 pour USDC)
      const balanceUsdc = BigInt(Math.round(parseFloat(summary.usdcBalance) * 1e6));
      const allowanceUsdc = BigInt(Math.round(parseFloat(summary.usdcAllowance) * 1e6));
      
      const hasFunds = balanceUsdc >= requiredAmount;
      const hasAllowance = allowanceUsdc >= requiredAmount;
      
      log.debug({
        requiredUsdc: (Number(requiredAmount) / 1e6).toFixed(2),
        balanceUsdc: summary.usdcBalance,
        allowanceUsdc: summary.usdcAllowance,
        hasFunds,
        hasAllowance
      }, "💰 Buy solvency check");
      
      return hasFunds && hasAllowance;
    } catch (error) {
      log.error({ error, requiredAmount: requiredAmount.toString() }, "❌ Error checking buy solvency");
      return false;
    }
  }

  /**
   * Vérifie la solvabilité pour une vente (inventaire)
   */
  private async checkSellSolvency(tokenId: string, requiredAmount: bigint): Promise<boolean> {
    try {
      // Pour l'instant, on vérifie seulement l'inventaire local
      // TODO: Ajouter la vérification on-chain des tokens ERC1155
      const availableShares = this.inventory.getInventory(tokenId);
      const requiredShares = Number(requiredAmount) / 1e6; // Convertir de micro-unités
      
      return availableShares >= requiredShares;
    } catch (error) {
      log.error({ error, tokenId: tokenId.substring(0, 20) + '...', requiredAmount: requiredAmount.toString() }, "❌ Error checking sell solvency");
      return false;
    }
  }

  private async calculateOrderPrices(
    snapshot: any, 
    tokenSide: 'YES' | 'NO',
    tokenId: string,
    otherSnapshot?: any
  ): Promise<{ bidPrice: number | null; askPrice: number | null; parityBias?: 'BUY' | 'SELL'; midPrice: number } | null> {
    const bestBid = snapshot.bestBid;
    const bestAsk = snapshot.bestAsk;
    const tickSize = snapshot.tickSize || 0.001;
    
    // VALIDATION CRITIQUE: Vérifier que les prix sont réels
    if (bestBid === null || bestAsk === null || bestBid <= 0 || bestAsk >= 1) {
      log.warn({ 
        tokenId: tokenId.substring(0, 20) + '...',
        bestBid, 
        bestAsk, 
        tokenSide 
      }, "📊 Invalid or null prices from WebSocket, skipping");
      return null;
    }
    
    // Vérifier que le carnet est valide
    if (bestBid <= 0 || bestAsk >= 1 || bestBid >= bestAsk) {
      log.warn({ bestBid, bestAsk, tokenSide }, "📊 Invalid order book, skipping");
      return null;
    }

    const midPrice = (bestBid + bestAsk) / 2;
    const rawSpread = bestAsk - bestBid;
    
    // GARDE-FOU CRITIQUE : Spread minimum (annulation immédiate si breach)
    const minSpreadRequired = this.config.targetSpreadCents / 100 * 0.6; // 60% du target minimum
    if (rawSpread < minSpreadRequired) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        rawSpread: (rawSpread * 100).toFixed(1) + '¢',
        minRequired: (minSpreadRequired * 100).toFixed(1) + '¢',
        action: 'cancelling_orders'
      }, "⚠️ Spread breach - cancelling orders immediately");
      
      // Annulation immédiate (ne pas attendre TTL)
      await this.orderCloser.closeOrdersForToken(tokenId);
      const currentOrders = this.activeOrders.get(tokenId);
      if (currentOrders) {
        currentOrders.bidId = undefined;
        currentOrders.askId = undefined;
      }
      
      return null;
    }
    
    // PIN-RISK GUARD : Marchés extrêmes (p ≈ 0 ou 1)
    if (midPrice > 0.98 || midPrice < 0.02) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        mid: midPrice.toFixed(4),
        reason: midPrice > 0.98 ? 'price_near_1' : 'price_near_0',
        action: 'skip_quoting'
      }, "🚨 Pin-risk detected");
      return null;
    }
    const baseTargetSpread = this.config.targetSpreadCents / 100;
    
    // Récupérer le dernier prix tradé réel (via CLOB ou mid-price)
    // Évite les valeurs aberrantes en utilisant directement le mid-price actuel
    const { fetchLastTradePrice } = await import("./data/book");
    const lastTradePrice = await fetchLastTradePrice(tokenId, this.clob);
    
    // Détecter un mouvement de prix significatif SEULEMENT si le prix est cohérent
    if (lastTradePrice) {
      const priceChange = Math.abs(lastTradePrice - midPrice);
      
      // Ignorer les valeurs aberrantes (>5¢ de différence)
      if (priceChange > this.config.maxDistanceFromMid) {
        log.warn({
          tokenSide,
          midPrice: midPrice.toFixed(4),
          lastTradePrice: lastTradePrice.toFixed(4),
          priceChange: priceChange.toFixed(4),
          maxDistance: this.config.maxDistanceFromMid
        }, "⚠️ Last trade price aberrant, ignoring");
      } else if (priceChange > this.config.priceChangeThreshold) {
        log.info({
          tokenSide,
          midPrice: midPrice.toFixed(4),
          lastTradePrice: lastTradePrice.toFixed(4),
          priceChange: priceChange.toFixed(4),
          threshold: this.config.priceChangeThreshold
        }, "⚡ Significant price movement detected");
      }
    }

    // Accepter les spreads serrés - ils sont profitables pour le market making
    // Seulement rejeter si le spread est vraiment trop large (> 50%)
    if (rawSpread > 0.5) {
      log.debug({ 
        rawSpread: rawSpread.toFixed(4), 
        baseTargetSpread: baseTargetSpread.toFixed(4),
        tokenSide 
      }, "📊 Spread too wide (>50%), skipping");
      return null;
    }

    // Amélioration du spread dynamique avec scaling plus fluide
    let dynamicSpread = baseTargetSpread;
    const spreadRatio = rawSpread / baseTargetSpread;
    
    if (spreadRatio > 1) {
      // Si rawSpread est plus grand que base, permettre à dynamicSpread de croître mais limiter  
      dynamicSpread = Math.min(
        rawSpread * this.config.minSpreadMultiplier,
        rawSpread * this.config.maxSpreadMultiplier
      );
    } else {
      // Si rawSpread est plus petit que base (spread serré), utiliser un spread minimum
      // mais rester compétitif en utilisant le spread réel
      dynamicSpread = Math.max(rawSpread * 0.5, baseTargetSpread * 0.1);
    }

    // Stratégie de parité si on a les deux snapshots
    let parityBias: 'BUY' | 'SELL' | undefined = undefined;
    if (otherSnapshot && otherSnapshot.bestBid && otherSnapshot.bestAsk) {
      const otherMid = (otherSnapshot.bestBid + otherSnapshot.bestAsk) / 2;
      const parity = midPrice + otherMid;
      const parityDeviation = Math.abs(parity - 1.0);

      if (parityDeviation > PARITY_THRESHOLD) {
        if (parity > 1.0 + PARITY_THRESHOLD) {
          parityBias = 'SELL'; // Market overpriced, focus on selling
        } else if (parity < 1.0 - PARITY_THRESHOLD) {
          parityBias = 'BUY'; // Market underpriced, focus on buying
        }
        
        log.debug({
          tokenSide,
          parity: parity.toFixed(4),
          parityDeviation: parityDeviation.toFixed(4),
          bias: parityBias
        }, "⚖️ Parity strategy applied");
      }
    }

    log.debug({
      tokenSide,
      rawSpread: rawSpread.toFixed(4),
      baseTargetSpread: baseTargetSpread.toFixed(4),
      dynamicSpread: dynamicSpread.toFixed(4),
      spreadRatio: spreadRatio.toFixed(2),
      parityBias
    }, "📊 Dynamic spread calculation");

    // Calculer les prix de départ : JOIN au best bid/ask
    let desiredBidPrice = bestBid;
    let desiredAskPrice = bestAsk;
    
    // SKEW D'INVENTAIRE DÉSACTIVÉ TEMPORAIREMENT (causait des ordres non compétitifs)
    // Le bot va placer aux meilleurs prix pour maximiser les fills
    const inv = this.inventory.getInventory(tokenId);
    const skew = 0; // INVENTORY_SKEW_LAMBDA * inv * tickSize;
    
    if (inv !== 0) {
      log.debug({
        tokenId: tokenId.substring(0, 20) + '...',
        inventory: inv.toFixed(2),
        skew: (skew * 100).toFixed(2) + '¢'
      }, "📊 Inventory skew (currently disabled)");
    }

    // ============================================================
    // QUOTE GUARDS : Protection post-only + amélioration de prix
    // ============================================================
    // IMPORTANT : Utilise ensurePostOnly pour :
    // 1. Empêcher les ordres marketables (qui croiseraient le livre)
    // 2. Améliorer les prix de TICK_IMPROVEMENT ticks (priorité de file)
    // 3. Valider les distances du mid-price
    
    const quoteGuardOptions = {
      tickImprovement: this.config.tickImprovement,
      maxDistanceFromMid: this.config.maxDistanceFromMid,
      enablePostOnly: true // Toujours actif pour éviter les trades accidentels
    };

    const bidGuardResult = ensurePostOnly(
      "BUY",
      bestBid,
      bestAsk,
      tickSize,
      desiredBidPrice,
      quoteGuardOptions
    );

    const askGuardResult = ensurePostOnly(
      "SELL",
      bestBid,
      bestAsk,
      tickSize,
      desiredAskPrice,
      quoteGuardOptions
    );

    const bidPrice = bidGuardResult.finalPrice;
    const askPrice = askGuardResult.finalPrice;

    // LOGS FORENSICS : Indispensables pour déboguer les placements aberrants
    log.debug({
      tokenId: tokenId.substring(0, 20) + '...',
      tokenSide,
      market: {
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        mid: midPrice.toFixed(4),
        tick: tickSize
      },
      bid: {
        desired: desiredBidPrice.toFixed(4),
        final: bidPrice.toFixed(4),
        improvement: bidGuardResult.improvementTicks + ' ticks',
        wouldCross: bidGuardResult.wouldCross,
        wasClamped: bidGuardResult.wasClamped,
        distanceFromMid: bidGuardResult.distanceFromMid.toFixed(4)
      },
      ask: {
        desired: desiredAskPrice.toFixed(4),
        final: askPrice.toFixed(4),
        improvement: askGuardResult.improvementTicks + ' ticks',
        wouldCross: askGuardResult.wouldCross,
        wasClamped: askGuardResult.wasClamped,
        distanceFromMid: askGuardResult.distanceFromMid.toFixed(4)
      }
    }, "🛡️ Quote guards applied");
    
    // ============================================================
    // VALIDATION FINALE : Vérifier que les prix sont cohérents
    // ============================================================
    const validation = validateQuotePrices(
        bidPrice, 
        askPrice, 
        bestBid, 
        bestAsk, 
      midPrice,
      this.config.maxDistanceFromMid
    );

    if (!validation.valid) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        bidPrice: bidPrice.toFixed(4),
        askPrice: askPrice.toFixed(4),
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        reason: validation.reason
      }, "❌ Quote validation failed, skipping");
      return null;
    }

    // Vérifier le spread final
    const finalSpread = askPrice - bidPrice;
    const minSpread = this.config.targetSpreadCents / 100;
    
    if (finalSpread < minSpread * 0.5) {
      log.warn({ 
        tokenId: tokenId.substring(0, 20) + '...',
        tokenSide,
        finalSpread: finalSpread.toFixed(4),
        minSpread: minSpread.toFixed(4),
        reason: "Spread too tight after guards"
      }, "⚠️ Final spread very tight, but proceeding");
    }

    return {
      bidPrice: parseFloat(bidPrice.toFixed(6)),
      askPrice: parseFloat(askPrice.toFixed(6)),
      parityBias,
      midPrice: parseFloat(midPrice.toFixed(6))
    };
  }

  /**
   * Calcule la taille d'un ordre BUY en adaptant le notional au capital disponible si AUTO_ADJUST_NOTIONAL est activé.
   * Cette méthode utilise la logique unifiée de risk/sizing et respecte les contraintes de notional minimum.
   */
  private async calculateOrderSize(tokenId: string, price: number): Promise<number | null> {
    // Calcule le notional en fonction du solde USDC actuel si AUTO_ADJUST_NOTIONAL est activé
    let notional = this.config.notionalPerOrderUsdc;
    
    if (this.config.autoAdjustNotional) {
      const summary = this.allowanceManager.getSummary();
      const balanceUsdc = parseFloat(summary.usdcBalance);
      
      // Si le solde est insuffisant pour le notional minimum, on ne peut pas trader
      if (balanceUsdc < this.config.minNotionalUsdc) {
        log.warn({ 
          balanceUsdc: balanceUsdc.toFixed(2),
          minNotional: this.config.minNotionalUsdc,
          summary
        }, "⚠️ USDC balance too low for minimum notional");
        return null;
      }
      
      // Garder une petite réserve (10% ou 0.5 USDC minimum)
      const reserve = Math.max(0.5, this.config.minNotionalUsdc * 0.1);
      const availableForTrade = Math.max(0, balanceUsdc - reserve);
      
      // Ajuster le notional, mais garantir au moins minNotionalUsdc si possible
      notional = Math.min(this.config.notionalPerOrderUsdc, availableForTrade);
      notional = Math.max(notional, Math.min(this.config.minNotionalUsdc, balanceUsdc - 0.5));
      
      log.debug({
        originalNotional: this.config.notionalPerOrderUsdc,
        balanceUsdc: balanceUsdc.toFixed(2),
        reserve: reserve.toFixed(2),
        adjustedNotional: notional.toFixed(2)
      }, "📊 Notional adjusted based on balance");
    }
    
    // Vérifier que le notional est suffisant
    if (notional < this.config.minNotionalUsdc) {
      log.warn({ 
        notional: notional.toFixed(2), 
        minNotional: this.config.minNotionalUsdc 
      }, "📊 Notional too low after adjustment");
      return null;
    }
    
    // CRITIQUE: Récupérer le minOrderSize dynamique du CLOB (par marché)
    let minShares = this.feed.getMinOrderSize(tokenId);
    if (!minShares || minShares === 0) {
      // Fallback : interroger le CLOB directement
      minShares = await this.clob.getMinOrderSizeForToken(tokenId);
      if (minShares) {
        this.feed.setMinOrderSize(tokenId, minShares);
      } else {
        minShares = 5; // Fallback final si CLOB ne répond pas
      }
    }
    const requiredNotional = price * minShares; // Notional requis pour atteindre minShares
    
    // Si le notional actuel ne permet pas d'atteindre 5 shares, l'augmenter
    if (notional < requiredNotional) {
      const oldNotional = notional;
      notional = Math.max(requiredNotional, this.config.minNotionalUsdc);
      
      log.debug({
        price: price.toFixed(4),
        minShares,
        oldNotional: oldNotional.toFixed(2),
        requiredNotional: requiredNotional.toFixed(2),
        newNotional: notional.toFixed(2)
      }, "📊 Notional increased to meet minimum shares requirement");
    }
    
    log.debug({
      price: price.toFixed(4),
      minShares,
      notional: notional.toFixed(2),
      expectedShares: (notional / price).toFixed(2)
    }, "📊 Order size calculation");
    
    // Utiliser la logique de sizing sécurisée avec le minimum Polymarket
    return calculateSafeSize(
      notional,
      price,
      minShares,
      this.config.minNotionalUsdc
    );
  }

  /**
   * Calcule la taille d'un ordre SELL avec arrondi vers le BAS strict.
   * Garantit qu'on ne vend JAMAIS plus que l'inventaire disponible.
   */
  private calculateSellSize(price: number, availableShares: number): number | null {
    // Vérifier qu'on a assez de shares pour vendre
    if (availableShares < this.config.minSizeShares) {
      log.debug({ 
        availableShares: availableShares.toFixed(2), 
        minSize: this.config.minSizeShares 
      }, "📊 Not enough shares to sell");
      return null;
    }
    
    // SELL sizing : dissocier du notional BUY, basé sur l'inventaire disponible
    const minShares = this.config.minSizeShares;
    const maxSharesPerOrder = 25; // Cap plus conservateur par ordre
    
    // Calculer la taille basée sur l'inventaire disponible
    let size = Math.floor(Math.min(availableShares, maxSharesPerOrder) * 100) / 100;
    
    // Vérifier le minimum de shares
    if (size < minShares) {
      log.debug({ 
        availableShares: availableShares.toFixed(2),
        calculatedSize: size.toFixed(2),
        minSize: minShares 
      }, "📊 Not enough shares for minimum order size");
      return null;
    }
    
    // Vérifier le notional minimum (beaucoup plus bas que BUY)
    const minNotionalSell = Math.max(1.0, price * minShares); // Au moins 1 USDC ou prix*5 shares
    const finalNotional = price * size;
    
    if (finalNotional < minNotionalSell) {
      log.debug({ 
        size: size.toFixed(2),
        price: price.toFixed(4),
        finalNotional: finalNotional.toFixed(2), 
        minNotionalSell: minNotionalSell.toFixed(2)
      }, "📊 Final notional too low for SELL");
      return null;
    }
    
    log.debug({
      price: price.toFixed(4),
      availableShares: availableShares.toFixed(2),
      calculatedSize: size.toFixed(2),
      finalNotional: finalNotional.toFixed(2)
    }, "📊 SELL size calculated successfully");
    
    return size;
  }

  private async replaceOrders(tokenId: string, snapshot: any, tokenSide: 'YES' | 'NO') {
    if (!this.marketInfo) {
      log.error("No market info available for replacement");
      return;
    }

    // Annuler les ordres existants
    await this.cancelOrders(tokenId);
    
    // Placer de nouveaux ordres (qui calculeront les nouveaux prix)
    await this.placeOrders(tokenId, snapshot, tokenSide);
  }

  private async cancelOrders(tokenId: string) {
    const orders = this.activeOrders.get(tokenId);
    if (!orders?.bidId || !orders?.askId) return;

    try {
      const cancelResp = await this.clob.cancelOrders([orders.bidId, orders.askId]);
      
      if (cancelResp) {
        log.info({
          tokenId: tokenId.substring(0, 20) + '...',
          canceledOrders: cancelResp.canceled || [orders.bidId, orders.askId]
        }, "🗑️ Orders canceled");
      }

      // Nettoyer le cache
      this.activeOrders.delete(tokenId);
    } catch (error) {
      log.error({ error, tokenId: tokenId.substring(0, 20) + '...' }, "❌ Error canceling orders");
    }
  }

  async stop() {
    log.info({ market: this.marketInfo?.slug }, "🛑 Stopping market maker");
    
    // Arrêter les timers
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
    }
    if (this.inventorySyncInterval) {
      clearInterval(this.inventorySyncInterval);
    }
    if (this.marketHealthCheckInterval) {
      clearInterval(this.marketHealthCheckInterval);
    }
    
    // Annuler tous les ordres actifs
    for (const [tokenId] of this.activeOrders) {
      await this.cancelOrders(tokenId);
    }

    // Nettoyer l'inventaire
    this.inventory.cleanup();
    
    // Fermer proprement les connexions WebSocket
    this.feed.disconnect();
    if (this.userFeed) {
      this.userFeed.disconnect();
    }
    
    // Log final des métriques
    log.info("📊 Final PnL summary:");
    this.pnl.logMetrics();
  }

  /**
   * Ferme tous les ordres ouverts
   */
  async closeAllOrders(dryRun: boolean = false): Promise<void> {
    const result = await this.orderCloser.closeAllOrders(dryRun);
    
    if (result.success) {
      log.info({
        total: result.totalOrders,
        cancelled: result.cancelledOrders.length,
        failed: result.failedOrders.length
      }, "✅ All orders closed successfully");
    } else {
      log.error({
        total: result.totalOrders,
        cancelled: result.cancelledOrders.length,
        failed: result.failedOrders.length,
        errors: result.errors
      }, "❌ Some orders failed to close");
    }
  }

  /**
   * Ferme les ordres pour un token spécifique
   */
  async closeOrdersForToken(tokenId: string, dryRun: boolean = false): Promise<void> {
    const result = await this.orderCloser.closeOrdersForToken(tokenId, dryRun);
    
    if (result.success) {
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        total: result.totalOrders,
        cancelled: result.cancelledOrders.length,
        failed: result.failedOrders.length
      }, "✅ Orders for token closed successfully");
    } else {
      log.error({
        tokenId: tokenId.substring(0, 20) + '...',
        total: result.totalOrders,
        cancelled: result.cancelledOrders.length,
        failed: result.failedOrders.length,
        errors: result.errors
      }, "❌ Some orders for token failed to close");
    }
  }

  /**
   * Retourne un résumé de l'inventaire
   */
  getInventorySummary(): any {
    return this.inventory.getSummary();
  }

  /**
   * Retourne l'inventaire pour un token spécifique
   */
  getInventoryForToken(tokenId: string): any {
    return this.inventory.getInventoryForToken(tokenId);
  }

  /**
   * Retourne un résumé des ordres ouverts
   */
  async getOrdersSummary(): Promise<any> {
    return await this.orderCloser.getOpenOrdersSummary();
  }

  /**
   * Force la mise à jour de l'allowance USDC
   */
  async updateUsdcAllowance(): Promise<boolean> {
    return await this.allowanceManager.forceUsdcCheck();
  }

  /**
   * Retourne le statut des allowances
   */
  getAllowanceStatus(): any {
    return this.allowanceManager.getSummary();
  }
}