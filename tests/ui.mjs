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
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const toastText = async () => { await page.waitForSelector(".toast", { timeout: 8000 }); return (await page.$$eval(".toast", (t) => t.map((x) => x.textContent).join(" | "))); };
const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));

/** Clicks a submit button, checks the spinner + loading bar appear, then lets the submit go through. */
async function clickAndSeeSpinner(selector, label) {
  await clearToasts();
  await page.evaluate(() => window.addEventListener("submit", (e) => { e.preventDefault(); window.__held = e.target; }, { once: true }));
  await page.locator(`main ${selector}`).first().click();
  const spinning = await page.evaluate(() => !!document.querySelector("button.loading") && document.getElementById("progress").classList.contains("on"));
  ok(spinning, `${label}: spinner + loading bar while working`);
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.evaluate(() => HTMLFormElement.prototype.submit.call(window.__held))]);
}

// ---------- Admin ----------
await page.goto(`${BASE}/login`);
await shot("01-login");
await page.fill("#email", "admin@test.com"); await page.fill("#password", "AdminPass123");
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
await clickAndSeeSpinner("form[data-busy] button:not([type=button])", "Save account");
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
await Promise.all([page.waitForNavigation(), page.click("form button")]);
ok(page.url().includes("/account/password"), "customer must set own password");
await page.fill("input[name=current]", temp2); await page.fill("input[name=password]", "Clinic2026!"); await page.fill("input[name=password2]", "Clinic2026!");
await clickAndSeeSpinner("form button", "Save password");
ok((await toastText()).includes("Password updated"), "password updated toast");
await shot("06-dashboard");

await page.goto(`${BASE}/setup/business`);
await page.fill("input[name=business_name]", "Smile Dental"); await page.fill("input[name=services]", "Consultation, Cleaning");
const sun = page.locator(".chips label", { hasText: "Sun" });
await sun.click();
ok(await sun.evaluate((l) => l.querySelector("input").checked), "day chip toggles on click");
await page.selectOption("select[name=open_hour]", "0"); await page.selectOption("select[name=close_hour]", "23");
await shot("07-business");
await clickAndSeeSpinner("form[data-busy] button", "Save business");
ok((await toastText()).includes("Business details saved"), "business saved toast");

await page.fill("input[name=api_key]", "sk-ant-bad");
await clickAndSeeSpinner("form[data-busy] button", "Test Claude key");
ok((await toastText()).includes("not valid"), "bad Claude key → red error toast");
await page.fill("input[name=api_key]", "sk-ant-good-key-123456");
await clickAndSeeSpinner("form[data-busy] button", "Save Claude key");
ok((await toastText()).includes("Claude is connected"), "Claude connected toast");

const keyPath = "/tmp/ui-sa.json";
fs.writeFileSync(keyPath, JSON.stringify({ type: "service_account", client_email: "bot@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }));
await page.setInputFiles("input[type=file]", keyPath);
await clickAndSeeSpinner("form[enctype] button", "Upload Google key");
ok((await toastText()).includes("Key uploaded"), "key uploaded toast");
await clearToasts();
await page.click("main button[data-copy]");
ok((await toastText()).includes("Copied"), "copy service-account email");
await page.fill("input[name=calendar_id]", "bookings@group.calendar.google.com");
await clickAndSeeSpinner(`form[action="/setup/google"] button`, "Test calendar");
ok((await toastText()).includes("Connected to"), "calendar connected toast");
await shot("08-test-chat-empty");

await page.click(".suggest button >> nth=0");
await page.waitForSelector(".typing", { timeout: 3000 }).then(() => ok(true, "typing indicator appears")).catch(() => ok(false, "typing indicator appears"));
await page.waitForFunction(() => document.querySelectorAll(".chat .m.b").length >= 2 && !document.querySelector(".typing"), null, { timeout: 15000 });
ok((await page.$$eval(".chat .m.b", (e) => e.at(-1).textContent)).includes("Smile Dental"), "chat reply arrives");
await page.fill(".chat input", "book me please"); await page.press(".chat input", "Enter");
await page.waitForFunction(() => document.querySelectorAll(".chat .m.b").length >= 3 && !document.querySelector(".typing"), null, { timeout: 15000 });
await shot("09-test-chat");
await page.click("[data-chat-reset]");
ok((await toastText()).includes("Conversation reset"), "start over resets chat");
await Promise.all([page.waitForNavigation(), page.click("text=It works, continue")]);

await page.goto(`${BASE}/setup/widget`);
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

// Mobile + dark screenshots
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/`); await shot("11-mobile-dashboard");
await page.emulateMedia({ colorScheme: "dark" }); await page.goto(`${BASE}/setup/business`); await shot("12-mobile-dark-business");
await page.emulateMedia({ colorScheme: "light" });

ok(errors.length === 0, "no JavaScript errors or native popups", errors.join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
