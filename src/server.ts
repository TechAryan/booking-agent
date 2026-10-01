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
import { extraRoutes } from "./routes/extras.js";
import { sweepPayments } from "./bookings.js";
import { purgeLoosePhotos } from "./proofs.js";
import { db as _db } from "./db.js";

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
// Browsers ask for these at the site root.
app.get("/favicon.ico", (_req, res) => res.sendFile(path.resolve("public/favicon.ico"), { maxAge: "7d" }));
app.get("/apple-touch-icon.png", (_req, res) => res.sendFile(path.resolve("public/apple-touch-icon.png"), { maxAge: "7d" }));

// Public endpoints (widget + WhatsApp webhook) use their own body parsers, so mount them first.
app.use(publicRoutes);

app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
app.use(loadSession);

// Appearance preference (harmless, so no login or CSRF needed). Remembered for a year on this device.
app.post("/theme", (req, res) => {
  const t = String(req.body?.theme || "");
  if (!["light", "dark", "system"].includes(t)) return res.status(400).json({ ok: false });
  res.cookie("theme", t, { maxAge: 365 * 86400_000, sameSite: "lax", secure: env.isProd, path: "/" });
  res.json({ ok: true });
});

// Test-only window into the fake Google Calendar.
if (process.env.FAKE_GOOGLE_CALENDAR === "1" && process.env.NODE_ENV === "test") {
  app.get("/__test/google-events", async (_req, res) => res.json((await import("./testing/fakeGoogle.js")).fakeEvents));
}

app.use(authRoutes);
app.use(adminRoutes);
app.use(setupRoutes);
app.use(extraRoutes);

app.use((_req, res) => res.status(404).send("Page not found."));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).send("That file is too big. Please go back and choose a smaller file.");
  res.status(500).send("Something went wrong. Please go back and try again.");
});

async function main() {
  await initDb();
  await bootstrapAdmin();
  app.listen(env.port, () => {
    console.log(`🚀 ${env.appName} running at ${env.publicUrl} (port ${env.port}) · database: ${db.kind()}`);
    startKeepAlive();
    // Confirm payments whose webhook we missed and release slots whose payment link ran out.
    let n = 0;
    const tick = () => {
      sweepPayments((id) => _db.get("SELECT * FROM workspaces WHERE id=?", id)).catch((e) => console.error("payment sweep", e?.message));
      if (n++ % 60 === 0) purgeLoosePhotos().catch(() => undefined); // photos never linked to a booking: gone after 2 days
    };
    setInterval(tick, Number(process.env.PAYMENT_SWEEP_MS || 60_000)).unref();
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
