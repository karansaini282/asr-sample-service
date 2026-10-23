import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: "ambience-transcription-service",
    env: process.env.NODE_ENV || "production",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(component, extra = {}) {
  return logger.child({ component, ...extra });
}
