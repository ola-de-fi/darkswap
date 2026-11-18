import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { startKeeper } from "./keeper.js";

loadEnv({ path: process.env.KEEPER_ENV_FILE ?? resolve(process.cwd(), ".env") });
loadEnv({ path: resolve(process.cwd(), "../.env"), override: false });

startKeeper().catch((error: unknown) => {
  const kind = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`${JSON.stringify({ level: "error", event: "startup_failed", error: kind })}\n`);
  process.exitCode = 1;
});
