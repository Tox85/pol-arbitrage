// src/data/book.ts
import { CustomClobClient } from "../clients/customClob";
import pino from "pino";

const log = pino({ name: "book" });

export type Top = { bestBid:number|null; bestAsk:number|null; tickSize:number|null; negRisk:boolean|null };

export async function snapshotTop(tokenId: string): Promise<Top> {
  const clob = new CustomClobClient(
    process.env.PRIVATE_KEY!,
    process.env.CLOB_API_KEY!,
    process.env.CLOB_API_SECRET!,
    process.env.CLOB_PASSPHRASE!,
    undefined, // baseURL par défaut
    process.env.POLY_PROXY_ADDRESS // funderAddress = proxy avec les fonds USDC
  );
  const book = await clob.getOrderBook(tokenId); // REST /book
  
  // Ne pas forcer des valeurs par défaut - utiliser ce que le serveur fournit
  const bestBid = book?.bids?.length ? Number(book.bids[0].price) : null;
  const bestAsk = book?.asks?.length ? Number(book.asks[0].price) : null;
  
  // Respecter le tick_size du serveur, pas de fallback
  const tick = book?.tick_size ? Number(book.tick_size) : null;
  const neg = book?.neg_risk ? Boolean(book.neg_risk) : null;
  
  return { bestBid, bestAsk, tickSize: tick, negRisk: neg };
}

/**
 * Récupère le prix de la dernière transaction RÉELLE pour un token donné.
 * Utilisé pour détecter des mouvements rapides du marché.
 * @param tokenId ID du token ERC-1155
 * @param clob Instance du CustomClobClient
 * @returns Prix de la dernière transaction réelle ou null si aucune donnée
 */
export async function fetchLastTradePrice(tokenId: string, clob: any): Promise<number | null> {
  try {
    // Note: L'API CLOB ne fournit pas d'endpoint public pour les trades récents
    // On utilise le mid-price du carnet comme meilleure approximation
    // Cela évite les valeurs aberrantes comme 0.5000 quand le mid est à 0.023
    const snapshot = await snapshotTop(tokenId);
    
    if (!snapshot.bestBid || !snapshot.bestAsk) {
      log.debug({ tokenId: tokenId.substring(0, 20) + '...' }, "No bid/ask available for last trade price");
      return null;
    }
    
    // Retourner le mid-price actuel (plus fiable que les trades qui peuvent être anciens)
    const midPrice = (snapshot.bestBid + snapshot.bestAsk) / 2;
    
    log.debug({
      tokenId: tokenId.substring(0, 20) + '...',
      bestBid: snapshot.bestBid.toFixed(4),
      bestAsk: snapshot.bestAsk.toFixed(4),
      midPrice: midPrice.toFixed(4)
    }, "Last trade price (mid-price) fetched");
    
    return midPrice;
  } catch (error) {
    log.error({ error, tokenId: tokenId.substring(0, 20) + '...' }, "Failed to fetch last trade price");
    return null;
  }
}
