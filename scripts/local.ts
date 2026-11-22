/**
 * LOKAL SINOV REJIMI — Cloudflare'siz, o'z kompyuteringizda.
 *
 *   1) .dev.vars.example faylidan nusxa oling -> .dev.vars va qiymatlarni yozing
 *   2) npm run local
 *
 * Bot Telegram'dan xabarlarni o'zi so'rab oladi (getUpdates), webhook kerak emas.
 * Ma'lumotlar .local-kv.json fayliga saqlanadi.
 * Kompyuter yoki terminal yopilsa — bot to'xtaydi (bu faqat sinov uchun).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { handleUpdate, COMMANDS, syncCommands } from "../src/index";
import { pollAll, sendDailyReport } from "../src/orders";
import { checkWatches } from "../src/uzumui";
import { checkFbsWatches } from "../src/uzumfbs";
import { checkStock, checkUzumNewFbs } from "../src/uzumalerts";
import { checkReminders } from "../src/reminders";
import { catalogReport } from "../src/stock";
import { pollClients, subReminders } from "../src/clients";
import { uzumEnabled } from "../src/uzum";
import { handleWeb, setMiniAppUrl } from "../src/webapp";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Env } from "../src/types";

// ---- .dev.vars o'qish ----
function loadVars(path: string): Record<string, string> {
  if (!existsSync(path)) {
    // Serverda (Docker/Coolify) kalitlar muhit o'zgaruvchilaridan olinadi
    if (process.env.TELEGRAM_BOT_TOKEN) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (/^[A-Z0-9_]+$/.test(k) && v) env[k] = v;
      return env;
    }
    console.error("❌ .dev.vars fayli topilmadi. .dev.vars.example dan nusxa olib, to'ldiring.");
    process.exit(1);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// ---- Oddiy fayl-KV (Cloudflare KV o'rniga) ----
const KV_FILE = ".local-kv.json";
type Entry = { v: string; m?: unknown; e?: number };
const store: Record<string, Entry> = existsSync(KV_FILE) ? JSON.parse(readFileSync(KV_FILE, "utf8")) : {};
const persist = () => writeFileSync(KV_FILE, JSON.stringify(store));
const alive = (k: string) => {
  const e = store[k];
  if (e?.e && e.e < Date.now()) {
    delete store[k];
    return undefined;
  }
  return e;
};
const kv = {
  async get(k: string) {
    return alive(k)?.v ?? null;
  },
  async put(k: string, v: string, o: { expirationTtl?: number; metadata?: unknown } = {}) {
    store[k] = { v, m: o.metadata, e: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : undefined };
    persist();
  },
  async delete(k: string) {
    delete store[k];
    persist();
  },
  async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
    const keys = Object.keys(store)
      .filter((k) => k.startsWith(prefix) && alive(k))
      .map((name) => ({ name, metadata: store[name].m }));
    return { keys, list_complete: true, cursor: "" };
  },
} as unknown as KVNamespace;

const vars = loadVars(".dev.vars");
const env = { ...vars, STATE: kv, TIMEZONE_OFFSET_HOURS: vars.TIMEZONE_OFFSET_HOURS ?? "5", REMIND_BEFORE_HOURS: vars.REMIND_BEFORE_HOURS ?? "3", UZUM_SHOPS: vars.UZUM_SHOPS ?? "132103,136366,138348,131883,40020", WB_STATS_CURRENCY: vars.WB_STATS_CURRENCY ?? "RUB" } as unknown as Env;

for (const k of ["TELEGRAM_BOT_TOKEN", "ADMIN_LOGIN", "ADMIN_PASSWORD"]) {
  if (!(env as any)[k]) {
    console.error(`❌ .dev.vars ichida ${k} to'ldirilmagan`);
    process.exit(1);
  }
}

const api = (method: string, body: unknown = {}) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);

async function main() {
  const me = await api("getMe").catch((e) => {
    console.error("❌ Telegram'ga ulanib bo'lmadi (internet yoki proksi?):", e.message);
    process.exit(1);
  });
  if (!me.ok) {
    console.error("❌ Telegram token noto'g'ri:", me.description);
    process.exit(1);
  }
  // Bot bulutda (Cloudflare) ishlayotgan bo'lsa — kompyuterdagi nusxa ishga tushmaydi (ikki marta bron bo'lmasin)
  const wh = await api("getWebhookInfo").catch(() => null);
  if (wh?.result?.url && !(env as any).FORCE_LOCAL) {
    console.log(`☁️ Bot Cloudflare'da ishlayapti (${wh.result.url}). Kompyuterdagi nusxa ishga tushirilmaydi.`);
    console.log("   Kompyuterda ishlatish kerak bo'lsa: .dev.vars ga FORCE_LOCAL=1 yozing.");
    process.exit(76);
  }
  // Lokal rejimda webhook o'chirilishi kerak (aks holda getUpdates ishlamaydi)
  await api("deleteWebhook", { drop_pending_updates: false });
  await api("setMyCommands", { commands: COMMANDS });
  await syncCommands(env);
  console.log(`✅ @${me.result.username} lokal rejimda ishga tushdi. Telegram'da /login yozing.`);
  console.log("   To'xtatish: Ctrl+C");

  // Har 3 daqiqada buyurtmalarni tekshirish
  const tick = async () => {
    try {
      const r = await pollAll(env);
      console.log(`[${new Date().toLocaleTimeString()}] tekshirildi: yangi=${r.newCount}` + (r.errors.length ? ` xatolar=${r.errors.join(" | ")}` : ""));
    } catch (e) {
      console.log("poll xato:", (e as Error).message);
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 3 * 60 * 1000);
  // 🆕 Uzum FBS yangi buyurtmalar — har daqiqada; ⚠️ qoldiq — har 30 daqiqada
  let newBusy = false;
  setInterval(async () => {
    if (newBusy || !(await uzumEnabled(env).catch(() => false))) return;
    newBusy = true;
    try {
      await checkReminders(env).catch((e) => console.log("eslatma xato:", e.message));
      await subReminders(env).catch((e) => console.log("obuna eslatma xato:", e.message));
      const nc = await pollClients(env).catch((e) => (console.log("mijoz buyurtma xato:", e.message), 0));
      if (nc) console.log(`   Mijozlar: ${nc} ta yangi Ozon/WB buyurtma`);
      const n = await checkUzumNewFbs(env);
      if (n) console.log(`   Uzum FBS: ${n} ta yangi buyurtma`);
    } finally {
      newBusy = false;
    }
  }, 60 * 1000);
  const stockTick = async () => {
    if (!(await uzumEnabled(env).catch(() => false))) return;
    const n = await checkStock(env).catch((e) => (console.log("qoldiq xato:", e.message), 0));
    if (n) console.log(`   Uzum: ${n} ta qoldiq ogohlantirishi`);
  };
  setTimeout(stockTick, 20_000);
  setInterval(stockTick, 30 * 60 * 1000);
  // 📦 FBO / qaytarish slot kuzatuvlari — har 10 soniyada (joy tez tugaydi)
  let fboBusy = false;
  setInterval(async () => {
    if (fboBusy) return;
    fboBusy = true;
    try {
      if (!(await uzumEnabled(env).catch(() => false))) return;
      const n = await checkWatches(env).catch((e) => (console.log("uzum slot xato:", e.message), 0));
      if (n) console.log(`   Uzum FBO: ${n} ta kuzatuvda bo'sh slot topildi`);
    } finally {
      fboBusy = false;
    }
  }, 10 * 1000);
  // ⚡ FBS avtomatik bron — har 15 soniyada (joy tez tugaydi)
  let fbsBusy = false;
  setInterval(async () => {
    if (fbsBusy) return; // oldingi tekshiruv hali tugamagan
    fbsBusy = true;
    try {
    if (!(await uzumEnabled(env).catch(() => false))) return;
    const n = await checkFbsWatches(env).catch((e) => (console.log("fbs bron xato:", e.message), 0));
    if (n) console.log(`   Uzum FBS: ${n} ta kuzatuvda joy topildi`);
    } finally {
      fbsBusy = false;
    }
  }, 15 * 1000);

  // Har kuni 09:00 (Toshkent) hisobot
  let lastReport = "";
  setInterval(() => {
    const t = new Date(Date.now() + 5 * 3600e3);
    const day = t.toISOString().slice(0, 10);
    if (t.getUTCHours() === 9 && lastReport !== day) {
      lastReport = day;
      sendDailyReport(env).catch((e) => console.log("hisobot xato:", e.message));
    }
  }, 15 * 1000);

  startMiniApp().catch((e) => console.log("📱 Ilova xato:", e.message));

  // Telegram xabarlarini olish
  let offset = 0;

  // /restart: Telegram'ga "o'qildi" deb belgilab, jarayondan chiqamiz — run.mjs darhol qayta ishga tushiradi
  (env as any).RESTART = async () => {
    await api("getUpdates", { offset, timeout: 0 }).catch(() => {});
    console.log("🔄 /restart — qayta ishga tushirilmoqda...");
    setTimeout(() => process.exit(75), 300);
  };

  // Qayta ishga tushgandan keyin menyuni ko'rsatish
  const rc = await env.STATE.get("restart:chat");
  if (rc) {
    await env.STATE.delete("restart:chat");
    let chat = Number(rc), msg = 0;
    try {
      const j = JSON.parse(rc);
      if (typeof j === "object") ({ chat, msg } = j);
    } catch {}
    // "Qayta ishga tushirilmoqda..." xabarini o'chirib, yangi menyuni chiqaramiz
    if (msg) await api("deleteMessage", { chat_id: chat, message_id: msg }).catch(() => {});
    handleUpdate(env, { message: { message_id: 0, chat: { id: chat, type: "private" }, from: { id: chat }, text: "/start" } }).catch(() => {});
  }
  for (;;) {
    try {
      const r = await api("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query", "widget_query", "pre_checkout_query"],
      });
      if (r.error_code === 409) {
        console.log("☁️ Telegram webhook yoqilgan — bot bulutga ko'chirilgan. Kompyuterdagi nusxa to'xtaydi.");
        process.exit(76);
      }
      for (const u of r.result ?? []) {
        offset = u.update_id + 1;
        handleUpdate(env, u).catch((e) => console.log("update xato:", e.message));
      }
    } catch (e) {
      console.log("getUpdates xato, 5 soniyadan keyin qayta:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * 📱 Mini App: kompyuterda http://localhost:8787/app da ishlaydi.
 * Telegram faqat https manzilni ochadi, shuning uchun:
 *  - .dev.vars ga MINIAPP_URL=https://... yozilsa — shu manzil ishlatiladi;
 *  - MINIAPP_TUNNEL=1 bo'lsa — cloudflared (o'rnatilgan bo'lsa) bepul vaqtinchalik https manzil ochadi.
 * Bot Cloudflare'ga ko'chirilgach bularning keragi yo'q — manzil avtomatik o'rnatiladi.
 */
async function startMiniApp() {
  const port = Number((env as any).MINIAPP_PORT ?? 8787);
  // Brauzerda sinash kaliti — .local/devkey.txt da saqlanadi (o'chirsangiz yangisi yaratiladi); tunnel (internet) orqali kelgan so'rovlarda ishlamaydi
  const KEY_FILE = ".local/devkey.txt";
  const devKey = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : randomBytes(12).toString("hex");
  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, devKey);
  createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const viaTunnel = !!(req.headers["cf-ray"] || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
      // Admin: umumiy ombor uchun katalog hisoboti (?key=SETUP_KEY)
      if (req.url?.startsWith("/admin/stock-catalog")) {
        const k = new URL(req.url, "http://x").searchParams.get("key");
        if (!(env as any).SETUP_KEY || k !== (env as any).SETUP_KEY) { res.writeHead(403); res.end("Forbidden"); return; }
        const rep = await catalogReport(env as Env);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rep));
        return;
      }
      const r = await handleWeb(
        viaTunnel ? env : ({ ...env, MINIAPP_DEV_KEY: devKey } as Env),
        new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }),
      );
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500);
      res.end("xato");
    }
  }).listen(port, process.env.MINIAPP_HOST || "127.0.0.1", () => {
    console.log(`📱 Ilovani kompyuterda sinash (brauzerda oching, linkni hech kimga bermang):`);
    console.log(`   http://localhost:${port}/app?dev=${devKey}`);
    console.log(`   mijoz ko'rinishi: ...&uid=<mijoz Telegram ID>`);
  });

  const fixed = (env as any).MINIAPP_URL as string | undefined;
  if (fixed) {
    const base = fixed.replace(/\/+$/, "");
    await setMiniAppUrl(env, base.endsWith("/app") ? base : `${base}/app`);
    console.log(`📱 Telegram'da «Ilova» tugmasi: ${fixed}`);
    return;
  }
  if ((env as any).MINIAPP_TUNNEL !== "1") return;
  const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  cf.on("error", () => console.log("📱 cloudflared topilmadi. O'rnatish: winget install Cloudflare.cloudflared (yoki botni bulutga ko'chiring)"));
  let done = false;
  const onData = (b: Buffer) => {
    const m = String(b).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !done) {
      done = true;
      setMiniAppUrl(env, `${m[0]}/app`)
        .then(() => console.log(`📱 Ilova ochiq: ${m[0]}/app (Telegram'dagi «Ilova» tugmasi yangilandi)`))
        .catch((e) => console.log("📱 menyu tugmasi xato:", e.message));
    }
  };
  cf.stdout.on("data", onData);
  cf.stderr.on("data", onData);
  process.on("exit", () => cf.kill());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (cf.kill(), process.exit(0)));
}

main();
