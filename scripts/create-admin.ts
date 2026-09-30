// Create or reset an admin from the command line:
//   npm run create-admin -- you@example.com "Your Name"
import { createUser, getUserByEmail, setPassword } from "../src/models.js";
import { db, initDb } from "../src/db.js";
await initDb();
import { tempPassword } from "../src/security.js";

const [email, name = "Admin"] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run create-admin -- you@example.com "Your Name"');
  process.exit(1);
}
const pw = tempPassword();
const existing = await getUserByEmail(email);
if (existing) {
  await setPassword(existing.id, pw, true);
  await db.run("UPDATE users SET role='admin', status='active' WHERE id=?", existing.id);
  console.log(`Reset ${email} to admin.`);
} else {
  await createUser({ email, name, password: pw, role: "admin", validUntil: null, permWidget: true, permWhatsapp: true });
  console.log(`Created admin ${email}.`);
}
console.log(`Temporary password: ${pw}  (you'll set your own on first login)`);
