// src/ws/userFeed.ts - WebSocket utilisateur pour recevoir les fills en temps réel
import WebSocket from "ws";
import crypto from "crypto";
import { rootLog } from "../logger";
import { WSS_USER_URL } from "../config";

const log = rootLog.child({ name: "ws-user" });

export type FillEvent = {
  type: "fill";
  orderId: string;
  asset: string; // tokenId
  market: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  fee?: string;
  timestamp: number;
  status: "MATCHED" | "LIVE" | "CANCELLED";
};

export type OrderEvent = {
  type: "order";
  orderId: string;
  status: "LIVE" | "MATCHED" | "CANCELLED" | "DELAYED";
  asset: string;
  side: "BUY" | "SELL";
  price: string;
  originalSize: string;
  sizeMatched?: string;
  timestamp: number;
};

export class UserFeed {
  private ws?: WebSocket;
  private ping?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private fillListeners: Array<(fill: FillEvent) => void> = [];
  private orderListeners: Array<(order: OrderEvent) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isConnecting = false;
  
  // Auth L2 comme pour REST API
  private apiKey: string;
  private apiSecret: string;
  private passphrase: string;
  private signingKey: string;

  constructor(apiKey: string, apiSecret: string, passphrase: string, signingKey: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
    this.signingKey = signingKey;
  }

  /**
   * Connecte et s'authentifie au WebSocket utilisateur
   */
  connect() {
    if (this.isConnecting) {
      log.debug("User feed connection already in progress, skipping");
      return;
    }

    this.isConnecting = true;
    this.reconnectAttempts++;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    log.info({ 
      attempt: this.reconnectAttempts, 
      maxAttempts: this.maxReconnectAttempts,
      url: WSS_USER_URL 
    }, "Connecting to user WebSocket");

    // Générer headers d'authentification L2 (même logique que CustomClobClient)
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = "GET";
    const requestPath = "/ws/user";
    
    // HMAC: message = timestamp + method + requestPath
    const message = `${timestamp}${method}${requestPath}`;
    
    // Secret en Base64 → décoder avant de l'utiliser
    const key = Buffer.from(this.apiSecret, "base64");
    const hmac = crypto.createHmac("sha256", key);
    const sigB64 = hmac.update(message).digest("base64");
    
    // Base64 URL-safe (conserver les "=")
    const signature = sigB64.replace(/\+/g, "-").replace(/\//g, "_");

    this.ws = new WebSocket(WSS_USER_URL, {
      headers: {
        "POLY_ADDRESS": this.signingKey,
        "POLY_API_KEY": this.apiKey,
        "POLY_PASSPHRASE": this.passphrase,
        "POLY_TIMESTAMP": timestamp,
        "POLY_SIGNATURE": signature
      }
    });

    this.ws.on("open", () => {
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      
      // Envoyer 1 frame d'auth/subscribe
      this.ws!.send(JSON.stringify({
        type: "user",
        markets: [], // tous mes évènements utilisateur
        auth: { 
          apikey: this.apiKey, 
          secret: this.apiSecret, 
          passphrase: this.passphrase 
        }
      }));
      
      log.info("✅ User WebSocket connected - ready to receive fills, orders, balance updates");
      
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
    });

    this.ws.on("pong", () => {
      // Pong reçu, connexion OK
    });

    this.ws.on("message", (buf) => {
      try {
        const txt = buf.toString();
        
        // Même filtre PING/PONG qu'au-dessus
        if (txt === "PING" || txt === "PONG") return;
        
        let msg: any;
        try { 
          msg = JSON.parse(txt); 
        } catch (parseError) {
          log.debug({ parseError, data: txt.substring(0, 200) }, "Failed to parse user WS message");
          return; 
        }
        
        // Log du message parsé pour debug
        log.debug({ event_type: msg.event_type, type: msg.type }, "User WS message received");
        
        // Route messages
        if (msg.event_type === "trade" || msg.event_type === "fill") {
          try {
            // Les événements "trade" avec orderId UUID (ex: d62084ef-...) sont des trades d'AUTRES utilisateurs
            // NOS ordres ont des IDs hex (0x...)
            // On peut les ignorer car on recevra un événement "order" MATCHED pour nos fills
            const orderId = msg.order_id || msg.orderId || msg.id || "";
            
            if (orderId && !orderId.startsWith("0x")) {
              log.debug({ orderId: orderId.substring(0, 16) + '...' }, "Ignoring trade event from other user (UUID orderId)");
              return;
            }
            
            const fill = {
              asset_id: msg.asset_id ?? msg.trade?.asset_id,
              side: (msg.side ?? msg.trade?.side)?.toLowerCase(), // "buy"/"sell"
              size: Number(msg.size ?? msg.trade?.size),
              price: Number(msg.price ?? msg.trade?.price),
              ts: Date.now(),
              market_slug: msg.market_slug, // si fourni
            };
            
            // Validation des champs requis
            if (!fill.asset_id || !fill.side || isNaN(fill.size) || isNaN(fill.price)) {
              log.warn({ msg }, "Fill event missing required fields");
              return;
            }
            
            // Convertir en format FillEvent existant
            const fillEvent: FillEvent = {
              type: "fill",
              orderId: orderId,
              asset: fill.asset_id,
              market: fill.market_slug || "unknown",
              side: fill.side?.toUpperCase() as "BUY" | "SELL",
              price: fill.price.toString(),
              size: fill.size.toString(),
              fee: "0",
              timestamp: fill.ts,
              status: "MATCHED"
            };
            
            log.info({
              orderId: fillEvent.orderId?.substring(0, 16) + '...' || 'unknown',
              side: fillEvent.side,
              price: fillEvent.price,
              size: fillEvent.size,
              asset: fillEvent.asset?.substring(0, 20) + '...' || 'unknown'
            }, "💰 FILL EVENT from trade");
            
            this.fillListeners.forEach(listener => listener(fillEvent));
          } catch (fillError) {
            log.error({ fillError, msg }, "Error processing fill event");
          }
        }
        
        // Order status update (LIVE, CANCELLED, etc.)
        else if (msg.event_type === "order" || msg.type === "order") {
          try {
            // Validation des champs requis
            if (!msg.asset_id && !msg.asset) {
              log.warn({ msg }, "Order event missing asset");
              return;
            }
            
            const order: OrderEvent = {
              type: "order",
              orderId: msg.order_id || msg.orderId || msg.id || "unknown",
              status: msg.status?.toUpperCase() || "LIVE",
              asset: msg.asset_id || msg.asset,
              side: msg.side?.toUpperCase() as "BUY" | "SELL",
              price: msg.price,
              originalSize: msg.original_size || msg.size,
              sizeMatched: msg.size_matched,
              timestamp: msg.timestamp || Date.now()
            };
            
            log.info({
              orderId: order.orderId?.substring(0, 16) + '...' || 'unknown',
              status: order.status,
              side: order.side,
              price: order.price,
              size: order.originalSize
            }, `📋 ORDER ${order.status}`);
            
            this.orderListeners.forEach(listener => listener(order));
            
            // Si l'ordre est MATCHED, c'est un FILL !
            // Convertir en FillEvent et notifier les fill listeners aussi
            if (order.status === "MATCHED") {
              const fillEvent: FillEvent = {
                type: "fill",
                orderId: order.orderId,
                asset: order.asset,
                market: "unknown",
                side: order.side,
                price: order.price,
                size: order.originalSize,
                fee: "0",
                timestamp: order.timestamp,
                status: "MATCHED"
              };
              
              log.info({
                orderId: fillEvent.orderId?.substring(0, 16) + '...' || 'unknown',
                side: fillEvent.side,
                price: fillEvent.price,
                size: fillEvent.size
              }, "💰 FILL from ORDER MATCHED event");
              
              this.fillListeners.forEach(listener => listener(fillEvent));
            }
          } catch (orderError) {
            log.error({ orderError, msg }, "Error processing order event");
          }
        }
        
        // Log des messages non reconnus pour debug
        else {
          log.debug({ msg }, "Unrecognized user WS message type");
        }
      } catch (e) {
        log.warn({ e, data: buf.toString().substring(0, 200) }, "WS user parse error");
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
      }, "User WebSocket closed");

      // Reconnexion avec backoff exponentiel
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
        log.info({ delay, attempt: this.reconnectAttempts }, "Scheduling user WS reconnection");
        
        this.reconnectTimeout = setTimeout(() => {
          this.connect();
        }, delay);
      } else {
        log.error({ maxAttempts: this.maxReconnectAttempts }, "Max user WS reconnection attempts reached");
      }
    });

    this.ws.on("error", (err) => {
      this.isConnecting = false;
      log.error({ 
        err: {
          type: err.constructor.name,
          message: err.message,
          code: (err as any).code
        }
      }, "User WebSocket error");
    });
  }

  /**
   * Enregistre un listener pour les fills
   */
  onFill(listener: (fill: FillEvent) => void) {
    this.fillListeners.push(listener);
  }

  /**
   * Enregistre un listener pour les mises à jour d'ordres
   */
  onOrder(listener: (order: OrderEvent) => void) {
    this.orderListeners.push(listener);
  }

  /**
   * Ferme proprement la connexion
   */
  disconnect() {
    log.info("Disconnecting user WebSocket...");
    
    if (this.ping) {
      clearInterval(this.ping);
      this.ping = undefined;
    }
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "Normal closure");
    }
    
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    log.info("User WebSocket disconnected");
  }
}

