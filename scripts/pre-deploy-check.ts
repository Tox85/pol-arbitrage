// Script de vérification pré-déploiement pour Railway
import "dotenv/config";

const REQUIRED_VARS = [
  "PRIVATE_KEY",
  "CLOB_API_KEY",
  "CLOB_API_SECRET",
  "CLOB_PASSPHRASE",
  "POLY_PROXY_ADDRESS",
  "RPC_URL",
  "CHAIN_ID"
];

const OPTIONAL_VARS = [
  "MAX_ACTIVE_MARKETS",
  "NOTIONAL_PER_ORDER_USDC",
  "MIN_NOTIONAL_SELL_USDC",
  "BASE_TARGET_SPREAD",
  "LOG_LEVEL"
];

console.log("🔍 Vérification de la configuration pour Railway...\n");

let hasErrors = false;

// Vérifier les variables obligatoires
console.log("📋 Variables obligatoires :");
for (const key of REQUIRED_VARS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ❌ ${key} - MANQUANT`);
    hasErrors = true;
  } else {
    // Masquer les valeurs sensibles
    const masked = key.includes("KEY") || key.includes("SECRET") || key.includes("PASSPHRASE")
      ? value.substring(0, 6) + "..." + value.substring(value.length - 4)
      : value;
    console.log(`  ✅ ${key} - ${masked}`);
  }
}

console.log("\n📋 Variables optionnelles :");
for (const key of OPTIONAL_VARS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ⚠️  ${key} - Utilise la valeur par défaut`);
  } else {
    console.log(`  ✅ ${key} - ${value}`);
  }
}

console.log("\n" + "=".repeat(60));

if (hasErrors) {
  console.log("❌ Configuration INVALIDE - Des variables obligatoires manquent");
  console.log("\nAjoutez ces variables dans Railway avant de déployer :");
  console.log("https://railway.app → Variables\n");
  process.exit(1);
} else {
  console.log("✅ Configuration VALIDE - Prêt pour le déploiement sur Railway!");
  console.log("\n📝 Commandes de déploiement :");
  console.log("  Via GitHub : Push to main (déjà fait ✅)");
  console.log("  Via CLI    : railway up\n");
  process.exit(0);
}

