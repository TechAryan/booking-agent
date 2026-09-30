import type { NextFunction, Request, Response } from "express";
import { db, User } from "./db.js";
import { env } from "./env.js";
import { accessProblem, getUser } from "./models.js";
import { hmacHex, randomToken, safeEqual, sha256 } from "./security.js";

const COOKIE = "sid";
const SESSION_DAYS = 14;

declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
      csrf?: string;
    }
  }
}

export async function startSession(res: Response, userId: number) {
  const token = randomToken();
  await db.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)", sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  await db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: SESSION_DAYS * 86400_000,
    path: "/",
  });
}

export async function endSession(req: Request, res: Response) {
  const token = req.cookies?.[COOKIE];
  if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  res.clearCookie(COOKIE, { path: "/" });
}

export async function endAllSessions(userId: number) {
  await db.run("DELETE FROM sessions WHERE user_id = ?", userId);
}

/** Attaches req.user (if logged in) and req.csrf. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    const row = await db.get("SELECT * FROM sessions WHERE token_hash = ?", sha256(token));
    if (row && Number(row.expires_at) > Date.now()) {
      req.user = await getUser(Number(row.user_id));
      req.sessionToken = token;
      req.csrf = hmacHex(env.appSecret, `csrf:${token}`).slice(0, 32);
    }
  }
  next();
}

/** Rejects cross-site form posts. All state-changing forms include the token. */
export function checkCsrf(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const sent = (req.body?._csrf as string) || (req.headers["x-csrf-token"] as string) || "";
  if (!req.csrf || !safeEqual(sent, req.csrf)) {
    return res.status(403).send("Your session expired. Please go back, refresh the page and try again.");
  }
  next();
}

export async function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  const problem = accessProblem(req.user);
  if (problem) {
    await endSession(req, res);
    return res.redirect(`/login?msg=${encodeURIComponent(problem)}`);
  }
  if (req.user.must_change_password && !req.path.startsWith("/account/password")) {
    return res.redirect("/account/password?first=1");
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).send("Admins only.");
  next();
}
