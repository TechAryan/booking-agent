// Browser test of every screen and button (needs Playwright: `npx playwright install chromium` or a local Chromium).
// Run against a server started by tests/run.mjs style env (fakes on :4100, app on :3300).
//   UI_BASE=http://localhost:3300 node tests/ui.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.UI_BASE || "http://localhost:3300";
const SHOTS = process.env.UI_SHOTS || "";
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${name}${!c && extra ? " — " + extra : ""}`); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
// Block the Clipboard API like the Claude browser pane does, so the fallback path is exercised.
await ctx.addInitScript(() => { if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")); });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => { errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(1000); } if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const toastText = async () => { await page.waitForSelector(".toast", { timeout: 8000 }); return (await page.$$eval(".toast", (t) => t.map((x) => x.textContent).join(" | "))); };
const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));

/** Clicks a submit button, checks the spinner + loading bar appear, then lets the submit go through. */
async function clickAndSeeSpinner(selector, label) {
  await clearToasts();
  await page.waitForLoadState("load"); await page.waitForTimeout(300); // the bar resets on "load"; click after it
  await page.evaluate(() => window.addEventListener("submit", (e) => { e.preventDefault(); window.__held = e.target; }, { once: true }));
  await page.locator(`main ${selector}`).and(page.locator('button:not([type=button])')).first().click();
  const spinning = await page.evaluate(() => !!document.querySelector("button.loading") && document.getElementById("progress").classList.contains("on"));
  ok(spinning, `${label}: spinner + loading bar while working`);
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.evaluate(() => HTMLFormElement.prototype.submit.call(window.__held))]);
}

// ---------- Admin ----------
await page.goto(`${BASE}/login`);
await shot("01-login");
ok((await page.getAttribute("html", "data-theme")) === "dark", "dark theme by default");
await page.click("[data-theme-toggle]");
await page.waitForSelector(".theme-pick.open");
await page.click('.theme-pick [data-set-theme="light"]');
await page.waitForTimeout(300);
ok((await page.getAttribute("html", "data-theme")) === "light", "switch to light from the top bar");
await page.reload();
ok((await page.getAttribute("html", "data-theme")) === "light", "theme choice remembered after reload");
await page.fill("#email", "admin@test.com"); await page.fill("#password", "AdminPass123");
await page.click(".reveal button");
ok((await page.getAttribute("#password", "type")) === "text", "eye button shows the password");
await page.click(".reveal button");
ok((await page.getAttribute("#password", "type")) === "password", "eye button hides it again");
await clickAndSeeSpinner("form button", "Log in");
ok(page.url().endsWith("/"), "admin logged in");

await page.goto(`${BASE}/admin/users/new`);
await page.fill("input[name=name]", "Dr Priya"); await page.fill("input[name=email]", "priya@clinic.com");
await page.fill("textarea[name=notes]", "Paid 999 via UPI");
await clickAndSeeSpinner("form button:not([type=button])", "Create account");
const temp = (await page.textContent("#pw")).trim();
ok(/^[a-z]+-\d{4}-[a-z]+$/.test(temp), "temporary password shown", temp);
await shot("02-account-created");

await clearToasts();
await page.click("#pw");
ok((await toastText()).includes("Copied"), "click password → copied toast (clipboard API blocked, fallback used)");
await clearToasts();
await page.click("text=Copy message");
ok((await toastText()).includes("Copied"), "Copy message → copied toast");

await page.click("text=Back to account");
await page.waitForLoadState();
await page.fill("textarea[name=notes]", "Paid 999 via UPI · renewed");
await clickAndSeeSpinner("form[data-role-form] button:not([type=button])", "Save account");
ok((await toastText()).includes("Saved"), "save shows 'Saved' toast");
ok(!page.url().includes("ok="), "toast message removed from URL after showing");
await shot("03-account-saved");

// Reset password: cancel, then confirm.
await clearToasts();
await page.click("text=Reset password");
await page.waitForSelector(".sheet");
ok((await page.textContent(".sheet")).includes("Reset password?"), "reset opens in-app confirm sheet (no browser popup)");
await shot("04-confirm-sheet");
await page.click(".sheet [data-no]");
await page.waitForSelector(".sheet", { state: "detached" });
ok(true, "cancel closes the sheet");
await page.click("text=Reset password");
await page.waitForSelector(".sheet");
const nav1 = page.waitForNavigation();
await page.click(".sheet [data-yes]");
await nav1;
ok((await page.textContent("h1")).includes("Password reset"), "confirm → password reset page with new temp password");
const temp2 = (await page.textContent("#pw")).trim();

// Delete: throwaway account
await page.goto(`${BASE}/admin/users/new`);
await page.fill("input[name=name]", "Temp"); await page.fill("input[name=email]", "temp@x.com");
await Promise.all([page.waitForNavigation(), page.click("main form button:not([type=button])")]);
await page.click("text=Back to account"); await page.waitForLoadState();
await page.click("main button.danger");
await page.waitForSelector(".sheet .destructive");
ok(true, "delete confirm button is red (destructive)");
await Promise.all([page.waitForNavigation(), page.click(".sheet [data-yes]")]);
ok((await toastText()).includes("Deleted temp@x.com"), "account deleted + toast");
ok(!(await page.textContent("table")).includes("temp@x.com"), "deleted account gone from list");
await shot("05-admin-list");

await Promise.all([page.waitForNavigation(), page.click("text=Log out")]);

// ---------- Customer ----------
await page.fill("#email", "priya@clinic.com"); await page.fill("#password", temp2);
await Promise.all([page.waitForNavigation(), page.click("main form button:not([type=button])")]);
ok(page.url().includes("/account/password"), "customer must set own password");
await page.fill("input[name=current]", temp2); await page.fill("input[name=password]", "Clinic2026!"); await page.fill("input[name=password2]", "Clinic2026!");
await clickAndSeeSpinner("form button", "Save password");
ok((await toastText()).includes("Password updated"), "password updated toast");
await page.waitForTimeout(1600);
ok(await page.evaluate(() => { const c = document.querySelector(".ring .bar"); return !!c && getComputedStyle(c).strokeDashoffset !== c.getAttribute("stroke-dashoffset") || c.getAttribute("data-offset") === c.getAttribute("stroke-dashoffset"); }), "dashboard progress ring animates to its value");
ok((await page.$$(".steps .tile")).length >= 4, "setup rows have colored icon tiles");
ok((await page.$$(".journey li")).length === 4, "new account sees the 4-step welcome journey");
await page.goto(`${BASE}/account/password`);
await page.click('.segmented [data-set-theme="system"]');
await page.waitForTimeout(300);
ok((await page.getAttribute("html", "data-theme")) === "system", "appearance: System from Account page");
await page.click('.segmented [data-set-theme="dark"]');
await shot("06-dashboard");

await page.goto(`${BASE}/setup/business`);
ok((await page.locator(".template:visible").count()) >= 12, "business-type picker opens on Popular");
await page.fill("[data-template-search]", "kirana");
ok(await page.isVisible('.template >> text=Kirana / grocery store'), "search finds Kirana");
await page.fill("[data-template-search]", "software engineer");
ok(await page.isVisible('.template >> text=Software developer'), "search matches by tags (software engineer → developer)");
await page.fill("[data-template-search]", "");
await page.click('[data-template-cat="creators"]');
ok(await page.isVisible('.template >> text=Influencer / creator') && !(await page.isVisible('.template >> text=Dental clinic')), "Creators category shows influencers");
await page.fill("[data-template-search]", "zzqq");
ok(await page.isVisible("[data-templates-empty]"), "no match → hint to just fill in the form");
await page.fill("[data-template-search]", "kirana"); await page.press("[data-template-search]", "Enter");
ok((await page.$$eval("input[name=svc_name]", (els) => els.map((e) => e.value).join(", "))).includes("Order pickup slot") && (await page.inputValue("textarea[name=extra_info]")).includes("pick up their order"), "Enter picks first match and fills extra info");
await page.fill("[data-template-search]", "influencer"); await page.press("[data-template-search]", "Enter");
ok((await page.inputValue("textarea[name=extra_info]")).includes("Brands and fans"), "changing business type replaces the suggested extra info");
await page.fill("[data-template-search]", "salon"); await page.press("[data-template-search]", "Enter");
ok((await page.inputValue("textarea[name=extra_info]")) === "", "type without a suggestion clears the old suggestion");
await page.fill("textarea[name=extra_info]", "My own note");
await page.fill("[data-template-search]", "kirana"); await page.press("[data-template-search]", "Enter");
ok((await page.inputValue("textarea[name=extra_info]")) === "My own note", "text the person wrote is never overwritten");
ok((await page.textContent("#toasts")).includes("kept what you wrote"), "and they're told it was kept");
ok((await page.textContent(".qs-head")).includes("Optional"), "picker is marked optional");
await page.click("[data-skip-templates]"); await page.waitForTimeout(500);
ok(await page.evaluate(() => document.activeElement?.name === "business_name"), "'fill in the form below' jumps to business name");
await page.fill("textarea[name=extra_info]", "");
await page.fill("[data-template-search]", "");
await page.click('[data-template-cat="health"]');
await shot("07a-business-types");
await page.click('.template >> text=Dental clinic');
ok((await page.$$eval("input[name=svc_name]", (els) => els.map((e) => e.value).join(", "))).includes("Tooth filling"), "Dental template fills service rows");
ok((await page.inputValue("select[name=slot_minutes]")) === "30", "template sets appointment length");
ok((await page.textContent("[data-slot-preview]")).includes("18 start times a day"), "live slot preview (10am–7pm, 30 min = 18 start times)");
await page.selectOption("select[name=slot_minutes]", "60");
ok((await page.textContent("[data-slot-preview]")).includes("17 start times a day"), "slot preview updates when length changes (60 min, every 30 min)");
await page.fill("input[name=business_name]", "Smile Dental");
// Services editor: add, set paid, open details, remove.
const nRows = await page.locator("[data-svc-row]").count();
await page.click("[data-svc-add]");
ok((await page.locator("[data-svc-row]").count()) === nRows + 1, "Add service adds a row");
ok(await page.evaluate(() => document.activeElement?.name === "svc_name"), "new row is focused");
const lastRow = page.locator("[data-svc-list] [data-svc-row]").last();
await lastRow.locator("input[name=svc_name]").fill("Whitening");
ok(!(await lastRow.locator("[data-svc-price] input").isVisible()), "price hidden while free");
await lastRow.locator("select[name=svc_kind]").selectOption("paid");
ok(await lastRow.locator("[data-svc-price] input").isVisible(), "choosing Paid shows the price box");
await lastRow.locator("input[name=svc_price]").fill("3500");
await lastRow.locator("[data-svc-more]").click();
ok(await lastRow.locator("textarea[name=svc_details]").isVisible(), "details open");
await lastRow.locator("textarea[name=svc_details]").fill("Takes 45 minutes");
await shot("07b-services-editor");
// Keep exactly: Consultation, Cleaning, Whitening
while ((await page.locator("[data-svc-list] [data-svc-row]").count()) > 3) {
  const n = await page.locator("[data-svc-list] [data-svc-row]").count();
  await page.locator("[data-svc-list] [data-svc-row]").nth(n - 2).locator("[data-svc-remove]").click();
  await page.waitForTimeout(260);
}
await page.locator("[data-svc-list] [data-svc-row]").nth(0).locator("input[name=svc_name]").fill("Consultation");
await page.locator("[data-svc-list] [data-svc-row]").nth(1).locator("input[name=svc_name]").fill("Cleaning");
const sun = page.locator(".chips label", { hasText: "Sun" });
await sun.click();
ok(await sun.evaluate((l) => l.querySelector("input").checked), "day chip toggles on click");
await page.selectOption("select[name=open_hour]", "0"); await page.selectOption("select[name=close_hour]", "23");
await shot("07-business");
await clickAndSeeSpinner("form[data-busy] button", "Save business");
ok((await toastText()).includes("Business details saved"), "business saved toast");

await page.click("ol.guide > li:nth-child(1) .tick-btn");
await page.click("ol.guide > li:nth-child(2) .tick-btn");
ok((await page.textContent(".guide-progress")).includes("2 of 4"), "guide steps can be ticked off");
await page.reload();
ok((await page.textContent(".guide-progress")).includes("2 of 4"), "ticked steps remembered");
await page.fill("input[name=api_key]", "hello");
ok((await page.textContent(".field-hint")).includes("start with sk-ant-"), "instant key format hint");
await page.fill("input[name=api_key]", "sk-ant-bad");
await clickAndSeeSpinner("form[data-busy] button", "Test Claude key");
ok((await toastText()).includes("not valid"), "bad Claude key → red error toast");
await page.fill("input[name=api_key]", "sk-ant-good-key-123456");
await clickAndSeeSpinner("form[data-busy] button", "Save Claude key");
ok((await toastText()).includes("Claude is connected"), "Claude connected toast");
{
  // Connect your AI: other options, version cards, More versions
  await page.goto(BASE + "/setup/claude?p=gemini");
  ok(await page.$eval("details.ai-others", (d) => d.open), "Other AI options open when a non-Claude AI is picked");
  await page.click("label.ver:has-text('More versions')");
  ok(await page.isVisible(".more-ver"), "More versions reveals the version box");
  await page.click("label.ver:has-text('Gemini 3.8 Flash')");
  ok(!(await page.isVisible(".more-ver")) && (await page.$eval("label.ver.on", (l) => l.textContent)).includes("3.8 Flash"), "picking a version card highlights it and hides the box");
  await shot("07b-ai-gemini");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/setup/claude");
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!over, "AI page fits a phone screen (no sideways scroll)");
  await shot("07c-ai-mobile");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(BASE + "/setup/google");
}

const keyPath = "/tmp/ui-sa.json";
fs.writeFileSync(keyPath, JSON.stringify({ type: "service_account", client_email: "bot@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }));
fs.writeFileSync("/tmp/ui-wrong.json", JSON.stringify({ type: "authorized_user" }));
ok(await page.isVisible("a.google-btn"), "Sign in with Google button shown");
await page.click("details.advanced-card > summary");
await page.setInputFiles("input[type=file]", "/tmp/ui-wrong.json");
await page.waitForSelector(".dropzone.bad");
ok((await toastText()).includes("isn't a Google service-account key"), "wrong key file rejected instantly, before upload");
await clearToasts();
await Promise.all([page.waitForNavigation(), page.setInputFiles("input[type=file]", keyPath)]);
ok((await toastText()).includes("Key uploaded"), "drop/choose key file → uploads automatically");
await clearToasts();
await page.click("main button[data-copy]");
ok((await toastText()).includes("Copied"), "copy service-account email");
await page.fill("input[name=calendar_id]", "bookings@group.calendar.google.com");
await clickAndSeeSpinner(`form[action="/setup/google"] button`, "Test calendar");
ok((await toastText()).includes("Connected to"), "calendar connected toast");
await page.goto(`${BASE}/setup/google`);
await clearToasts();
await Promise.all([page.waitForNavigation(), page.click("a.google-btn")]);
ok((await toastText()).includes("Google connected"), "Sign in with Google connects in one click");
await page.goto(`${BASE}/setup/google`);
ok((await page.textContent(".google-card")).includes("Signed in as owner@gmail.com"), "shows signed-in account + calendar picker");
await shot("08a-google-signed-in");
await page.goto(`${BASE}/setup/test`);
await shot("08-test-chat-empty");

await page.click(".suggest button >> nth=0");
await page.waitForSelector(".typing", { timeout: 3000 }).then(() => ok(true, "typing indicator appears")).catch(() => ok(false, "typing indicator appears"));
await page.waitForFunction(() => document.querySelectorAll(".chat .m.b").length >= 2 && !document.querySelector(".typing"), null, { timeout: 15000 });
ok((await page.$$eval(".chat .m.b", (e) => e.at(-1).textContent)).includes("Smile Dental"), "chat reply arrives");
await clearToasts();
await page.fill(".chat input", "book me please"); await page.press(".chat input", "Enter");
await page.waitForFunction(() => document.querySelectorAll(".chat .m.b").length >= 3 && !document.querySelector(".typing"), null, { timeout: 15000 });
ok((await toastText()).includes("first booking works"), "first test booking is celebrated");
await shot("09-test-chat");
await clearToasts(); await page.click("[data-chat-reset]");
ok((await toastText()).includes("Conversation reset"), "start over resets chat");
await Promise.all([page.waitForNavigation(), page.click("text=It works, continue")]);

await page.goto(`${BASE}/setup/widget`);
await page.click('[data-color="#ff375f"]');
ok((await page.evaluate(() => getComputedStyle(document.querySelector("[data-widget-preview]")).getPropertyValue("--accent").trim())) === "#ff375f", "colour swatch updates live preview");
await page.fill("[data-preview-greeting]", "Namaste! Book with us");
ok((await page.textContent("[data-greeting-out]")) === "Namaste! Book with us", "greeting updates live preview");
await page.check("input[name=enabled]");
await clickAndSeeSpinner("form button:not([type=button])", "Save widget");
ok((await toastText()).includes("Widget is live"), "widget live toast");
await clearToasts();
await page.click("text=Copy code >> nth=0");
ok((await toastText()).includes("Copied"), "copy embed code");
await shot("10-widget");

await page.goto(`${BASE}/setup/whatsapp`);
await page.fill("input[name=phone_number_id]", "111222333"); await page.fill("input[name=api_key]", "kapso-good");
await clickAndSeeSpinner("form[data-busy] button", "Connect WhatsApp");
ok((await toastText()).includes("WhatsApp is live"), "WhatsApp connected toast");
await clearToasts();
await page.click("text=Pause WhatsApp >> nth=-1");
await page.waitForSelector(".sheet .destructive");
await Promise.all([page.waitForNavigation(), page.click(".sheet [data-yes]")]);
ok((await toastText()).includes("WhatsApp paused"), "pause WhatsApp via confirm sheet");
await page.goto(`${BASE}/setup/whatsapp?p=meta`);
ok(await page.$eval("details.ai-others", (d) => d.open) && (await page.textContent("#connect h2")).includes("Meta direct"), "other WhatsApp provider opens with its guide");
await page.setViewportSize({ width: 390, height: 844 });
await page.reload();
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "WhatsApp provider page fits a phone screen");
await shot("10b-whatsapp-meta-mobile");
await page.setViewportSize({ width: 1200, height: 900 });

// ---------- v7 pages ----------
await page.goto(`${BASE}/setup/profile`);
await page.fill("textarea[name=address]", "12 MG Road, Bengaluru");
await page.fill("input[name=social_instagram]", "https://instagram.com/smiledental");
await clickAndSeeSpinner('form[action="/setup/profile"] button', "Save profile");
ok((await toastText()).includes("Profile saved"), "profile saved");
ok((await page.textContent("[data-map-preview]")).includes("map search for your address"), "map link made from the address");
fs.writeFileSync("/tmp/ui-faq.md", "# FAQ\nWe open at 10.");
await page.setInputFiles("[data-filedrop] input[type=file]", "/tmp/ui-faq.md");
ok((await page.textContent("[data-filedrop] [data-dz-title]")).includes("ui-faq.md"), "picked file shown in the drop zone");
await clickAndSeeSpinner('form[action^="/setup/profile/files"] button', "Upload knowledge");
ok((await toastText()).includes("Added 1 file"), "knowledge file uploaded");
await page.click(".k-list details summary");
ok(await page.isVisible(".k-list details textarea"), "knowledge item opens for editing");
await shot("13a-profile");

await page.goto(`${BASE}/setup/holidays`);
const hd = new Date(Date.now() + 5.5 * 3600000 + 9 * 86400000).toISOString().slice(0, 10);
await page.fill('form[action="/setup/holidays"] input[name=date]', hd);
await page.fill('form[action="/setup/holidays"] input[name=label]', "Diwali");
await clickAndSeeSpinner('form[action="/setup/holidays"] button', "Add holiday");
ok((await toastText()).includes("Day off added") && (await page.textContent(".hol-list")).includes("Diwali"), "holiday added and listed");
await page.selectOption("select[name=country]", { label: "India" });
await Promise.all([page.waitForNavigation(), page.click('form[action="/setup/holidays#public"] button')]);
ok((await page.textContent("#public")).includes("Republic Day"), "public holidays load from Google");
await shot("13b-holidays");

await page.goto(`${BASE}/setup/business`);
await page.locator("[data-svc-list] [data-svc-row]").nth(1).locator("select[name=svc_kind]").selectOption("paid");
await page.locator("[data-svc-list] [data-svc-row]").nth(1).locator("input[name=svc_price]").fill("1000");
await clickAndSeeSpinner("form#business-form button:not([type=button])", "Save prices");
await page.goto(`${BASE}/setup/payments`);
await page.fill("[data-discount]", "10");
ok((await page.textContent("[data-online-price]")).includes("₹900"), "online price preview updates as you type");
await clickAndSeeSpinner('form[action="/setup/payments"] button', "Save payment options");
ok((await toastText()).includes("Saved"), "payment options saved");
await page.fill("input[name=upi_id]", "smile@okaxis");
await clickAndSeeSpinner('form[action="/setup/payments/upi"] button', "Save UPI");
ok((await toastText()).includes("UPI saved"), "UPI saved");
await shot("13c-payments");

await page.goto(`${BASE}/setup/test`);
await page.click(".chat-as label:has-text('The owner')");
ok(await page.isVisible("[data-owner-hint]") && !(await page.isVisible(".suggest")), "chat-as-owner shows owner hints");
await page.fill(".chat input", "hello"); await page.press(".chat input", "Enter");
await page.waitForFunction(() => document.querySelectorAll(".chat .m.b").length >= 2 && !document.querySelector(".typing"), null, { timeout: 15000 });
ok((await page.$$eval(".chat .m.b", (e) => e.at(-1).textContent)).includes("Smile Dental"), "owner chat replies");
await page.click(".chat-as label:has-text('A customer')");

await page.goto(`${BASE}/bookings`);
ok((await page.locator(".bk").count()) >= 1, "bookings page lists the test booking");
await shot("13d-bookings");
await page.goto(`${BASE}/bookings/new`);
const tmr = new Date(Date.now() + 5.5 * 3600000 + 86400000).toISOString().slice(0, 10);
await page.fill("[data-slot-date]", tmr); await page.dispatchEvent("[data-slot-date]", "change");
await page.waitForSelector("[data-slot-pick] .chip");
ok((await page.locator("[data-slot-pick] .chip").count()) > 3, "add-booking shows free times as chips");
await page.fill("input[name=name]", "Walk-in Ravi"); await page.fill("input[name=phone]", "9876500000");
await clearToasts();
await page.click("form[data-slot-form] .row button");
ok((await toastText()).includes("Pick one of the free times"), "can't submit without picking a time");
await page.locator("[data-slot-pick] .chip").nth(2).click();
await shot("13e-add-booking");
await clickAndSeeSpinner("form[data-slot-form] .row button", "Add booking");
ok((await toastText()).includes("Booked BK-"), "walk-in booking added");
await page.goto(`${BASE}/`);
ok(await page.isVisible(".card.today"), "dashboard has the Today card");
await shot("13f-dashboard-today");
ok((await page.textContent(".steps")).includes("Profile & knowledge") && (await page.textContent(".steps")).includes("Holidays"), "dashboard shows the new optional steps");

// Mobile + dark screenshots
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/`); await shot("11-mobile-dashboard");
await page.emulateMedia({ colorScheme: "dark" }); await page.goto(`${BASE}/setup/business`); await shot("12-mobile-dark-business");
await page.goto(`${BASE}/bookings`); await shot("12b-mobile-bookings");
await page.emulateMedia({ colorScheme: "light" });

// ---------- v6: Claude keys, payments, expiry ----------
await page.setViewportSize({ width: 1200, height: 900 });
await page.goto(`${BASE}/`);
await Promise.all([page.waitForNavigation(), page.click("text=Log out")]);
await page.fill("#email", "admin@test.com"); await page.fill("#password", "AdminPass123");
await Promise.all([page.waitForNavigation(), page.click("main form button:not([type=button])")]);
await page.goto(`${BASE}/admin/keys`);
ok(await page.isVisible("#add-key"), "keys page opens with the add form when empty");
await page.fill("#add-key input[name=name]", "Main key"); await page.fill("#add-key input[name=key]", "sk-ant-ui-key-123456");
await clickAndSeeSpinner("#add-key button", "Add Claude key");
ok((await toastText()).includes("tested and saved"), "Claude key saved toast");
ok(!(await page.isVisible("#add-key")), "add form tucks away once a key exists");
await page.click("main [data-open=add-key]");
ok(await page.isVisible("#add-key"), "Add key button reveals the form");
await shot("13-claude-keys");

await page.goto(`${BASE}/admin/users/new`);
ok(!(await page.$eval("details.advanced", (d) => d.open)), "Advanced (our Claude key) is closed by default");
await page.click("details.advanced summary");
ok(!(await page.isVisible("[data-new-key]")), "new-key fields hidden until chosen");
await page.selectOption("select[name=shared_key]", "new");
ok(await page.isVisible("[data-new-key]"), "choosing '+ Add a new key' shows its fields");
await page.selectOption("select[name=role]", "admin");
ok(!(await page.isVisible("details.advanced")) && !(await page.isVisible(".segmented.pay")), "admin role hides customer-only options");
await page.selectOption("select[name=role]", "user");
const keyVal = await page.$eval("select[name=shared_key] option:nth-child(2)", (o) => o.value);
await page.selectOption("select[name=shared_key]", keyVal);
ok(!(await page.isVisible("[data-new-key]")), "picking an existing key hides new-key fields");
await page.fill("input[name=name]", "Ravi Salon"); await page.fill("input[name=email]", "ravi@salon.com"); await page.fill("input[name=phone]", "9876543210");
const before3 = await page.inputValue("input[name=valid_until]");
await page.click('[data-quick-dates] [data-add="+3m"]');
ok((await page.inputValue("input[name=valid_until]")) > before3, "quick date chip moves 'valid until'");
await page.click(".segmented.pay label.trial");
await shot("14-new-account-advanced");
await clickAndSeeSpinner("form[data-role-form] button:not([type=button])", "Create with our key");
ok(await page.isVisible("text=Send on WhatsApp"), "login details can be sent on WhatsApp");
await page.click("text=Back to account"); await page.waitForLoadState();
ok((await page.textContent(".page-head")).includes("Free trial"), "payment status shown on account");

await page.click("[data-open=record-payment]");
await page.waitForTimeout(200);
ok(await page.isVisible("#record-payment"), "Record payment opens the form");
await page.fill("#record-payment input[name=amount]", "2,999");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
await page.setInputFiles("#record-payment input[name=screenshot]", { name: "upi.png", mimeType: "image/png", buffer: png });
await page.waitForSelector("[data-img-preview]:not([hidden])", { timeout: 3000 }).then(() => ok(true, "screenshot preview appears")).catch(() => ok(false, "screenshot preview appears"));
const ext0 = await page.inputValue("input[name=extend_to]");
await page.click('#record-payment [data-add="+3m"]');
ok((await page.inputValue("input[name=extend_to]")) > ext0, "+3 months moves the new validity");
await page.click("#record-payment .switch-row");
ok(await page.$eval("input[name=extend_to]", (i) => i.disabled), "turning 'Extend access' off disables the date");
await page.click("#record-payment .switch-row");
await shot("15-record-payment");
await clickAndSeeSpinner("#record-payment button:not([type=button])", "Save payment");
ok((await toastText()).includes("Access extended"), "payment saved + extended toast");
ok((await page.textContent(".pay-list")).includes("₹2,999"), "payment appears in history");
await page.click(".pay-list .shot");
await page.waitForSelector(".lightbox img");
ok(true, "screenshot opens in viewer");
await page.keyboard.press("Escape");
await page.waitForSelector(".lightbox", { state: "detached" });
ok(true, "Escape closes the viewer");
await shot("16-payments");

// Priya's access ends in 2 days → attention card + banner.
const in2 = new Date(Date.now() + 5.5 * 3600000 + 2 * 86400000).toISOString().slice(0, 10);
await page.goto(`${BASE}/admin`);
await page.keyboard.press("/");
ok(await page.evaluate(() => document.activeElement?.name === "q"), "pressing / focuses search");
await page.fill("input[name=q]", "priya"); await Promise.all([page.waitForNavigation(), page.press("input[name=q]", "Enter")]);
await Promise.all([page.waitForNavigation(), page.click("tr[data-href] td >> nth=0")]);
await page.fill("input[name=valid_until]", in2);
await Promise.all([page.waitForNavigation(), page.click("form[data-role-form] button:not([type=button])")]);
await page.goto(`${BASE}/admin`);
ok(await page.isVisible(".card.attention"), "Needs attention card lists accounts ending soon");
ok((await page.textContent(".attention")).includes("2 days left"), "shows days left");
await Promise.all([page.waitForNavigation(), page.click('.chips a:has-text("Ending soon")')]);
ok((await page.textContent("table")).includes("priya@clinic.com") && !(await page.textContent("table")).includes("ravi@salon.com"), "Ending soon filter");
await page.goto(`${BASE}/admin`);
await shot("17-admin-attention");
await page.emulateMedia({ colorScheme: "dark" });
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await shot("18-admin-dark");
await page.goto(`${BASE}/admin/keys`); await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark")); await shot("19-keys-dark");

await Promise.all([page.waitForNavigation(), page.click("text=Log out")]);
await page.fill("#email", "priya@clinic.com"); await page.fill("#password", "Clinic2026!");
await Promise.all([page.waitForNavigation(), page.click("main form button:not([type=button])")]);
ok(await page.isVisible(".expiry"), "customer sees 'access ends' banner");
ok((await page.textContent(".expiry")).includes("in 2 days"), "banner says in 2 days");
await shot("20-customer-expiry-banner");
await page.click(".expiry [data-dismiss]");
await page.waitForSelector(".expiry", { state: "detached" });
await page.reload();
ok(!(await page.isVisible(".expiry")), "hidden banner stays hidden on this device");
await page.goto(`${BASE}/account/password`);
ok((await page.textContent("#subscription")).includes("2 days left"), "account shows days left with meter");
await shot("21-customer-subscription");
await page.emulateMedia({ colorScheme: "light" });

ok(errors.length === 0, "no JavaScript errors or native popups", errors.join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
