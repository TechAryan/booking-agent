# Booking Agent

An AI booking assistant that businesses set up themselves. Nothing to install on their side, no `.env` files.

- **Customers of the business** book, check and cancel appointments through a **website chat widget** and/or **WhatsApp**.
- **Business owners** log in, follow a guided setup (business details → Claude → Google Calendar → test chat), then switch on the widget or WhatsApp.
- **Admins** create accounts, set validity dates, activate/deactivate, choose which channels each account gets, reset passwords, and add more admins.

Each business uses **its own** Anthropic, Google and Kapso accounts. Their keys are stored encrypted in the database.

```
Customer ──► Website widget ─┐
                             ├─► this app ─► Claude (business's key) ─► Google Calendar (business's calendar)
Customer ──► WhatsApp ─► Kapso ┘                                     
```

---

## Run it locally

Needs **Node 22.13 or newer**. Locally it uses a SQLite file (Node's built-in SQLite, nothing to compile). In production it uses Turso when `TURSO_DATABASE_URL` is set.

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `APP_SECRET`: any long random string, e.g. the output of `openssl rand -base64 48`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`: the first admin, created on first start

```bash
npm run dev
```

Open http://localhost:3000 and log in as the admin.

> The widget works locally. **WhatsApp needs a public https URL** (deploy, or use a tunnel: `npx cloudflared tunnel --url http://localhost:3000` and set `PUBLIC_URL` to the tunnel URL).

## Deploy for free (Render + Turso)

The app runs on Render's free plan and keeps its data in Turso's free database, so restarts lose nothing.

1. **Turso** (free database). Sign up at turso.tech → **Create database** (pick the region closest to you, e.g. Mumbai) → copy the **Database URL** (`libsql://…`) → **Create token** → copy it.
2. **GitHub.** Push this folder to a **private** repo (`.env`, `data/` and secrets are git-ignored).
3. **Render.** render.com → **New → Blueprint** → pick the repo. It reads `render.yaml`; fill in `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` → **Apply**.
4. Open the `https://booking-agent-….onrender.com` address, log in as admin, change the password.
5. **Back up `APP_SECRET`**: Render → service → Environment → copy it somewhere safe. You need the same value if you ever move hosts.

**About the free plan:** Render sleeps a free app after 15 idle minutes. The app pings itself every 10 minutes to stay awake. As a backup, add a free monitor (cron-job.org or UptimeRobot) that opens `/healthz` every 5–10 minutes. If it ever does sleep, the first message wakes it in about a minute. Kapso retries webhooks, so nothing is lost. 750 free hours a month covers exactly one app running 24/7.

## Edge worker (keeps webhooks safe while the app sleeps)

Free hosts put the app to sleep, and some providers give up on a webhook after ~50 seconds. The small worker in
`edge/` runs on Cloudflare's free plan and is always awake: it checks each webhook's signature, saves it to the
`inbox` table, answers at once, and wakes the app (`/internal/drain`). A timer every minute wakes the app when a job
is due (payment checks now, reminder calls later). If the database is unreachable it passes the request to the app.

1. In `edge/wrangler.toml` set `APP_URL` (this app's address). From `edge/`: `npx wrangler login` (free Cloudflare account).
2. `npx wrangler secret put TURSO_URL`, `… TURSO_TOKEN`, `… APP_SECRET` (same values as the app), then `npx wrangler deploy`.
4. On Render, set `WEBHOOK_BASE_URL` to the worker's URL (e.g. `https://booking-agent-edge.<you>.workers.dev`), then click **Reconnect** on each business's WhatsApp page so Kapso points at the worker. Razorpay webhooks already set up keep working on the app's own URL.

Without the worker everything still works the same way: the app saves each webhook to the inbox and processes it.

## Choosing the AI

Setup → **Connect your AI**. Claude is first and recommended; Gemini, OpenAI, DeepSeek, Sarvam and OpenRouter sit
under **Other AI options**, each with its own steps. Pick a version (Recommended / Cheaper / Smartest) or open
**More versions** to load the live list for your key. **Test and save** checks the key and runs a practice booking
with pretend tools (the calendar isn't touched). Code: `src/ai/` (one adapter per API format, `providers.ts` for the
list, `registry.ts` for the connection and usage counts). Chats are stored in one format, so switching AI keeps them.
Keys for each AI a business tried stay saved (encrypted), so switching back needs no re-paste.

## Website (one page per business)

Setup → **Your website** → **Create my website**: the business's AI writes the words as JSON (never HTML), from
the business's own details only. The owner edits words, colour, sections and photos, previews, then **Save and
publish**. The page lives at `<edge>/p/<slug>` (the edge worker reads it from the database, cached a minute; photos
come from R2). Prices, services, hours and contact details republish automatically two minutes after a change, using
the published words (draft edits stay private until published). Pages have no scripts, a strict CSP and Google
business markup. Code: `src/sites/`, `src/routes/website.ts`. Own domains come next.

## WhatsApp providers

Setup → **Connect WhatsApp**. Kapso is first (recommended); Meta direct (cheapest), Twilio, Gupshup, 360dialog,
WATI, Gallabox and Exotel are under "Already use another WhatsApp provider?". Each has its own steps and fields.
**Connect** checks the details and sets the webhook where the provider allows it (Meta, 360dialog, Twilio, Gupshup,
WATI); Gallabox and Exotel show the exact address to paste. Webhook addresses are
`/webhooks/wa/<provider>/<business>/<secret>`: the secret is checked first (the edge worker does this too), and
Meta, Twilio and Gallabox signatures are checked again when the message is processed. Code: `src/wa/`.
WATI, Gallabox and Exotel are marked Beta until confirmed with real accounts.

## Photo storage (Cloudflare R2, optional)

Payment screenshots are kept in the database until you add R2 (10 GB free, no download fees):
Cloudflare → R2 → create bucket `booking-agent-files` → Manage API tokens → **Object Read & Write** on that bucket.
Put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` on Render. New photos go to R2;
older ones keep working from the database. If an upload fails, the photo is saved in the database instead.
R2 has no spending cap of its own, so the app keeps one: past `R2_MAX_GB` (default 9, under the free 10 GB) new
photos stay in the database and the admin page says so. Big screenshots are shrunk to JPEG first, and every
screenshot's image is deleted after `PHOTO_KEEP_DAYS` (default 180); the amount and UTR stay for checks.

## Moving to Railway later ($5/month, no sleep)

Customers and data stay in Turso, so moving is one command (see the top of `deploy/railway-setup.sh`):

```bash
npm i -g @railway/cli && railway login
APP_SECRET='<copied from Render>' TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN='…' \
  bash deploy/railway-setup.sh you@example.com
```

Then click **Reconnect** on each customer's WhatsApp page (or on yours to test) so Kapso sends to the new address, and update the widget code on their sites if they used the direct link. Finally, suspend the Render service.

Without Turso, `bash deploy/railway-setup.sh you@example.com` does a fresh install with the database on a Railway volume.

## Day-to-day

**New customer**

1. **Admin → + New account.** Enter name, email, WhatsApp number, valid-until date (quick chips: 1 week / 1 month / 3 months / 1 year), payment status (Paid / Pending / Free trial) and channels.
2. Copy the login message shown, or tap **Send on WhatsApp**.
3. They log in, set their own password, and follow the setup steps. You can see their progress on their account page.

**Payment received:** open their account → **Record payment** (amount, date, UPI reference, optional screenshot). Leave "Extend access" on to move "Valid until" forward at the same time. History and screenshots stay on the account.
**Renewals:** accounts ending within 7 days appear under **Needs attention** on the Admin page, with a **Remind** button that opens WhatsApp with a ready-made message (no email service, so it costs nothing). Customers also see a banner in their dashboard from 3 days before their access ends.
**Covering a customer's Claude usage:** Admin → **Claude keys** → add one of our keys (tested before saving). Then in their account → **Advanced** → pick the key. They skip the Claude step and never see the key. Replacing a key updates every customer on it. Off by default.
**Stop service:** set status to Inactive. They can't log in and the bot stops replying.
**Forgot password:** open their account → **Reset password**.
**Another admin:** create an account with the role "Admin".
**Admin locked out:** `npm run create-admin -- you@example.com` prints a new temporary password.

## Google sign-in (one-time, for the whole product)

Lets every business connect its calendar with one click. With it, customers get an email calendar invite and online sessions get a Google Meet link. Without it, businesses can still use the old key-file method (no invites or Meet links).

1. [Google Cloud console](https://console.cloud.google.com) → pick or create a project → **APIs & Services → Library → Google Calendar API → Enable**.
2. **Google Auth Platform → Branding**: app name, support email, app home page `https://<your app>/`, privacy policy `https://<your app>/privacy`.
3. **Audience**: *External*, then **Publish app** (so sign-ins don't expire after 7 days). Until Google verifies the app, users see "Google hasn't verified this app" and there's a 100-user cap; the Google step explains how to click through.
4. **Data access → Add scopes**: `calendar.events`, `calendar.freebusy`, `calendar.calendarlist.readonly` (plus `openid`, `email`).
5. **Clients → Create client → Web application**. Authorized redirect URI: `https://<your app>/setup/google/callback` (add your tunnel URL too for local testing).
6. Put the Client ID and Client Secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Render → Environment, and your local `.env`).
7. Later, to remove the warning: submit the app for verification in Google Auth Platform → Verification Center. Google needs a domain you own (not onrender.com).

## Payments

- Each business connects its **own Razorpay** account (Payments page: Key ID + Key Secret, then add the webhook URL and secret shown there). Money goes straight to them.
- Flow: the assistant quotes "pay at venue" vs "pay online (with the online discount)". Online = the slot is held for 20 minutes and a payment link is sent. It confirms automatically by webhook, by the customer's redirect back, or by a check every minute. If the link expires, the slot is released and the customer is told. If a payment lands after its slot was taken, it's kept as credit and the customer picks a new time.
- Without Razorpay, **UPI** works as a fallback: the customer gets a QR/UPI page, the booking shows "payment pending", and the owner confirms on the Bookings page or by WhatsApp.
- **UPI screenshots**: the customer sends the payment screenshot on WhatsApp or uploads it on the pay page. Claude reads it; we check the amount, the business's UPI ID and that the 12-digit transaction ID (UTR) hasn't been used before, then tell the owner. Optional "confirm automatically" (Payments → UPI) confirms only when everything matches. Screenshots can be edited, so for fraud-proof automatic confirmation use Razorpay. Plain UPI IDs/QRs have no API to check payments.
- **Paid bookings can't be cancelled** (by the customer, the owner chat or the Bookings page): they can only be moved. Free and not-yet-paid bookings can be cancelled. Rescheduling is always allowed.
- Walk-in or phone bookings: **Bookings → Add booking** (pick a free time, mark "already paid" if they paid in person). **Export CSV** downloads the list.

## Owner on WhatsApp

Add owner numbers on the WhatsApp page. Messages from those numbers go to a control assistant that can list/add/edit/delete services and prices, set the online discount, add offers (for everyone, one service, or one customer, with dates), add holidays, change business details and instructions, list bookings, confirm UPI payments, cancel bookings, and **book for customers who call or walk in** (name, number, service, time, and payment: send a link, pay later, or already paid with an optional screenshot as proof). If the customer hasn't messaged the business in the last 24 hours, WhatsApp won't let us message them first, so the owner gets a one-tap link to send the details from their own WhatsApp. Start a message with `/customer` to try the customer side. Owners also get alerts for new bookings, payments and cancellations (WhatsApp only allows this within 24 hours of the owner's last message). The Test page has a "Chat as the owner" switch to try it without WhatsApp.

## What the setup wizard checks

| Step | What the owner does | What we verify before saving |
|---|---|---|
| Business details | Name, services, days, hours, slot length, notes | Required fields, close after open |
| Claude | Pastes an Anthropic API key, picks a model | A real 5-token call: key valid, has credit, model allowed |
| Google Calendar | Uploads service-account JSON, shares calendar, pastes Calendar ID | JSON is a service account; calendar readable and writable |
| Test | Chats with suggested prompts, books a test slot | Marked done after a successful test booking |
| Widget (optional) | Colour, greeting, switch on | Gives the embed script, iframe code and direct link |
| WhatsApp (optional) | Connects a number in Kapso, pastes Phone number ID + API key | Key valid and number belongs to it; **webhook created automatically** with a signing secret |

## Security notes

- Passwords: scrypt. Sessions: random tokens stored hashed, httpOnly cookies. CSRF tokens on every form.
- Customer API keys and Google keys are AES-256-GCM encrypted with `APP_SECRET`. The UI only shows masked keys.
- WhatsApp webhooks are verified with an HMAC signature per business, and duplicates are ignored.
- On WhatsApp, a customer can only see or cancel bookings made from their own number. On the widget, only bookings made in that browser's chat.
- Login and API rate limits are built in.

## Project layout

| Path | What |
|---|---|
| `src/server.ts` | App setup and routes |
| `src/routes/auth.ts` | Login, logout, change password |
| `src/routes/admin.ts` | Admin panel |
| `src/routes/setup.ts` | Dashboard and setup wizard |
| `src/routes/public.ts` | Widget page, `widget.js`, WhatsApp webhook |
| `src/agent.ts` | Claude conversation and tool loop (per business, per channel) |
| `src/calendar.ts` | Slot logic and Google Calendar |
| `src/kapso.ts` | Kapso API: verify, webhooks, send |
| `src/db.ts` | Database: schema + local SQLite / Turso backends |
| `public/` | CSS and browser JS |
| `render.yaml` | Render free-plan blueprint |
| `deploy/railway-setup.sh` | One-command Railway setup / move |
| `tests/` | `npm test` (API, local DB), `npm run test:turso` (Turso client against a local stand-in), `npm run test:ui` (clicks through every screen in a real browser; run `npx playwright install chromium` once first) |

## How background work runs

- **Inbox:** every webhook is saved first (`inbox` table, duplicates dropped), then processed. One customer's messages are handled in order and answered together; failures retry with growing waits, up to 5 times.
- **Jobs:** anything due later (`jobs` table), one row per thing: e.g. a payment link is checked every minute until it's paid or expires. Workers take rows with a lease, so several app servers never run the same job.
- **Double bookings:** the free-slot check and the insert happen in one database transaction, so it holds across servers.
- Tests: `npm test` runs unit checks, then the API suites; `npm run test:turso` also runs the edge worker checks.

## Not included yet

- Self sign-up and online payment (UPI via Razorpay needs KYC).
- Editable pricing plans (use "Internal notes" and "Valid until" for now).
- Emails (the admin shares login details by hand).
- Reminders before appointments (needs approved WhatsApp templates).
