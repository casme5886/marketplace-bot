/**
 * Statistika: bugun / kecha / 7 kun / 30 kun bo'yicha buyurtmalar, sotuvlar, qaytarishlar,
 * top mahsulotlar va shaharlar. Ozon (Seller API) + Wildberries (Statistika API).
 */
import type { Env, Marketplace } from "./types";
import { escapeHtml } from "./telegram";
import { fmtTime, MP_ICON, MP_NAME, tzOffset } from "./format";
import { ozonEnabled, ozonMoney, ozonPostingsRange, ozonReturns, ozonStatusUz } from "./ozon";
import { wbEnabled } from "./wb";

/* ---------- Ma'lumot turlari ---------- */

/** Bitta buyurtma (statistika uchun ixcham) */
export interface SaleRec {
  mp: Marketplace;
  id: string;
  t: number; // vaqt (ms)
  name: string;
  qty: number;
  sum: number;
  cur: string;
  city: string;
  st: string; // holat (o'zbekcha)
  x?: 1; // bekor qilingan
  d?: 1; // yetkazilgan / sotib olingan
}

/** Qaytarish yoki WB sotib olish yozuvi */
export interface MoveRec {
  mp: Marketplace;
  id: string;
  t: number;
  name: string;
  sum: number;
  cur: string;
  city: string;
  why?: string;
}

export type PeriodKey = "td" | "yd" | "7d" | "30d";
export const PERIODS: PeriodKey[] = ["td", "yd", "7d", "30d"];
const PERIOD_NAME: Record<PeriodKey, string> = { td: "Bugun", yd: "Kecha", "7d": "7 kun", "30d": "30 kun" };

const DAY = 864e5;

/** Mahalliy (Toshkent) kun boshlanishi */
function dayStart(env: Env, ms = Date.now()): number {
  const off = tzOffset(env) * 3600e3;
  return Math.floor((ms + off) / DAY) * DAY - off;
}

export function periodRange(env: Env, p: PeriodKey): { from: number; to: number; label: string } {
  const now = Date.now();
  const d0 = dayStart(env, now);
  const day = (ms: number) => fmtTime(env, new Date(ms).toISOString()).split(" ")[0];
  switch (p) {
    case "yd":
      return { from: d0 - DAY, to: d0, label: `Kecha · ${day(d0 - DAY)}` };
    case "7d":
      return { from: d0 - 6 * DAY, to: now, label: `7 kun · ${day(d0 - 6 * DAY)}–${day(now)}` };
    case "30d":
      return { from: d0 - 29 * DAY, to: now, label: `30 kun · ${day(d0 - 29 * DAY)}–${day(now)}` };
    default:
      return { from: d0, to: now, label: `Bugun · ${day(now)}` };
  }
}

/* ---------- Kesh (marketpleys limitlari uchun) ---------- */

async function cached<T>(env: Env, key: string, ttlSec: number, force: boolean, fn: () => Promise<T>): Promise<{ data: T; stale?: string }> {
  const raw = await env.STATE.get(key);
  const c = raw ? (JSON.parse(raw) as { t: number; d: T }) : null;
  // WB statistikasi daqiqasiga 1 marta so'rovga ruxsat beradi — majburiy yangilashda ham 60 s kutamiz
  if (c && Date.now() - c.t < (force ? 60 : ttlSec) * 1000) return { data: c.d };
  try {
    const d = await fn();
    await env.STATE.put(key, JSON.stringify({ t: Date.now(), d }), { expirationTtl: 2 * 86400 });
    return { data: d };
  } catch (e) {
    if (c) return { data: c.d, stale: (e as Error).message };
    throw e;
  }
}

/* ---------- Ozon ---------- */

const cityOf = (a: any, p: any) => a?.city || a?.region || p?.delivery_method?.warehouse || "—";

async function ozonData(env: Env, from: number, force: boolean) {
  const key = `stat:oz:${new Date(from).toISOString().slice(0, 10)}`;
  return cached(env, key, 180, force, async () => {
    const to = new Date(Date.now() + 3600e3);
    const posts = await ozonPostingsRange(env, new Date(from), to);
    const sales: SaleRec[] = posts.map((p) => {
      const prods: any[] = p.products ?? [];
      const cur = (typeof prods[0]?.price === "object" && prods[0]?.price?.currency) || prods[0]?.currency_code || "UZS";
      const r: SaleRec = {
        mp: "ozon",
        id: String(p.posting_number),
        t: new Date(p.in_process_at ?? p.created_at ?? Date.now()).getTime(),
        name: prods.map((x) => x.name).join(", ") || "—",
        qty: prods.reduce((s, x) => s + Number(x.quantity ?? 1), 0),
        sum: prods.reduce((s, x) => s + ozonMoney(x.price) * Number(x.quantity ?? 1), 0),
        cur,
        city: cityOf(p.analytics_data, p),
        st: ozonStatusUz(p.status),
      };
      if (p.status === "cancelled") r.x = 1;
      if (p.status === "delivered") r.d = 1;
      return r;
    });
    let returns: MoveRec[] = [];
    let retErr = "";
    try {
      const rs = await ozonReturns(env, new Date(from), to);
      returns = rs.map((x) => ({
        mp: "ozon" as const,
        id: String(x.posting_number ?? x.id),
        t: new Date(x.logistic?.return_date ?? x.visual?.change_moment ?? Date.now()).getTime(),
        name: x.product?.name ?? "—",
        sum: Number(x.product?.price?.price ?? 0) * Number(x.product?.quantity ?? 1),
        cur: x.product?.price?.currency_code ?? "UZS",
        city: x.place?.name ?? "",
        why: x.return_reason_name ?? "",
      }));
    } catch (e) {
      retErr = "Ozon qaytarishlar: " + (e as Error).message.slice(0, 120);
    }
    return { sales, returns, retErr };
  });
}

/* ---------- Wildberries (statistics-api) ---------- */

const WB_STAT = "https://statistics-api.wildberries.ru";

/** WB statistikasi vaqtni Moskva vaqtida (UTC+3) beradi va qabul qiladi */
const toMsk = (ms: number) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 19);
const fromMsk = (s: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "+03:00").getTime();

async function wbStat(env: Env, path: string, from: number): Promise<any[]> {
  const res = await fetch(`${WB_STAT}${path}?dateFrom=${encodeURIComponent(toMsk(from))}&flag=0`, {
    headers: { Authorization: env.WB_API_TOKEN ?? "" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("WB tokenida \"Statistika\" huquqi yo'q");
  if (res.status === 429) throw new Error("WB statistika: juda tez-tez so'rov, 1 daqiqadan keyin yangilang");
  if (!res.ok) throw new Error(`WB statistika ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

const wbName = (x: any) => [x.subject, x.brand].filter(Boolean).join(" · ") + (x.supplierArticle ? ` (${x.supplierArticle})` : "") || `nmId ${x.nmId}`;
const wbCity = (x: any) => x.regionName || x.oblastOkrugName || x.warehouseName || "—";

async function wbData(env: Env, from: number, force: boolean) {
  const cur = env.WB_STATS_CURRENCY || "RUB";
  const day = new Date(from).toISOString().slice(0, 10);
  const orders = await cached(env, `stat:wbo:${day}`, 300, force, async () => {
    const rows = await wbStat(env, "/api/v1/supplier/orders", from);
    const seen = new Set<string>();
    const out: SaleRec[] = [];
    for (const x of rows) {
      const id = String(x.srid ?? x.gNumber ?? x.odid);
      if (seen.has(id)) continue; // flag=0 da bir buyurtma bir necha marta kelishi mumkin
      seen.add(id);
      const r: SaleRec = {
        mp: "wb",
        id,
        t: fromMsk(x.date),
        name: wbName(x),
        qty: 1,
        sum: Number(x.priceWithDisc ?? x.finishedPrice ?? x.totalPrice ?? 0),
        cur,
        city: wbCity(x),
        st: x.isCancel ? "Bekor qilindi" : "Buyurtma",
      };
      if (x.isCancel) r.x = 1;
      out.push(r);
    }
    return out;
  });
  const sales = await cached(env, `stat:wbs:${day}`, 300, force, async () => {
    const rows = await wbStat(env, "/api/v1/supplier/sales", from);
    const buy: MoveRec[] = [];
    const ret: MoveRec[] = [];
    const seen = new Set<string>();
    for (const x of rows) {
      const sid = String(x.saleID ?? "");
      if (seen.has(sid + x.srid)) continue;
      seen.add(sid + x.srid);
      const rec: MoveRec = {
        mp: "wb",
        id: String(x.srid ?? sid),
        t: fromMsk(x.date),
        name: wbName(x),
        sum: Math.abs(Number(x.priceWithDisc ?? x.finishedPrice ?? 0)),
        cur,
        city: wbCity(x),
      };
      if (sid.startsWith("R")) ret.push(rec);
      else buy.push(rec);
    }
    return { buy, ret };
  });
  return { orders, sales };
}

/* ---------- Umumiy yig'ish ---------- */

export interface Stats {
  orders: SaleRec[]; // davrdagi buyurtmalar (bekorlar ham)
  buyouts: MoveRec[]; // WB: mijoz sotib olgan
  returns: MoveRec[];
  errs: string[];
  label: string;
  updated: number;
}

/** 30 kunlik ma'lumotni olib (keshdan), kerakli davrga filtrlaydi */
export async function getStats(env: Env, p: PeriodKey, force = false): Promise<Stats> {
  const r = periodRange(env, p);
  const from30 = periodRange(env, "30d").from;
  const inP = (t: number) => t >= r.from && t < r.to + 60e3;
  const errs: string[] = [];
  const orders: SaleRec[] = [];
  const buyouts: MoveRec[] = [];
  const returns: MoveRec[] = [];

  const jobs: Promise<void>[] = [];
  if (ozonEnabled(env)) {
    jobs.push(
      ozonData(env, from30, force)
        .then(({ data, stale }) => {
          orders.push(...data.sales.filter((x) => inP(x.t)));
          returns.push(...data.returns.filter((x) => inP(x.t)));
          if (data.retErr) errs.push(data.retErr);
          if (stale) errs.push("Ozon (eski ma'lumot): " + stale.slice(0, 100));
        })
        .catch((e) => void errs.push("Ozon: " + (e as Error).message.slice(0, 150))),
    );
  }
  if (wbEnabled(env)) {
    jobs.push(
      wbData(env, from30, force)
        .then(({ orders: o, sales: s }) => {
          orders.push(...o.data.filter((x) => inP(x.t)));
          buyouts.push(...s.data.buy.filter((x) => inP(x.t)));
          returns.push(...s.data.ret.filter((x) => inP(x.t)));
          const st = o.stale ?? s.stale;
          if (st) errs.push("WB (eski ma'lumot): " + st.slice(0, 100));
        })
        .catch((e) => void errs.push("WB: " + (e as Error).message.slice(0, 150))),
    );
  }
  await Promise.all(jobs);
  orders.sort((a, b) => b.t - a.t);
  returns.sort((a, b) => b.t - a.t);
  return { orders, buyouts, returns, errs, label: r.label, updated: Date.now() };
}

/* ---------- Formatlash ---------- */

function money(sums: Record<string, number>): string {
  const parts = Object.entries(sums)
    .filter(([, v]) => v > 0)
    .map(([cur, v]) => {
      const s = Math.round(v).toLocaleString("ru-RU").replace(/\s/g, " ");
      return cur === "UZS" ? `${s} so'm` : cur === "RUB" ? `${s} ₽` : `${s} ${cur}`;
    });
  return parts.join(" + ") || "0";
}

function sumBy<T extends { sum: number; cur: string }>(list: T[]) {
  const out: Record<string, number> = {};
  for (const x of list) out[x.cur] = (out[x.cur] ?? 0) + x.sum;
  return out;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function top(list: { key: string; qty: number; sum: number; cur: string }[], n: number) {
  const m = new Map<string, { qty: number; sums: Record<string, number> }>();
  for (const x of list) {
    const e = m.get(x.key) ?? { qty: 0, sums: {} };
    e.qty += x.qty;
    e.sums[x.cur] = (e.sums[x.cur] ?? 0) + x.sum;
    m.set(x.key, e);
  }
  return [...m.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, n);
}

const shortCity = (c: string) => c.split(",")[0].trim() || "—";
const MEDAL = ["🥇", "🥈", "🥉"];
const rank = (i: number) => MEDAL[i] ?? `${i + 1}.`;

/** Bosh panel uchun ixcham bugungi natija */
export function todayLines(s: Stats): string[] {
  const live = s.orders.filter((o) => !o.x);
  const oz = live.filter((o) => o.mp === "ozon").length;
  const wb = live.filter((o) => o.mp === "wb").length;
  const cancel = s.orders.length - live.length;
  const lines = [
    "<b>📅 Bugun</b>",
    `🛒 Buyurtmalar: <b>${live.length}</b> ta  (🔵 ${oz} · 🟣 ${wb})`,
    `💰 ${money(sumBy(live))}`,
  ];
  const extra: string[] = [];
  if (s.buyouts.length) extra.push(`✅ Sotib olindi: ${s.buyouts.length}`);
  extra.push(`↩️ Qaytarish: ${s.returns.length}`);
  if (cancel) extra.push(`❌ Bekor: ${cancel}`);
  lines.push(extra.join(" · "));
  return lines;
}

/* ---------- Ekranlar ---------- */

type Btn = { text: string; callback_data: string };
export interface StatScreen {
  text: string;
  reply_markup: { inline_keyboard: Btn[][] };
}

/** Davr tugmalari: tanlangani • bilan belgilanadi */
function periodRow(prefix: string, cur: PeriodKey): Btn[] {
  return PERIODS.map((p) => ({ text: p === cur ? `• ${PERIOD_NAME[p]} •` : PERIOD_NAME[p], callback_data: `${prefix}:${p}` }));
}

function errLines(errs: string[]): string {
  return errs.length ? "\n\n⚠️ " + errs.map((e) => escapeHtml(e)).join("\n⚠️ ") : "";
}

/** 📈 Statistika — umumiy ko'rinish */
export function statsScreen(env: Env, p: PeriodKey, s: Stats): StatScreen {
  const L: string[] = [`<b>📈 Statistika</b> · ${s.label}`];
  for (const mp of ["ozon", "wb"] as Marketplace[]) {
    const all = s.orders.filter((o) => o.mp === mp);
    if (mp === "ozon" && !ozonEnabled(env)) continue;
    if (mp === "wb" && !wbEnabled(env)) continue;
    const live = all.filter((o) => !o.x);
    const ret = s.returns.filter((o) => o.mp === mp);
    L.push("", `${MP_ICON[mp]} <b>${MP_NAME[mp]}</b>`);
    L.push(`🛒 Buyurtma: <b>${live.length}</b> ta · ${money(sumBy(live))}`);
    const ex: string[] = [];
    if (mp === "wb") {
      const b = s.buyouts.filter((o) => o.mp === mp);
      ex.push(`✅ Sotib olindi: ${b.length}` + (b.length ? ` (${money(sumBy(b))})` : ""));
    } else {
      const d = all.filter((o) => o.d).length;
      if (d) ex.push(`✅ Yetkazildi: ${d}`);
    }
    ex.push(`↩️ Qaytarish: ${ret.length}`);
    ex.push(`❌ Bekor: ${all.length - live.length}`);
    L.push(ex.join(" · "));
  }

  const live = s.orders.filter((o) => !o.x);
  if (live.length) {
    const avg = sumBy(live);
    for (const k of Object.keys(avg)) avg[k] = avg[k] / Math.max(1, live.filter((o) => o.cur === k).length);
    L.push("", `<b>Jami:</b> ${live.length} ta · ${money(sumBy(live))}`, `🧾 O'rtacha chek: ${money(avg)}`);
    const tp = top(live.map((o) => ({ key: o.name, qty: o.qty, sum: o.sum, cur: o.cur })), 3);
    L.push("", "<b>🏆 Top mahsulotlar</b>");
    tp.forEach(([k, v], i) => L.push(`${rank(i)} ${escapeHtml(cut(k, 40))} — <b>${v.qty}</b> dona`));
    const tc = top(live.map((o) => ({ key: shortCity(o.city), qty: 1, sum: o.sum, cur: o.cur })), 3);
    L.push("", "<b>🗺 Top shaharlar</b>");
    tc.forEach(([k, v], i) => L.push(`${rank(i)} ${escapeHtml(cut(k, 40))} — <b>${v.qty}</b> ta`));
  } else {
    L.push("", "🤷 Bu davrda buyurtma yo'q.");
  }
  L.push("", `<i>🔄 ${fmtTime(env, new Date(s.updated).toISOString())}</i>`);

  return {
    text: L.join("\n") + errLines(s.errs),
    reply_markup: {
      inline_keyboard: [
        periodRow("s", p),
        [
          { text: `🛍 Buyurtmalar (${live.length})`, callback_data: `so:${p}:0` },
          { text: `↩️ Qaytarishlar (${s.returns.length})`, callback_data: `sr:${p}:0` },
        ],
        [
          { text: "🏆 Top mahsulotlar", callback_data: `st:${p}` },
          { text: "🗺 Shaharlar", callback_data: `sc:${p}` },
        ],
        [
          { text: "🏠 Menyu", callback_data: "m:home" },
          { text: "🔄 Yangilash", callback_data: `s:${p}:f` },
        ],
      ],
    },
  };
}

const PAGE = 8;

function pager(prefix: string, p: PeriodKey, page: number, total: number): Btn[] {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages <= 1) return [];
  return [
    { text: "◀️", callback_data: `${prefix}:${p}:${(page - 1 + pages) % pages}` },
    { text: `${page + 1} / ${pages}`, callback_data: `${prefix}:${p}:${page}` },
    { text: "▶️", callback_data: `${prefix}:${p}:${(page + 1) % pages}` },
  ];
}

/** 🛍 Buyurtmalar ro'yxati: qaysi tovar, qaysi shaharga, qancha */
export function soldScreen(env: Env, p: PeriodKey, page: number, s: Stats): StatScreen {
  const list = s.orders;
  const live = list.filter((o) => !o.x);
  const L = [`<b>🛍 Buyurtmalar</b> · ${s.label}`, `Jami: <b>${live.length}</b> ta · ${money(sumBy(live))}` + (list.length - live.length ? ` · ❌ bekor ${list.length - live.length}` : "")];
  const pg = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  const slice = list.slice(pg * PAGE, pg * PAGE + PAGE);
  if (!slice.length) L.push("", "🤷 Bu davrda buyurtma yo'q.");
  for (const o of slice) {
    L.push(
      "",
      `${MP_ICON[o.mp]} <b>${escapeHtml(cut(o.name, 60))}</b>${o.qty > 1 ? ` × ${o.qty}` : ""}`,
      `   📍 ${escapeHtml(cut(o.city, 40))} · 💰 ${money({ [o.cur]: o.sum })}`,
      `   🕒 ${fmtTime(env, new Date(o.t).toISOString())} · ${o.x ? "❌ " : ""}${escapeHtml(o.st)}`,
    );
  }
  const nav = pager("so", p, pg, list.length);
  return {
    text: L.join("\n") + errLines(s.errs),
    reply_markup: {
      inline_keyboard: [
        periodRow("so", p).map((b) => ({ ...b, callback_data: b.callback_data + ":0" })),
        ...(nav.length ? [nav] : []),
        [
          { text: "⬅️ Statistika", callback_data: `s:${p}` },
          { text: "🏠", callback_data: "m:home" },
        ],
      ],
    },
  };
}

/** ↩️ Qaytarishlar ro'yxati */
export function returnsScreen(env: Env, p: PeriodKey, page: number, s: Stats): StatScreen {
  const list = s.returns;
  const L = [`<b>↩️ Qaytarishlar</b> · ${s.label}`, `Jami: <b>${list.length}</b> ta` + (list.length ? ` · ${money(sumBy(list))}` : "")];
  const pg = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  const slice = list.slice(pg * PAGE, pg * PAGE + PAGE);
  if (!slice.length) L.push("", "✅ Bu davrda qaytarish yo'q.");
  for (const o of slice) {
    L.push(
      "",
      `${MP_ICON[o.mp]} <b>${escapeHtml(cut(o.name, 60))}</b>`,
      `   💰 ${money({ [o.cur]: o.sum })} · 🕒 ${fmtTime(env, new Date(o.t).toISOString())}`,
    );
    if (o.why) L.push(`   💬 ${escapeHtml(cut(o.why, 60))}`);
    else if (o.city) L.push(`   📍 ${escapeHtml(cut(o.city, 40))}`);
  }
  const nav = pager("sr", p, pg, list.length);
  return {
    text: L.join("\n") + errLines(s.errs),
    reply_markup: {
      inline_keyboard: [
        periodRow("sr", p).map((b) => ({ ...b, callback_data: b.callback_data + ":0" })),
        ...(nav.length ? [nav] : []),
        [
          { text: "⬅️ Statistika", callback_data: `s:${p}` },
          { text: "🏠", callback_data: "m:home" },
        ],
      ],
    },
  };
}

/** 🏆 Top mahsulotlar yoki 🗺 shaharlar (10 tagacha) */
export function topScreen(env: Env, p: PeriodKey, kind: "st" | "sc", s: Stats): StatScreen {
  const live = s.orders.filter((o) => !o.x);
  const isProd = kind === "st";
  const rows = top(
    live.map((o) => ({ key: isProd ? o.name : shortCity(o.city), qty: isProd ? o.qty : 1, sum: o.sum, cur: o.cur })),
    10,
  );
  const L = [`<b>${isProd ? "🏆 Top mahsulotlar" : "🗺 Shaharlar bo'yicha"}</b> · ${s.label}`, ""];
  if (!rows.length) L.push("🤷 Bu davrda buyurtma yo'q.");
  const total = rows.reduce((a, [, v]) => a + v.qty, 0) || 1;
  rows.forEach(([k, v], i) => {
    const pct = Math.round((v.qty / total) * 100);
    const bar = "▰".repeat(Math.max(1, Math.round(pct / 10))) + "▱".repeat(Math.max(0, 10 - Math.max(1, Math.round(pct / 10))));
    L.push(`${rank(i)} <b>${escapeHtml(cut(k, 45))}</b>`, `   ${bar} ${v.qty} ${isProd ? "dona" : "ta"} · ${money(v.sums)}`);
  });
  return {
    text: L.join("\n") + errLines(s.errs),
    reply_markup: {
      inline_keyboard: [
        periodRow(kind, p),
        [
          isProd ? { text: "🗺 Shaharlar", callback_data: `sc:${p}` } : { text: "🏆 Top mahsulotlar", callback_data: `st:${p}` },
          { text: "⬅️ Statistika", callback_data: `s:${p}` },
        ],
      ],
    },
  };
}

/** Kunlik hisobot (09:00): kechagi natijalar */
export function yesterdayReport(env: Env, s: Stats): string {
  const live = s.orders.filter((o) => !o.x);
  const L = [`<b>☀️ Xayrli tong! Kechagi natijalar</b> · ${s.label.replace("Kecha · ", "")}`, ""];
  for (const mp of ["ozon", "wb"] as Marketplace[]) {
    const l = live.filter((o) => o.mp === mp);
    if ((mp === "ozon" && !ozonEnabled(env)) || (mp === "wb" && !wbEnabled(env))) continue;
    L.push(`${MP_ICON[mp]} ${MP_NAME[mp]}: <b>${l.length}</b> ta · ${money(sumBy(l))}`);
  }
  const cancel = s.orders.length - live.length;
  L.push(`↩️ Qaytarish: ${s.returns.length}` + (cancel ? ` · ❌ Bekor: ${cancel}` : "") + (s.buyouts.length ? ` · ✅ Sotib olindi: ${s.buyouts.length}` : ""));
  const tp = top(live.map((o) => ({ key: o.name, qty: o.qty, sum: o.sum, cur: o.cur })), 1)[0];
  if (tp) L.push(`🏆 Eng ko'p: ${escapeHtml(cut(tp[0], 40))} — ${tp[1].qty} dona`);
  return L.join("\n") + errLines(s.errs);
}
