// Market Selector - Filtrage strict avec spread, volume, depth, profit attendu
import pino from "pino";
import { PolyClobClient } from "../clients/polySDK";
import { MarketFeed } from "../ws/marketFeed";
import { fetchAllOpenTradableMarkets, GammaMarket } from "../clients/gamma";
import {
  MIN_SPREAD_CENTS,
  MIN_VOLUME_24H_USD,
  MIN_DEPTH_TOP2_USD,
  HOURS_TO_CLOSE_MIN,
  MIN_NOTIONAL_PER_ORDER_USDC,
  MIN_EXPECTED_PROFIT_USDC,
  MAX_MARKETS,
  MAX_MARKETS_PER_EVENT
} from "../config";

const log = pino({ name: "selector" });

export type CandidateMarket = {
  slug: string;
  tokenId: string; // Le token choisi (YES ou NO) pour trader
  yesTokenId: string; // Pour référence
  noTokenId: string; // Pour référence
  side: "YES" | "NO"; // Quel côté on trade
  conditionId: string;
  endDate: string | null;
  volume24h: number;
  spread: number;
  depth: number;
  hoursToClose: number;
  score: number;
  skipReason?: string;
};

// Utilitaire pour normaliser les clobTokenIds
function normalizeClobTokenIds(raw: unknown): { yes: string; no: string } | null {
  if (Array.isArray(raw) && raw.length === 2 && raw.every(x => typeof x === 'string')) {
    return { yes: raw[0].trim(), no: raw[1].trim() };
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr) && arr.length === 2 && arr.every(x => typeof x === 'string')) {
          return { yes: arr[0].trim(), no: arr[1].trim() };
        }
      } catch {}
    }
    if (s.includes(',')) {
      const [a, b] = s.split(',').map(t => t.trim().replace(/^"|"$/g, ''));
      if (a && b) return { yes: a, no: b };
    }
  }
  return null;
}

export class MarketSelector {
  private clob: PolyClobClient;
  private marketFeed: MarketFeed;

  constructor(clob: PolyClobClient, marketFeed: MarketFeed) {
    this.clob = clob;
    this.marketFeed = marketFeed;
    log.info("🎯 Market Selector initialized");
  }

  /**
   * Sélectionne les meilleurs marchés selon les critères stricts
   */
  async selectMarkets(): Promise<CandidateMarket[]> {
    log.info("🔍 Starting market selection...");

    // 1. Récupérer tous les marchés ouverts depuis Gamma
    const gammaMarkets = await fetchAllOpenTradableMarkets(5);
    log.info({ total: gammaMarkets.length }, "📊 Gamma markets fetched");

    if (gammaMarkets.length === 0) {
      log.error("❌ No markets found from Gamma - check your network connection and Gamma API availability");
      return [];
    }

    // DEBUG: Afficher un échantillon des premiers marchés
    if (gammaMarkets.length > 0) {
      log.info({
        sample: gammaMarkets.slice(0, 3).map(m => ({
          slug: m.slug,
          volume24h: m.volume24hrClob,
          active: m.active,
          acceptingOrders: m.acceptingOrders,
          enableOrderBook: m.enableOrderBook,
          hasClobTokenIds: !!m.clobTokenIds
        }))
      }, "📊 Sample of fetched markets");
    }

    // 2. PRE-FILTRE: Filtrer d'abord par volume depuis Gamma (RAPIDE)
    const preFiltered = gammaMarkets.filter(m => {
      const volume = Number(m.volume24hrClob || 0);
      return volume >= MIN_VOLUME_24H_USD;
    });

    log.info({
      total: gammaMarkets.length,
      afterVolumeFilter: preFiltered.length,
      minVolume: MIN_VOLUME_24H_USD
    }, "📊 Pre-filtered by volume");

    // 2b. ABONNER LE WEBSOCKET aux tokens des candidats (pour avoir des prix temps réel)
    log.info("📡 Subscribing to WebSocket market feeds for candidates...");
    const tokenIds: string[] = [];
    for (const m of preFiltered) {
      const ids = normalizeClobTokenIds(m.clobTokenIds);
      if (ids) {
        tokenIds.push(ids.yes, ids.no);
      }
    }
    
    // S'abonner aux tokens
    if (tokenIds.length > 0) {
      this.marketFeed.subscribe(tokenIds, () => {
        // Callback vide - on veut juste recevoir les données
      });
      
      // Attendre 3 secondes pour que les données WebSocket arrivent
      log.info({ tokenCount: tokenIds.length }, "⏳ Waiting 3s for WebSocket price data...");
      await new Promise(resolve => setTimeout(resolve, 3000));
      log.info("✅ WebSocket price data should be available now");
    }

    // 3. Évaluer TOUS les marchés qui passent le filtre volume
    // (Pas de limitation - on veut tous les marchés éligibles)
    const allCandidates = preFiltered;

    log.info({
      totalCandidates: allCandidates.length,
      note: "Évaluant TOUS les marchés (pas de limitation)"
    }, "📊 Selected all candidates for evaluation");

    // 4. Évaluer TOUS les candidats (appels API CLOB)
    const candidates: CandidateMarket[] = [];

    for (let i = 0; i < allCandidates.length; i++) {
      const market = allCandidates[i];
      
      // Délai réduit pour éviter rate limiting (50ms entre chaque appel)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      const candidate = await this.evaluateMarket(market, i);
      if (candidate) {
        candidates.push(candidate);
      }
      
      // Log de progression tous les 50 marchés (car on en évalue beaucoup plus)
      if ((i + 1) % 50 === 0) {
        log.info({
          progress: `${i + 1}/${allCandidates.length}`,
          candidatesFound: candidates.length,
          eligible: candidates.filter(c => !c.skipReason).length
        }, "📊 Evaluation progress");
      }
    }

    log.info({
      evaluated: candidates.length,
      eligible: candidates.filter(c => !c.skipReason).length
    }, "📊 Markets evaluated");

    // 3. Filtrer les marchés éligibles
    const eligible = candidates.filter(c => !c.skipReason);

    if (eligible.length === 0) {
      log.warn("No eligible markets found");
      return [];
    }

    // 4. Trier par score (spread + depth + volume + distance à résolution)
    eligible.sort((a, b) => b.score - a.score);

    // 5. Appliquer MAX_MARKETS_PER_EVENT (limiter à 1 marché par événement)
    const selected = this.applyEventLimit(eligible);

    // 6. Prendre les MAX_MARKETS meilleurs
    const final = selected.slice(0, MAX_MARKETS);

    log.info({
      totalCandidates: candidates.length,
      eligible: eligible.length,
      afterEventLimit: selected.length,
      final: final.length,
      markets: final.map(m => ({
        slug: m.slug,
        side: m.side,
        spread: (m.spread * 100).toFixed(2) + '¢',
        volume: m.volume24h.toFixed(0),
        depth: m.depth.toFixed(0),
        hoursToClose: m.hoursToClose.toFixed(1),
        score: m.score.toFixed(1)
      }))
    }, "✅ Market selection completed");

    return final;
  }

  /**
   * Évalue un marché selon les critères stricts
   * Choisit dynamiquement le meilleur token (YES ou NO) à trader
   */
  private async evaluateMarket(market: GammaMarket, index: number = 0): Promise<CandidateMarket | null> {
    try {
      // Extraire les token IDs
      const ids = normalizeClobTokenIds(market.clobTokenIds);
      if (!ids) {
        log.debug({ slug: market.slug }, "Skip: invalid token IDs");
        return null;
      }

      // Récupérer les prix depuis le WebSocket (plus fiable que REST)
      const yesPrices = this.marketFeed.getLastPrices(ids.yes);
      const noPrices = this.marketFeed.getLastPrices(ids.no);

      // Si pas de données WebSocket, utiliser REST en fallback
      let yesBid: number | null = null;
      let yesAsk: number | null = null;
      let noBid: number | null = null;
      let noAsk: number | null = null;
      let yesDepth = 0;
      let noDepth = 0;

      if (yesPrices && yesPrices.bestBid && yesPrices.bestAsk) {
        // Utiliser les données WebSocket (correctes)
        yesBid = yesPrices.bestBid;
        yesAsk = yesPrices.bestAsk;
        yesDepth = 1000; // Estimation pour les données WebSocket
      } else {
        // Fallback REST si pas de données WebSocket
        try {
          const yesBook = await this.clob.getOrderBook(ids.yes);
          yesBid = yesBook.bids?.[0] ? Number(yesBook.bids[0].price) : null;
          yesAsk = yesBook.asks?.[0] ? Number(yesBook.asks[0].price) : null;
          yesDepth = this.calculateDepth(yesBook);
        } catch (error) {
          log.debug({ slug: market.slug, error: (error as Error).message }, "Failed to get YES order book");
        }
      }

      if (noPrices && noPrices.bestBid && noPrices.bestAsk) {
        // Utiliser les données WebSocket (correctes)
        noBid = noPrices.bestBid;
        noAsk = noPrices.bestAsk;
        noDepth = 1000; // Estimation pour les données WebSocket
      } else {
        // Fallback REST si pas de données WebSocket
        try {
          const noBook = await this.clob.getOrderBook(ids.no);
          noBid = noBook.bids?.[0] ? Number(noBook.bids[0].price) : null;
          noAsk = noBook.asks?.[0] ? Number(noBook.asks[0].price) : null;
          noDepth = this.calculateDepth(noBook);
        } catch (error) {
          log.debug({ slug: market.slug, error: (error as Error).message }, "Failed to get NO order book");
        }
      }

      // Calculer les spreads
      const yesSpread = (yesBid && yesAsk) ? yesAsk - yesBid : null;
      const noSpread = (noBid && noAsk) ? noAsk - noBid : null;

      // DEBUG: Afficher les données brutes pour les premiers marchés
      if (index < 3) {
        log.info({
          slug: market.slug,
          yes: { bid: yesBid, ask: yesAsk, spread: yesSpread, depth: yesDepth.toFixed(0) },
          no: { bid: noBid, ask: noAsk, spread: noSpread, depth: noDepth.toFixed(0) }
        }, "🔍 Market evaluation");
      }

      // Vérifier qu'on a au moins un côté valide
      if (!yesSpread && !noSpread) {
        log.debug({ slug: market.slug }, "Skip: no valid spreads");
        return null;
      }

      // STRATÉGIE: Choisir le token avec le MEILLEUR spread (le plus large)
      // Si un seul est valide, on prend celui-là
      let chosenSide: "YES" | "NO";
      let chosenTokenId: string;
      let chosenSpread: number;
      let chosenDepth: number;

      if (yesSpread && noSpread) {
        // Les deux sont valides, choisir le meilleur spread
        if (yesSpread >= noSpread) {
          chosenSide = "YES";
          chosenTokenId = ids.yes;
          chosenSpread = yesSpread;
          chosenDepth = yesDepth;
        } else {
          chosenSide = "NO";
          chosenTokenId = ids.no;
          chosenSpread = noSpread;
          chosenDepth = noDepth;
        }
      } else if (yesSpread) {
        chosenSide = "YES";
        chosenTokenId = ids.yes;
        chosenSpread = yesSpread;
        chosenDepth = yesDepth;
      } else {
        chosenSide = "NO";
        chosenTokenId = ids.no;
        chosenSpread = noSpread!;
        chosenDepth = noDepth;
      }

      // Volume 24h (partagé entre YES et NO)
      const volume24h = Number(market.volume24hrClob || 0);

      // Heures jusqu'à résolution
      const hoursToClose = market.endDate ? this.calculateHoursToClose(market.endDate) : 999;

      // Créer le candidat avec le token choisi
      const candidate: CandidateMarket = {
        slug: market.slug || "unknown",
        tokenId: chosenTokenId,
        yesTokenId: ids.yes,
        noTokenId: ids.no,
        side: chosenSide,
        conditionId: market.conditionId,
        endDate: market.endDate || null,
        volume24h,
        spread: chosenSpread,
        depth: chosenDepth,
        hoursToClose,
        score: 0 // Sera calculé après
      };

      // Appliquer les filtres stricts
      const skipReason = this.applyFilters(candidate);
      if (skipReason) {
        candidate.skipReason = skipReason;
      } else {
        // Calculer le score pour les marchés éligibles
        candidate.score = this.calculateScore(candidate);
        log.info({
          slug: candidate.slug,
          side: candidate.side,
          spread: (candidate.spread * 100).toFixed(2) + '¢',
          volume: candidate.volume24h.toFixed(0),
          depth: candidate.depth.toFixed(0),
          score: candidate.score.toFixed(1)
        }, "✅ Market eligible");
      }

      return candidate;
    } catch (error: any) {
      log.error({
        slug: market.slug,
        error: error.message
      }, "Error evaluating market");
      return null;
    }
  }

  /**
   * Applique les filtres stricts
   * Retourne le skip reason si le marché ne passe pas, sinon undefined
   */
  private applyFilters(candidate: CandidateMarket): string | undefined {
    // Filtre 1: Spread minimum
    if (candidate.spread < MIN_SPREAD_CENTS / 100) {
      return `spread_too_small: ${(candidate.spread * 100).toFixed(2)}¢ < ${MIN_SPREAD_CENTS}¢`;
    }

    // Filtre 1b: Spread MAXIMUM (éviter marchés illiquides/résolus)
    const MAX_SPREAD_CENTS = 50; // 50¢ maximum (augmenté pour capturer plus de marchés)
    if (candidate.spread > MAX_SPREAD_CENTS / 100) {
      return `spread_too_large: ${(candidate.spread * 100).toFixed(2)}¢ > ${MAX_SPREAD_CENTS}¢`;
    }

    // Filtre 2: Volume minimum
    if (candidate.volume24h < MIN_VOLUME_24H_USD) {
      return `volume_low: ${candidate.volume24h.toFixed(0)} < ${MIN_VOLUME_24H_USD}`;
    }

    // Filtre 3: Depth minimum
    if (candidate.depth < MIN_DEPTH_TOP2_USD) {
      return `depth_low: ${candidate.depth.toFixed(0)} < ${MIN_DEPTH_TOP2_USD}`;
    }

    // Filtre 4: Heures jusqu'à résolution
    if (candidate.hoursToClose < HOURS_TO_CLOSE_MIN) {
      return `closing_soon: ${candidate.hoursToClose.toFixed(1)}h < ${HOURS_TO_CLOSE_MIN}h`;
    }

    // Filtre 5: Capable de supporter MIN_NOTIONAL_PER_ORDER_USDC
    // Pour cela, il faut que le spread * notional >= MIN_EXPECTED_PROFIT_USDC
    const expectedProfit = (candidate.spread) * MIN_NOTIONAL_PER_ORDER_USDC;
    if (expectedProfit < MIN_EXPECTED_PROFIT_USDC) {
      return `expected_profit_low: ${expectedProfit.toFixed(4)} < ${MIN_EXPECTED_PROFIT_USDC}`;
    }

    return undefined; // Marché éligible
  }

  /**
   * Calcule le score pondéré pour le classement
   */
  private calculateScore(candidate: CandidateMarket): number {
    // Poids:
    // - Spread: 40% (plus c'est large, mieux c'est)
    // - Depth: 30% (plus il y a de liquidité, mieux c'est)
    // - Volume: 20% (plus c'est élevé, mieux c'est)
    // - Distance à résolution: 10% (plus c'est loin, mieux c'est)

    const spreadScore = candidate.spread * 1000; // 0.015 -> 15
    const depthScore = Math.log10(candidate.depth + 1) * 100; // 300 -> 250
    const volumeScore = Math.log10(candidate.volume24h + 1) * 50; // 5000 -> 185
    const timeScore = Math.min(candidate.hoursToClose / 24, 30); // Max 30 points

    return (
      spreadScore * 0.4 +
      depthScore * 0.3 +
      volumeScore * 0.2 +
      timeScore * 0.1
    );
  }

  /**
   * Calcule la depth (somme des 2 meilleurs niveaux bid + ask en USDC)
   * Avec normalisation et garde-fous contre les valeurs aberrantes
   */
  private calculateDepth(book: any): number {
    const bids = book.bids || [];
    const asks = book.asks || [];
    const levels = 2; // top2

    let bidDepth = 0;
    for (let i = 0; i < Math.min(levels, bids.length); i++) {
      const price = Number(bids[i].price);
      const sizeRaw = Number(bids[i].size);
      
      // Heuristique : normaliser les size aberrants (agrégations)
      // Si size > 100k, c'est probablement une micro-unité mal gérée
      const size = sizeRaw > 100_000 ? sizeRaw / 1e6 : sizeRaw;
      
      // Validation : prix et quantité dans des bornes raisonnables
      if (price > 0 && price <= 1 && size > 0 && size < 1e6) {
        bidDepth += price * size;
      }
    }

    let askDepth = 0;
    for (let i = 0; i < Math.min(levels, asks.length); i++) {
      const price = Number(asks[i].price);
      const sizeRaw = Number(asks[i].size);
      
      // Heuristique : normaliser les size aberrants
      const size = sizeRaw > 100_000 ? sizeRaw / 1e6 : sizeRaw;
      
      // Validation : prix et quantité dans des bornes raisonnables
      if (price > 0 && price <= 1 && size > 0 && size < 1e6) {
        askDepth += price * size;
      }
    }

    // Garde-fou final : plafonner à 10k USDC pour éviter les faux positifs
    const totalDepth = bidDepth + askDepth;
    return Math.min(totalDepth, 10_000);
  }

  /**
   * Calcule les heures jusqu'à la résolution
   */
  private calculateHoursToClose(endDate: string): number {
    const end = new Date(endDate);
    const now = new Date();
    const diffMs = end.getTime() - now.getTime();
    return diffMs / (1000 * 60 * 60);
  }

  /**
   * Applique la limite MAX_MARKETS_PER_EVENT (1 seul marché par événement)
   */
  private applyEventLimit(markets: CandidateMarket[]): CandidateMarket[] {
    // Grouper par conditionId (événement)
    const byEvent = new Map<string, CandidateMarket[]>();
    
    for (const market of markets) {
      const existing = byEvent.get(market.conditionId) || [];
      existing.push(market);
      byEvent.set(market.conditionId, existing);
    }

    // Prendre le meilleur de chaque événement
    const selected: CandidateMarket[] = [];
    
    for (const [conditionId, eventMarkets] of byEvent.entries()) {
      // Trier par score et prendre le meilleur
      eventMarkets.sort((a, b) => b.score - a.score);
      const best = eventMarkets.slice(0, MAX_MARKETS_PER_EVENT);
      selected.push(...best);

      if (eventMarkets.length > MAX_MARKETS_PER_EVENT) {
        log.info({
          conditionId: conditionId.substring(0, 20) + '...',
          totalMarkets: eventMarkets.length,
          selected: best.length,
          bestSlug: best[0].slug
        }, "📊 Event limit applied");
      }
    }

    return selected;
  }
}

