// src/ws/marketFeed.ts
import WebSocket from "ws";
import { rootLog } from "../index";
import { WSS_URL } from "../config";

const log = rootLog.child({ name: "ws" });

type PriceUpdate = { asset_id:string; best_bid?:string; best_ask?:string };

export class MarketFeed {
  private ws?: WebSocket;
  private ping?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private listeners = new Map<string, (bb:number|null, ba:number|null, tick:number)=>void>();
  
  // CACHE TICK SIZE par asset (NOUVEAU - CRITIQUE)
  private tickSizeByAsset = new Map<string, number>();
  private minOrderSizeByAsset = new Map<string, number>();
  
  // Cache des dernières valeurs price_change (source de vérité)
  private lastPrices = new Map<string, {bestBid: number|null, bestAsk: number|null}>();
  
  // Timestamp de la dernière mise à jour par token (pour détecter les marchés inactifs)
  private lastPriceUpdateTime = new Map<string, number>();
  private currentTokenIds: string[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isConnecting = false;

  subscribe(tokenIds: string[], onUpdate: (tokenId:string, bb:number|null, ba:number|null, tick:number)=>void) {
    // Ne PAS écraser les listeners existants, juste ajouter/mettre à jour
    tokenIds.forEach(t => {
      const existing = this.listeners.get(t);
      if (!existing) {
        this.listeners.set(t, (bb,ba,tick)=>onUpdate(t,bb,ba,tick));
      }
    });
    this.currentTokenIds = tokenIds;
    this.connect(tokenIds);
  }
  
  /**
   * Retourne le tick size pour un asset (depuis le cache)
   */
  getTickSize(tokenId: string): number {
    return this.tickSizeByAsset.get(tokenId) || 0.001;
  }
  
  /**
   * Retourne le min order size pour un asset (depuis le cache)
   */
  getMinOrderSize(tokenId: string): number {
    return this.minOrderSizeByAsset.get(tokenId) || 5;
  }
  
  /**
   * Met à jour le tick size pour un asset
   */
  setTickSize(tokenId: string, tickSize: number) {
    this.tickSizeByAsset.set(tokenId, tickSize);
  }
  
  /**
   * Met à jour le min order size pour un asset
   */
  setMinOrderSize(tokenId: string, minOrderSize: number) {
    this.minOrderSizeByAsset.set(tokenId, minOrderSize);
  }
  
  getLastPrices(tokenId: string): { bestBid: number|null, bestAsk: number|null } | null {
    return this.lastPrices.get(tokenId) || null;
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
      
      // Attendre un peu que la connexion soit complètement établie
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // Format de souscription qui fonctionne selon nos tests
          const sub = { type: "MARKET", assets_ids: tokenIds };
          this.ws.send(JSON.stringify(sub));
          
          this.ping = setInterval(()=> {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.ping();
            }
          }, 10_000);
          
          log.info({ tokenIds }, "WSS connected & subscribed");
        }
      }, 100);
    });

    this.ws.on("pong", () => {
      // Pong reçu, connexion OK
    });

    this.ws.on("message", (buf) => {
        try {
          const data = buf.toString();
          
          // Gérer les messages PONG
          if (data === "PONG") {
            return;
          }
          
          const msg = JSON.parse(data);
          
          // NOUVEAU FORMAT price_change (post 15-Sep-2025)
          // Format: { event_type: "price_change", asset_id: "...", price: "0.45" }
          if (msg.event_type === "price_change" && msg.asset_id && msg.price != null) {
            const tokenId = msg.asset_id;
            const price = parseFloat(msg.price);
            
            // CRITIQUE: price_change donne le PRICE, pas best_bid/best_ask
            // On doit le combiner avec le book existant
            const current = this.lastPrices.get(tokenId) || { bestBid: null, bestAsk: null };
            
            // Mise à jour intelligente : price_change indique un changement de mid
            // On ajuste bid/ask proportionnellement
            const currentMid = (current.bestBid || price) + (current.bestAsk || price) / 2;
            const newMid = price;
            
            this.lastPriceUpdateTime.set(tokenId, Date.now());
            
            // Notifier seulement si changement significatif
            if (Math.abs(newMid - currentMid) > 0.001) {
              const tick = this.getTickSize(tokenId);
              this.listeners.get(tokenId)?.(current.bestBid, current.bestAsk, tick);
            }
          }
          
          // NOUVEAU: tick_size_change handler (price >0.96 ou <0.04)
          else if (msg.event_type === "tick_size_change" && msg.asset_id && msg.tick_size != null) {
            const tokenId = msg.asset_id;
            const newTickSize = parseFloat(msg.tick_size);
            const oldTickSize = this.tickSizeByAsset.get(tokenId) || 0.001;
            
            if (newTickSize !== oldTickSize) {
              this.tickSizeByAsset.set(tokenId, newTickSize);
              
              log.info({
                asset: tokenId.substring(0, 20) + '...',
                oldTick: oldTickSize,
                newTick: newTickSize,
                reason: newTickSize > 0.001 ? "Price >0.96 or <0.04" : "Back to normal"
              }, "📐 Tick size changed");
              
              // Notifier pour reprice immédiat
              const prices = this.lastPrices.get(tokenId);
              if (prices) {
                this.listeners.get(tokenId)?.(prices.bestBid, prices.bestAsk, newTickSize);
              }
            }
          }
          
          // FORMAT LEGACY: msg.market + msg.price_changes (backward compatibility)
          else if (msg.market && msg.price_changes && Array.isArray(msg.price_changes)) {
            for (const pc of msg.price_changes as PriceUpdate[]) {
              const bb = pc.best_bid != null ? Number(pc.best_bid) : null;
              const ba = pc.best_ask != null ? Number(pc.best_ask) : null;
              
              this.lastPrices.set(pc.asset_id, { bestBid: bb, bestAsk: ba });
              this.lastPriceUpdateTime.set(pc.asset_id, Date.now());
              
              const tick = this.getTickSize(pc.asset_id);
              this.listeners.get(pc.asset_id)?.(bb,ba,tick);
            }
          } else if (msg.event_type === "book") {
            const asset = msg.asset_id;
            const bb = msg.bids?.length ? Number(msg.bids[0].price) : null;
            const ba = msg.asks?.length ? Number(msg.asks[0].price) : null;
            
            // NOUVEAU: Extraire tick_size et min_order_size du book si présents
            if (msg.tick_size != null) {
              const tickSize = parseFloat(msg.tick_size);
              const currentTick = this.tickSizeByAsset.get(asset);
              if (currentTick !== tickSize) {
                this.tickSizeByAsset.set(asset, tickSize);
              }
            }
            
            if (msg.min_order_size != null) {
              const minSize = parseFloat(msg.min_order_size);
              this.minOrderSizeByAsset.set(asset, minSize);
            }
            
            // FILTRE CRITIQUE: Ignorer les données book corrompues
            const isCorruptedData = (bb === 0.001 && ba === 0.999) || 
                                   (bb === 0.001 && ba === null) || 
                                   (bb === null && ba === 0.999);
            
            if (isCorruptedData) {
              return; // Ignorer silencieusement (trop verbeux)
            }
            
            // Seulement utiliser les données book si elles semblent valides
            if (bb !== null && ba !== null && bb < ba && bb > 0 && ba < 1) {
              this.lastPrices.set(asset, { bestBid: bb, bestAsk: ba });
              this.lastPriceUpdateTime.set(asset, Date.now());
              
              const tick = this.getTickSize(asset);
              this.listeners.get(asset)?.(bb, ba, tick);
            }
          }
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
