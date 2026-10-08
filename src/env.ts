import "dotenv/config";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export const env = {
  port: Number(process.env.PORT || 3000),
  // Public https URL of this app, used for webhook + widget links. No trailing slash.
  // Falls back to the address Render / Railway give the service, so it usually needs no setting there.
  publicUrl: (
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "") ||
    `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/+$/, ""),
  // Where providers send webhooks. Set to the edge worker's URL once it's deployed (same paths); defaults to this app.
  webhookBase: (process.env.WEBHOOK_BASE_URL || "").replace(/\/+$/, ""),
  // Long random string. Encrypts customer API keys at rest. Never change it after launch.
  appSecret: need("APP_SECRET"),
  databasePath: process.env.DATABASE_PATH || "./data/app.db",
  // Hosted database (Turso). When set, it's used instead of the local file.
  tursoUrl: process.env.TURSO_DATABASE_URL || "",
  tursoToken: process.env.TURSO_AUTH_TOKEN || "",
  appName: process.env.APP_NAME || "Booking Agent",
  isProd: process.env.NODE_ENV === "production",
  // Only used on first start, when no admin exists yet.
  bootstrapAdminEmail: process.env.ADMIN_EMAIL || "",
  bootstrapAdminPassword: process.env.ADMIN_PASSWORD || "",
  // Overridable for tests.
  kapsoApiBase: (process.env.KAPSO_API_BASE || "https://api.kapso.ai").replace(/\/+$/, ""),
  // "Sign in with Google" (one OAuth app for the whole product). Empty = only the key-file method is offered.
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  // Overridable for tests.
  razorpayApiBase: (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/+$/, ""),
  defaultModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
};
