// Wrapper autour du SDK officiel Polymarket pour compatibilité totale
import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import pino from "pino";

const log = pino({ name: "poly-sdk" });

/**
 * Client CLOB basé sur le SDK officiel Polymarket
 * Compatible avec notre architecture existante
 */
export class PolyClobClient {
  private client: ClobClient;
  private wallet: Wallet;
  private proxyAddress: string;
  private eoaAddress: string;

  constructor(
    privateKey: string,
    apiKey: string,
    apiSecret: string,
    apiPassphrase: string,
    baseURL: string = "https://clob.polymarket.com",
    funderAddress?: string
  ) {
    this.wallet = new Wallet(privateKey);
    this.eoaAddress = this.wallet.address;
    this.proxyAddress = funderAddress || this.eoaAddress;
    
    log.info({
      eoaAddress: this.eoaAddress,
      proxyAddress: this.proxyAddress,
      baseURL,
      usingProxy: !!funderAddress
    }, "🚀 Initializing Polymarket SDK Client");
    
    // Déterminer le signatureType approprié
    // Si funderAddress est fourni et différent de l'EOA, utiliser POLY_GNOSIS_SAFE (2)
    // Sinon utiliser EOA (0)
    const signatureType = (funderAddress && funderAddress.toLowerCase() !== this.eoaAddress.toLowerCase()) 
      ? 2  // POLY_GNOSIS_SAFE - pour proxy Polymarket
      : 0; // EOA - pour wallet direct
    
    log.info({
      signatureType,
      signatureTypeLabel: signatureType === 2 ? 'POLY_GNOSIS_SAFE' : 'EOA'
    }, "🔐 Signature type determined");
    
    // Créer le client officiel AVEC le signatureType
    this.client = new ClobClient(
      baseURL,
      137, // Polygon chainId
      this.wallet,
      {
        key: apiKey,
        secret: apiSecret,
        passphrase: apiPassphrase
      },
      signatureType, // CRUCIAL : Passer le signatureType ici !
      funderAddress // funderAddress = proxy si spécifié
    );
    
    log.info("✅ Polymarket SDK Client initialized with correct signatureType");
  }

  /**
   * Place un ordre en utilisant le SDK officiel
   */
  async postOrder(orderData: any): Promise<any> {
    try {
      // Extraire les données de l'ordre
      const order = orderData.order || orderData;
      
      // Convertir le format de notre buildOrder vers le format SDK
      const price = this.calculatePrice(order);
      const size = this.calculateSize(order);
      const side = this.convertSide(order.side);
      
      log.debug({
        tokenId: order.tokenId?.substring(0, 20) + '...',
        side: side === 0 ? 'BUY' : 'SELL',
        price: price.toFixed(4),
        size: size.toFixed(2)
      }, "📝 Placing order with SDK");
      
      // Créer l'ordre avec le SDK (utiliser l'enum Side)
      const userOrder = {
        tokenID: order.tokenId,
        price,
        size,
        side: side === 0 ? Side.BUY : Side.SELL, // Utiliser l'enum du SDK
        feeRateBps: order.feeRateBps || "0"
      };
      
      // Créer et signer l'ordre
      const signedOrder = await this.client.createOrder(userOrder);
      
      log.debug({
        signatureType: signedOrder.signatureType,
        maker: signedOrder.maker,
        signer: signedOrder.signer
      }, "✍️ Order signed by SDK");
      
      // Envoyer l'ordre
      const orderType = orderData.orderType || "GTC";
      const response = await this.client.postOrder(signedOrder, orderType as any);
      
      log.info({
        orderId: response.orderID,
        success: response.success
      }, "✅ Order placed successfully");
      
      return {
        success: response.success,
        orderId: response.orderID,
        orderID: response.orderID, // Compatibilité
        ...response
      };
      
    } catch (error: any) {
      log.error({
        error: error.message,
        response: error.response?.data
      }, "❌ Failed to place order");
      throw error;
    }
  }

  /**
   * Annule des ordres
   */
  async cancelOrders(orderIds: string[]): Promise<any> {
    try {
      log.info({ count: orderIds.length }, "🗑️ Canceling orders");
      const response = await this.client.cancelOrders(orderIds);
      log.info({ canceled: response.canceled?.length || orderIds.length }, "✅ Orders canceled");
      return response;
    } catch (error: any) {
      log.error({ error: error.message }, "❌ Failed to cancel orders");
      throw error;
    }
  }

  /**
   * Récupère le balance/allowance
   */
  async getBalanceAllowance(params: any): Promise<any> {
    try {
      return await this.client.getBalanceAllowance(params as any);
    } catch (error: any) {
      log.error({ error: error.message }, "❌ Failed to get balance/allowance");
      throw error;
    }
  }

  /**
   * Met à jour le balance/allowance
   */
  async updateBalanceAllowance(body: any): Promise<any> {
    try {
      return await this.client.updateBalanceAllowance(body as any);
    } catch (error: any) {
      log.error({ error: error.message }, "❌ Failed to update balance/allowance");
      throw error;
    }
  }

  /**
   * Récupère l'orderbook
   */
  async getOrderBook(tokenId: string): Promise<any> {
    try {
      return await this.client.getOrderBook(tokenId);
    } catch (error: any) {
      log.error({ error: error.message }, "❌ Failed to get orderbook");
      throw error;
    }
  }

  /**
   * Récupère les ordres ouverts
   */
  async getOpenOrders(): Promise<any[]> {
    try {
      return await this.client.getOpenOrders();
    } catch (error: any) {
      log.error({ error: error.message }, "❌ Failed to get open orders");
      return [];
    }
  }

  /**
   * Récupère les ordres (avec filtres optionnels)
   * Alias pour compatibilité
   */
  async getOrders(_params?: any): Promise<any> {
    try {
      // Le SDK officiel utilise getOpenOrders, on ajoute un alias
      return await this.client.getOpenOrders();
    } catch (error: any) {
      log.error({ error: error.message }, "❌ Failed to get orders");
      return [];
    }
  }

  /**
   * Retourne l'adresse EOA
   */
  getAddress(): string {
    return this.eoaAddress;
  }

  /**
   * Retourne l'adresse du maker (proxy ou EOA)
   */
  getMakerAddress(): string {
    return this.proxyAddress;
  }

  // ===== NOUVELLES MÉTHODES - MÉTADONNÉES MARCHÉS =====

  /**
   * Récupère les métadonnées d'un marché depuis CLOB
   * API: GET /markets (cherche par condition_id)
   * Retourne: tick_size, min_order_size, end_date, neg_risk
   */
  async getMarketMetadata(conditionId: string): Promise<{
    tickSize: number;
    minOrderSize: number;
    negRisk: boolean;
    endDate?: string;
  } | null> {
    try {
      // Note: Le SDK ne expose pas directement getMarket, on utilise les books
      const response = await this.client.getMarket(conditionId);
      
      if (!response) {
        return null;
      }

      return {
        tickSize: parseFloat(response.minimum_tick_size || response.tick_size || "0.001"),
        minOrderSize: parseFloat(response.minimum_order_size || response.min_size || "5"),
        negRisk: response.neg_risk || false,
        endDate: response.end_date_iso || response.end_date
      };
    } catch (error: any) {
      log.debug({ conditionId: conditionId.substring(0, 20) + '...' }, "Market metadata not available via SDK");
      return null;
    }
  }

  /**
   * Récupère le tick size pour un token depuis le book
   * API: GET /book?token_id={token_id}
   */
  async getTickSizeForToken(tokenId: string): Promise<number> {
    try {
      const book = await this.getOrderBook(tokenId);
      
      if (book && book.tick_size) {
        return parseFloat(book.tick_size);
      }
      
      return 0.001; // Fallback tick size standard
    } catch (error: any) {
      return 0.001;
    }
  }

  /**
   * Récupère min_order_size pour un token depuis le book
   * API: GET /book?token_id={token_id}
   */
  async getMinOrderSizeForToken(tokenId: string): Promise<number> {
    try {
      const book = await this.getOrderBook(tokenId);
      
      if (book && (book.min_order_size || book.minimum_order_size)) {
        return parseFloat(book.min_order_size || book.minimum_order_size);
      }
      
      return 5; // Fallback minimum Polymarket standard
    } catch (error: any) {
      return 5;
    }
  }

  /**
   * Récupère les books pour plusieurs tokens (batch)
   * Retourne: bestBid, bestAsk, tickSize, minOrderSize par token
   */
  async getBooks(tokenIds: string[]): Promise<Map<string, {
    bestBid: number | null;
    bestAsk: number | null;
    tickSize: number;
    minOrderSize: number;
  }>> {
    const result = new Map();
    
    for (const tokenId of tokenIds) {
      try {
        const book = await this.getOrderBook(tokenId);
        
        if (book) {
          result.set(tokenId, {
            bestBid: book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].price) : null,
            bestAsk: book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].price) : null,
            tickSize: parseFloat(book.tick_size || "0.001"),
            minOrderSize: parseFloat(book.min_order_size || book.minimum_order_size || "5")
          });
        }
      } catch (error) {
        // Continuer avec les autres tokens
        continue;
      }
    }
    
    return result;
  }

  // ===== MÉTHODES UTILITAIRES =====

  /**
   * Calcule le prix à partir d'un ordre
   */
  private calculatePrice(order: any): number {
    const makerAmount = parseFloat(order.makerAmount) / 1e6;
    const takerAmount = parseFloat(order.takerAmount) / 1e6;
    
    // BUY: price = makerAmount (USDC) / takerAmount (shares)
    // SELL: price = takerAmount (USDC) / makerAmount (shares)
    if (order.side === "BUY" || order.side === 0) {
      return makerAmount / takerAmount;
    } else {
      return takerAmount / makerAmount;
    }
  }

  /**
   * Calcule la size à partir d'un ordre
   */
  private calculateSize(order: any): number {
    const takerAmount = parseFloat(order.takerAmount) / 1e6;
    const makerAmount = parseFloat(order.makerAmount) / 1e6;
    
    // BUY: size = takerAmount (shares)
    // SELL: size = makerAmount (shares)
    if (order.side === "BUY" || order.side === 0) {
      return takerAmount;
    } else {
      return makerAmount;
    }
  }

  /**
   * Convertit le side en format SDK (0 = BUY, 1 = SELL)
   */
  private convertSide(side: string | number): 0 | 1 {
    if (typeof side === 'number') {
      return side as 0 | 1;
    }
    return side === "BUY" ? 0 : 1;
  }
}

