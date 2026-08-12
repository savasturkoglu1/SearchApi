import { buildApp, createDependencies, listenApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const runtime = createDependencies(config);
const app = buildApp(config, runtime);
let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    app.log.info({ signal }, "Browser capture server kapatılıyor");
    const forceExit = setTimeout(() => {
      app.log.error({ signal }, "Browser kapanışı zaman aşımına uğradı");
      process.exit(1);
    }, 15_000);
    forceExit.unref();
    try {
      await app.close();
    } finally {
      clearTimeout(forceExit);
      process.exit(exitCode);
    }
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await listenApp(app, runtime, { host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await shutdown("STARTUP_ERROR", 1);
}
