// src/data/discovery.ts - Découverte simplifiée des marchés
import pino from "pino";
import { fetchAllOpenTradableMarkets } from "../clients/gamma";

const log = pino({ name: "discovery" });

type Picked = {
  conditionId: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  bestBidYes?: number|null;
  bestAskYes?: number|null;
  bestBidNo?: number|null;
  bestAskNo?: number|null;
  volume24hrClob?: number|null;
};

/**
 * Découvre les marchés actifs sur le CLOB Polymarket
 * APPROCHE: Utiliser uniquement l'API Gamma (plus fiable que le CLOB direct)
 * 
 * @param max Nombre maximum de marchés à retourner
 * @param minVol Volume minimum en USD pour filtrer
 * @returns Liste de marchés avec leurs token IDs normalisés
 */
export async function discoverLiveClobMarkets(max=50, minVol=0): Promise<Picked[]> {
  // Récupérer tous les marchés depuis Gamma
  const gamma = await fetchAllOpenTradableMarkets(5); // 5 pages max = 1000 marchés
  
  log.info({ gamma: gamma.length }, "Marchés Gamma trouvés");
  
  const out: Picked[] = [];
  
  for (const gm of gamma) {
    // Filtrer par volume minimum
    if ((gm.volume24hrClob ?? 0) < minVol) continue;
    
    // Utiliser les vrais token IDs de l'API Gamma
    let tokenIds: string[] = [];
    
    if (gm.clobTokenIds && Array.isArray(gm.clobTokenIds)) {
      tokenIds = gm.clobTokenIds;
    } else if (typeof gm.clobTokenIds === 'string') {
      try {
        // Essayer de parser si c'est une chaîne JSON
        tokenIds = JSON.parse(gm.clobTokenIds);
      } catch (e) {
        log.warn({ marketId: gm.id, clobTokenIds: gm.clobTokenIds }, "Token IDs mal formatés");
        continue;
      }
    }
    
    if (!tokenIds || tokenIds.length < 2) {
      log.warn({ marketId: gm.id, tokenIds }, "Marché sans token IDs valides");
      continue;
    }
    
    const yesTokenId = tokenIds[0]; // Premier token = Yes
    const noTokenId = tokenIds[1];  // Deuxième token = No
    
    out.push({
      conditionId: gm.conditionId || gm.id,
      slug: gm.slug || gm.id,
      yesTokenId: yesTokenId,
      noTokenId: noTokenId,
      bestBidYes: gm.bestBid ?? null,
      bestAskYes: gm.bestAsk ?? null,
      volume24hrClob: gm.volume24hrClob ?? null
    });
    
    log.info({ 
      marketId: gm.id, 
      slug: gm.slug,
      volume: gm.volume24hrClob,
      bestBid: gm.bestBid,
      bestAsk: gm.bestAsk,
      yesToken: yesTokenId.substring(0, 20) + '...',
      noToken: noTokenId.substring(0, 20) + '...'
    }, "Marché ajouté");
  }
  
  log.info({ gamma: gamma.length, selected: out.length }, "marchés Gamma sélectionnés");
  return out.slice(0, max);
}

