// State Machine - Gestion des états par marché
// États: IDLE → PLACE_BUY → WAIT_BUY_FILL → PLACE_SELL → ASK_CHASE → WAIT_SELL_FILL → COMPLETE → IDLE
//        ↳ DEACTIVATING (si retrait requis)
import pino from "pino";

const log = pino({ name: "state" });

export type MarketState =
  | "IDLE"
  | "PLACE_BUY"
  | "WAIT_BUY_FILL"
  | "PLACE_SELL"
  | "ASK_CHASE"
  | "WAIT_SELL_FILL"
  | "COMPLETE"
  | "DEACTIVATING";

export type StateData = {
  state: MarketState;
  tokenId: string;
  marketSlug: string;
  
  // Données de l'ordre BUY
  buyOrderId?: string;
  buyPrice?: number;
  buySize?: number;
  buyPlacedAt?: number;
  
  // Données de l'ordre SELL
  sellOrderId?: string;
  sellPrice?: number;
  sellSize?: number;
  sellPlacedAt?: number;
  
  // Ask chase tracking
  askChaseStartedAt?: number;
  askChaseReplaceCount?: number;
  
  // Shares en position
  positionShares?: number;
  
  // Timestamp de la dernière transition
  lastTransitionAt: number;
  
  // Timestamp d'initialisation du marché
  initializedAt: number;
};

export class StateMachine {
  // État par tokenId
  private states = new Map<string, StateData>();

  constructor() {
    log.info("🔄 State Machine initialized");
  }

  /**
   * Initialise un nouveau marché en état IDLE
   */
  initMarket(tokenId: string, marketSlug: string) {
    const now = Date.now();
    this.states.set(tokenId, {
      state: "IDLE",
      tokenId,
      marketSlug,
      lastTransitionAt: now,
      initializedAt: now
    });
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: marketSlug,
      state: "IDLE"
    }, "🆕 Market initialized");
  }

  /**
   * Retourne l'état actuel d'un marché
   */
  getState(tokenId: string): StateData | undefined {
    return this.states.get(tokenId);
  }

  /**
   * Vérifie si un marché est en état IDLE
   */
  isIdle(tokenId: string): boolean {
    const state = this.states.get(tokenId);
    return state?.state === "IDLE";
  }

  /**
   * Transition: IDLE → PLACE_BUY
   */
  transitionToPlaceBuy(tokenId: string) {
    const state = this.states.get(tokenId);
    if (!state) {
      log.error({ tokenId: tokenId.substring(0, 20) + '...' }, "Cannot transition: market not initialized");
      return;
    }

    if (state.state !== "IDLE") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to PLACE_BUY from non-IDLE state");
      return;
    }

    state.state = "PLACE_BUY";
    state.lastTransitionAt = Date.now();
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      transition: "IDLE → PLACE_BUY"
    }, "🔄 State transition");
  }

  /**
   * Transition: PLACE_BUY → WAIT_BUY_FILL
   */
  transitionToWaitBuyFill(
    tokenId: string,
    orderId: string,
    price: number,
    size: number
  ) {
    const state = this.states.get(tokenId);
    if (!state) return;

    if (state.state !== "PLACE_BUY") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to WAIT_BUY_FILL from non-PLACE_BUY state");
      return;
    }

    state.state = "WAIT_BUY_FILL";
    state.buyOrderId = orderId;
    state.buyPrice = price;
    state.buySize = size;
    state.buyPlacedAt = Date.now();
    state.lastTransitionAt = Date.now();
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      orderId: orderId.substring(0, 16) + '...',
      price: price.toFixed(4),
      size,
      transition: "PLACE_BUY → WAIT_BUY_FILL"
    }, "🔄 State transition");
  }

  /**
   * Transition: WAIT_BUY_FILL → PLACE_SELL (sur fill BUY)
   */
  transitionToPlaceSell(tokenId: string, filledSize: number) {
    const state = this.states.get(tokenId);
    if (!state) return;

    if (state.state !== "WAIT_BUY_FILL") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to PLACE_SELL from non-WAIT_BUY_FILL state");
      return;
    }

    state.state = "PLACE_SELL";
    state.positionShares = filledSize;
    state.lastTransitionAt = Date.now();
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      filledSize,
      transition: "WAIT_BUY_FILL → PLACE_SELL"
    }, "🔄 State transition");
  }

  /**
   * Transition: PLACE_SELL → ASK_CHASE
   */
  transitionToAskChase(
    tokenId: string,
    orderId: string,
    price: number,
    size: number
  ) {
    const state = this.states.get(tokenId);
    if (!state) return;

    if (state.state !== "PLACE_SELL") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to ASK_CHASE from non-PLACE_SELL state");
      return;
    }

    state.state = "ASK_CHASE";
    state.sellOrderId = orderId;
    state.sellPrice = price;
    state.sellSize = size;
    state.sellPlacedAt = Date.now();
    state.askChaseStartedAt = Date.now();
    state.askChaseReplaceCount = 0;
    state.lastTransitionAt = Date.now();
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      orderId: orderId.substring(0, 16) + '...',
      price: price.toFixed(4),
      size,
      transition: "PLACE_SELL → ASK_CHASE"
    }, "🔄 State transition");
  }

  /**
   * Transition: ASK_CHASE → WAIT_SELL_FILL (fin de la fenêtre ou max replaces)
   */
  transitionToWaitSellFill(tokenId: string) {
    const state = this.states.get(tokenId);
    if (!state) return;

    if (state.state !== "ASK_CHASE") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to WAIT_SELL_FILL from non-ASK_CHASE state");
      return;
    }

    state.state = "WAIT_SELL_FILL";
    state.lastTransitionAt = Date.now();
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      chaseReplaces: state.askChaseReplaceCount,
      transition: "ASK_CHASE → WAIT_SELL_FILL"
    }, "🔄 State transition");
  }

  /**
   * Transition: WAIT_SELL_FILL → COMPLETE (sur fill SELL)
   */
  transitionToComplete(tokenId: string) {
    const state = this.states.get(tokenId);
    if (!state) return;

    if (state.state !== "WAIT_SELL_FILL" && state.state !== "ASK_CHASE") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to COMPLETE from invalid state");
      return;
    }

    state.state = "COMPLETE";
    state.lastTransitionAt = Date.now();
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      transition: `${state.state} → COMPLETE`
    }, "🔄 State transition");
  }

  /**
   * Transition: COMPLETE → IDLE (cycle terminé)
   * AUSSI: PLACE_BUY → IDLE si l'ordre échoue
   */
  transitionToIdle(tokenId: string) {
    const state = this.states.get(tokenId);
    if (!state) return;

    // Autoriser la transition depuis COMPLETE ou PLACE_BUY (si ordre échoué)
    if (state.state !== "COMPLETE" && state.state !== "PLACE_BUY") {
      log.warn({
        tokenId: tokenId.substring(0, 20) + '...',
        currentState: state.state
      }, "Cannot transition to IDLE from non-COMPLETE/non-PLACE_BUY state");
      return;
    }

    // Reset tout sauf tokenId, marketSlug et initializedAt
    const { tokenId: tid, marketSlug, initializedAt } = state;
    this.states.set(tokenId, {
      state: "IDLE",
      tokenId: tid,
      marketSlug,
      lastTransitionAt: Date.now(),
      initializedAt
    });
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: marketSlug,
      transition: "COMPLETE → IDLE"
    }, "🔄 Cycle completed");
  }

  /**
   * Transition: * → DEACTIVATING (retrait demandé)
   */
  transitionToDeactivating(tokenId: string, reason: string) {
    const state = this.states.get(tokenId);
    if (!state) return;

    const oldState = state.state;
    state.state = "DEACTIVATING";
    state.lastTransitionAt = Date.now();
    
    log.warn({
      tokenId: tokenId.substring(0, 20) + '...',
      slug: state.marketSlug,
      oldState,
      reason,
      transition: `${oldState} → DEACTIVATING`
    }, "⚠️ Market deactivating");
  }

  /**
   * Incrémente le compteur de replace pour ask chase
   */
  incrementAskChaseReplace(tokenId: string) {
    const state = this.states.get(tokenId);
    if (!state || state.state !== "ASK_CHASE") return;

    state.askChaseReplaceCount = (state.askChaseReplaceCount || 0) + 1;
    
    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      replaceCount: state.askChaseReplaceCount
    }, "🔄 Ask chase replace");
  }

  /**
   * Supprime un marché du state
   */
  removeMarket(tokenId: string) {
    const state = this.states.get(tokenId);
    if (state) {
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        slug: state.marketSlug,
        finalState: state.state
      }, "🗑️ Market removed from state machine");
      
      this.states.delete(tokenId);
    }
  }

  /**
   * Log l'état de tous les marchés actifs
   */
  logStates() {
    const markets = Array.from(this.states.values());
    
    log.info({
      totalMarkets: markets.length,
      states: markets.reduce((acc, m) => {
        acc[m.state] = (acc[m.state] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      details: markets.map(m => ({
        slug: m.marketSlug,
        state: m.state,
        tokenId: m.tokenId.substring(0, 20) + '...',
        positionShares: m.positionShares,
        buyOrderId: m.buyOrderId?.substring(0, 16) + '...',
        sellOrderId: m.sellOrderId?.substring(0, 16) + '...'
      }))
    }, "🔄 State machine status");
  }
}

