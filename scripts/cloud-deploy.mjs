/**
 * ☁️ Botni Cloudflare'ga ko'chirish (bulutga-kochirish.bat shu faylni ishga tushiradi).
 *  1) Cloudflare'ga kirish (birinchi marta brauzer ochiladi — o'zingiz tasdiqlaysiz)
 *  2) Botni yuklash (wrangler deploy)
 *  3) .dev.vars dagi kalitlarni Cloudflare "secret"lariga o'tkazish
 *  4) Kompyuterdagi ma'lumotlarni (.local-kv.json: profillar, kuzatuvlar...) bulutga ko'chirish
 *  5) Telegram webhook'ni ulash
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";
const say = (m) => console.log(`\n${m}`);
const fail = (m) => {
  console.error(`\n❌ ${m}`);
  process.exit(1);
};

function run(args, { capture = false } = {}) {
  if (!capture) {
    const r = spawnSync(npx, ["wrangler", ...args], { stdio: "inherit", shell: isWin });
    return { code: r.status, out: "" };
  }
  return new Promise((res) => {
    const p = spawn(npx, ["wrangler", ...args], { shell: isWin });
    let out = "";
    p.stdout.on("data", (d) => (process.stdout.write(d), (out += d)));
    p.stderr.on("data", (d) => (process.stderr.write(d), (out += d)));
    p.stdin.end();
    p.on("close", (code) => res({ code, out }));
  });
}

// 0) .dev.vars
if (!existsSync(".dev.vars")) fail(".dev.vars topilmadi — avval bot kompyuterda ishlagan bo'lishi kerak.");
const vars = {};
for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && m[2] !== "") vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
for (const k of ["TELEGRAM_WEBHOOK_SECRET", "SETUP_KEY"]) {
  if (!vars[k]) {
    vars[k] = randomBytes(18).toString("hex");
    appendFileSync(".dev.vars", `\n${k}=${vars[k]}\n`);
  }
}

// 1) Kirish
say("1/5 🔐 Cloudflare hisobini tekshiryapman...");
const who = await run(["whoami"], { capture: true });
if (!/associated with the email|You are logged in/i.test(who.out)) {
  say("Brauzer ochiladi — Cloudflare hisobingizga kiring va «Allow» bosing.");
  if (run(["login"]).code !== 0) fail("Cloudflare'ga kirib bo'lmadi.");
}

// 2) Yuklash
say("2/5 🚀 Botni Cloudflare'ga yuklayapman...");
const dep = await run(["deploy"], { capture: true });
if (dep.code !== 0) fail("Yuklashda xato (yuqoridagi xabarni ko'ring).");
const url = (dep.out.match(/https:\/\/[^\s]+\.workers\.dev/) ?? [])[0];
if (!url) fail("Bot manzili (workers.dev) topilmadi. Cloudflare panelida Workers → subdomain yoqilganini tekshiring.");
say(`✅ Bot manzili: ${url}`);

// 3) Secret'lar ([vars] dagilar bundan mustasno)
say("3/5 🔑 Kalitlarni (token, parollar) Cloudflare'ga o'tkazyapman...");
const toml = readFileSync("wrangler.toml", "utf8");
const plain = new Set([...toml.matchAll(/^([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]));
const secrets = Object.fromEntries(Object.entries(vars).filter(([k]) => !plain.has(k)));
const tmp = join(tmpdir(), `mh-secrets-${Date.now()}.json`);
writeFileSync(tmp, JSON.stringify(secrets));
try {
  if (run(["secret", "bulk", tmp]).code !== 0) fail("Kalitlarni o'tkazib bo'lmadi.");
} finally {
  try {
    unlinkSync(tmp);
  } catch {}
}

// 4) Ma'lumotlarni ko'chirish
say("4/5 📦 Kompyuterdagi ma'lumotlarni (profillar, kuzatuvlar, foydalanuvchilar) ko'chiryapman...");
await new Promise((r) => setTimeout(r, 4000));
if (existsSync(".local-kv.json")) {
  const store = JSON.parse(readFileSync(".local-kv.json", "utf8"));
  const entries = Object.entries(store);
  let total = 0;
  for (let i = 0; i < entries.length; i += 150) {
    const chunk = Object.fromEntries(entries.slice(i, i + 150));
    const r = await fetch(`${url}/import?key=${vars.SETUP_KEY}`, { method: "POST", body: JSON.stringify(chunk) });
    const t = await r.text();
    if (!r.ok) fail(`Ko'chirishda xato: ${r.status} ${t}`);
    total += Number((t.match(/\d+/) ?? ["0"])[0]);
  }
  say(`✅ ${total} ta yozuv ko'chirildi.`);
} else say("(.local-kv.json yo'q — ko'chiradigan narsa yo'q)");

// 5) Webhook
say("5/5 🔗 Telegram'ni bulutdagi botga ulayapman...");
const s = await fetch(`${url}/setup?key=${vars.SETUP_KEY}`);
const st = await s.text();
if (!s.ok) fail(`Webhook o'rnatilmadi: ${s.status} ${st}`);
say(`✅ ${st}`);
say("🎉 TAYYOR! Bot endi Cloudflare'da kecha-kunduz ishlaydi — kompyuter o'chiq bo'lsa ham.");
say("Kompyuterdagi bot o'zi to'xtaydi. Autostart ham o'chiriladi.");
