import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./env.js";
import { loadSession } from "./auth.js";
import { db, initDb } from "./db.js";
import { bootstrapAdmin } from "./models.js";
import { publicRoutes } from "./routes/public.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { setupRoutes } from "./routes/setup.js";

const app = express();
app.set("trust proxy", 1); // behind Railway/Render/Cloudflare
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!req.path.startsWith("/w/")) res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.get("/healthz", async (_req, res) => {
  try {
    await db.get("SELECT 1 AS ok");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.use("/static", express.static(path.resolve("public"), { maxAge: "1h" }));

// Public endpoints (widget + WhatsApp webhook) use their own body parsers, so mount them first.
app.use(publicRoutes);

app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
app.use(loadSession);

app.use(authRoutes);
app.use(adminRoutes);
app.use(setupRoutes);

app.use((_req, res) => res.status(404).send("Page not found."));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).send("That file is too big. Upload the small .json key file from Google.");
  res.status(500).send("Something went wrong. Please go back and try again.");
});

async function main() {
  await initDb();
  await bootstrapAdmin();
  app.listen(env.port, () => {
    console.log(`🚀 ${env.appName} running at ${env.publicUrl} (port ${env.port}) · database: ${db.kind()}`);
    startKeepAlive();
  });
}

// Free hosts (Render) put the app to sleep after ~15 idle minutes. Pinging our own public URL every
// 10 minutes counts as traffic and keeps it awake. Harmless on hosts that don't sleep; off when KEEP_ALIVE=0.
function startKeepAlive() {
  if (process.env.KEEP_ALIVE === "0" || !/^https:\/\//.test(env.publicUrl)) return;
  setInterval(() => {
    fetch(`${env.publicUrl}/healthz`).catch(() => undefined);
  }, 10 * 60_000).unref();
}

main().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
