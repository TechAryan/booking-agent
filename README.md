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

1. **Admin → + New account.** Enter name, email, valid-until date and channels. Put the plan and payment reference in "Internal notes".
2. Copy the login message shown, with the temporary password, and send it to them on WhatsApp or email.
3. They log in, set their own password, and follow the setup steps. You can see their progress on their account page.

**Renewal:** change "Valid until".
**Stop service:** set status to Inactive. They can't log in and the bot stops replying.
**Forgot password:** open their account → **Reset password**.
**Another admin:** create an account with the role "Admin".
**Admin locked out:** `npm run create-admin -- you@example.com` prints a new temporary password.

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

## Not included yet

- Self sign-up and online payment (UPI via Razorpay needs KYC).
- Editable pricing plans (use "Internal notes" and "Valid until" for now).
- Emails (the admin shares login details by hand).
- Reminders before appointments (needs approved WhatsApp templates).
