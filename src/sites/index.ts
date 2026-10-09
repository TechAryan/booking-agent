// The business's one-page website: draft words + settings, a published copy of the page, photos, and
// automatic republishing when prices, services, hours or contact details change.
import crypto from "node:crypto";
import { db, Workspace } from "../db.js";
import { env } from "../env.js";
import { listServices, mapsLink, quote } from "../catalog.js";
import { onJob } from "../jobs.js";
import { getWorkspaceById } from "../models.js";
import { noteR2Bytes, r2Room, shrink } from "../proofs.js";
import { deleteFile, getFile, putFile, storageReady } from "../storage.js";
import { cleanCopy, SiteCopy } from "./copy.js";
import { cleanConfig, renderSite, SiteConfig } from "./render.js";

export interface Site {
  workspace_id: number; slug: string; domain: string | null; config: string; copy: string | null;
  html: string | null; pub_copy: string | null; pub_config: string | null; published_at: number | null; content_hash: string | null; updated_at: number | null;
}

export const RESERVED = new Set(["admin", "api", "app", "www", "login", "setup", "img", "static", "p", "w", "pay", "help", "support", "booking", "bookings", "webhooks", "internal"]);

/** Pages live on the always-on edge address when there is one. */
export const siteBase = () => env.webhookBase || env.publicUrl;
export const siteUrl = (slug: string) => `${siteBase()}/p/${slug}`;

export function slugify(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
export const validSlug = (s: string) => /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s) && !RESERVED.has(s) && !s.includes("--");

export const getSite = (wsId: number) => db.get<Site>("SELECT * FROM sites WHERE workspace_id=?", wsId);
export const siteBySlug = (slug: string) => db.get<Site>("SELECT * FROM sites WHERE slug=?", slug);

/** Creates the site row with a free address made from the business name. */
export async function ensureSite(ws: Workspace): Promise<Site> {
  const have = await getSite(ws.id);
  if (have) return have;
  const base = slugify(ws.business_name || "") || `shop-${ws.id}`;
  let slug = validSlug(base) ? base : `${base || "shop"}-${ws.id}`.slice(0, 40);
  for (let n = 2; await siteBySlug(slug); n++) slug = `${base.slice(0, 36)}-${n}`;
  await db.run("INSERT OR IGNORE INTO sites (workspace_id, slug, config, updated_at) VALUES (?,?,?,?)", ws.id, slug, JSON.stringify(cleanConfig({})), Date.now());
  return (await getSite(ws.id))!;
}

export async function saveDraft(wsId: number, patch: { copy?: SiteCopy; config?: SiteConfig; slug?: string }) {
  const sets: string[] = [], args: (string | number)[] = [];
  if (patch.copy) { sets.push("copy=?"); args.push(JSON.stringify(patch.copy)); }
  if (patch.config) { sets.push("config=?"); args.push(JSON.stringify(patch.config)); }
  if (patch.slug) { sets.push("slug=?"); args.push(patch.slug); }
  if (!sets.length) return;
  await db.run(`UPDATE sites SET ${sets.join(", ")}, updated_at=? WHERE workspace_id=?`, ...args, Date.now(), wsId);
}

export const copyOf = (s: Site, which: "draft" | "published" = "draft"): SiteCopy | null => {
  const raw = which === "published" ? s.pub_copy : s.copy;
  return raw ? cleanCopy(JSON.parse(raw), JSON.parse(raw).services?.map((x: any) => x.name) ?? []) : null;
};
export const configOf = (s: Site, which: "draft" | "published" = "draft") => cleanConfig(JSON.parse((which === "published" ? s.pub_config : s.config) || "{}"));

/** Builds the page from words + settings and the business's live details. */
export async function buildPage(ws: Workspace, site: Site, which: "draft" | "published" = "draft") {
  const copy = copyOf(site, which);
  if (!copy) throw new Error("Write the website text first.");
  const config = configOf(site, which);
  const services = await Promise.all((await listServices(ws)).map(async (s) => ({ ...s, quote: await quote(ws, s) })));
  const waNum = String((ws.wa_provider && ws.wa_provider !== "kapso" ? ws.wa_display : ws.kapso_display_number) ?? "").replace(/[^\d]/g, "");
  const wa = ws.whatsapp_enabled && waNum.length >= 10 ? waNum : null;
  return renderSite({
    ws, copy, config, services, slug: site.slug,
    pageUrl: siteUrl(site.slug),
    chatUrl: ws.widget_enabled ? `${env.publicUrl}/w/${ws.public_id}` : null,
    whatsapp: wa,
    mapUrl: mapsLink(ws),
    imgBase: `/p/${site.slug}/img/`,
    appName: env.appName,
    appUrl: env.publicUrl,
  });
}

const hash = (s: string) => crypto.createHash("sha256").update(s.replace(/© \d{4}/, "")).digest("hex");

/** Publishes the draft (words and settings as they are now). */
export async function publish(ws: Workspace) {
  const site = await ensureSite(ws);
  const html = await buildPage(ws, site, "draft");
  await db.run("UPDATE sites SET html=?, pub_copy=copy, pub_config=config, content_hash=?, published_at=?, updated_at=? WHERE workspace_id=?", html, hash(html), Date.now(), Date.now(), ws.id);
  await db.run("UPDATE workspaces SET site_live=1 WHERE id=?", ws.id);
  return siteUrl(site.slug);
}

export async function unpublish(wsId: number) {
  await db.run("UPDATE sites SET html=NULL, published_at=NULL WHERE workspace_id=?", wsId);
  await db.run("UPDATE workspaces SET site_live=0 WHERE id=?", wsId);
}

onJob("site_publish", async (job) => {
  const site = await getSite(job.workspace_id);
  if (!site?.html || !site.pub_copy) return; // not published: nothing to do
  const ws = await getWorkspaceById(job.workspace_id);
  if (!ws) return;
  const html = await buildPage(ws, site, "published");
  const h = hash(html);
  if (h !== site.content_hash) await db.run("UPDATE sites SET html=?, content_hash=?, updated_at=? WHERE workspace_id=?", html, h, Date.now(), ws.id);
});

// ------------------------------------------------------------------ photos

export async function addPhoto(ws: Workspace, buf: Buffer, mime: string): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error("Photos must be JPG, PNG or WebP.");
  if (buf.length > 8 * 1024 * 1024) throw new Error("That photo is too large (8 MB max).");
  const n = Number((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM site_photos WHERE workspace_id=?", ws.id))?.c ?? 0);
  if (n >= 12) throw new Error("You can keep up to 12 photos. Remove one first.");
  const s = await shrink(buf, mime);
  const id = crypto.randomBytes(9).toString("hex");
  let key: string | null = null;
  if (storageReady() && (await r2Room(s.buf.length))) {
    key = `site/${ws.id}/${id}.${s.mime.split("/")[1]}`;
    try { await putFile(key, s.buf, s.mime); noteR2Bytes(s.buf.length); } catch (e: any) { console.error("site photo upload, keeping it in the database:", e?.message); key = null; }
  }
  await db.run("INSERT INTO site_photos (id, workspace_id, r2_key, data, mime, bytes, created_at) VALUES (?,?,?,?,?,?,?)", id, ws.id, key, key ? null : s.buf.toString("base64"), s.mime, s.buf.length, Date.now());
  return id;
}

export async function listPhotos(wsId: number) {
  return db.all<{ id: string; bytes: number }>("SELECT id, bytes FROM site_photos WHERE workspace_id=? ORDER BY created_at", wsId);
}

export async function deletePhoto(wsId: number, id: string) {
  const row = await db.get<{ r2_key: string | null }>("SELECT r2_key FROM site_photos WHERE workspace_id=? AND id=?", wsId, id);
  if (!row) return;
  if (row.r2_key) await deleteFile(row.r2_key).catch(() => undefined);
  await db.run("DELETE FROM site_photos WHERE workspace_id=? AND id=?", wsId, id);
}

/** Bytes of a photo on a published (or own) site. */
export async function photoFor(wsId: number, id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const row = await db.get<{ r2_key: string | null; data: string | null; mime: string }>("SELECT r2_key, data, mime FROM site_photos WHERE workspace_id=? AND id=?", wsId, id);
  if (!row) return null;
  if (row.data) return { bytes: Buffer.from(row.data, "base64"), mime: row.mime };
  if (row.r2_key) { const f = await getFile(row.r2_key); return f ? { bytes: f.bytes, mime: row.mime } : null; }
  return null;
}
