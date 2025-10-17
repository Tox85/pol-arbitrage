// Logger global pour toute l'application
import pino from "pino";
import { LOG_LEVEL } from "./config";

// Configuration du logger
export const rootLog = pino({
  level: LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});

