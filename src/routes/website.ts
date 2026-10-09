// Dashboard: the business's one-page website. Public: /p/<slug> (also served by the edge worker).
import { Router, Request } from "express";
import multer from "multer";
import { checkCsrf, requireLogin } from "../auth.js";
import { logActivity } from "../db.js";
import { env } from "../env.js";
import { listServices } from "../catalog.js";
import { getWorkspaceForUser } from "../models.js";
import { rateLimited } from "../security.js";
import { html, Safe } from "../views/html.js";
import { icon, tile } from "../views/icons.js";
import { csrfField, page, withMsg } from "../views/layout.js";
import { stepNav } from "../views/stepper.js";
import { cleanCopy, SiteCopy, writeCopy } from "../sites/copy.js";
import { cleanConfig, SITE_COLORS } from "../sites/render.js";
import {
  addPhoto, buildPage, configOf, copyOf, deletePhoto, ensureSite, getSite, listPhotos, photoFor, publish, saveDraft, siteBySlug, siteUrl, unpublish, validSlug,
} from "../sites/index.js";

export const websiteRoutes = Router();
const ws = (req: Request) => getWorkspaceForUser(req.user!.id);
const photosUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 8 } });

const SECTION_LABELS: [keyof ReturnType<typeof cleanConfig>["sections"], string][] = [
  ["services", "Services and prices"], ["about", "About us"], ["gallery", "Photo gallery"], ["faq", "Questions (FAQ)"], ["location", "Hours, address and contact"],
];

function ago(ms: number) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

websiteRoutes.get("/setup/website", requireLogin, async (req, res) => {
  const w = await ws(req);
  const site = await getSite(w.id);
  const copy = site ? copyOf(site) : null;
  const ready = !!(w.business_done && w.claude_ok);
  if (!site || !copy) {
    return res.send(page(req, {
      title: "Website",
      body: html`${stepNav(req, "website", w)}
        <div class="page-head">${tile("globe", "lg")}<div><p class="eyebrow">Optional</p><h1>Your website</h1></div></div>
        <p class="sub">A fast one-page website for your business, made from your services, prices, hours and notes. Customers book from it on WhatsApp or chat. Free, and it updates itself when your prices or hours change.</p>
        <div class="card site-start">
          <ul class="checks">
            <li>${icon("check", 14)} Your services with live prices and online discounts</li>
            <li>${icon("check", 14)} Book buttons for WhatsApp, website chat and calls</li>
            <li>${icon("check", 14)} Hours, address, map and FAQs, set up for Google</li>
            <li>${icon("check", 14)} Works great on phones, loads in under a second</li>
          </ul>
          ${ready
            ? html`<form method="post" action="/setup/website/create" data-busy="Writing your website… about 20 seconds">${csrfField(req)}
                <label>Tone <span class="hint">optional, e.g. "friendly and premium" or "simple, Hinglish"</span></label>
                <input type="text" name="tone" maxlength="100" placeholder="Friendly and professional">
                <div class="row"><button>Create my website</button></div></form>`
            : html`<div class="flash info">Finish your business details and connect your AI first.</div>`}
        </div>`,
    }));
  }
  const config = configOf(site);
  const services = await listServices(w);
  const photos = await listPhotos(w.id);
  const url = siteUrl(site.slug);
  const live = !!site.html;
  const dirty = live && (site.copy !== site.pub_copy || site.config !== site.pub_config);
  const blurbOf = new Map(copy.services.map((s) => [s.name.toLowerCase(), s.blurb]));
  const faqs = [...copy.faqs, { q: "", a: "" }];
  res.send(page(req, {
    title: "Website",
    body: html`${stepNav(req, "website", w)}
      <div class="page-head">${tile("globe", "lg")}<div><p class="eyebrow">Optional</p><h1>Your website</h1></div></div>
      <div class="card site-status ${live ? "live" : ""}">
        ${live
          ? html`<div class="done-line">${tile("check")}<span><b>Live</b><small><a href="${url}" target="_blank" rel="noopener">${url.replace(/^https?:\/\//, "")}</a> · published ${ago(site.published_at!)}${dirty ? " · you have unpublished changes" : ""}</small></span></div>
              <div class="row"><a class="btn small" href="${url}" target="_blank" rel="noopener">Open</a><button type="button" class="secondary small" data-copy="${url}">Copy link</button></div>`
          : html`<p><b>Not published yet.</b> Check the preview, then press <b>Save and publish</b>.</p>`}
        <p class="muted small">Prices, services, hours and contact details update on the page by themselves within a few minutes.</p>
      </div>

      <form method="post" action="/setup/website" data-busy="Saving…" class="site-form">
        ${csrfField(req)}
        <div class="card">
          <h2>Look</h2>
          <label>Colour</label>
          <div class="swatches">${SITE_COLORS.map((c) => html`<label class="sw" style="--c:${c}"><input type="radio" name="color" value="${c}" ${config.color === c ? "checked" : ""} aria-label="${c}"><span></span></label>`)}</div>
          <label>Top of the page</label>
          <div class="seg-row">
            <label class="chip-radio"><input type="radio" name="hero" value="color" ${config.hero === "color" ? "checked" : ""}><span>Colour</span></label>
            <label class="chip-radio"><input type="radio" name="hero" value="photo" ${config.hero === "photo" ? "checked" : ""} ${photos.length ? "" : "disabled"}><span>First photo${photos.length ? "" : " (add photos below)"}</span></label>
          </div>
          <label>Sections</label>
          ${SECTION_LABELS.map(([k, label]) => html`<label class="switch-row"><input type="checkbox" name="sec_${k}" value="1" ${config.sections[k] ? "checked" : ""}><span><b>${label}</b></span></label>`)}
        </div>

        <div class="card">
          <div class="spread-row"><h2>Words</h2></div>
          <p class="muted small">Written by your AI from your details. Edit anything; nothing here is made up, but please check it.</p>
          <label>Headline</label><input type="text" name="headline" value="${copy.headline}" maxlength="80" required>
          <label>Line under the headline</label><input type="text" name="subheadline" value="${copy.subheadline}" maxlength="160">
          <label>Booking button</label><input type="text" name="cta" value="${copy.cta}" maxlength="30" placeholder="Book now">
          <label>About us</label><textarea name="about" rows="6" maxlength="900">${copy.about}</textarea>
          ${services.length ? html`<label>Service descriptions</label>${services.map((s) => html`<div class="svc-blurb"><b>${s.name}</b><input type="text" name="blurb:${s.name}" value="${blurbOf.get(s.name.toLowerCase()) ?? ""}" maxlength="200" placeholder="One line about ${s.name}"></div>`)}` : ""}
          <label>Questions <span class="hint">leave a question empty to remove it</span></label>
          ${faqs.slice(0, 8).map((f, n) => html`<div class="faq-edit"><input type="text" name="faq_q" value="${f.q}" maxlength="140" placeholder="Question ${n + 1}"><textarea name="faq_a" rows="2" maxlength="500" placeholder="Answer">${f.a}</textarea></div>`)}
          <details class="hint-box"><summary>Google listing text</summary>
            <label>Page title</label><input type="text" name="seo_title" value="${copy.seo_title}" maxlength="65">
            <label>Description</label><input type="text" name="seo_description" value="${copy.seo_description}" maxlength="160">
          </details>
        </div>

        <div class="card">
          <h2>Address</h2>
          <label>Your page address</label>
          <div class="slug-row"><span class="mono">${env.webhookBase ? new URL(env.webhookBase).host : new URL(env.publicUrl).host}/p/</span><input type="text" name="slug" value="${site.slug}" maxlength="40" pattern="[a-z0-9-]{3,40}" required></div>
          <p class="hint">Lowercase letters, numbers and dashes. Your own domain (like www.yourshop.in) comes soon.</p>
        </div>

        <div class="card sticky-actions">
          <div class="row"><button name="action" value="publish">Save and publish</button><button name="action" value="draft" class="secondary">Save draft</button></div>
        </div>
      </form>

      <div class="card" id="photos">
        <h2>Photos</h2>
        <p class="muted small">Up to 12. Big photos are made smaller automatically. Use your own photos only.</p>
        ${photos.length ? html`<div class="site-photos">${photos.map((p, n) => html`<figure><img src="/setup/website/photo/${p.id}" alt="" loading="lazy">${n === 0 ? html`<figcaption>Cover</figcaption>` : ""}
          <form method="post" action="/setup/website/photo/${p.id}/delete" data-confirm="Remove this photo?" data-confirm-ok="Remove">${csrfField(req)}<button class="secondary small" aria-label="Remove photo">${icon("trash", 13)}</button></form></figure>`)}</div>` : ""}
        <form method="post" action="/setup/website/photos?_csrf=${req.csrf}" enctype="multipart/form-data" data-busy="Uploading…" class="row">
          <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple required><button class="secondary">Upload</button>
        </form>
      </div>

      <div class="card">
        <div class="spread-row"><h2>Preview</h2><a class="btn small secondary" href="/setup/website/preview" target="_blank" rel="noopener">Open full screen</a></div>
        <iframe class="site-preview" src="/setup/website/preview" title="Website preview" sandbox="allow-popups" loading="lazy"></iframe>
        <p class="hint">Shows your draft. Save to see changes.</p>
      </div>

      <div class="card">
        <h2>Rewrite the words</h2>
        <p class="muted small">Your AI writes everything again from your latest details. Your current words are replaced (photos and look stay).</p>
        <form method="post" action="/setup/website/rewrite" data-busy="Rewriting… about 20 seconds" data-confirm="Rewrite all the words?" data-confirm-ok="Rewrite">
          ${csrfField(req)}<input type="text" name="tone" maxlength="100" placeholder="Tone, e.g. friendly and premium (optional)">
          <div class="row"><button class="secondary">Rewrite with AI</button></div>
        </form>
        ${live ? html`<form method="post" action="/setup/website/unpublish" data-confirm="Take your website offline?" data-confirm-detail="The link stops working until you publish again." data-confirm-ok="Take offline">${csrfField(req)}<div class="row"><button class="danger small">Take offline</button></div></form>` : ""}
      </div>`,
  }));
});

websiteRoutes.post("/setup/website/create", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  if (!(w.business_done && w.claude_ok)) return res.redirect("/setup/website");
  if (rateLimited(`site-ai:${w.id}`, Number(process.env.AI_TEST_LIMIT || 6), 60 * 60_000)) return res.redirect(withMsg("/setup/website", "err", "You've written the site a few times already. Try again in an hour."));
  try {
    await ensureSite(w);
    const copy = await writeCopy(w, String(req.body.tone || ""));
    await saveDraft(w.id, { copy });
    await logActivity(w.id, "setup", "", "Website text written");
    res.redirect(withMsg("/setup/website", "ok", "Your website is ready to check. Look at the preview, edit anything, then press Save and publish."));
  } catch (e: any) {
    res.redirect(withMsg("/setup/website", "err", e?.message || "Couldn't write the website. Try again."));
  }
});

websiteRoutes.post("/setup/website/rewrite", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  if (rateLimited(`site-ai:${w.id}`, Number(process.env.AI_TEST_LIMIT || 6), 60 * 60_000)) return res.redirect(withMsg("/setup/website", "err", "You've rewritten the site a few times already. Try again in an hour."));
  try {
    await ensureSite(w);
    await saveDraft(w.id, { copy: await writeCopy(w, String(req.body.tone || "")) });
    res.redirect(withMsg("/setup/website", "ok", "New words written. Check the preview, then publish."));
  } catch (e: any) {
    res.redirect(withMsg("/setup/website", "err", e?.message || "Couldn't rewrite. Try again."));
  }
});

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);

websiteRoutes.post("/setup/website", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  const site = await getSite(w.id);
  if (!site) return res.redirect("/setup/website");
  const b = req.body;
  const services = await listServices(w);
  const qs = list(b.faq_q), as = list(b.faq_a);
  const copy: SiteCopy = cleanCopy({
    headline: b.headline, subheadline: b.subheadline, about: b.about, cta: b.cta, seo_title: b.seo_title, seo_description: b.seo_description,
    services: services.map((s) => ({ name: s.name, blurb: b[`blurb:${s.name}`] ?? "" })).filter((s) => String(s.blurb).trim()),
    faqs: qs.map((q, n) => ({ q, a: as[n] ?? "" })),
  }, services.map((s) => s.name));
  if (!copy.headline) return res.redirect(withMsg("/setup/website", "err", "Add a headline."));
  const photos = (await listPhotos(w.id)).map((p) => p.id);
  const config = cleanConfig({
    color: b.color, hero: b.hero, photos,
    sections: Object.fromEntries(SECTION_LABELS.map(([k]) => [k, b[`sec_${k}`] === "1"])),
  });
  const slug = String(b.slug || "").trim().toLowerCase();
  if (slug !== site.slug) {
    if (!validSlug(slug)) return res.redirect(withMsg("/setup/website", "err", "That address isn't allowed. Use 3–40 lowercase letters, numbers and single dashes."));
    const taken = await siteBySlug(slug);
    if (taken && taken.workspace_id !== w.id) return res.redirect(withMsg("/setup/website", "err", "That address is taken. Try another."));
  }
  await saveDraft(w.id, { copy, config, slug });
  if (b.action === "publish") {
    const url = await publish(w);
    await logActivity(w.id, "setup", "", `Website published: ${url}`);
    return res.redirect(withMsg("/setup/website", "ok", `Published. Your website is live at ${url.replace(/^https?:\/\//, "")}`));
  }
  res.redirect(withMsg("/setup/website", "ok", "Draft saved. The preview shows it."));
});

websiteRoutes.post("/setup/website/photos", requireLogin, checkCsrf, photosUpload.array("photos", 8), async (req, res) => {
  const w = await ws(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) return res.redirect(withMsg("/setup/website#photos", "err", "Pick one or more photos."));
  await ensureSite(w);
  let n = 0, err = "";
  for (const f of files) {
    try { await addPhoto(w, f.buffer, f.mimetype); n++; } catch (e: any) { err = e.message; }
  }
  await syncPhotos(w.id);
  res.redirect(withMsg("/setup/website#photos", n ? "ok" : "err", n ? `Added ${n} photo${n === 1 ? "" : "s"}.${err ? ` ${err}` : ""}` : err));
});

websiteRoutes.post("/setup/website/photo/:id/delete", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  await deletePhoto(w.id, String(req.params.id));
  await syncPhotos(w.id);
  res.redirect(withMsg("/setup/website#photos", "ok", "Photo removed."));
});

/** The draft's photo list follows the uploaded photos (order = upload order). */
async function syncPhotos(wsId: number) {
  const site = await getSite(wsId);
  if (!site) return;
  const config = configOf(site);
  config.photos = (await listPhotos(wsId)).map((p) => p.id).slice(0, 12);
  if (!config.photos.length) config.hero = "color";
  await saveDraft(wsId, { config });
}

websiteRoutes.get("/setup/website/photo/:id", requireLogin, async (req, res) => {
  const w = await ws(req);
  const p = await photoFor(w.id, String(req.params.id));
  if (!p) return res.sendStatus(404);
  res.type(p.mime).setHeader("Cache-Control", "private, max-age=3600");
  res.send(p.bytes);
});

websiteRoutes.get("/setup/website/preview", requireLogin, async (req, res) => {
  const w = await ws(req);
  const site = await getSite(w.id);
  if (!site?.copy) return res.redirect("/setup/website");
  const htmlText = (await buildPage(w, site, "draft")).replaceAll(`/p/${site.slug}/img/`, "/setup/website/photo/");
  sendPage(res, htmlText, "private, no-store");
});

websiteRoutes.post("/setup/website/unpublish", requireLogin, checkCsrf, async (req, res) => {
  const w = await ws(req);
  await unpublish(w.id);
  res.redirect(withMsg("/setup/website", "ok", "Your website is offline. Publish again any time."));
});

// ---------------------------------------------------------------- public (the edge worker serves the same paths)

function sendPage(res: any, body: string, cache: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  res.send(body);
}

websiteRoutes.get("/p/:slug", async (req, res) => {
  const site = await siteBySlug(String(req.params.slug).toLowerCase());
  if (!site?.html) return res.status(404).type("text/plain").send("This page isn't published.");
  sendPage(res, site.html, "public, max-age=60");
});

websiteRoutes.get("/p/:slug/img/:id", async (req, res) => {
  const site = await siteBySlug(String(req.params.slug).toLowerCase());
  if (!site?.html) return res.sendStatus(404);
  const p = await photoFor(site.workspace_id, String(req.params.id));
  if (!p) return res.sendStatus(404);
  res.type(p.mime).setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(p.bytes);
});

export type _Unused = Safe;
