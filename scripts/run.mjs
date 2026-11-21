/**
 * MarketHub botni avtomatik boshqarish (start-bot.bat shu faylni ishga tushiradi):
 *  - kodni yig'adi (esbuild) va botni ishga tushiradi;
 *  - src/, scripts/ yoki .dev.vars o'zgarsa — o'zi qayta yig'ib, qayta ishga tushiradi;
 *  - bot xato bilan to'xtasa — 5 soniyadan keyin o'zi qayta yoqadi.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".local", "bot.mjs");
const time = () => new Date().toLocaleTimeString("uz-UZ", { hour12: false });
const log = (m) => console.log(`[${time()}] ${m}`);

let child = null;
let restarting = false;
let stopping = false;
let crashes = 0;

async function compile() {
  await build({
    entryPoints: [join(root, "scripts", "local.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "warning",
  });
}

async function start() {
  try {
    await compile();
  } catch (e) {
    log("❌ Kodni yig'ishda xato — tuzatilishini kutyapman (fayl saqlansa, o'zi qayta urinadi).");
    return;
  }
  log("🚀 Bot ishga tushmoqda...");
  const startedAt = Date.now();
  child = spawn(process.execPath, [out], { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => {
    child = null;
    if (restarting || stopping) return;
    if (code === 76) {
      // Bot bulutda ishlayapti — kompyuterdagi nusxa to'xtaydi
      log("☁️ Bot Cloudflare'da ishlayapti — bu oynani yopishingiz mumkin.");
      stopping = true;
      setTimeout(() => process.exit(0), 3000);
      return;
    }
    if (code === 75) {
      // Telegram'dagi /restart buyrug'i
      crashes = 0;
      log("🔄 /restart buyrug'i — qayta ishga tushiryapman...");
      setTimeout(() => !child && !stopping && start(), 1000);
      return;
    }
    // Tez-tez qulasa — kutish vaqtini oshiramiz (maks. 60 s)
    crashes = Date.now() - startedAt < 60_000 ? crashes + 1 : 0;
    const wait = Math.min(60, 5 * Math.max(1, crashes));
    log(`⚠️ Bot to'xtadi (kod ${code}). ${wait} soniyadan keyin qayta ishga tushaman...`);
    setTimeout(() => !child && !stopping && start(), wait * 1000);
  });
}

async function restart(reason) {
  if (restarting) return;
  restarting = true;
  log(`🔄 ${reason} — qayta ishga tushiryapman...`);
  if (child) {
    const c = child;
    await new Promise((res) => {
      c.once("exit", res);
      c.kill();
      setTimeout(res, 5000);
    });
  }
  restarting = false;
  crashes = 0;
  await start();
}

// O'zgarishlarni kuzatish. Windows fayl o'qilganda ham "o'zgardi" deydi —
// shuning uchun faqat fayl MAZMUNI haqiqatan o'zgarsa qayta ishga tushiramiz.
const hashes = new Map();
const hashOf = (p) => {
  try {
    return createHash("md5").update(readFileSync(p)).digest("hex");
  } catch {
    return "";
  }
};
const scan = (dir) => {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(f));
    if (/\.(ts|mjs|js|json)$/.test(p)) hashes.set(p, hashOf(p));
  }
};
scan(join(root, "src"));
scan(join(root, "scripts"));
hashes.set(join(root, ".dev.vars"), hashOf(join(root, ".dev.vars")));

let timer = null;
const changed = new Set();
const onChange = (what, base) => (_ev, file) => {
  const p = file ? join(base, String(file)) : base;
  if (!/\.(ts|mjs|js|json)$|\.dev\.vars$/.test(p)) return;
  const h = hashOf(p);
  if (hashes.get(p) === h) return; // mazmun o'zgarmagan
  hashes.set(p, h);
  changed.add(`${what}${file ? "/" + file : ""}`);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const list = [...changed].join(", ");
    changed.clear();
    restart(`${list} o'zgardi`);
  }, 1500);
};
for (const dir of ["src", "scripts"]) {
  const p = join(root, dir);
  if (existsSync(p)) watch(p, { recursive: true }, onChange(dir, p));
}
if (existsSync(join(root, ".dev.vars"))) watch(join(root, ".dev.vars"), onChange(".dev.vars", join(root, ".dev.vars")));

const quit = () => {
  stopping = true;
  log("👋 To'xtatilmoqda...");
  if (child) child.kill();
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

log("👀 Avtomatik rejim: kod yangilansa yoki bot to'xtasa — o'zi qayta ishga tushadi. Yopish: Ctrl+C yoki oynani yoping.");
start();
