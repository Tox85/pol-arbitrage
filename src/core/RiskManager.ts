// Risk Manager - Gestion des caps et contraintes d'exposition
import pino from "pino";
import {
  MAX_SHARES_PER_MARKET,
  MAX_USDC_PER_MARKET,
  MAX_NOTIONAL_AT_RISK_USDC,
  MIN_NOTIONAL_PER_ORDER_USDC,
  MIN_EXPECTED_PROFIT_USDC,
  MIN_SIZE_SHARES
} from "../config";

const log = pino({ name: "risk" });

export type ExposureByMarket = {
  tokenId: string;
  shares: number;
  notionalUsdc: number;
};

export class RiskManager {
  // Exposition par marché (tokenId -> shares & notional)
  private exposureByMarket = new Map<string, ExposureByMarket>();
  
  // Notional global à risque (somme de tous les ordres actifs)
  private globalNotionalAtRisk = 0;

  constructor() {
    log.info("📊 Risk Manager initialized");
  }

  /**
   * Vérifie si on peut placer un ordre BUY sans dépasser les caps
   */
  canPlaceBuy(
    tokenId: string,
    sizeShares: number,
    price: number,
    spreadCents: number
  ): { allowed: boolean; reason?: string } {
    // Calculer le notional
    const notional = sizeShares * price;

    // Vérification 1: Min notional (avec tolérance 0.5% pour erreurs d'arrondi)
    const minNotionalWithTolerance = MIN_NOTIONAL_PER_ORDER_USDC * 0.995;
    if (notional < minNotionalWithTolerance) {
      return {
        allowed: false,
        reason: `min_notional: ${notional.toFixed(3)} < ${MIN_NOTIONAL_PER_ORDER_USDC}`
      };
    }

    // Vérification 2: Expected profit minimal
    const expectedProfit = (spreadCents / 100) * notional;
    if (expectedProfit < MIN_EXPECTED_PROFIT_USDC) {
      return {
        allowed: false,
        reason: `expected_profit_low: ${expectedProfit.toFixed(4)} < ${MIN_EXPECTED_PROFIT_USDC}`
      };
    }

    // Vérification 3: Minimum shares
    if (sizeShares < MIN_SIZE_SHARES) {
      return {
        allowed: false,
        reason: `min_size: ${sizeShares} < ${MIN_SIZE_SHARES}`
      };
    }

    // Vérification 4: Cap shares par marché
    const currentExposure = this.exposureByMarket.get(tokenId);
    const currentShares = currentExposure?.shares || 0;
    if (currentShares + sizeShares > MAX_SHARES_PER_MARKET) {
      return {
        allowed: false,
        reason: `shares_cap: ${currentShares + sizeShares} > ${MAX_SHARES_PER_MARKET}`
      };
    }

    // Vérification 5: Cap notional par marché
    const currentNotional = currentExposure?.notionalUsdc || 0;
    if (currentNotional + notional > MAX_USDC_PER_MARKET) {
      return {
        allowed: false,
        reason: `market_notional_cap: ${(currentNotional + notional).toFixed(2)} > ${MAX_USDC_PER_MARKET}`
      };
    }

    // Vérification 6: Cap notional global
    if (this.globalNotionalAtRisk + notional > MAX_NOTIONAL_AT_RISK_USDC) {
      return {
        allowed: false,
        reason: `global_notional_cap: ${(this.globalNotionalAtRisk + notional).toFixed(2)} > ${MAX_NOTIONAL_AT_RISK_USDC}`
      };
    }

    return { allowed: true };
  }

  /**
   * Enregistre un ordre BUY placé (ajoute à l'exposition)
   */
  recordBuyOrder(tokenId: string, sizeShares: number, price: number) {
    const notional = sizeShares * price;
    
    const current = this.exposureByMarket.get(tokenId) || {
      tokenId,
      shares: 0,
      notionalUsdc: 0
    };

    current.shares += sizeShares;
    current.notionalUsdc += notional;
    
    this.exposureByMarket.set(tokenId, current);
    this.globalNotionalAtRisk += notional;

    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      addedShares: sizeShares,
      addedNotional: notional.toFixed(2),
      totalShares: current.shares,
      totalNotional: current.notionalUsdc.toFixed(2),
      globalAtRisk: this.globalNotionalAtRisk.toFixed(2)
    }, "📈 BUY order recorded");
  }

  /**
   * Enregistre un ordre SELL rempli (retire de l'exposition)
   */
  recordSellFill(tokenId: string, sizeShares: number, price: number) {
    const notional = sizeShares * price;
    
    const current = this.exposureByMarket.get(tokenId);
    if (!current) {
      log.warn({ tokenId: tokenId.substring(0, 20) + '...' }, "No exposure found for SELL fill");
      return;
    }

    current.shares = Math.max(0, current.shares - sizeShares);
    current.notionalUsdc = Math.max(0, current.notionalUsdc - notional);
    
    this.exposureByMarket.set(tokenId, current);
    this.globalNotionalAtRisk = Math.max(0, this.globalNotionalAtRisk - notional);

    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      removedShares: sizeShares,
      removedNotional: notional.toFixed(2),
      remainingShares: current.shares,
      remainingNotional: current.notionalUsdc.toFixed(2),
      globalAtRisk: this.globalNotionalAtRisk.toFixed(2)
    }, "📉 SELL fill recorded");
  }

  /**
   * Annule un ordre BUY (retire de l'exposition)
   */
  cancelBuyOrder(tokenId: string, sizeShares: number, price: number) {
    const notional = sizeShares * price;
    
    const current = this.exposureByMarket.get(tokenId);
    if (!current) {
      log.warn({ tokenId: tokenId.substring(0, 20) + '...' }, "No exposure found for BUY cancel");
      return;
    }

    current.shares = Math.max(0, current.shares - sizeShares);
    current.notionalUsdc = Math.max(0, current.notionalUsdc - notional);
    
    this.exposureByMarket.set(tokenId, current);
    this.globalNotionalAtRisk = Math.max(0, this.globalNotionalAtRisk - notional);

    log.info({
      tokenId: tokenId.substring(0, 20) + '...',
      cancelledShares: sizeShares,
      cancelledNotional: notional.toFixed(2),
      remainingShares: current.shares,
      remainingNotional: current.notionalUsdc.toFixed(2),
      globalAtRisk: this.globalNotionalAtRisk.toFixed(2)
    }, "🗑️ BUY order cancelled");
  }

  /**
   * Retourne l'exposition pour un marché
   */
  getExposure(tokenId: string): ExposureByMarket {
    return this.exposureByMarket.get(tokenId) || {
      tokenId,
      shares: 0,
      notionalUsdc: 0
    };
  }

  /**
   * Retourne le notional global à risque
   */
  getGlobalNotionalAtRisk(): number {
    return this.globalNotionalAtRisk;
  }

  /**
   * Log les métriques de risque
   */
  logMetrics() {
    const markets = Array.from(this.exposureByMarket.values()).filter(
      e => e.shares > 0 || e.notionalUsdc > 0
    );

    log.info({
      globalAtRisk: this.globalNotionalAtRisk.toFixed(2),
      maxAllowed: MAX_NOTIONAL_AT_RISK_USDC,
      percentUsed: ((this.globalNotionalAtRisk / MAX_NOTIONAL_AT_RISK_USDC) * 100).toFixed(1) + '%',
      activeMarkets: markets.length,
      markets: markets.map(m => ({
        tokenId: m.tokenId.substring(0, 20) + '...',
        shares: m.shares.toFixed(2),
        notional: m.notionalUsdc.toFixed(2)
      }))
    }, "💼 Risk metrics");
  }

  /**
   * Nettoie un marché (retire de l'exposition)
   */
  cleanMarket(tokenId: string) {
    const exposure = this.exposureByMarket.get(tokenId);
    if (exposure) {
      this.globalNotionalAtRisk = Math.max(0, this.globalNotionalAtRisk - exposure.notionalUsdc);
      this.exposureByMarket.delete(tokenId);
      
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        removedShares: exposure.shares,
        removedNotional: exposure.notionalUsdc.toFixed(2),
        globalAtRisk: this.globalNotionalAtRisk.toFixed(2)
      }, "🧹 Market cleaned from exposure");
    }
  }
}

