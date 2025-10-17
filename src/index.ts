// Point d'entrée principal - PolymMM-GuardedSpread
import "dotenv/config";
import { DRY_RUN } from "./config";
import { PolyClobClient } from "./clients/polySDK";
import { MarketMaker } from "./core/MarketMaker";
import { rootLog } from "./logger";

const log = rootLog.child({ name: "main" });

// ============================================================
// VALIDATION DES VARIABLES D'ENVIRONNEMENT
// ============================================================
const REQUIRED_ENV = [
  "PRIVATE_KEY",
  "CLOB_API_KEY",
  "CLOB_API_SECRET",
  "CLOB_PASSPHRASE",
  "POLY_PROXY_ADDRESS"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

console.log("✅ ENV OK - All required environment variables are present");

// ============================================================
// FONCTION PRINCIPALE
// ============================================================
async function main() {
  log.info({ separator: "=".repeat(60) }, "");
  log.info("🚀 Starting PolymMM-GuardedSpread Market Maker Bot");
  log.info({ separator: "=".repeat(60) }, "");

  // Afficher la configuration
  log.info({
    DRY_RUN,
    MAX_MARKETS: process.env.MAX_MARKETS || 3,
    MIN_SPREAD_CENTS: process.env.MIN_SPREAD_CENTS || 1.5,
    MIN_VOLUME_24H_USD: process.env.MIN_VOLUME_24H_USD || 5000,
    MIN_DEPTH_TOP2_USD: process.env.MIN_DEPTH_TOP2_USD || 300,
    HOURS_TO_CLOSE_MIN: process.env.HOURS_TO_CLOSE_MIN || 24,
    MIN_NOTIONAL_PER_ORDER_USDC: process.env.MIN_NOTIONAL_PER_ORDER_USDC || 2.0,
    MIN_EXPECTED_PROFIT_USDC: process.env.MIN_EXPECTED_PROFIT_USDC || 0.02,
    MAX_SHARES_PER_MARKET: process.env.MAX_SHARES_PER_MARKET || 50,
    MAX_USDC_PER_MARKET: process.env.MAX_USDC_PER_MARKET || 8,
    MAX_NOTIONAL_AT_RISK_USDC: process.env.MAX_NOTIONAL_AT_RISK_USDC || 25,
    ORDER_TTL_MS: process.env.ORDER_TTL_MS || 10000,
    ASK_CHASE_WINDOW_SEC: process.env.ASK_CHASE_WINDOW_SEC || 8,
    ASK_CHASE_MAX_REPLACES: process.env.ASK_CHASE_MAX_REPLACES || 3
  }, "⚙️ Configuration");

  // Créer le client CLOB
  log.info("🔌 Initializing CLOB client...");
  const clob = new PolyClobClient(
    process.env.PRIVATE_KEY!,
    process.env.CLOB_API_KEY!,
    process.env.CLOB_API_SECRET!,
    process.env.CLOB_PASSPHRASE!,
    "https://clob.polymarket.com",
    process.env.POLY_PROXY_ADDRESS
  );
  log.info("✅ CLOB client initialized");

  // Créer et démarrer le Market Maker
  const marketMaker = new MarketMaker(clob);
  await marketMaker.start();

  // Gestion propre de l'arrêt
  const shutdown = async () => {
    log.info("🛑 Shutdown signal received, stopping bot...");
    await marketMaker.stop();
    log.info("👋 Bot stopped gracefully");
    process.exit(0);
  };

  // SIGINT = Ctrl+C local
  process.on("SIGINT", shutdown);

  // SIGTERM = Railway/Docker shutdown
  process.on("SIGTERM", shutdown);

  // Keep-alive
  log.info("✅ Bot running, press Ctrl+C to stop");
}

// ============================================================
// DÉMARRAGE
// ============================================================
main().catch((error) => {
  log.error({ error }, "❌ Fatal error");
  process.exit(1);
});
