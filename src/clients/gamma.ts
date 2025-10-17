// src/clients/gamma.ts
import axios from "axios";
import pino from "pino";

const log = pino({ name: "gamma" });
const BASE = process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

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

export type GammaMarket = {
  id: string;
  slug: string | null;
  question: string | null;
  conditionId: string;
  enableOrderBook?: boolean | null;
  acceptingOrders?: boolean | null;
  closed?: boolean | null;
  active?: boolean | null;
  archived?: boolean | null;
  endDate?: string | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  volume24hrClob?: number | null;
  clobTokenIds?: string[] | string | null; // Array of token IDs ["yesId", "noId"] or JSON string
  outcomes?: string[] | null; // ["Yes", "No"]
  markets?: GammaMarket[]; // For events with nested markets
};

export async function fetchOpenTradableMarkets(limit=200, offset=0): Promise<GammaMarket[]> {
  // Essayer plusieurs endpoints pour maximiser les chances
  const endpoints = [
    `${BASE}/events?closed=false&limit=${limit}&offset=${offset}`, // Meilleur résultat
    `${BASE}/markets?order=updatedAt&ascending=false&limit=${limit}&offset=${offset}`, // Deuxième meilleur
    `${BASE}/markets?closed=false&limit=${limit}&offset=${offset}` // Fallback
  ];
  
  for (const url of endpoints) {
    log.info({ url }, "Fetching Gamma markets");
    
    try {
      const { data } = await axios.get<GammaMarket[]>(url, { timeout: 15000 });
      const page: any[] = Array.isArray(data) ? data : [];
      
      // Extraire les marchés des événements et filtrer
      const allMarkets: GammaMarket[] = [];
      
      for (const item of page) {
        if (item.markets && Array.isArray(item.markets)) {
          // C'est un événement avec des marchés imbriqués
          for (const market of item.markets) {
            allMarkets.push(market);
          }
        } else {
          // C'est un marché direct
          allMarkets.push(item);
        }
      }
      
      // Filtrer pour les marchés vraiment actifs
      const filtered = allMarkets.filter(m => {
        // Vérifier que c'est un marché actif et non archivé
        if (m.active !== true || m.closed === true || m.archived === true) return false;
        
        // Vérifier que le marché accepte les ordres
        if (m.acceptingOrders === false) return false;
        
        // Vérifier que la date de fin est dans le futur (au moins 1 heure)
        if (m.endDate) {
          const endDate = new Date(m.endDate);
          const now = new Date();
          const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
          if (endDate <= oneHourFromNow) {
            log.debug({ slug: m.slug, endDate: m.endDate }, "Marché exclu : date de fin proche ou passée");
            return false;
          }
        }
        
        // Vérifier que l'orderbook est activé
        if (m.enableOrderBook !== true) return false;
        
        // Vérifier qu'on a les token IDs normalisés
        const ids = normalizeClobTokenIds(m.clobTokenIds);
        if (!ids) return false;
        
        return true;
      });
      
      log.info({ url, total: page.length, tradable: filtered.length }, "gamma markets page");
      
      // Si on trouve des marchés actifs, on les retourne
      if (filtered.length > 0) {
        return filtered;
      }
    } catch (error) {
      log.error({ url, error }, "Failed to fetch Gamma markets");
    }
  }
  
  log.warn("Aucun marché actif trouvé sur tous les endpoints");
  return [];
}

// pagination helper
export async function fetchAllOpenTradableMarkets(maxPages=10): Promise<GammaMarket[]> {
  const acc: GammaMarket[] = [];
  for (let i=0;i<maxPages;i++){
    const page = await fetchOpenTradableMarkets(200, i*200);
    acc.push(...page);
    if (page.length < 200) break;
  }
  return acc;
}

// Nouvelle fonction avec vraie pagination et normalisation
export type CandidateMarket = {
  slug: string;
  yesAsset: string;
  noAsset: string;
  volume24h: number;
};

export async function listCandidateMarkets(minVolume: number = 0): Promise<CandidateMarket[]> {
  let offset = 0;
  const limit = 200;
  const out: CandidateMarket[] = [];
  
  for (;;) {
    const url = `${BASE}/events?closed=false&limit=${limit}&offset=${offset}`;
    log.info({ url }, "Fetching Gamma markets");
    
    try {
      const resp = await axios.get(url, { timeout: 15000 });
      const page: any[] = Array.isArray(resp.data) ? resp.data : [];
      
      if (!page.length) break;
      
      for (const m of page) {
        if (m.active !== true || m.acceptingOrders !== true || m.archived === true || m.closed === true) continue;
        
        const vol = Number(m.volume24hrClob ?? m.volume24hr ?? 0);
        if (vol < minVolume) continue;
        
        const ids = normalizeClobTokenIds(m.clobTokenIds);
        if (!ids) continue;
        
        out.push({ 
          slug: m.slug, 
          yesAsset: ids.yes, 
          noAsset: ids.no, 
          volume24h: vol 
        });
      }
      
      offset += page.length;
      if (page.length < limit) break;
    } catch (error) {
      log.error({ url, error }, "Failed to fetch Gamma markets page");
      break;
    }
  }
  
  return out;
}
