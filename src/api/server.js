import Fastify from "fastify";
import { registerTranscriptionRoutes } from "./routes.js";
import { CONFIG } from "../config.js";

export async function buildApiServer(options = {}) {
  const fastify = Fastify({
    logger: options.logger ?? true,
  });

  await registerTranscriptionRoutes(fastify, options);

  // Health and root endpoint
  fastify.get("/", async () => {
    return {
      service: "Ambience Healthcare Audio Transcription Service",
      status: "healthy",
      version: "1.0.0",
      endpoints: {
        submitJob: "POST /transcribe",
        getTranscript: "GET /transcript/:jobId",
        searchTranscripts: "GET /transcript/search?userId={id}&jobStatus={status}",
        metrics: "GET /api/metrics",
      },
    };
  });

  return fastify;
}

// Standalone execution check
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const server = await buildApiServer();
  try {
    await server.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    console.log(`[API Server] Running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
