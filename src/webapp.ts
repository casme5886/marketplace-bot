/**
 * 📱 MarketHub Mini App (Telegram Web App)
 *   GET  /app            — ilova sahifasi
 *   /api/*               — ilova uchun ma'lumot (har so'rovda Telegram initData imzosi tekshiriladi)
 * Kim kirganini Telegram tasdiqlaydi: login/parol so'ralmaydi.
 * Xodim (bot paroli bilan kirgan) — barcha profillar; mijoz — faqat o'z do'konlari (xizmat hisobi orqali).
 */
import { getLang, setLang } from "./i18n";
import type { Env, Order } from "./types";
import APP_HTML from "./apphtml";
import { sendText, tg } from "./telegram";
import { getOwner, isAuthorized } from "./auth";
import { fmtPhone } from "./phonelogin";
import { tzOffset } from "./format";
import * as CL from "./clients";
import { uzumAccounts, uzumFbsConfirm, uzumFbsLabel, uzumGet, uzumInvoice, uzumInvoices, uzumShops, uzumSlots } from "./uzum";
import { addDaysWatch, reserve, stopSearch, toggleWatchAuto } from "./uzumui";
import { fbsRoot, fbsWatchStop, fbsWatchToggle, fbsWebCreate, fbsWebDays, fbsWebPoints, fbsWebSlots, fbsWebSplitCreate, fbsWebSplitPlan, fbsWebState, fbsWebWatch, sendFbsLabels, skuLine } from "./uzumfbs";
import { bulkHandover, doAction, makeLabel, pendingOrders, wbHandoverSupply } from "./orders";
import { ozonEnabled } from "./ozon";
import { wbEnabled } from "./wb";
import { bookings } from "./booklog";
import { getStats, periodRange, type PeriodKey } from "./stats";
import { notifications } from "./notify";
import { createPayLink, payOptions, payReady, priceUzs } from "./payments";
import { cardInfo, decideReceipt, receiptImage, receiptsFor, setCard, submitReceipt } from "./receipts";

type Json = Record<string, unknown>;
interface Shop {
  id: number;
  name: string;
  acc: string;
}
interface Viewer {
  uid: number;
  user: any;
  staff: boolean;
  client: CL.Client | null;
  shops: Shop[];
}

const DAY = 864e5;
const WD = ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"];
const MON = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];

/* ---------- Yordamchilar ---------- */

const json = (o: Json, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();

function loc(env: Env, ms: number) {
  const d = new Date(ms + tzOffset(env) * 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    ymd: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    day: d.getUTCDate(),
    wd: WD[d.getUTCDay()],
    hm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    label: `${d.getUTCDate()}-${MON[d.getUTCMonth()]}`,
  };
}
const ymdStart = (env: Env, ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - tzOffset(env) * 3600e3;
const ymdLabel = (env: Env, ymd: string) => loc(env, ymdStart(env, ymd) + 3600e3).label;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Telegram initData imzosini tekshirish (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) */
export async function verifyInitData(env: Env, initData: string): Promise<any | null> {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(env.TELEGRAM_BOT_TOKEN));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)));
  if (sig.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") ?? 0) > 86400) return null;
  try {
    const u = JSON.parse(p.get("user") ?? "null");
    return u?.id ? u : null;
  } catch {
    return null;
  }
}

const viewCache = new Map<number, { t: number; v: Viewer }>();
async function viewer(env: Env, user: any): Promise<Viewer> {
  const uid = Number(user.id);
  // Xodim uchun do'konlar ro'yxati 90 s eslab qolinadi (har bosishda Uzum'dan qayta so'ramaslik)
  const c = viewCache.get(uid);
  if (c && Date.now() - c.t < 90_000) return { ...c.v, user };
  const v = await viewerFresh(env, user, uid);
  if (v.staff) viewCache.set(uid, { t: Date.now(), v });
  return v;
}
async function viewerFresh(env: Env, user: any, uid: number): Promise<Viewer> {
  const staff = await isAuthorized(env, uid);
  const client = await CL.getClient(env, uid);
  const shops: Shop[] = [];
  if (staff) {
    const all: Shop[] = [];
    for (const a of await uzumAccounts(env).catch(() => [])) {
      for (const s of await uzumShops(env, a.id).catch(() => [])) if (!all.some((x) => x.id === s.id)) all.push({ id: s.id, name: s.name, acc: a.id });
    }
    // Xodim ko'rinishida — mahsulot kartochkasi yo'q do'konlar ko'rsatilmaydi
    const has = await Promise.all(all.map((s) => shopHasProducts(env, s)));
    const vis = all.filter((_, i) => has[i]);
    const hid = new Set<number>(JSON.parse((await env.STATE.get(`hidshops:${uid}`)) ?? "[]"));
    shops.push(...(vis.length ? vis : all).filter((s) => !hid.has(s.id))); // hammasi tekshirilmasa (tarmoq xatosi) — barchasi
  } else if (client) {
    const svc = await CL.svcSettings(env);
    for (const s of client.shops) shops.push({ id: s.id, name: s.name, acc: svc.acc });
  }
  return { uid, user, staff, client, shops };
}

/** Botda ro'yxatdan o'tganmi: xodim, Uzum do'koni ulagan mijoz yoki Ozon/WB ulagan mijoz */
async function registered(env: Env, v: Viewer): Promise<boolean> {
  if (v.staff || v.shops.length) return true;
  const m = await CL.mpCreds(env, v.uid);
  return !!(m.oz || m.wb);
}
/** Do'konda kamida bitta mahsulot kartochkasi bormi (kesh: 6 soat; xato bo'lsa — 10 daqiqa) */
async function shopHasProducts(env: Env, s: Shop): Promise<boolean> {
  const key = `shopprod:${s.id}`;
  const c = await env.STATE.get(key);
  if (c !== null) return c === "1";
  let ok = false;
  let ttl = 6 * 3600;
  try {
    const r = await uzumGet<any>(env, s.acc, `/seller/shop/${s.id}/product/getProducts?page=0&size=1&filter=ALL`);
    ok = (r?.productList ?? []).length > 0 || Number(r?.totalProductsAmount ?? 0) > 0;
  } catch {
    ttl = 600;
  }
  await env.STATE.put(key, ok ? "1" : "0", { expirationTtl: ttl });
  return ok;
}
/** Mijozning FBS doirasi: xizmat hisobi + mijoz ID (KV kalitlari mijozga alohida bo'ladi) */
async function clientScope(env: Env, v: Viewer): Promise<string | null> {
  if (v.staff || !v.client?.shops.length) return null;
  const svc = await CL.svcSettings(env);
  return svc.acc ? `${svc.acc}|u${v.uid}` : null;
}
const canBook = (v: Viewer) => v.staff || CL.subActive(v.client);
const shopOf = (v: Viewer, id: number) => v.shops.find((s) => s.id === id);

/** Ozon/WB uchun muhit: xodim — botning o'z tokenlari, mijoz — o'zining tokenlari */
async function mpEnv(env: Env, v: Viewer): Promise<{ env: Env; oz: boolean; wb: boolean } | null> {
  if (v.staff) return { env, oz: ozonEnabled(env), wb: wbEnabled(env) };
  const m = await CL.mpCreds(env, v.uid);
  if (!m.oz && !m.wb) return null;
  const te = await CL.tenantEnv(env, v.uid, m);
  return { env: te, oz: !!m.oz, wb: !!m.wb };
}

/* ---------- Kuzatuvlar ---------- */

async function watchList(env: Env, v: Viewer) {
  const ids = new Map(v.shops.map((s) => [s.id, s.name]));
  const out: Json[] = [];
  const page = await env.STATE.list({ prefix: "uwatch:" });
  for (const k of page.keys) {
    const [, kind, shop, inv] = k.name.split(":");
    if (!ids.has(Number(shop))) continue;
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const w = JSON.parse(raw);
    const days: string[] = w.half === "m" ? w.days ?? [] : [w.ymd];
    out.push({
      id: `u:${kind}:${shop}:${inv}`,
      type: kind === "r" ? "ret" : "fbo",
      shop: ids.get(Number(shop)),
      title: `Nakladnoy № ${w.invNo}`,
      when: days.map((d) => ymdLabel(env, d)).join(", ") + (w.half === "a" ? " · ertalab" : w.half === "p" ? " · tushdan keyin" : ""),
      days,
      auto: !!w.auto,
      t: w.t,
    });
  }
  const scope = await clientScope(env, v);
  if (v.staff || scope) {
    const fp = await env.STATE.list({ prefix: "fbswatch:" });
    for (const k of fp.keys) {
      const raw = await env.STATE.get(k.name);
      if (!raw) continue;
      const w = JSON.parse(raw);
      if (v.staff ? String(w.acc).includes("|u") : w.acc !== scope) continue;
      const days = String(w.ymd ?? "").split("-").filter(Boolean);
      out.push({
        id: `f:${w.acc}`,
        type: "fbs",
        shop: "Uzum FBS",
        title: `${w.orderIds?.length ?? 0} ta buyurtma · ${w.label}`,
        when:
          (days.length ? days.map((d: string) => ymdLabel(env, d)).join(", ") : "istalgan kun") +
          (w.hours?.length ? " · " + [...w.hours].sort((a: number, b: number) => a - b).map((h: number) => `${String(h).padStart(2, "0")}:00`).join(", ") : ""),
        days,
        hours: w.hours ?? [],
        split: !!w.split,
        auto: !!w.auto,
        t: w.t,
      });
    }
  }
  return out.sort((a, b) => Number(b.t) - Number(a.t));
}

async function watchAct(env: Env, v: Viewer, id: string, act: "toggle" | "stop"): Promise<string> {
  const p = id.split(":");
  if (p[0] === "u") {
    const kind = p[1] as "f" | "r";
    const shop = Number(p[2]), inv = Number(p[3]);
    if (!shopOf(v, shop)) throw new Error("Bu kuzatuv sizga tegishli emas");
    if (act === "stop") await stopSearch(env, kind, shop, inv);
    else {
      if (!canBook(v)) throw new Error("Obuna tugagan");
      await toggleWatchAuto(env, kind, shop, inv);
    }
    return act === "stop" ? "Kuzatuv to'xtatildi" : "O'zgartirildi";
  }
  const scope = await clientScope(env, v);
  if (p[0] === "f" && (v.staff ? !p.slice(1).join(":").includes("|u") : p.slice(1).join(":") === scope)) {
    const acc = p.slice(1).join(":");
    if (!v.staff && act === "toggle" && !canBook(v)) throw new Error("Obuna tugagan");
    if (act === "stop") await fbsWatchStop(env, acc);
    else await fbsWatchToggle(env, acc);
    return act === "stop" ? "Kuzatuv to'xtatildi" : "O'zgartirildi";
  }
  throw new Error("Kuzatuv topilmadi");
}

/** ✏️ Kuzatuvni tahrirlash: kunlar, soatlar (FBS), avto/xabar */
async function watchEdit(env: Env, v: Viewer, id: string, body: any): Promise<string> {
  if (!canBook(v)) throw new Error("Obuna tugagan");
  const p = id.split(":");
  const days = (Array.isArray(body.days) ? body.days : []).map(String).filter((d: string) => /^\d{8}$/.test(d));
  if (!days.length) throw new Error("Kamida bitta kun tanlang");
  if (p[0] === "u") {
    const kind = p[1] as "f" | "r";
    const shop = Number(p[2]), inv = Number(p[3]);
    if (!shopOf(v, shop)) throw new Error("Bu kuzatuv sizga tegishli emas");
    const allowed = new Set(days7(env).map((d) => d.ymd));
    const ok = days.filter((d: string) => allowed.has(d));
    if (!ok.length) throw new Error("Kunlar yaqin 7 kun ichida bo'lsin");
    const old = await env.STATE.list({ prefix: `uwatch:${kind}:${shop}:${inv}:` });
    const chat = old.keys.length ? Number(JSON.parse((await env.STATE.get(old.keys[0].name)) ?? "{}").chatId ?? v.uid) : v.uid;
    await addDaysWatch(env, chat, kind, shop, inv, [...new Set<string>(ok)].sort(), [], !!body.auto);
    return "Kuzatuv yangilandi";
  }
  if (p[0] === "f") {
    const acc = p.slice(1).join(":");
    const scope = await clientScope(env, v);
    if (v.staff ? acc.includes("|u") : acc !== scope) throw new Error("Kuzatuv topilmadi");
    const key = `fbswatch:${acc}`;
    const raw = await env.STATE.get(key);
    if (!raw) throw new Error("Kuzatuv topilmadi");
    const w = JSON.parse(raw);
    const hs = (Array.isArray(body.hours) ? body.hours : []).map(Number).filter((h: number) => h >= 8 && h <= 15);
    w.ymd = days.sort().join("-");
    w.half = hs.length ? "h" : "x";
    if (hs.length) w.hours = hs;
    else delete w.hours;
    w.auto = !!body.auto;
    w.sig = "";
    await env.STATE.put(key, JSON.stringify(w), { expirationTtl: 3 * 86400 });
    return "Kuzatuv yangilandi";
  }
  throw new Error("Kuzatuv topilmadi");
}

/** 🔗 Ozon/WB ni ilovada ulash (mijoz) — botdagi tekshiruv bilan bir xil */
async function mpConnect(env: Env, v: Viewer, body: any): Promise<string> {
  if (v.staff) throw new Error("Xodim profili Ozon/WB ni sozlamalar orqali ishlatadi");
  const which = body.which === "wb" ? "wb" : "oz";
  if (body.remove) {
    await CL.mpRemove(env, v.uid, which === "oz" ? "o" : "w");
    ordCache.delete(v.uid);
    return which === "oz" ? "Ozon uzildi" : "WB uzildi";
  }
  const a = String(body.a ?? "").trim(), b = String(body.b ?? "").trim();
  if (which === "oz" && (!/^\d{3,12}$/.test(a) || b.length < 10)) throw new Error("Client-Id (raqam) va Api-Key ni to'g'ri kiriting");
  if (which === "wb" && a.length < 20) throw new Error("WB tokenini to'liq kiriting");
  await env.STATE.put(`clmpw:${v.uid}`, JSON.stringify(which === "oz" ? { step: "oz_key", pid: 0, id: a } : { step: "wb", pid: 0 }), { expirationTtl: 300 });
  const r = await CL.mpInput(env, v.uid, v.uid, which === "oz" ? b : a);
  const txt = plain(r?.sc.text ?? "");
  ordCache.delete(v.uid);
  if (!/ulandi!/.test(txt)) throw new Error(txt.split("\n")[0].replace(/^❌\s*/, "") || "Ulanmadi");
  return which === "oz" ? "Ozon ulandi" : "Wildberries ulandi";
}

/** 🛍 Do'kon haqida ma'lumot (Profil → do'kon) */
async function shopInfo(env: Env, v: Viewer, mp: string, id: number): Promise<Json> {
  const ord = await ordersFor(env, v).catch(() => ({ list: [] as Json[] }));
  const list = ((ord as any).list ?? []) as Json[];
  const tabs = (arr: Json[]) => ({
    new: arr.filter((o: any) => o.tab === "new").length,
    pack: arr.filter((o: any) => o.tab === "pack").length,
    sum: arr.filter((o: any) => o.tab !== "sent").reduce((a: number, o: any) => a + Number(o.price ?? 0), 0),
  });
  if (mp === "uzum") {
    const s = v.shops.find((x) => x.id === id);
    if (!s) throw new Error("Do'kon topilmadi");
    let products: number | null = null;
    try {
      const r = await uzumGet<any>(env, s.acc, `/seller/shop/${s.id}/product/getProducts?page=0&size=1&filter=ALL`);
      products = Number(r?.totalProductsAmount ?? (r?.productList ?? []).length);
    } catch {}
    const bk = await bookings(env, [id]);
    let watches = 0;
    for (const k of (await env.STATE.list({ prefix: "uwatch:" })).keys) if (Number(k.name.split(":")[2]) === id) watches++;
    const linked = v.client?.t ?? 0;
    return {
      ok: true, mp, id, name: s.name, products, watches,
      booked: bk.length, booked7: bk.filter((b) => b.t > Date.now() - 7 * DAY).length,
      last: bk.slice(0, 5).map((b) => ({ no: b.invNo, from: b.from, kind: b.kind, stock: b.stock, t: b.t })),
      fbs: tabs(list.filter((o: any) => o.mp === "uzum" && o.sid === id)),
      since: v.staff ? 0 : linked,
      canUnlink: true, staff: v.staff,
      url: `https://seller.uzum.uz/seller/${id}/products`,
    };
  }
  const m = mp === "ozon" ? "ozon" : "wb";
  const conn = v.staff ? (m === "ozon" ? ozonEnabled(env) : wbEnabled(env)) : !!(await CL.mpCreds(env, v.uid))[m === "ozon" ? "oz" : "wb"];
  if (!conn) throw new Error("Ulanmagan");
  return {
    ok: true, mp: m, name: m === "ozon" ? "Ozon" : "Wildberries",
    fbs: tabs(list.filter((o: any) => o.mp === m)),
    canUnlink: !v.staff, staff: v.staff,
    url: m === "ozon" ? "https://seller.ozon.ru/app/postings/fbs" : "https://seller.wildberries.ru/marketplace-orders",
  };
}
async function shopUnlink(env: Env, v: Viewer, mp: string, id: number): Promise<string> {
  ordCache.delete(v.uid);
  if (mp === "uzum") {
    if (v.staff) {
      const k = `hidshops:${v.uid}`;
      const hid: number[] = JSON.parse((await env.STATE.get(k)) ?? "[]");
      if (!hid.includes(id)) hid.push(id);
      await env.STATE.put(k, JSON.stringify(hid));
      viewCache.delete(v.uid);
      return "Do'kon ilovadan yashirildi";
    }
    const name = await CL.unlinkShop(env, v.uid, id);
    return `${name} uzildi`;
  }
  if (v.staff) throw new Error("Xodim profilida Ozon/WB sozlamalar orqali ulanadi");
  await CL.mpRemove(env, v.uid, mp === "ozon" ? "o" : "w");
  return mp === "ozon" ? "Ozon uzildi" : "Wildberries uzildi";
}

/** 📈 Statistika (Ozon/WB buyurtmalari): kunlar bo'yicha grafik uchun */
async function statsData(env: Env, v: Viewer, p: string): Promise<Json> {
  const me = await mpEnv(env, v);
  const bk = await bookings(env, v.shops.map((s) => s.id));
  const period = (["td", "yd", "7d", "30d"].includes(p) ? p : "7d") as PeriodKey;
  const r = periodRange(env, period);
  const out: Json = { ok: true, label: r.label, booked: bk.filter((b) => b.t >= r.from).length, mp: !!me };
  if (!me) return out;
  const s = await getStats(me.env, period);
  const live = s.orders.filter((o) => !o.x);
  const days: Record<string, { n: number; sum: number }> = {};
  for (let t = r.from; t <= r.to; t += DAY) days[loc(env, t + 3600e3).ymd] = { n: 0, sum: 0 };
  for (const o of live) {
    const k = loc(env, o.t).ymd;
    days[k] = days[k] ?? { n: 0, sum: 0 };
    days[k].n += o.qty || 1;
    if (o.cur === "UZS") days[k].sum += o.sum;
  }
  const topM = new Map<string, { qty: number; sum: number; mp: string }>();
  for (const o of live) {
    const e = topM.get(o.name) ?? { qty: 0, sum: 0, mp: o.mp };
    e.qty += o.qty || 1;
    if (o.cur === "UZS") e.sum += o.sum;
    topM.set(o.name, e);
  }
  return {
    ...out,
    orders: live.length,
    canceled: s.orders.length - live.length,
    returns: s.returns.length,
    sum: live.filter((o) => o.cur === "UZS").reduce((a, o) => a + o.sum, 0),
    byMp: { ozon: live.filter((o) => o.mp === "ozon").length, wb: live.filter((o) => o.mp === "wb").length },
    days: Object.entries(days).sort().map(([k, x]) => ({ ymd: k, label: ymdLabel(env, k), ...x })),
    top: [...topM.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 5).map(([name, x]) => ({ name, ...x })),
    errs: s.errs,
  };
}

/* ---------- Buyurtmalar ---------- */

type Tab = "new" | "pack" | "sent";
const UZ_ST: [string, Tab][] = [
  ["CREATED", "new"],
  ["PACKING", "pack"],
  ["PENDING_DELIVERY", "sent"],
];
const ordCache = new Map<number, { t: number; data: Json }>();
const noFbs = new Map<string, Set<number>>();

async function ordersFor(env: Env, v: Viewer, force = false): Promise<Json> {
  const c = ordCache.get(v.uid);
  if (!force && c && Date.now() - c.t < 20_000) return c.data;
  const list: Json[] = [];
  const errors: string[] = [];
  const qs = (o: Record<string, string | number>) => Object.entries(o).map(([a, b]) => `${a}=${encodeURIComponent(String(b))}`).join("&");
  // 🟪 Uzum FBS
  const byAcc = new Map<string, Shop[]>();
  for (const s of v.shops) if (s.acc) byAcc.set(s.acc, [...(byAcc.get(s.acc) ?? []), s]);
  for (const [acc, shops] of byAcc) {
    const names = new Map(shops.map((s) => [s.id, s.name]));
    // Profil ko'radigan, lekin FBS huquqi yo'q do'konlar (403 «Has no access to shops») — chetlab o'tamiz
    const denied = noFbs.get(acc) ?? new Set<number>();
    let ids = shops.map((s) => s.id).filter((x) => !denied.has(x));
    for (const [st, tab] of UZ_ST) {
      for (let page = 0; page < 3 && ids.length; page++) {
        let r: any;
        try {
          r = await uzumGet<any>(env, acc, `/seller/fbs/v2/orders?${qs({ page, size: 20, sortBy: "CREATED_DATE", sortOrder: "DESC", scheme: "FBS", statuses: st, shopIds: ids.join(","), places: "STOCK,DROP_OFF" })}`);
        } catch (e) {
          const msg = (e as Error).message;
          const m = msg.match(/no access to shops:?\s*\[([\d,\s]+)\]/i);
          if (m) {
            for (const x of m[1].split(",").map((y) => Number(y.trim())).filter(Boolean)) denied.add(x);
            noFbs.set(acc, denied);
            const before = ids.length;
            ids = ids.filter((x) => !denied.has(x));
            if (ids.length < before) {
              page--; // qolgan do'konlar bilan qayta
              continue;
            }
          }
          errors.push(`Uzum: ${msg.slice(0, 100)}`);
          break;
        }
        const orders: any[] = r?.orders ?? [];
        for (const o of orders) {
          list.push({
            mp: "uzum",
            id: String(o.id),
            sid: Number(o.shopId),
            shop: names.get(o.shopId) ?? String(o.shopId),
            items: (o.orderItems ?? []).slice(0, 5).map((it: any) => ({ name: skuLine(it), qty: Number(it.amount ?? 1), barcode: it.barcode ? String(it.barcode) : "" })),
            price: Number(o.price ?? 0),
            cur: "so'm",
            deadline: o.deliverUntil ? Number(o.deliverUntil) : null,
            tab,
            acts: tab === "new" ? ["confirm"] : tab === "pack" ? ["label"] : [],
          });
        }
        if (orders.length < 20) break;
      }
    }
  }
  // 🟦 Ozon / 🟪 WB
  const me = await mpEnv(env, v);
  if (me && (me.oz || me.wb)) {
    const r = await pendingOrders(me.env).catch((e) => ({ all: [] as Order[], errs: [String((e as Error).message)], oz: null, wb: null }));
    errors.push(...r.errs);
    for (const o of r.all) {
      const tab: Tab = o.canShip ? "new" : o.status === "handed" ? "sent" : "pack";
      list.push({
        mp: o.mp,
        id: o.id,
        shop: o.mp === "ozon" ? "Ozon" : "Wildberries",
        items: o.items.slice(0, 5).map((i) => ({ name: i.name, qty: i.qty })),
        price: o.price,
        cur: o.currency === "UZS" ? "so'm" : o.currency,
        deadline: o.deadline ? new Date(o.deadline).getTime() : null,
        tab,
        supply: o.supply,
        acts: tab === "new" ? ["ship"] : tab === "pack" ? (o.mp === "wb" && o.supply) || (o.mp === "ozon" && o.readyToHandover) ? ["label", "send"] : ["label"] : [],
      });
    }
  }
  list.sort((a, b) => Number(a.deadline ?? 9e15) - Number(b.deadline ?? 9e15));
  const data = { list, errors, mp: { uzum: byAcc.size > 0, ozon: !!me?.oz, wb: !!me?.wb } };
  ordCache.set(v.uid, { t: Date.now(), data });
  return data;
}

async function orderAct(env: Env, v: Viewer, mp: string, id: string, act: string): Promise<string> {
  if (!canBook(v)) throw new Error("Obuna tugagan");
  const data: any = await ordersFor(env, v);
  const o = (data.list as any[]).find((x) => x.mp === mp && x.id === id);
  if (!o) throw new Error("Buyurtma topilmadi yoki holati o'zgargan");
  if (!o.acts.includes(act)) throw new Error("Bu amal hozir mumkin emas");
  if (mp === "uzum") {
    const acc = shopOf(v, Number(o.sid))?.acc;
    if (!acc) throw new Error("Profil topilmadi");
    if (act === "confirm") {
      await uzumFbsConfirm(env, acc, Number(id));
      return "Yig'ishga o'tkazildi";
    }
    return plain(await sendFbsLabels(env, v.uid, acc, "ord", Number(id))) + " — chatga qarang";
  }
  const me = await mpEnv(env, v);
  if (!me) throw new Error("Ozon/WB ulanmagan");
  if (act === "send") {
    ordCache.delete(v.uid);
    if (mp === "ozon") return plain(await bulkHandover(me.env, v.uid, "ozon"));
    const ids = (data.list as any[]).filter((x) => x.mp === "wb" && x.supply === o.supply).map((x) => String(x.id));
    return plain(await wbHandoverSupply(me.env, v.uid, String(o.supply), ids));
  }
  const r = await doAction(me.env, v.uid, mp as "ozon" | "wb", id, act === "ship" ? "ship" : "label");
  return plain(r) + (act === "label" ? " — chatga qarang" : "");
}

/* ---------- 🛡 Admin panel (faqat egasi) ---------- */

async function isOwner(env: Env, v: Viewer) {
  return v.staff && Number(await getOwner(env)) === v.uid;
}

async function adminData(env: Env): Promise<Json> {
  const clients = await CL.listClientsAll(env);
  const svc = await CL.svcSettings(env);
  const now = Date.now();
  const uw = (await env.STATE.list({ prefix: "uwatch:" })).keys.map((k) => Number(k.name.split(":")[2]));
  const fw = (await env.STATE.list({ prefix: "fbswatch:" })).keys.length;
  let book7 = 0, bookAll = 0;
  const rows: Json[] = [];
  for (const c of clients) {
    const ids = c.shops.map((x) => x.id);
    const bk = await bookings(env, ids);
    bookAll += bk.length;
    const b7 = bk.filter((b) => now - b.t < 7 * DAY).length;
    book7 += b7;
    const m = await CL.mpCreds(env, c.uid);
    const end = c.sub;
    rows.push({
      uid: c.uid,
      name: c.name,
      shops: c.shops.map((x) => x.name),
      sub: c.sub,
      end,
      active: CL.subActive(c),
      trial: CL.inTrial(c),
      oz: !!m.oz,
      wb: !!m.wb,
      watches: uw.filter((x) => ids.includes(x)).length,
      booked: bk.length,
      booked7: b7,
      t: c.t,
    });
  }
  const active = rows.filter((r) => r.active).length;
  return {
    ok: true,
    free: false,
    trialDays: 7,
    svc: { phone: svc.phone, price: svc.price, contact: svc.contact, acc: !!svc.acc },
    card: await cardInfo(env),
    receipts: await receiptsFor(env),
    totals: {
      clients: rows.length,
      active,
      withShops: rows.filter((r) => (r.shops as string[]).length).length,
      trial: rows.filter((r) => r.trial).length,
      paid: rows.filter((r) => r.active && !r.trial).length,
      expiring: rows.filter((r) => Number(r.end) > now && Number(r.end) - now < 7 * DAY).length,
      new7: rows.filter((r) => now - Number(r.t) < 7 * DAY).length,
      watchesFbo: uw.length,
      watchesFbs: fw,
      book7,
      bookAll,
    },
    clients: rows,
  };
}

async function adminAct(env: Env, body: any): Promise<string> {
  const uid = Number(body.uid);
  if (!uid || !(await CL.getClient(env, uid))) throw new Error("Mijoz topilmadi");
  if (body.act === "add") {
    const days = Math.max(1, Math.min(366, Number(body.days) || 30));
    await CL.extendSub(env, uid, days);
    return `+${days} kun qo'shildi`;
  }
  if (body.act === "stop") {
    await CL.stopSub(env, uid);
    return "Obuna to'xtatildi";
  }
  throw new Error("Noma'lum amal");
}

/* ---------- 🏷 Yorliq: ilovada ko'rish va yuklab olish ---------- */

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Yorliqni olib, 10 daqiqalik maxfiy havola yaratadi (Telegram yuklab olishi uchun sarlavhasiz ochiladi) */
async function labelLink(env: Env, v: Viewer, mp: string, id: string): Promise<Json> {
  const data: any = await ordersFor(env, v);
  const o = (data.list as any[]).find((x) => x.mp === mp && x.id === id);
  if (!o) throw new Error("Buyurtma topilmadi");
  if (!o.acts.includes("label")) throw new Error("Yorliq hali tayyor emas — avval yig'ishga o'tkazing");
  let bytes: Uint8Array, mime: string, name: string;
  if (mp === "uzum") {
    const acc = shopOf(v, Number(o.sid))?.acc;
    if (!acc) throw new Error("Profil topilmadi");
    bytes = await uzumFbsLabel(env, acc, Number(id));
    mime = "application/pdf";
    name = `yorliq-${id}.pdf`;
  } else {
    const me = await mpEnv(env, v);
    if (!me) throw new Error("Ozon/WB ulanmagan");
    const l = await makeLabel(me.env, { mp: mp as "ozon" | "wb", id, items: [], status: "", price: 0, currency: "", city: "", createdAt: "", canShip: false });
    bytes = l.data instanceof Uint8Array ? l.data : new Uint8Array(l.data);
    mime = l.mime;
    name = `yorliq-${id}.${mime === "image/png" ? "png" : "pdf"}`;
  }
  if (!bytes.length) throw new Error("Yorliq bo'sh keldi");
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  await env.STATE.put(`lbl:${token}`, JSON.stringify({ mime, name, data: b64(bytes) }), { expirationTtl: 600 });
  return { ok: true, url: `/lbl/${token}`, name, mime };
}

async function serveLabel(env: Env, token: string, download: boolean): Promise<Response> {
  if (!/^[0-9a-f]{32}$/.test(token)) return new Response("Topilmadi", { status: 404 });
  const raw = await env.STATE.get(`lbl:${token}`);
  if (!raw) return new Response("Havola eskirgan — ilovada yorliqni qayta oching", { status: 404 });
  const l = JSON.parse(raw);
  const bytes = Uint8Array.from(atob(l.data), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "content-type": l.mime,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${l.name}"`,
      "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff",
    },
  });
}

/* ---------- 🚚 FBS ta'minlash (xodimlar) ---------- */

async function fbsApi(env: Env, v: Viewer, op: string, q: URLSearchParams, body: any): Promise<Json> {
  let accs: { id: string; label: string }[];
  if (v.staff) accs = await uzumAccounts(env);
  else {
    const scope = await clientScope(env, v);
    if (!scope) throw new Error("Avval Uzum do'koningizni ulang");
    if (!canBook(v) && op !== "") throw new Error("Obuna tugagan — uzaytiring");
    accs = [{ id: scope, label: "Uzum" }];
  }
  const accId = String(q.get("acc") ?? body.acc ?? "");
  if (op === "" && !accId) return { ok: true, accounts: accs.map((a) => ({ id: a.id, label: a.label })), days: fbsWebDays() };
  if (!accs.some((a) => a.id === accId)) throw new Error("Profil topilmadi");
  if (op === "") return { ok: true, ...(await fbsWebState(env, accId)) };
  if (op === "/points") return { ok: true, ...(await fbsWebPoints(env, accId, Array.isArray(body.sel) ? body.sel : [])) };
  if (op === "/slots") return { ok: true, ...(await fbsWebSlots(env, accId, Number(q.get("p")))) };
  if (op === "/create") {
    const r = await fbsWebCreate(env, accId, Number(body.p), Number(body.s));
    ordCache.delete(v.uid);
    return { ok: r.ok, msg: r.msg, error: r.ok ? undefined : r.msg };
  }
  if (op === "/split") return { ok: true, ...(await fbsWebSplitPlan(env, accId, Array.isArray(body.pts) ? body.pts : [], Number(body.parts) || 3, Number(body.minPart) || 2)) };
  if (op === "/split/create") {
    const r = await fbsWebSplitCreate(env, v.uid, accId);
    ordCache.delete(v.uid);
    return { ok: r.created > 0, ...r, msg: `${r.created} ta ta'minlash yaratildi` + (r.left ? ` · ${r.left} ta buyurtma qoldi` : ""), error: r.created ? undefined : r.failed[0] ?? "Yaratilmadi" };
  }
  if (op === "/watch") {
    const r = await fbsWebWatch(env, v.uid, accId, body.pts ?? [], body.days ?? [], body.hours ?? [], !!body.auto, String(body.label ?? ""), !!body.split, Number(body.parts) || 3, Number(body.minPart) || 2);
    return { ok: true, msg: r.msg };
  }
  throw new Error("Topilmadi");
}

/* ---------- Asosiy ---------- */

async function me(env: Env, v: Viewer): Promise<Json> {
  const svc = await CL.svcSettings(env);
  const ws = await watchList(env, v);
  const bk = await bookings(env, v.shops.map((s) => s.id));
  const m = v.staff ? { oz: ozonEnabled(env), wb: wbEnabled(env) } : await CL.mpCreds(env, v.uid).then((x) => ({ oz: !!x.oz, wb: !!x.wb }));
  const c = v.client;
  // Ilova faqat botda ro'yxatdan o'tganlarga (do'kon yoki Ozon/WB ulangan)
  if (!(await registered(env, v))) {
    const sv = await CL.svcSettings(env);
    return { ok: true, needReg: true, lang: await getLang(env, v.uid), name: v.user.first_name ?? "", staff: false, shops: [], mp: { oz: false, wb: false }, svcPhone: sv.phone, sub: { price: sv.price, contact: sv.contact } };
  }
  const phone = await env.STATE.get(`phone:${v.uid}`);
  return {
    ok: true,
    name: v.user.first_name ?? "",
    fullName: [v.user.first_name, v.user.last_name].filter(Boolean).join(" "),
    username: v.user.username ?? "",
    phone: phone ? fmtPhone(phone) : "",
    staff: v.staff,
    owner: await isOwner(env, v),
    shops: v.shops.map((s) => ({ id: s.id, name: s.name })),
    sub: v.staff
      ? { staff: true }
      : { card: await cardInfo(env), opts: (await priceUzs(env)) ? await payOptions(env) : [], receipts: (await receiptsFor(env, v.uid)).map((r) => ({ id: r.id, sum: r.sum, months: r.months, t: r.t, status: r.status })), free: false, trial: CL.inTrial(c), until: c?.sub ?? 0, active: CL.subActive(c), price: svc.price, contact: svc.contact, pay: (await payReady(env)) ? await payOptions(env) : null },
    svcPhone: svc.phone,
    lang: await getLang(env, v.uid),
    hidden: v.staff ? JSON.parse((await env.STATE.get(`hidshops:${v.uid}`)) ?? "[]").length : 0,
    mp: m,
    watching: ws.length,
    booked: bk.length,
    recent: bk.slice(0, 10).map((b) => ({
      shop: v.shops.find((s) => s.id === b.shopId)?.name ?? "",
      invNo: b.invNo,
      when: `${loc(env, b.from).label}, ${loc(env, b.from).hm}–${loc(env, b.to).hm}`,
      stock: b.stock,
      auto: b.auto,
      t: b.t,
    })),
  };
}

function days7(env: Env) {
  const t = loc(env, Date.now());
  const start = ymdStart(env, t.ymd);
  return Array.from({ length: 7 }, (_, k) => {
    const l = loc(env, start + k * DAY + 3600e3);
    return { ymd: l.ymd, day: l.day, wd: k === 0 ? "Bugun" : k === 1 ? "Ertaga" : l.wd, label: l.label };
  });
}

async function invoices(env: Env, v: Viewer, shop: number, kind: "f" | "r" = "f"): Promise<Json> {
  if (!shopOf(v, shop)) throw new Error("Do'kon topilmadi");
  const list = await uzumInvoices(env, kind, shop);
  const out = [];
  for (const i of list) {
    const w = await env.STATE.list({ prefix: `uwatch:${kind}:${shop}:${i.id}:` });
    out.push({
      id: i.id,
      number: i.number,
      qty: i.qty,
      price: i.price,
      stock: i.stock,
      status: i.statusText,
      slot: i.slot ? `${loc(env, i.slot.from).label}, ${loc(env, i.slot.from).hm}–${loc(env, i.slot.to).hm}` : "",
      locked: !!(i.slot && i.updatesLeft === 0),
      updatesLeft: i.updatesLeft ?? null,
      watching: w.keys.length > 0,
      type: i.type ?? "",
      freeUntil: i.freeUntil ?? null,
    });
  }
  return { ok: true, list: out, days: days7(env) };
}

async function slots(env: Env, v: Viewer, shop: number, invId: number, kind: "f" | "r" = "f"): Promise<Json> {
  if (!shopOf(v, shop)) throw new Error("Do'kon topilmadi");
  const inv = await uzumInvoice(env, kind, shop, invId);
  if (!inv) throw new Error("Nakladnoy topilmadi");
  const s = await uzumSlots(env, shop, inv);
  return {
    ok: true,
    slots: s.slice(0, 40).map((x) => ({ from: x.from, to: x.to, ymd: loc(env, x.from).ymd, text: `${loc(env, x.from).label}, ${loc(env, x.from).hm}–${loc(env, x.to).hm}` })),
  };
}

/** Murakkab bo'limlarni bot chatida ochish (Ozon/WB ulash, FBS topshirish joyi, obuna to'lovi) */
async function openInChat(env: Env, v: Viewer, s: string): Promise<string> {
  let sc: { text: string; reply_markup: unknown } | null = null;
  if (s === "mp" && !v.staff) sc = await CL.mpScreen(env, v.uid);
  else if (s === "con") sc = await CL.connectScreen(env, v.uid, null);
  else if (s === "paid" && !v.staff) sc = await CL.paidNotice(env, v.uid);
  else if (s === "sub" && !v.staff) sc = await CL.subScreen(env, v.uid);
  else if (s === "fbs" && v.staff) sc = await fbsRoot(env);
  if (!sc) throw new Error("Bu bo'lim mavjud emas");
  await sendText(env, v.uid, sc.text, { reply_markup: sc.reply_markup });
  return "Bot chatiga yuborildi";
}

/* ---------- Kirish nuqtasi ---------- */

export function isWebPath(path: string) {
  return path === "/app" || path === "/app/" || path.startsWith("/api/") || path.startsWith("/lbl/");
}

export async function handleWeb(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/app" || url.pathname === "/app/") {
    return new Response(APP_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  }
  // 🏷 Yorliq fayli — maxfiy 10 daqiqalik havola (Telegram downloadFile sarlavha yubormaydi)
  if (url.pathname.startsWith("/lbl/")) return serveLabel(env, url.pathname.slice(5), url.searchParams.get("dl") === "1");
  let user = await verifyInitData(env, req.headers.get("x-init-data") ?? "");
  // 🧪 Faqat kompyuterdagi sinov: konsolda chiqqan maxfiy kalit bilan brauzerda ochish (bulutda bu kalit yo'q)
  const devKey = (env as any).MINIAPP_DEV_KEY as string | undefined;
  if (!user && devKey && req.headers.get("x-dev-key") === devKey) {
    const id = Number(req.headers.get("x-dev-uid")) || (await getOwner(env));
    if (id) {
      const un = (await env.STATE.get(`uname:${id}`)) ?? "Sinov";
      const m = un.match(/^(.*?)(?: \(@([^)]+)\))?$/);
      user = { id, first_name: (m?.[1] || "Sinov").trim(), username: m?.[2] };
    }
  }
  if (!user) return fail("Ilovani Telegram ichidan oching", 401);
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const q = url.searchParams;
  try {
    const v = await viewer(env, user);
    if (!["/api/me", "/api/open", "/api/shop/link", "/api/mp", "/api/lang"].includes(url.pathname) && !(await registered(env, v))) return fail("Avval botda ro'yxatdan o'ting", 403);
    if (url.pathname === "/api/open" && body.s !== "con" && !(await registered(env, v))) return fail("Avval botda ro'yxatdan o'ting", 403);
    switch (url.pathname) {
      case "/api/me":
        return json(await me(env, v));
      case "/api/watches":
        return json({ ok: true, list: await watchList(env, v) });
      case "/api/watch/toggle":
      case "/api/watch/stop":
        return json({ ok: true, msg: await watchAct(env, v, String(body.id ?? ""), url.pathname.endsWith("stop") ? "stop" : "toggle") });
      case "/api/invoices":
        return json(await invoices(env, v, Number(q.get("shop")), q.get("kind") === "r" ? "r" : "f"));
      case "/api/slots":
        return json(await slots(env, v, Number(q.get("shop")), Number(q.get("inv")), q.get("kind") === "r" ? "r" : "f"));
      case "/api/watch/add": {
        const shop = Number(body.shop), inv = Number(body.inv);
        if (!shopOf(v, shop)) throw new Error("Do'kon topilmadi");
        if (!canBook(v)) throw new Error("Obuna tugagan — uzaytiring");
        const allowed = new Set(days7(env).map((d) => d.ymd));
        const days = (Array.isArray(body.days) ? body.days : []).map(String).filter((d: string) => allowed.has(d));
        if (!days.length) throw new Error("Kamida bitta kun tanlang");
        await addDaysWatch(env, v.uid, body.kind === "r" ? "r" : "f", shop, inv, [...new Set<string>(days)].sort(), [], !!body.auto);
        return json({ ok: true, msg: body.auto ? "Avtomatik bron yoqildi" : "Kuzatuv yoqildi" });
      }
      case "/api/book": {
        const shop = Number(body.shop);
        if (!shopOf(v, shop)) throw new Error("Do'kon topilmadi");
        if (!canBook(v)) throw new Error("Obuna tugagan — uzaytiring");
        const sc = await reserve(env, body.kind === "r" ? "r" : "f", shop, Number(body.inv), Number(body.from), Number(body.to));
        const ok = /Band qilindi|qabul qildi/.test(sc.text);
        return json({ ok, msg: plain(sc.text), error: ok ? undefined : plain(sc.text) });
      }
      case "/api/orders":
        return json({ ok: true, ...(await ordersFor(env, v, q.get("force") === "1")) });
      case "/api/label":
        return json(await labelLink(env, v, String(body.mp), String(body.id)));
      case "/api/order":
        return json({ ok: true, msg: await orderAct(env, v, String(body.mp), String(body.id), String(body.act)) });
      case "/api/fbs":
      case "/api/fbs/points":
      case "/api/fbs/slots":
      case "/api/fbs/create":
      case "/api/fbs/watch":
      case "/api/fbs/split":
      case "/api/fbs/split/create":
        return json(await fbsApi(env, v, url.pathname.slice(8), q, body));
      case "/api/admin":
        if (!(await isOwner(env, v))) return fail("Faqat admin uchun", 403);
        return json(await adminData(env));
      case "/api/admin/svc":
        if (!(await isOwner(env, v))) return fail("Faqat admin uchun", 403);
        for (const f of ["price", "phone", "contact"]) if (typeof body[f] === "string") await CL.saveSetting(env, f, body[f]);
        return json({ ok: true, msg: "Sozlamalar saqlandi" });
      case "/api/admin/card":
        if (!(await isOwner(env, v))) return fail("Faqat admin uchun", 403);
        await setCard(env, String(body.card ?? ""), String(body.name ?? ""));
        return json({ ok: true, msg: "Karta saqlandi" });
      case "/api/admin/receipt":
        if (!(await isOwner(env, v))) return fail("Faqat admin uchun", 403);
        if (body.decide) return json({ ok: true, msg: await decideReceipt(env, v.uid, String(body.id), body.decide === "ok", String(body.note ?? "")) });
        return json({ ok: true, img: await receiptImage(env, String(body.id)) });
      case "/api/receipt":
        return json({ ok: true, msg: "Chek yuborildi — admin tasdiqlagach obuna uzayadi", r: await submitReceipt(env, v.uid, Number(body.months) || 1, String(body.img ?? "")) });
      case "/api/admin/act":
        if (!(await isOwner(env, v))) return fail("Faqat admin uchun", 403);
        return json({ ok: true, msg: await adminAct(env, body) });
      case "/api/ntf":
        return json({ ok: true, list: await notifications(env, v.uid) });
      case "/api/pay":
        return json({ ok: true, link: await createPayLink(env, v.uid, String(body.pack ?? "1")) });
      case "/api/watch/edit":
        return json({ ok: true, msg: await watchEdit(env, v, String(body.id ?? ""), body) });
      case "/api/lang":
        return json({ ok: true, lang: await setLang(env, v.uid, String(body.lang ?? "uz")) });
      case "/api/shop":
        return json(await shopInfo(env, v, String(q.get("mp") ?? "uzum"), Number(q.get("id") ?? 0)));
      case "/api/shop/unlink":
        return json({ ok: true, msg: await shopUnlink(env, v, String(body.mp ?? ""), Number(body.id ?? 0)) });
      case "/api/shop/unhide":
        await env.STATE.delete(`hidshops:${v.uid}`);
        viewCache.delete(v.uid);
        return json({ ok: true, msg: "Barcha do'konlar qayta ko'rsatildi" });
      case "/api/shop/link": {
        if (v.staff) return fail("Xodim do'konlari xizmat hisobidan olinadi", 400);
        const id = String(body.id ?? "").replace(/\D/g, "");
        if (!/^\d{3,9}$/.test(id)) return fail("Do'kon ID — faqat raqam (masalan 123456)", 400);
        const sc = await CL.linkShop(env, v.user, id);
        const txt = plain(sc.text ?? "");
        ordCache.delete(v.uid);
        if (!/ulandi!/.test(txt)) return fail(txt.split("\n\nTekshiring")[0].replace(/^[❌🚫⏳❓]\s*/u, "").trim() || "Ulanmadi", 400);
        return json({ ok: true, msg: txt.split("\n")[0].replace(/^✅\s*/u, "") });
      }
      case "/api/mp":
        return json({ ok: true, msg: await mpConnect(env, v, body) });
      case "/api/stats":
        return json(await statsData(env, v, String(q.get("p") ?? "7d")));
      case "/api/phone":
        // Keyingi ulashilgan kontakt — Profil uchun (xodim so'roviga aylanmasin)
        await env.STATE.put(`appphone:${v.uid}`, "1", { expirationTtl: 300 });
        return json({ ok: true });
      case "/api/open":
        return json({ ok: true, msg: await openInChat(env, v, String(body.s ?? "")) });
    }
    return fail("Topilmadi", 404);
  } catch (e) {
    return fail((e as Error).message.slice(0, 200));
  }
}

/** Telegram'da «📱 Ilova» menyu tugmasini o'rnatish va manzilni eslab qolish */
export async function setMiniAppUrl(env: Env, url: string) {
  await env.STATE.put("app:url", url);
  await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Ilova", web_app: { url } } });
}
export const miniAppUrl = (env: Env) => env.STATE.get("app:url");
