// src/risk/pinGuard.ts
// Protection contre les marchés à probabilités extrêmes (pin risk)
// Évite l'accumulation de positions sur des marchés proche de 0 ou 1

/**
 * Vérifie si un marché est dans une zone de pin-risk
 * Pin-risk = probabilité très proche de 0 ou 1
 * Risque: Le marché peut se résoudre et causer une perte totale
 */
export function isPinRisk(
  bestBid: number,
  bestAsk: number,
  tickSize: number,
  options: {
    highThreshold?: number; // Seuil haut (default: 0.98)
    lowThreshold?: number;  // Seuil bas (default: 0.02)
    minSpread?: number;     // Spread minimum (default: 2 ticks)
  } = {}
): boolean {
  const highThreshold = options.highThreshold || 0.98;
  const lowThreshold = options.lowThreshold || 0.02;
  const minSpread = options.minSpread || (2 * tickSize);
  
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  
  // Pin-risk si mid > 0.98 ou mid < 0.02
  const isPinned = mid > highThreshold || mid < lowThreshold;
  
  // Également si spread < 2 ticks (marché trop serré, risque adverse selection)
  const isTooTight = spread < minSpread;
  
  return isPinned || isTooTight;
}

/**
 * Calcule les restrictions à appliquer en zone pin-risk
 * Retourne: { allowBuy, allowSell, maxExposure, reason }
 */
export function getPinRiskRestrictions(
  bestBid: number,
  bestAsk: number,
  currentInventory: number,
  options: {
    highThreshold?: number;
    lowThreshold?: number;
  } = {}
): {
  allowBuy: boolean;
  allowSell: boolean;
  maxExposureMultiplier: number;
  reason?: string;
} {
  const highThreshold = options.highThreshold || 0.98;
  const lowThreshold = options.lowThreshold || 0.02;
  
  const mid = (bestBid + bestAsk) / 2;
  
  // Si proche de 1.00 (YES va gagner)
  if (mid > highThreshold) {
    return {
      allowBuy: false, // NE PAS acheter proche de 1.00 (trop risqué)
      allowSell: currentInventory > 0, // Seulement vendre si on a de l'inventaire
      maxExposureMultiplier: 0.5, // Réduire expo max de 50%
      reason: `Pin-risk HIGH (mid=${mid.toFixed(4)} > ${highThreshold})`
    };
  }
  
  // Si proche de 0.00 (NO va gagner)
  if (mid < lowThreshold) {
    return {
      allowBuy: currentInventory < 0, // Seulement acheter pour fermer short
      allowSell: false, // NE PAS vendre proche de 0.00 (trop risqué)
      maxExposureMultiplier: 0.5,
      reason: `Pin-risk LOW (mid=${mid.toFixed(4)} < ${lowThreshold})`
    };
  }
  
  // Zone normale
  return {
    allowBuy: true,
    allowSell: true,
    maxExposureMultiplier: 1.0,
    reason: undefined
  };
}

/**
 * Calcule le TTL ajusté en fonction du pin-risk
 * Plus on est proche de 0/1, plus le TTL doit être court
 */
export function getPinAdjustedTTL(
  mid: number,
  baseTTL: number,
  pinThreshold: number = 0.98
): number {
  if (mid > pinThreshold || mid < (1 - pinThreshold)) {
    // Proche de pin: TTL divisé par 2
    return Math.floor(baseTTL / 2);
  }
  
  return baseTTL;
}

