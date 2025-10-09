// src/ws/userFeed.ts - WebSocket utilisateur pour recevoir les fills en temps réel
import WebSocket from "ws";
import crypto from "crypto";
import { rootLog } from "../index";
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
      
      log.info("✅ User WebSocket connected - ready to receive fills, orders, balance updates");
      
      // Ping périodique
      this.ping = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 25_000); // Augmenté à 25s comme suggéré
    });

    this.ws.on("pong", () => {
      // Pong reçu, connexion OK
    });

    this.ws.on("message", (buf) => {
      try {
        const data = buf.toString();
        
        if (data === "PONG") {
          return;
        }
        
        const msg = JSON.parse(data);
        
        // Log tous les messages pour debug
        log.debug({
          event_type: msg.event_type,
          type: msg.type,
          message: JSON.stringify(msg)
        }, "🔍 UserFeed message received");
        
        // Fill event (ordre exécuté totalement ou partiellement)
        if (msg.event_type === "match" || msg.type === "fill" || msg.event_type === "fill") {
          const fill: FillEvent = {
            type: "fill",
            orderId: msg.order_id || msg.orderId,
            asset: msg.asset_id || msg.asset,
            market: msg.market,
            side: msg.side?.toUpperCase() as "BUY" | "SELL",
            price: msg.price,
            size: msg.size || msg.size_matched,
            fee: msg.fee_rate_bps ? (parseFloat(msg.price) * parseFloat(msg.size) * parseFloat(msg.fee_rate_bps) / 10000).toString() : "0",
            timestamp: msg.timestamp || Date.now(),
            status: "MATCHED"
          };
          
          log.info({
            orderId: fill.orderId.substring(0, 16) + '...',
            side: fill.side,
            price: fill.price,
            size: fill.size,
            asset: fill.asset.substring(0, 20) + '...'
          }, "💰 FILL EVENT");
          
          this.fillListeners.forEach(listener => listener(fill));
        }
        
        // Order status update (LIVE, CANCELLED, etc.)
        else if (msg.event_type === "order" || msg.type === "order") {
          const order: OrderEvent = {
            type: "order",
            orderId: msg.order_id || msg.orderId,
            status: msg.status?.toUpperCase() || "LIVE",
            asset: msg.asset_id || msg.asset,
            side: msg.side?.toUpperCase() as "BUY" | "SELL",
            price: msg.price,
            originalSize: msg.original_size || msg.size,
            sizeMatched: msg.size_matched,
            timestamp: msg.timestamp || Date.now()
          };
          
          log.info({
            orderId: order.orderId.substring(0, 16) + '...',
            status: order.status,
            side: order.side,
            price: order.price,
            size: order.originalSize
          }, `📋 ORDER ${order.status}`);
          
          this.orderListeners.forEach(listener => listener(order));
        }
      } catch (e) {
        log.warn({ e, data: buf.toString().substring(0, 100) }, "WS user parse error");
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

