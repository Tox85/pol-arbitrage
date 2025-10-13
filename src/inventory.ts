// src/inventory.ts - Gestion de l'inventaire des tokens (shares)
import pino from "pino";
import { JsonRpcProvider } from "ethers";
import { MIN_INVENTORY_CLEANUP, INVENTORY_PERSISTENCE_FILE } from "./config";
// MAX_INVENTORY_YES, MAX_INVENTORY_NO - UNUSED (removed, managed in marketMaker.ts)
import fs from "fs/promises";

const log = pino({ name: "inventory" });

export class InventoryManager {
  // Map: tokenId -> current_shares_held (positive for long, negative for short)
  private inventory: Map<string, number> = new Map();
  private maxInventory: number;
  private provider: JsonRpcProvider; // Pour d'éventuelles vérifications on-chain
  private saveMutex: Promise<void> = Promise.resolve(); // Mutex pour écriture atomique sérialisée

  constructor(provider: JsonRpcProvider, maxInventory: number = 100) {
    this.provider = provider;
    this.maxInventory = maxInventory;

    // L'inventaire sera chargé via loadFromFile() après l'initialisation
    this.inventory = new Map();

    // NE PAS utiliser syncWithRealPositions() car il contient des valeurs hardcodées
    // La synchronisation réelle sera faite via syncFromOnChainReal() après l'initialisation

    log.info({
      maxInventory,
      loadedShares: this.inventory.size,
      totalShares: Array.from(this.inventory.values()).reduce((sum, val) => sum + val, 0),
      persistenceFile: INVENTORY_PERSISTENCE_FILE
    }, "📦 InventoryManager initialized");
  }

  /**
   * Sauvegarde l'inventaire dans le fichier
   */
  private async saveInventory(): Promise<void> {
    await this.saveToFile(INVENTORY_PERSISTENCE_FILE);
  }

  /**
   * Sauvegarde l'inventaire dans un fichier spécifique
   */
  async saveToFile(filePath: string = INVENTORY_PERSISTENCE_FILE): Promise<void> {
    // MUTEX : Sérialiser toutes les écritures pour éviter race conditions
    this.saveMutex = this.saveMutex.then(async () => {
      try {
        const data: Record<string, number> = {};
        for (const [tokenId, shares] of this.inventory.entries()) {
          data[tokenId] = shares;
        }
        
        // ÉCRITURE ATOMIQUE : tmp → rename (évite corruption en cas de crash)
        const tmpFile = `${filePath}.tmp.${Date.now()}`;
        const content = JSON.stringify(data, null, 2);
        
        // 1. Écrire dans fichier temporaire
        await fs.writeFile(tmpFile, content, 'utf-8');
        
        // 2. Rename atomique (garantit cohérence)
        try {
          await fs.rename(tmpFile, filePath);
        } catch (renameError) {
          // Fallback Windows : supprimer puis rename
          try {
            await fs.unlink(filePath);
          } catch { /* fichier n'existe pas */ }
          await fs.rename(tmpFile, filePath);
        }
        
        log.debug({ filePath, count: this.inventory.size }, "💾 Inventory saved atomically");
      } catch (error) {
        log.error({ error, filePath }, "❌ Failed to save inventory");
      }
    });
    
    await this.saveMutex;
  }

  /**
   * Charge l'inventaire depuis un fichier spécifique
   */
  async loadFromFile(filePath: string = INVENTORY_PERSISTENCE_FILE): Promise<Map<string, number>> {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, number>;
      const map = new Map<string, number>();
      for (const [tokenId, shares] of Object.entries(parsed)) {
        map.set(tokenId, shares);
      }
      this.inventory = map;
      log.info({ filePath, count: map.size }, "📦 Inventory loaded from file");
      return map;
    } catch (error) {
      log.warn({ error, filePath }, "Could not load inventory file - starting fresh");
      return new Map();
    }
  }

  /**
   * Synchronise l'inventaire d'un token spécifique via lecture on-chain directe.
   * Cette méthode lit le solde réel du token ERC-1155 sur la blockchain.
   * @param tokenId L'ID du token ERC-1155 à synchroniser
   * @param ownerAddress Adresse du proxy wallet
   */
  async syncFromOnChainReal(tokenId: string, ownerAddress: string): Promise<void> {
    try {
      const { readErc1155Balance } = await import("./lib/erc1155");
      
      const balance = await readErc1155Balance(this.provider, tokenId, ownerAddress);
      
      // Convertir de micro-units à shares (diviser par 1e6)
      const shares = Number(balance) / 1e6;
      
      // Mettre à jour l'inventaire local
      this.inventory.set(tokenId, shares);
      
      log.info({
        tokenId: tokenId.substring(0, 20) + '...',
        balance: balance.toString(),
        shares: shares.toFixed(2)
      }, "🔄 Token synchronized from on-chain");

    } catch (error) {
      log.error({
        error,
        tokenId: tokenId.substring(0, 20) + '...'
      }, "❌ Failed to sync token from on-chain");
    }
  }

  /**
   * Synchronise l'inventaire d'un token spécifique avec la blockchain (méthode legacy).
   * @deprecated Utiliser syncFromClob() à la place qui interroge directement le CLOB.
   */
  async syncFromOnChain(tokenId: string): Promise<void> {
    log.warn({
      tokenId: tokenId.substring(0, 20) + '...'
    }, "⚠️ syncFromOnChain() is deprecated, use syncFromClob() instead");
    
    // Pour la compatibilité, on initialise simplement à 0 si le token n'existe pas
    if (!this.inventory.has(tokenId)) {
      this.inventory.set(tokenId, 0);
    }
  }

  /**
   * Synchronise tous les tokens de l'inventaire via lecture on-chain.
   * @param ownerAddress Adresse du proxy wallet
   */
  async syncAllFromOnChainReal(ownerAddress: string): Promise<void> {
    log.info("🔄 Starting full on-chain inventory sync...");
    
    const tokenIds = Array.from(this.inventory.keys());
    
    for (const tokenId of tokenIds) {
      await this.syncFromOnChainReal(tokenId, ownerAddress);
      // Petite pause pour éviter les rate limits RPC
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    await this.saveInventory();
    
    log.info({
      syncedTokens: tokenIds.length,
      totalShares: Array.from(this.inventory.values()).reduce((sum, val) => sum + val, 0)
    }, "✅ Full on-chain inventory sync completed");
  }

  /**
   * Synchronise tous les tokens de l'inventaire avec la blockchain (méthode legacy).
   * @deprecated Utiliser syncAllFromClob() à la place.
   */
  async syncAllFromOnChain(): Promise<void> {
    log.warn("⚠️ syncAllFromOnChain() is deprecated, use syncAllFromClob() instead");
  }

  /**
   * Obtient tout l'inventaire sous forme d'objet
   */
  getAllInventory(): Record<string, number> {
    return Object.fromEntries(this.inventory);
  }

  /**
   * Ajoute des shares à l'inventaire après un ordre BUY réussi.
   * @param tokenId L'ID du token (outcome)
   * @param size Le nombre de shares achetées
   */
  addBuy(tokenId: string, size: number): void {
    const current = this.getInventory(tokenId);
    const newTotal = current + size;
    this.inventory.set(tokenId, newTotal);
    this.saveInventory().catch(error => {
      log.error({ error }, "Failed to save inventory after BUY");
    }); // Sauvegarder après chaque modification
    log.debug({ 
      tokenId: tokenId.substring(0, 20) + '...', 
      size, 
      previousInventory: current,
      newInventory: newTotal 
    }, "➕ Inventory updated (BUY)");
  }

  /**
   * Déduit des shares de l'inventaire après un ordre SELL réussi.
   * @param tokenId L'ID du token (outcome)
   * @param size Le nombre de shares vendues
   */
  addSell(tokenId: string, size: number): void {
    const current = this.getInventory(tokenId);
    const newTotal = current - size;
    this.inventory.set(tokenId, newTotal);
    this.saveInventory().catch(error => {
      log.error({ error }, "Failed to save inventory after SELL");
    }); // Sauvegarder après chaque modification
    log.debug({ 
      tokenId: tokenId.substring(0, 20) + '...', 
      size, 
      previousInventory: current,
      newInventory: newTotal 
    }, "➖ Inventory updated (SELL)");
  }

  /**
   * Retourne l'inventaire actuel pour un token donné.
   * @param tokenId L'ID du token (outcome)
   * @returns Le nombre de shares détenues (peut être négatif pour un short implicite)
   */
  getInventory(tokenId: string): number {
    return this.inventory.get(tokenId) || 0;
  }

  /**
   * Vérifie si un achat est possible sans dépasser la limite d'inventaire.
   * @param tokenId L'ID du token
   * @param size La taille de l'ordre d'achat
   * @returns true si l'achat est possible, false sinon
   */
  canBuy(tokenId: string, size: number): boolean {
    const current = this.getInventory(tokenId);
    // On peut acheter si l'inventaire actuel + la taille de l'achat ne dépasse pas la limite max
    // Ou si l'inventaire est négatif (on est short), on peut toujours acheter pour réduire le short
    return (current + size <= this.maxInventory) || (current < 0);
  }

  /**
   * Vérifie si une vente est possible avec l'inventaire disponible.
   * @param tokenId L'ID du token
   * @param size La taille de l'ordre de vente
   * @returns true si la vente est possible, false sinon
   */
  canSell(tokenId: string, size: number): boolean {
    const current = this.getInventory(tokenId);
    // On peut vendre si on a suffisamment de shares en inventaire (current > 0)
    // Ou si on est déjà short et qu'on veut augmenter notre short (current - size >= -maxInventory)
    return current >= size || (current - size >= -this.maxInventory);
  }

  /**
   * Nettoie l'inventaire des tokens avec une quantité négligeable.
   */
  cleanup(): void {
    let cleanedCount = 0;
    this.inventory.forEach((value, key) => {
      if (Math.abs(value) < MIN_INVENTORY_CLEANUP) {
        this.inventory.delete(key);
        cleanedCount++;
        log.debug({ tokenId: key.substring(0, 20) + '...' }, "🧹 Cleaned up negligible inventory");
      }
    });
    if (cleanedCount > 0) {
      log.info({ cleanedCount }, "🧹 Inventory cleanup completed");
    }
  }

  /**
   * Retourne un résumé de l'inventaire.
   */
  getSummary(): any {
    let totalTokens = 0;
    let totalValue = 0; // Ceci nécessiterait les prix actuels pour être précis
    let longPositions = 0;
    let shortPositions = 0;
    let totalShares = 0;

    this.inventory.forEach((value, tokenId) => {
      if (Math.abs(value) >= MIN_INVENTORY_CLEANUP) {
        totalTokens++;
        totalShares += Math.abs(value);
        if (value > 0) {
          longPositions++;
        } else if (value < 0) {
          shortPositions++;
        }
      }
    });

    return {
      totalTokens,
      totalShares: totalShares.toFixed(2),
      totalValue, // Actuellement 0, à améliorer avec les prix
      longPositions,
      shortPositions,
      maxInventory: this.maxInventory,
      details: Object.fromEntries(
        Array.from(this.inventory.entries()).filter(([_, value]) => Math.abs(value) >= MIN_INVENTORY_CLEANUP)
      )
    };
  }

  /**
   * Retourne l'inventaire pour un token spécifique avec plus de détails.
   * @param tokenId L'ID du token
   * @returns Détails de l'inventaire pour ce token
   */
  getInventoryForToken(tokenId: string): {
    current: number;
    canBuy: boolean;
    canSell: boolean;
    maxBuySize: number;
    maxSellSize: number;
  } {
    const current = this.getInventory(tokenId);
    const maxBuySize = Math.max(0, this.maxInventory - current);
    const maxSellSize = Math.max(0, current);

    return {
      current,
      canBuy: current < this.maxInventory,
      canSell: current > 0,
      maxBuySize,
      maxSellSize
    };
  }

  /**
   * Force la mise à jour de l'inventaire pour un token (utile pour la synchronisation).
   * @param tokenId L'ID du token
   * @param newValue La nouvelle valeur d'inventaire
   */
  setInventory(tokenId: string, newValue: number): void {
    const previous = this.getInventory(tokenId);
    this.inventory.set(tokenId, newValue);
    log.debug({ 
      tokenId: tokenId.substring(0, 20) + '...', 
      previous, 
      newValue 
    }, "🔄 Inventory force updated");
  }

  /**
   * Réinitialise complètement l'inventaire.
   */
  reset(): void {
    const count = this.inventory.size;
    this.inventory.clear();
    log.info({ clearedCount: count }, "🔄 Inventory reset");
  }

  // TODO: Implémenter la lecture on-chain via ERC1155 pour vérifier l'inventaire réel
  // Cela nécessiterait l'ABI de l'ERC1155 et l'adresse du contrat.
  async readOnChainInventory(tokenId: string, ownerAddress: string): Promise<number> {
    log.warn("On-chain inventory check not yet implemented.");
    return 0; // Placeholder
  }
}