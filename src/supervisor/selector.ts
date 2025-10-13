// src/supervisor/selector.ts
// Sélecteur dynamique top-K marchés avec rescoring continu

import pino from "pino";
import { PolyClobClient } from "../clients/polySDK";
import { fetchAllOpenTradableMarkets } from "../clients/gamma";
import { MIN_SPREAD_CENTS, MAX_SPREAD_CENTS, MIN_VOLUME_USDC, MAX_ACTIVE_MARKETS } from "../config";

const log = pino({ name: "selector" });

export type MarketCandidate = {
  conditionId: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  volume24hr: number;
  spread: number;
  score: number;
  minOrderSize: number;
  tickSize: number;
};

export type SelectorConfig = {
  rescoreIntervalMs: number; // Interval de rescoring (5000-10000ms)
  failCyclesBeforeDrop: number; // Nombre de cycles échoués avant drop (3)
  maxActiveMarkets: number; // K marchés actifs (MAX_ACTIVE_MARKETS)
  minSpreadCents: number;
  maxSpreadCents: number;
  minVolumeUsdc: number;
};

export class MarketSelector {
  private clob: PolyClobClient;
  private config: SelectorConfig;
  private rescoreTimer?: NodeJS.Timeout;
  private activeSet: Set<string> = new Set(); // conditionIds actifs
  private failCounters: Map<string, number> = new Map(); // conditionId → nb échecs consécutifs
  private onReplaceCallback?: (leave: MarketCandidate[], join: MarketCandidate[]) => Promise<void>;

  constructor(clob: PolyClobClient, config: SelectorConfig) {
    this.clob = clob;
    this.config = config;
    log.info({ config }, "📊 MarketSelector initialized");
  }

  /**
   * Callback appelé quand des marchés doivent être remplacés
   */
  onReplace(callback: (leave: MarketCandidate[], join: MarketCandidate[]) => Promise<void>) {
    this.onReplaceCallback = callback;
  }

  /**
   * Démarre le rescoring périodique
   */
  async start() {
    log.info({ intervalMs: this.config.rescoreIntervalMs }, "🚀 Starting dynamic market selection");

    // Premier rescoring immédiat
    await this.rescore();

    // Rescoring périodique
    this.rescoreTimer = setInterval(async () => {
      await this.rescore();
    }, this.config.rescoreIntervalMs);
  }

  /**
   * Arrête le sélecteur
   */
  stop() {
    if (this.rescoreTimer) {
      clearInterval(this.rescoreTimer);
      this.rescoreTimer = undefined;
    }
    log.info("⏹️ MarketSelector stopped");
  }

  /**
   * Rescoring des marchés : Top-K dynamique
   */
  private async rescore() {
    try {
      // 1. Récupérer watchlist depuis Gamma
      const allMarkets = await fetchAllOpenTradableMarkets(200);
      
      // 2. Filtrer marchés éligibles
      const eligible = await this.filterEligible(allMarkets);
      
      if (eligible.length === 0) {
        log.warn("⚠️ No eligible markets found");
        return;
      }

      // 3. Ranking par score (spread × volume)
      eligible.sort((a, b) => b.score - a.score);
      
      // 4. Top-K marchés
      const topK = eligible.slice(0, this.config.maxActiveMarkets);
      const topKIds = new Set(topK.map(m => m.conditionId));

      // 5. Calculer leave & join
      const leave: MarketCandidate[] = [];
      const join: MarketCandidate[] = [];

      // Markets à laisser : actifs mais plus dans top-K OU échecs multiples
      for (const conditionId of this.activeSet) {
        if (!topKIds.has(conditionId)) {
          const market = eligible.find(m => m.conditionId === conditionId);
          if (market) {
            leave.push(market);
          }
        }
      }

      // Markets à joindre : dans top-K mais pas encore actifs
      for (const market of topK) {
        if (!this.activeSet.has(market.conditionId)) {
          join.push(market);
        }
      }

      // 6. Appliquer changements
      if (leave.length > 0 || join.length > 0) {
        log.info({
          leave: leave.map(m => m.slug),
          join: join.map(m => m.slug),
          activeCount: this.activeSet.size
        }, "🔄 Market rotation");

        // Mettre à jour activeSet
        for (const m of leave) {
          this.activeSet.delete(m.conditionId);
          this.failCounters.delete(m.conditionId);
        }
        for (const m of join) {
          this.activeSet.add(m.conditionId);
        }

        // Notifier callback
        if (this.onReplaceCallback) {
          await this.onReplaceCallback(leave, join);
        }
      } else {
        log.debug({ activeCount: this.activeSet.size }, "✅ No rotation needed");
      }

    } catch (error) {
      log.error({ error }, "❌ Error in rescore");
    }
  }

  /**
   * Filtre les marchés éligibles selon critères
   */
  private async filterEligible(markets: any[]): Promise<MarketCandidate[]> {
    const candidates: MarketCandidate[] = [];

    for (const m of markets) {
      // Vérifications de base
      if (!m.yesTokenId || !m.noTokenId || !m.volume24hrClob) continue;

      // Calculer spread
      const spread = m.bestAskYes && m.bestBidYes 
        ? m.bestAskYes - m.bestBidYes 
        : 1.0;

      const spreadCents = spread * 100;

      // Filtres
      const minSpread = this.config.minSpreadCents;
      const maxSpread = this.config.maxSpreadCents;
      const minVol = this.config.minVolumeUsdc;

      if (spreadCents < minSpread || spreadCents > maxSpread) continue;
      if (m.volume24hrClob < minVol) continue;

      // Récupérer constraints (tick, minSize) - avec fallback
      let minOrderSize = 5;
      let tickSize = 0.001;

      try {
        const meta = await this.clob.getMarketMetadata(m.conditionId);
        if (meta) {
          minOrderSize = meta.minOrderSize || 5;
          tickSize = meta.tickSize || 0.001;
        }
      } catch { /* Utiliser fallbacks */ }

      // Score : volume dominant + bonus spread large
      const volumeScore = Math.log10((m.volume24hrClob || 0) + 1) * 100;
      const spreadScore = spreadCents; // 1¢ = 1 point, 10¢ = 10 points
      const score = volumeScore + spreadScore;

      candidates.push({
        conditionId: m.conditionId,
        slug: m.slug,
        yesTokenId: m.yesTokenId,
        noTokenId: m.noTokenId,
        volume24hr: m.volume24hrClob,
        spread,
        score,
        minOrderSize,
        tickSize
      });
    }

    return candidates;
  }

  /**
   * Retourne les marchés actifs actuels
   */
  getActiveMarkets(): string[] {
    return Array.from(this.activeSet);
  }
}

