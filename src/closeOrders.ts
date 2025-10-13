// src/closeOrders.ts - Script pour fermer les ordres ouverts
import pino from "pino";
import { PolyClobClient } from "./clients/polySDK";
import { JsonRpcProvider } from "ethers";
import { RPC_URL } from "./config";
// POLY_PROXY_ADDRESS - UNUSED (removed)

const log = pino({ name: "close-orders" });

export class OrderCloser {
  private clob: PolyClobClient;

  constructor(clob: PolyClobClient, _inventoryManager: any, _provider?: JsonRpcProvider) {
    this.clob = clob;
    log.info("🗑️ OrderCloser initialized");
  }

  /**
   * Récupère tous les ordres ouverts pour le compte.
   * @returns Une liste d'ordres ouverts.
   */
  async getOpenOrders(): Promise<any[]> {
    try {
      const response = await this.clob.getOrders({ status: 'OPEN' });
      return response.data || [];
    } catch (error: any) {
      log.error({ error: error.response?.data || error.message }, "❌ Failed to retrieve open orders.");
      return [];
    }
  }

  /**
   * Annule une liste d'ordres par leurs IDs.
   * @param orderIds Les IDs des ordres à annuler.
   * @param dryRun Si true, simule l'annulation sans l'exécuter.
   * @returns Un objet avec les ordres annulés et ceux qui ont échoué.
   */
  async cancelOrdersByIds(orderIds: string[], dryRun: boolean = false): Promise<{ cancelled: string[], failed: { id: string, error: any }[] }> {
    const cancelled: string[] = [];
    const failed: { id: string, error: any }[] = [];

    if (orderIds.length === 0) {
      log.info("No order IDs provided for cancellation.");
      return { cancelled, failed };
    }

    if (dryRun) {
      log.info({ orderIds }, "🧪 DRY RUN: Would cancel these orders.");
      return { cancelled: orderIds, failed: [] };
    }

    try {
      // Le CustomClobClient.cancelOrders prend un tableau d'IDs
      const response = await this.clob.cancelOrders(orderIds);
      // La réponse du CLOB peut varier, on suppose qu'elle indique le succès
      // ou qu'elle lève une erreur en cas d'échec global.
      // Si la réponse contient une liste d'ordres annulés, on l'utilise.
      if (response && Array.isArray(response.canceled)) {
        cancelled.push(...response.canceled);
        // Si certains n'ont pas été annulés, on peut les considérer comme échoués
        const notCancelled = orderIds.filter(id => !response.canceled.includes(id));
        for (const id of notCancelled) {
          failed.push({ id, error: "Not confirmed as cancelled by API" });
        }
      } else {
        // Si la réponse est juste un succès sans détails, on suppose que tout a été annulé
        cancelled.push(...orderIds);
      }
      log.info({ count: cancelled.length }, "✅ Orders cancelled successfully.");
    } catch (error: any) {
      log.error({ error: error.response?.data || error.message, orderIds }, "❌ Failed to cancel orders.");
      for (const id of orderIds) {
        failed.push({ id, error: error.response?.data || error.message });
      }
    }

    return { cancelled, failed };
  }

  /**
   * Ferme tous les ordres ouverts pour le compte.
   * @param dryRun Si true, simule la fermeture sans l'exécuter.
   * @returns Un résumé de l'opération.
   */
  async closeAllOrders(dryRun: boolean = false): Promise<{ success: boolean, totalOrders: number, cancelledOrders: string[], failedOrders: { id: string, error: any }[], errors: any[] }> {
    log.info({ dryRun }, "🗑️ Closing all orders...");
    const openOrders = await this.getOpenOrders();
    const orderIds = openOrders.map(order => order.orderId || order.orderID).filter(Boolean);

    if (orderIds.length === 0) {
      log.info("No open orders found to close.");
      return { success: true, totalOrders: 0, cancelledOrders: [], failedOrders: [], errors: [] };
    }

    const { cancelled, failed } = await this.cancelOrdersByIds(orderIds, dryRun);

    const success = failed.length === 0;
    if (success) {
      log.info({ totalOrders: orderIds.length, cancelled: cancelled.length }, "✅ All orders closed successfully.");
    } else {
      log.warn({ totalOrders: orderIds.length, cancelled: cancelled.length, failed: failed.length }, "⚠️ Some orders failed to close.");
    }

    return { success, totalOrders: orderIds.length, cancelledOrders: cancelled, failedOrders: failed, errors: failed.map(f => f.error) };
  }

  /**
   * Ferme les ordres ouverts pour un token spécifique.
   * @param tokenId L'ID du token pour lequel fermer les ordres.
   * @param dryRun Si true, simule la fermeture sans l'exécuter.
   * @returns Un résumé de l'opération.
   */
  async closeOrdersForToken(tokenId: string, dryRun: boolean = false): Promise<{ success: boolean, totalOrders: number, cancelledOrders: string[], failedOrders: { id: string, error: any }[], errors: any[] }> {
    log.info({ tokenId: tokenId.substring(0, 20) + '...', dryRun }, "🗑️ Closing orders for specific token...");
    const openOrders = await this.getOpenOrders();
    const ordersToCancel = openOrders.filter(order => order.tokenId === tokenId);
    const orderIds = ordersToCancel.map(order => order.orderId || order.orderID).filter(Boolean);

    if (orderIds.length === 0) {
      log.info({ tokenId: tokenId.substring(0, 20) + '...' }, "No open orders found for this token.");
      return { success: true, totalOrders: 0, cancelledOrders: [], failedOrders: [], errors: [] };
    }

    const { cancelled, failed } = await this.cancelOrdersByIds(orderIds, dryRun);

    const success = failed.length === 0;
    if (success) {
      log.info({ tokenId: tokenId.substring(0, 20) + '...', cancelled: cancelled.length }, "✅ Orders for token closed successfully.");
    } else {
      log.warn({ tokenId: tokenId.substring(0, 20) + '...', cancelled: cancelled.length, failed: failed.length }, "⚠️ Some orders for token failed to close.");
    }

    return { success, totalOrders: orderIds.length, cancelledOrders: cancelled, failedOrders: failed, errors: failed.map(f => f.error) };
  }

  /**
   * Récupère un résumé des ordres ouverts.
   */
  async getOpenOrdersSummary(): Promise<any> {
    const orders = await this.getOpenOrders();
    let totalOrders = orders.length;
    let ordersByToken: Map<string, number> = new Map();
    let ordersBySide: { BUY: number; SELL: number; } = { BUY: 0, SELL: 0 };
    let totalNotional = 0;

    for (const order of orders) {
      // Par token
      const tokenId = order.tokenId || 'unknown';
      ordersByToken.set(tokenId, (ordersByToken.get(tokenId) || 0) + 1);

      // Par côté
      if (order.side === 'BUY' || order.side === 'SELL') {
        ordersBySide[order.side as 'BUY' | 'SELL']++;
      }

      // Notional total (approximatif)
      if (order.price && order.size) {
        totalNotional += order.price * order.size;
      }
    }

    return {
      totalOrders,
      ordersByToken: Object.fromEntries(ordersByToken),
      ordersBySide,
      totalNotional: totalNotional.toFixed(2)
    };
  }
}