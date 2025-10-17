// Market Maker - Orchestrateur principal du bot PolymMM-GuardedSpread
import pino from "pino";
import { PolyClobClient } from "../clients/polySDK";
import { MarketFeed } from "../ws/marketFeed";
import { UserFeed, FillEvent, OrderEvent } from "../ws/userFeed";
import { MarketSelector, CandidateMarket } from "./MarketSelector";
import { StateMachine, MarketState } from "./StateMachine";
import { RiskManager } from "./RiskManager";
import { OrderManager } from "./OrderManager";
import {
  MAX_SHARES_PER_MARKET,
  RECONCILE_INTERVAL_MS,
  METRICS_LOG_INTERVAL_MS,
  MIN_SPREAD_CENTS,
  MIN_NOTIONAL_PER_ORDER_USDC,
  MIN_SIZE_SHARES
} from "../config";

const log = pino({ name: "mm" });

export class MarketMaker {
  private clob: PolyClobClient;
  private marketFeed: MarketFeed;
  private userFeed: UserFeed;
  private selector: MarketSelector;
  private stateMachine: StateMachine;
  private riskManager: RiskManager;
  private orderManager: OrderManager;

  // Marchés actifs
  private activeMarkets = new Map<string, CandidateMarket>();

  // Timers
  private metricsInterval?: NodeJS.Timeout;
  private reconcileInterval?: NodeJS.Timeout;
  private marketHealthInterval?: NodeJS.Timeout;

  // Running flag
  private running = false;

  constructor(clob: PolyClobClient) {
    this.clob = clob;
    this.marketFeed = new MarketFeed();
    this.userFeed = new UserFeed(
      process.env.CLOB_API_KEY!,
      process.env.CLOB_API_SECRET!,
      process.env.CLOB_PASSPHRASE!,
      clob.getAddress()
    );
    this.selector = new MarketSelector(clob, this.marketFeed);
    this.stateMachine = new StateMachine();
    this.riskManager = new RiskManager();
    this.orderManager = new OrderManager(clob);

    log.info("🚀 Market Maker PolymMM-GuardedSpread initialized");
  }

  /**
   * Démarre le market maker
   */
  async start() {
    log.info("🚀 Starting Market Maker...");
    this.running = true;

    // 1. Connecter les WebSockets
    this.connectWebSockets();

    // 2. Sélectionner les meilleurs marchés
    const markets = await this.selector.selectMarkets();

    if (markets.length === 0) {
      log.error("❌ No eligible markets found, stopping");
      return;
    }

    // 3. Initialiser les marchés actifs
    for (const market of markets) {
      // Utiliser le tokenId choisi (peut être YES ou NO)
      this.activeMarkets.set(market.tokenId, market);
      this.stateMachine.initMarket(market.tokenId, market.slug);

      // S'abonner aux mises à jour de prix pour le token choisi
      this.marketFeed.subscribe(
        [market.tokenId],
        (tokenId, bestBid, bestAsk) => this.handlePriceUpdate(tokenId, bestBid, bestAsk)
      );

      log.info({
        slug: market.slug,
        side: market.side,
        tokenId: market.tokenId.substring(0, 20) + '...',
        spread: (market.spread * 100).toFixed(2) + '¢',
        volume: market.volume24h.toFixed(0),
        depth: market.depth.toFixed(0)
      }, "✅ Market initialized");
    }

    // 4. Attendre que les prix arrivent via WebSocket (max 10 secondes)
    log.info("⏳ Waiting for initial prices from WebSocket...");
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Vérifier quels marchés ont reçu des prix
    for (const [tokenId, market] of this.activeMarkets.entries()) {
      const prices = this.marketFeed.getLastPrices(tokenId);
      if (prices && prices.bestBid && prices.bestAsk) {
        log.info({
          slug: market.slug,
          bestBid: prices.bestBid.toFixed(4),
          bestAsk: prices.bestAsk.toFixed(4)
        }, "✅ Initial prices received");
      } else {
        log.warn({
          slug: market.slug,
          tokenId: tokenId.substring(0, 20) + '...'
        }, "⚠️ No prices received yet, will wait");
      }
    }

    // 4. Démarrer les timers périodiques
    this.startPeriodicTasks();

    // 5. Démarrer la boucle principale
    this.startMainLoop();

    log.info({ activeMarkets: this.activeMarkets.size }, "✅ Market Maker started");
  }

  /**
   * Connecte les WebSockets (market feed + user feed)
   */
  private connectWebSockets() {
    log.info("🔌 Connecting WebSockets...");

    // User feed pour les fills et order updates
    this.userFeed.connect();
    this.userFeed.onFill((fill) => this.handleFill(fill));
    this.userFeed.onOrder((order) => this.handleOrderUpdate(order));

    log.info("✅ WebSockets connected");
  }

  /**
   * Boucle principale - Traite chaque marché selon son état
   */
  private async startMainLoop() {
    log.info("🔄 Starting main loop...");

    let iterationCount = 0;

    while (this.running) {
      try {
        iterationCount++;
        
        // LOG CRITIQUE: Toujours logger les 100 premières itérations pour debug
        if (iterationCount <= 100 || iterationCount % 10 === 0) {
          log.info({
            iteration: iterationCount,
            activeMarkets: this.activeMarkets.size,
            marketIds: Array.from(this.activeMarkets.keys()).map(id => id.substring(0, 16) + '...')
          }, "🔄 Main loop running");
        }

        // Traiter chaque marché actif
        log.debug({
          marketsToProcess: this.activeMarkets.size
        }, "🔄 Processing all active markets...");

        for (const [tokenId, market] of this.activeMarkets.entries()) {
          await this.processMarket(tokenId, market);
        }

        log.debug("✅ All markets processed, sleeping 500ms...");

        // Petite pause pour ne pas spammer
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        log.error({ error: error.message, stack: error.stack }, "❌ Error in main loop");
      }
    }

    log.info("🛑 Main loop stopped");
  }

  /**
   * Traite un marché selon son état actuel
   */
  private async processMarket(tokenId: string, market: CandidateMarket) {
    const state = this.stateMachine.getState(tokenId);
    if (!state) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...'
      }, "⚠️ processMarket: No state found - SKIPPING");
      return;
    }

    // Vérifier les critères de sortie
    const exitReason = await this.checkExitCriteria(tokenId, market);
    if (exitReason) {
      await this.deactivateMarket(tokenId, exitReason);
      return;
    }

    // LOG CRITIQUE: Voir quel état on traite (passage en INFO pour debug)
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: market.slug,
      state: state.state
    }, "🔄 Processing market");

    // Traiter selon l'état
    switch (state.state) {
      case "IDLE":
        await this.handleIdleState(tokenId, market);
        break;

      case "PLACE_BUY":
        await this.handlePlaceBuyState(tokenId, market);
        break;

      case "WAIT_BUY_FILL":
        await this.handleWaitBuyFillState(tokenId, market);
        break;

      case "PLACE_SELL":
        await this.handlePlaceSellState(tokenId, market);
        break;

      case "ASK_CHASE":
        await this.handleAskChaseState(tokenId, market);
        break;

      case "WAIT_SELL_FILL":
        await this.handleWaitSellFillState(tokenId, market);
        break;

      case "COMPLETE":
        // Transition vers IDLE
        this.stateMachine.transitionToIdle(tokenId);
        break;

      case "DEACTIVATING":
        // Marché en cours de désactivation
        break;
    }
  }

  /**
   * État IDLE: Tenter de placer un BUY
   */
  private async handleIdleState(tokenId: string, market: CandidateMarket) {
    // LOG CRITIQUE: Pour confirmer qu'on entre bien dans ce handler
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: market.slug
    }, "🔍 IDLE STATE: Checking if we can place BUY");

    // Récupérer les prix actuels
    const prices = this.marketFeed.getLastPrices(tokenId);
    
    // LOG DÉTAILLÉ: Voir exactement ce que getLastPrices retourne
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      prices: prices,
      hasPrices: !!prices,
      hasBid: prices?.bestBid !== null && prices?.bestBid !== undefined,
      hasAsk: prices?.bestAsk !== null && prices?.bestAsk !== undefined
    }, "📊 Prices check");
    
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: market.slug,
        prices: prices
      }, "⏸️ IDLE: No prices available yet - BLOCKING");
      return; // Pas de prix disponibles
    }

    const { bestBid, bestAsk } = prices;

    // Vérifier le spread
    const spread = bestAsk - bestBid;
    if (spread < MIN_SPREAD_CENTS / 100) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: market.slug,
        spread: (spread * 100).toFixed(2) + '¢',
        minRequired: MIN_SPREAD_CENTS + '¢'
      }, "⏸️ IDLE: Spread too narrow - BLOCKING");
      return; // Spread trop serré
    }

    // Calculer la taille de l'ordre
    const size = this.calculateOrderSize(bestBid);
    if (!size) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: market.slug,
        bestBid: bestBid.toFixed(4)
      }, "⏸️ IDLE: Cannot calculate valid order size - BLOCKING");
      return; // Impossible de calculer une taille valide
    }

    // Vérifier les caps avec RiskManager
    const riskCheck = this.riskManager.canPlaceBuy(tokenId, size, bestBid, spread * 100);
    if (!riskCheck.allowed) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: market.slug,
        size: size.toFixed(2),
        reason: riskCheck.reason
      }, "⏸️ IDLE: Risk check failed - BLOCKING");
      return;
    }

    // Tout est OK, on peut placer le BUY
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: market.slug,
      bestBid: bestBid.toFixed(4),
      bestAsk: bestAsk.toFixed(4),
      spread: (spread * 100).toFixed(2) + '¢',
      size: size.toFixed(2)
    }, "🎯 IDLE → PLACE_BUY: Ready to place BUY order");

    // Transition vers PLACE_BUY
    this.stateMachine.transitionToPlaceBuy(tokenId);
  }

  /**
   * État PLACE_BUY: Placer l'ordre BUY
   */
  private async handlePlaceBuyState(tokenId: string, market: CandidateMarket) {
    const prices = this.marketFeed.getLastPrices(tokenId);
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      return;
    }

    const { bestBid, bestAsk } = prices;
    const size = this.calculateOrderSize(bestBid);
    if (!size) {
      // Retour à IDLE si on ne peut pas calculer la taille
      this.stateMachine.transitionToIdle(tokenId);
      return;
    }

    // Placer l'ordre BUY
    const result = await this.orderManager.placeBuy(tokenId, bestBid, bestAsk, size);

    if (result.success && result.orderId) {
      // Enregistrer dans RiskManager
      this.riskManager.recordBuyOrder(tokenId, size, bestBid);

      // Transition vers WAIT_BUY_FILL
      this.stateMachine.transitionToWaitBuyFill(tokenId, result.orderId, bestBid, size);
    } else {
      // Échec, retour à IDLE
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        error: result.error
      }, "❌ Failed to place BUY, returning to IDLE");
      this.stateMachine.transitionToIdle(tokenId);
    }
  }

  /**
   * État WAIT_BUY_FILL: Attendre le fill ou replace si besoin
   */
  private async handleWaitBuyFillState(tokenId: string, market: CandidateMarket) {
    // LOG CRITIQUE: Confirmer qu'on entre dans ce handler
    log.debug({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: market.slug
    }, "⏳ WAIT_BUY_FILL STATE: Checking for price updates");

    const prices = this.marketFeed.getLastPrices(tokenId);
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: market.slug
      }, "⚠️ WAIT_BUY_FILL: No prices available - SKIPPING");
      return;
    }

    const { bestBid, bestAsk } = prices;

    // VALIDATION: Ignorer prix aberrants (protection contre erreurs WebSocket)
    if (bestBid < 0.001 || bestBid > 0.999 || bestAsk < 0.001 || bestAsk > 0.999) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4)
      }, "⚠️ Ignoring aberrant prices in WAIT_BUY_FILL");
      return;
    }

    const spread = bestAsk - bestBid;
    if (spread < 0.001 || spread > 0.5) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        spread: (spread * 100).toFixed(2) + '¢'
      }, "⚠️ Ignoring aberrant spread in WAIT_BUY_FILL");
      return;
    }

    // Vérifier si on doit replacer
    if (this.orderManager.shouldReplaceBuy(tokenId, bestBid, bestAsk)) {
      const state = this.stateMachine.getState(tokenId);
      if (!state) return;

      // Sauvegarder l'ancien prix/size pour le RiskManager
      const oldPrice = state.buyPrice || 0;
      const oldSize = state.buySize || 0;

      // Replace l'ordre sur l'exchange
      const result = await this.orderManager.replaceBuy(tokenId, bestBid, bestAsk);

      if (result.success && result.orderId) {
        // ✅ SUCCÈS : Mettre à jour le RiskManager (cancel ancien + record nouveau)
        if (oldPrice && oldSize) {
          this.riskManager.cancelBuyOrder(tokenId, oldSize, oldPrice);
        }
        this.riskManager.recordBuyOrder(tokenId, oldSize, bestBid);
        
        // Mettre à jour l'état (pas de transition, on reste en WAIT_BUY_FILL)
        state.buyOrderId = result.orderId;
        state.buyPrice = bestBid;
        state.buyPlacedAt = Date.now();
        
        log.info({
          tokenId: tokenId.substring(0, 20) + '...',
          orderId: result.orderId.substring(0, 16) + '...',
          oldPrice: oldPrice.toFixed(4),
          newPrice: bestBid.toFixed(4)
        }, "🔄 BUY order replaced, staying in WAIT_BUY_FILL");
      } else {
        // ❌ ÉCHEC : Le replace a échoué, on garde l'exposition actuelle
        log.warn({
          tokenId: tokenId.substring(0, 20) + '...',
          oldPrice: oldPrice.toFixed(4),
          attemptedPrice: bestBid.toFixed(4)
        }, "⚠️ BUY replace failed, keeping current order");
      }
    }
  }

  /**
   * État PLACE_SELL: Placer l'ordre SELL
   */
  private async handlePlaceSellState(tokenId: string, market: CandidateMarket) {
    const state = this.stateMachine.getState(tokenId);
    if (!state || !state.positionShares) {
      log.error({ tokenId: tokenId.substring(0, 20) + '...' }, "No position shares for SELL");
      return;
    }

    const prices = this.marketFeed.getLastPrices(tokenId);
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      return;
    }

    const { bestBid, bestAsk } = prices;
    const size = Math.floor(state.positionShares); // Toutes les shares

    // Placer l'ordre SELL
    const result = await this.orderManager.placeSell(tokenId, bestBid, bestAsk, size);

    if (result.success && result.orderId) {
      // Transition vers ASK_CHASE
      this.stateMachine.transitionToAskChase(tokenId, result.orderId, bestAsk, size);
    } else {
      // Échec, réessayer plus tard
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        error: result.error
      }, "❌ Failed to place SELL, will retry");
    }
  }

  /**
   * État ASK_CHASE: Chase the ask si prix change
   */
  private async handleAskChaseState(tokenId: string, market: CandidateMarket) {
    const state = this.stateMachine.getState(tokenId);
    if (!state) return;

    const prices = this.marketFeed.getLastPrices(tokenId);
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      return;
    }

    const { bestBid, bestAsk } = prices;

    // Vérifier si on peut encore chase
    const replaceCount = state.askChaseReplaceCount || 0;
    if (!this.orderManager.canAskChase(tokenId, replaceCount)) {
      // Fenêtre expirée ou max replaces, passer à WAIT_SELL_FILL
      this.stateMachine.transitionToWaitSellFill(tokenId);
      return;
    }

    // Replace si le prix a changé
    const result = await this.orderManager.replaceSell(tokenId, bestBid, bestAsk);

    if (result.success) {
      this.stateMachine.incrementAskChaseReplace(tokenId);
    }
  }

  /**
   * État WAIT_SELL_FILL: Attendre le fill SELL ou replace si besoin
   * NOUVEAU : Replace continu au bestAsk si le prix change (comme pour BUY)
   */
  private async handleWaitSellFillState(tokenId: string, market: CandidateMarket) {
    // LOG CRITIQUE: Confirmer qu'on entre dans ce handler
    log.debug({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: market.slug
    }, "⏳ WAIT_SELL_FILL STATE: Checking for price updates");

    const prices = this.marketFeed.getLastPrices(tokenId);
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: market.slug
      }, "⚠️ WAIT_SELL_FILL: No prices available - SKIPPING");
      return;
    }

    const { bestBid, bestAsk } = prices;

    // VALIDATION: Ignorer prix aberrants (protection contre erreurs WebSocket)
    if (bestBid < 0.001 || bestBid > 0.999 || bestAsk < 0.001 || bestAsk > 0.999) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4)
      }, "⚠️ Ignoring aberrant prices in WAIT_SELL_FILL");
      return;
    }

    const spread = bestAsk - bestBid;
    if (spread < 0.001 || spread > 0.5) {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        spread: (spread * 100).toFixed(2) + '¢'
      }, "⚠️ Ignoring aberrant spread in WAIT_SELL_FILL");
      return;
    }

    // Vérifier si on doit replacer le SELL
    if (this.orderManager.shouldReplaceSell(tokenId, bestBid, bestAsk)) {
      const state = this.stateMachine.getState(tokenId);
      if (!state) return;

      // Replace
      const result = await this.orderManager.replaceSell(tokenId, bestBid, bestAsk);

      if (result.success && result.orderId) {
        // Juste mettre à jour les données de l'ordre (pas de transition)
        state.sellOrderId = result.orderId;
        state.sellPrice = bestAsk;
        state.sellPlacedAt = Date.now();
        
        log.info({
          tokenId: tokenId.substring(0, 20) + '...',
          orderId: result.orderId.substring(0, 16) + '...',
          price: bestAsk.toFixed(4)
        }, "🔄 SELL order replaced, staying in WAIT_SELL_FILL");
      }
    }
  }

  /**
   * Gère un fill reçu du UserFeed
   */
  private handleFill(fill: FillEvent) {
    const tokenId = fill.asset;
    
    log.info({
      tokenId: tokenId?.substring(0, 20) + '...' || 'unknown',
      orderId: fill.orderId?.substring(0, 16) + '...' || 'unknown',
      side: fill.side,
      price: fill.price,
      size: fill.size,
      rawFill: fill
    }, "🔔 Fill received from UserFeed");
    
    const state = this.stateMachine.getState(tokenId);
    if (!state) {
      log.warn({
        tokenId: tokenId?.substring(0, 20) + '...' || 'unknown',
        orderId: fill.orderId?.substring(0, 16) + '...' || 'unknown',
        availableMarkets: Array.from(this.activeMarkets.keys()).map(k => k.substring(0, 20) + '...')
      }, "❌ Fill received for unknown market");
      return;
    }

    const size = parseFloat(fill.size);
    const price = parseFloat(fill.price);

    log.info({
      slug: state.marketSlug,
      tokenId: tokenId.substring(0, 20) + '...',
      orderId: fill.orderId?.substring(0, 16) + '...' || 'unknown',
      side: fill.side,
      price: price.toFixed(4),
      size,
      currentState: state.state
    }, "💰 Fill received for active market");

    // Retirer l'ordre actif
    this.orderManager.removeActiveOrder(tokenId);

    if (fill.side === "BUY" && state.state === "WAIT_BUY_FILL") {
      // BUY fill: transition vers PLACE_SELL
      log.info({
        slug: state.marketSlug,
        filledSize: size
      }, "✅ BUY filled → transitioning to PLACE_SELL");
      this.stateMachine.transitionToPlaceSell(tokenId, size);
    } else if (fill.side === "SELL" && (state.state === "ASK_CHASE" || state.state === "WAIT_SELL_FILL")) {
      // SELL fill: enregistrer dans RiskManager et transition vers COMPLETE
      log.info({
        slug: state.marketSlug,
        filledSize: size
      }, "✅ SELL filled → transitioning to COMPLETE");
      this.riskManager.recordSellFill(tokenId, size, price);
      this.stateMachine.transitionToComplete(tokenId);
    } else {
      log.warn({
        slug: state.marketSlug,
        fillSide: fill.side,
        currentState: state.state
      }, "⚠️ Fill received but state/side mismatch");
    }
  }

  /**
   * Gère les mises à jour d'ordres
   */
  private handleOrderUpdate(order: OrderEvent) {
    log.debug({
      orderId: order.orderId.substring(0, 16) + '...',
      status: order.status,
      side: order.side
    }, "📋 Order update");

    // Si l'ordre est cancelled, le retirer
    if (order.status === "CANCELLED") {
      const tokenId = order.asset;
      const state = this.stateMachine.getState(tokenId);
      
      if (state) {
        // Vérifier si l'ordre cancelled correspond à l'ordre actuel
        const isBuyOrder = order.side === "BUY" && state.buyOrderId === order.orderId;
        const isSellOrder = order.side === "SELL" && state.sellOrderId === order.orderId;
        
        if (!isBuyOrder && !isSellOrder) {
          // C'est un ancien ordre (déjà replacé), on l'ignore
          log.debug({
            orderId: order.orderId.substring(0, 16) + '...',
            currentBuyOrderId: state.buyOrderId?.substring(0, 16) + '...',
            currentSellOrderId: state.sellOrderId?.substring(0, 16) + '...'
          }, "🗑️ Ignoring CANCELLED event for old order");
          return;
        }

        // C'est notre ordre actuel qui a été annulé (annulation externe, pas un replace)
        this.orderManager.removeActiveOrder(tokenId);

        // Si on était en WAIT_BUY_FILL, retourner à IDLE
        if (state.state === "WAIT_BUY_FILL" && isBuyOrder) {
          // Cancel dans RiskManager
          if (state.buyPrice && state.buySize) {
            this.riskManager.cancelBuyOrder(tokenId, state.buySize, state.buyPrice);
          }
          log.warn({
            tokenId: tokenId.substring(0, 20) + '...',
            orderId: order.orderId.substring(0, 16) + '...'
          }, "⚠️ BUY order cancelled externally, returning to IDLE");
          this.stateMachine.transitionToIdle(tokenId);
        }
      }
    }
  }

  /**
   * Gère les mises à jour de prix du MarketFeed
   */
  private handlePriceUpdate(tokenId: string, bestBid: number | null, bestAsk: number | null) {
    // Log seulement si utile
    log.debug({
      tokenId: tokenId.substring(0, 20) + '...',
      bestBid: bestBid?.toFixed(4),
      bestAsk: bestAsk?.toFixed(4)
    }, "💹 Price update");
  }

  /**
   * Calcule la taille de l'ordre en fonction du notional et du prix
   */
  private calculateOrderSize(price: number): number | null {
    // Polymarket impose un minimum de 5 shares par ordre sur certains marchés
    // On calcule la size pour respecter à la fois MIN_NOTIONAL et 5 shares minimum
    const POLYMARKET_MIN_SHARES = 5.0;
    
    // Calculer la size depuis le notional
    const notional = MIN_NOTIONAL_PER_ORDER_USDC;
    let size = notional / price;

    // Arrondir vers le bas à 2 décimales
    size = Math.floor(size * 100) / 100;

    // Appliquer le maximum entre MIN_SIZE_SHARES et POLYMARKET_MIN_SHARES
    const effectiveMinSize = Math.max(MIN_SIZE_SHARES, POLYMARKET_MIN_SHARES);
    
    if (size < effectiveMinSize) {
      // Si la size calculée est trop petite, augmenter au minimum requis
      size = effectiveMinSize;
      
      log.debug({
        price: price.toFixed(4),
        notional,
        calculatedSize: (notional / price).toFixed(2),
        adjustedSize: size,
        minRequired: effectiveMinSize,
        newNotional: (size * price).toFixed(2)
      }, "⚠️ Size adjusted to Polymarket minimum (5 shares)");
    }

    return size;
  }

  /**
   * Vérifie les critères de sortie d'un marché
   * Retourne la raison si le marché doit être désactivé
   */
  private async checkExitCriteria(tokenId: string, market: CandidateMarket): Promise<string | null> {
    const state = this.stateMachine.getState(tokenId);
    if (!state) return null;

    // Grace period de 30 secondes après initialisation
    const marketAge = Date.now() - state.initializedAt;
    const GRACE_PERIOD_MS = 30_000;
    
    if (marketAge < GRACE_PERIOD_MS) {
      // Pendant la grace period, ne pas désactiver pour "no_prices"
      return null;
    }

    // Récupérer les prix actuels
    const prices = this.marketFeed.getLastPrices(tokenId);
    if (!prices || prices.bestBid === null || prices.bestAsk === null) {
      log.warn({
        slug: state.marketSlug,
        tokenId: tokenId.substring(0, 20) + '...',
        marketAge: `${(marketAge / 1000).toFixed(0)}s`
      }, "⚠️ No prices after grace period");
      return "no_prices";
    }

    const { bestBid, bestAsk } = prices;
    const spread = bestAsk - bestBid;

    // Vérifier le spread
    if (spread < MIN_SPREAD_CENTS / 100) {
      return `spread_too_small: ${(spread * 100).toFixed(2)}¢`;
    }

    // TODO: Ajouter d'autres critères (depth, volume, time to close)

    return null; // Pas de sortie nécessaire
  }

  /**
   * Désactive un marché (retrait)
   */
  private async deactivateMarket(tokenId: string, reason: string) {
    const state = this.stateMachine.getState(tokenId);
    if (!state) return;

    log.warn({
      slug: state.marketSlug,
      tokenId: tokenId.substring(0, 20) + '...',
      reason
    }, "🚪 Deactivating market");

    // Transition vers DEACTIVATING
    this.stateMachine.transitionToDeactivating(tokenId, reason);

    // Annuler les ordres actifs
    await this.orderManager.cancelOrder(tokenId);

    // Si on a une position, essayer de la liquider
    if (state.positionShares && state.positionShares > 0) {
      log.info({
        slug: state.marketSlug,
        positionShares: state.positionShares
      }, "🔄 Liquidating position");

      // Placer un SELL au best ask
      const prices = this.marketFeed.getLastPrices(tokenId);
      if (prices && prices.bestBid && prices.bestAsk) {
        await this.orderManager.placeSell(
          tokenId,
          prices.bestBid,
          prices.bestAsk,
          Math.floor(state.positionShares)
        );
      }
    }

    // Nettoyer
    this.riskManager.cleanMarket(tokenId);
    this.stateMachine.removeMarket(tokenId);
    this.activeMarkets.delete(tokenId);

    log.info({
      slug: state.marketSlug,
      tokenId: tokenId.substring(0, 20) + '...'
    }, "✅ Market deactivated");

    // TODO: Remplacer par un nouveau marché si disponible
  }

  /**
   * Démarre les tâches périodiques
   */
  private startPeriodicTasks() {
    // Métriques toutes les 60s
    this.metricsInterval = setInterval(() => {
      this.logMetrics();
    }, METRICS_LOG_INTERVAL_MS);

    // Réconciliation toutes les 60s
    this.reconcileInterval = setInterval(() => {
      this.reconcile();
    }, RECONCILE_INTERVAL_MS);

    // Health check des marchés toutes les 3 minutes
    this.marketHealthInterval = setInterval(() => {
      this.checkMarketHealth();
    }, 180_000);

    log.info("⏱️ Periodic tasks started");
  }

  /**
   * Log les métriques
   */
  private logMetrics() {
    log.info({ separator: "=".repeat(60) }, "📊 METRICS REPORT");
    this.stateMachine.logStates();
    this.riskManager.logMetrics();
    this.orderManager.logActiveOrders();
  }

  /**
   * Réconciliation périodique
   */
  private async reconcile() {
    log.info("🔄 Starting reconciliation...");
    // TODO: Implémenter la réconciliation avec l'API REST
  }

  /**
   * Vérifie la santé des marchés
   */
  private checkMarketHealth() {
    for (const [tokenId, market] of this.activeMarkets.entries()) {
      const isActive = this.marketFeed.isMarketActive(tokenId, 5 * 60 * 1000);
      if (!isActive) {
        log.warn({
          slug: market.slug,
          tokenId: tokenId.substring(0, 20) + '...'
        }, "⚠️ Market inactive (no price updates in 5 minutes)");
      }
    }
  }

  /**
   * Arrête le market maker proprement
   */
  async stop() {
    log.info("🛑 Stopping Market Maker...");
    this.running = false;

    // Arrêter les timers
    if (this.metricsInterval) clearInterval(this.metricsInterval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    if (this.marketHealthInterval) clearInterval(this.marketHealthInterval);

    // Annuler tous les ordres actifs
    for (const tokenId of this.activeMarkets.keys()) {
      await this.orderManager.cancelOrder(tokenId);
    }

    // Fermer les WebSockets
    this.marketFeed.disconnect();
    this.userFeed.disconnect();

    log.info("✅ Market Maker stopped");
  }
}

