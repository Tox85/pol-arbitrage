// src/ws/marketFeed.ts
import WebSocket from "ws";
import { rootLog } from "../logger";
import { WSS_URL } from "../config";

const log = rootLog.child({ name: "ws" });

type PriceUpdate = { asset_id:string; best_bid?:string; best_ask?:string };

export class MarketFeed {
  private ws?: WebSocket;
  private ping?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private listeners = new Map<string, (bb:number|null, ba:number|null)=>void>();
  // Cache des dernières valeurs price_change (source de vérité)
  private lastPrices = new Map<string, {bestBid: number|null, bestAsk: number|null}>();
  // Anti-spam pour les logs de prix
  private lastPriceLogs = new Map<string, {bid: number|null, ask: number|null}>();
  // Timestamp de la dernière mise à jour par token (pour détecter les marchés inactifs)
  private lastPriceUpdateTime = new Map<string, number>();
  // Cache des tick_size par token (dynamique)
  private tickSizes = new Map<string, number>();
  private currentTokenIds: string[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isConnecting = false;
  
  // State local pour abonnement unique
  private subscribed = new Set<string>();
  private subTimer: NodeJS.Timeout | null = null;

  subscribe(tokenIds: string[], onUpdate: (tokenId:string, bb:number|null, ba:number|null)=>void) {
    // Ne PAS écraser les listeners existants, juste ajouter/mettre à jour
    tokenIds.forEach(t => {
      const existing = this.listeners.get(t);
      if (!existing) {
        this.listeners.set(t, (bb,ba)=>onUpdate(t,bb,ba));
        log.debug({ tokenId: t.substring(0, 20) + '...' }, "Listener added");
      } else {
        log.debug({ tokenId: t.substring(0, 20) + '...' }, "Listener already exists, keeping it");
      }
      // CORRECTIF: Ajouter chaque token à la liste de souscription
      this.subscribeAsset(t);
    });
    this.currentTokenIds = tokenIds;
    this.connect(tokenIds);
  }

  // Nouvelles méthodes pour abonnement unique
  subscribeAsset(id: string) {
    this.subscribed.add(id.trim());
    if (this.subTimer) clearTimeout(this.subTimer);
    this.subTimer = setTimeout(() => this.flushSubscription(), 75);
  }

  unsubscribeAsset(id: string) {
    this.subscribed.delete(id.trim());
    if (this.subTimer) clearTimeout(this.subTimer);
    this.subTimer = setTimeout(() => this.flushSubscription(), 75);
  }

  private flushSubscription() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // CORRECTIF: Utiliser "MARKET" en majuscules comme dans la version fonctionnelle
    this.ws.send(JSON.stringify({ type: "MARKET", assets_ids: Array.from(this.subscribed) }));
    log.info({ count: this.subscribed.size }, "📡 Subscription envoyée (MARKET)");
  }

  // Parsing post-migration (schema 2025-09-15)
  private handleMessage(msg: any) {
    switch (msg.event_type) {
      case "book":
        // msg.bids / msg.asks — mets à jour le snapshot + top init
        const asset = msg.asset_id;
        const bb = msg.bids?.length ? Number(msg.bids[0].price) : null;
        const ba = msg.asks?.length ? Number(msg.asks[0].price) : null;
        
        // Validation simple : bid < ask, bid > 0, ask <= 1
        // Sur Polymarket, des marchés one-sided (ex: 0.002/0.003 ou 0.997/0.998) sont valides
        if (bb !== null && ba !== null && bb < ba && bb > 0 && ba <= 1) {
          this.lastPrices.set(asset, { bestBid: bb, bestAsk: ba });
          this.lastPriceUpdateTime.set(asset, Date.now());
          this.listeners.get(asset)?.(bb, ba);
          log.debug({ 
            asset: asset.substring(0, 20) + '...', 
            bb: bb.toFixed(4), 
            ba: ba.toFixed(4) 
          }, "📚 book snapshot");
        } else {
          log.debug({
            asset: asset.substring(0, 20) + '...',
            bb, ba,
            reason: "Invalid book data (bid >= ask or out of range)"
          }, "⚠️ Ignoring invalid book data");
        }
        break;
        
      case "price_change":
        for (const pc of msg.price_changes) {
          // Utiliser best_bid/best_ask directement depuis price_change
          const bid = pc.best_bid == null ? null : Number(pc.best_bid);
          const ask = pc.best_ask == null ? null : Number(pc.best_ask);
          
          // Garde-fous : filtrer les valeurs aberrantes
          // - 0 < bid < ask <= 1
          // - spread <= 0.20 (20¢) pour éviter les carnets fantômes
          const spread = bid !== null && ask !== null ? ask - bid : null;
          const ok = bid !== null && ask !== null && bid > 0 && ask <= 1 && bid < ask && spread !== null && spread <= 0.20;
          
          if (!ok) {
            log.debug({ 
              asset: pc.asset_id.substring(0, 20) + '...', 
              bid, 
              ask, 
              spread: spread ? (spread * 100).toFixed(1) + '¢' : 'N/A'
            }, "⚠️ ignore price_change (implausible)");
            continue;
          }
          
          // Valeurs valides : mettre à jour
          this.lastPrices.set(pc.asset_id, { bestBid: bid, bestAsk: ask });
          this.lastPriceUpdateTime.set(pc.asset_id, Date.now());
          this.listeners.get(pc.asset_id)?.(bid, ask);
          log.debug({ 
            asset: pc.asset_id.substring(0, 20) + '...', 
            bb: bid.toFixed(4), 
            ba: ask.toFixed(4),
            spread: (spread! * 100).toFixed(1) + '¢'
          }, "💹 price_change");
        }
        break;
        
      case "tick_size_change":
        // Mettre à jour le tick_size dynamique
        const newTickSize = Number(msg.new_tick_size);
        if (newTickSize > 0 && newTickSize <= 1) {
          this.tickSizes.set(msg.asset_id, newTickSize);
          log.info({ 
            asset: msg.asset_id.substring(0, 20) + '...', 
            newTickSize 
          }, "📏 tick_size_change");
        }
        break;
    }
  }

  private updateTop(assetId: string, bid: number, ask: number) {
    // Mettre à jour le cache (source de vérité)
    this.lastPrices.set(assetId, { bestBid: bid, bestAsk: ask });
    
    // Mettre à jour le timestamp de dernière activité
    this.lastPriceUpdateTime.set(assetId, Date.now());
    
    // Notifier les listeners
    this.listeners.get(assetId)?.(bid, ask);
    
    // Log seulement si le prix a changé (anti-spam)
    const prev = this.lastPriceLogs.get(assetId);
    if (!prev || prev.bid !== bid || prev.ask !== ask) {
      log.debug({ asset_id: assetId, best_bid: bid, best_ask: ask }, "price update");
      this.lastPriceLogs.set(assetId, { bid, ask });
    }
  }
  
  getLastPrices(tokenId: string): { bestBid: number|null, bestAsk: number|null } | null {
    return this.lastPrices.get(tokenId) || null;
  }

  /**
   * Récupère le tick_size pour un token donné
   * Retourne null si pas encore connu (utiliser DEFAULT_TICK_SIZE en fallback)
   */
  getTickSize(tokenId: string): number | null {
    return this.tickSizes.get(tokenId) || null;
  }

  /**
   * Définit le tick_size pour un token (depuis /book ou autre source)
   */
  setTickSize(tokenId: string, tickSize: number): void {
    if (tickSize > 0 && tickSize <= 1) {
      this.tickSizes.set(tokenId, tickSize);
    }
  }

  /**
   * Vérifie si un token a reçu une mise à jour récente (dans les 5 minutes)
   * Retourne false si le marché semble inactif
   */
  isMarketActive(tokenId: string, maxAgeMs: number = 5 * 60 * 1000): boolean {
    const lastUpdate = this.lastPriceUpdateTime.get(tokenId);
    if (!lastUpdate) return false;
    
    const age = Date.now() - lastUpdate;
    return age < maxAgeMs;
  }

  private connect(tokenIds: string[]) {
    if (this.isConnecting) {
      log.debug("Connection already in progress, skipping");
      return;
    }

    this.isConnecting = true;
    this.reconnectAttempts++;

    // Nettoyer les timeouts précédents
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    log.info({ 
      attempt: this.reconnectAttempts, 
      maxAttempts: this.maxReconnectAttempts,
      url: WSS_URL 
    }, "Attempting WebSocket connection");

    this.ws = new WebSocket(WSS_URL);
    
    this.ws.on("open", () => {
      this.isConnecting = false;
      this.reconnectAttempts = 0; // Reset counter on successful connection
      
      // Keepalive propre (évite messages texte)
      let lastPong = Date.now();
      this.ws!.on("pong", () => { lastPong = Date.now(); });
      
      this.ping = setInterval(() => {
        if (Date.now() - lastPong > 30000) { 
          this.ws!.terminate(); 
          return; 
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 10000);
      
      log.info({ tokenIds }, "WSS connected");
      
      // CORRECTIF: Envoyer la souscription dès l'ouverture (et à chaque reconnect)
      this.flushSubscription();
    });

    this.ws.on("pong", () => {
      // Pong reçu, connexion OK
    });

    this.ws.on("message", (buf) => {
        try {
          const txt = buf.toString();
          
          // Filtrer PING/PONG avant JSON.parse
          if (txt === "PING" || txt === "PONG") return; // ne pas parser
          
          let msg: any;
          try { 
            msg = JSON.parse(txt); 
          } catch { 
            return; 
          }
          
          this.handleMessage(msg);
        } catch(e) { 
          log.warn({ e, data: buf.toString().substring(0, 100) }, "WS parse error"); 
        }
      });
    this.ws.on("close", (code, reason) => {
      this.isConnecting = false;
      clearInterval(this.ping!);
      
      log.warn({ 
        code, 
        reason: reason.toString(),
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts
      }, "WebSocket connection closed");

      // Reconnexion avec backoff exponentiel
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
        log.info({ delay, attempt: this.reconnectAttempts }, "Scheduling reconnection");
        
        this.reconnectTimeout = setTimeout(() => {
          this.connect(this.currentTokenIds);
        }, delay);
      } else {
        log.error({ maxAttempts: this.maxReconnectAttempts }, "Max reconnection attempts reached");
      }
    });
    
    this.ws.on("error", (err) => {
      this.isConnecting = false;
      log.error({ 
        err: {
          type: err.constructor.name,
          message: err.message,
          errno: (err as any).errno,
          code: (err as any).code,
          syscall: (err as any).syscall,
          hostname: (err as any).hostname
        }
      }, "WSS error");
    });
  }

  /**
   * Ferme proprement la connexion WebSocket
   */
  disconnect() {
    log.info("Disconnecting WebSocket...");
    
    // Nettoyer tous les timeouts
    if (this.ping) {
      clearInterval(this.ping);
      this.ping = undefined;
    }
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    
    // Fermer la connexion WebSocket
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "Normal closure");
    }
    
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    log.info("WebSocket disconnected");
  }

}
