import type { Env } from "./types";
import { uzumAccounts, uzumGet, uzumShops } from "./uzum";

/**
 * 🏬 Umumiy FBS ombor.
 * Bitta "asosiy mahsulot" (Master) — bitta haqiqiy qoldiq. Unga Uzum (bir nechta do'kon), Ozon va WB kartochkalari bog'lanadi.
 * Sinxronlash: har aylanishda har kartochkaning marketdagi qoldig'i oxirgi ma'lum qiymat bilan solishtiriladi —
 * kamaygan bo'lsa (sotuv) umumiy qoldiqdan ayriladi, oshgan bo'lsa (bekor/qaytish) qo'shiladi;
 * so'ng yangi umumiy qoldiq hamma kartochkaga yoziladi.
 */

export type Mp = "uz" | "oz" | "wb";
export interface Listing {
  k: string; // "uz:<skuId>" | "oz:<offer_id>" | "wb:<chrtID>"
  mp: Mp;
  shop: string;
  code: string;
  title: string;
  img?: string;
  qty: number | null;
  ref: Record<string, any>;
}
export interface Master {
  id: string;
  name: string;
  qty: number;
  links: string[];
  on: boolean;
  low?: number;
  img?: string;
}
interface Conf {
  on: boolean;
  ozWh?: number;
  wbWh?: number;
  lastRun?: number;
  lastErr?: string[];
}
interface LogRow {
  t: number;
  m: string;
}

const K_ITEMS = "fstk:items", K_LAST = "fstk:last", K_CONF = "fstk:conf", K_LOG = "fstk:log";
const getJ = async <T>(env: Env, k: string, d: T): Promise<T> => {
  const r = await env.STATE.get(k);
  return r ? (JSON.parse(r) as T) : d;
};
const putJ = (env: Env, k: string, v: unknown) => env.STATE.put(k, JSON.stringify(v));

export const loadItems = (env: Env) => getJ<Master[]>(env, K_ITEMS, []);
export const saveItems = (env: Env, l: Master[]) => putJ(env, K_ITEMS, l);
export const loadConf = (env: Env) => getJ<Conf>(env, K_CONF, { on: false });
export const saveConf = (env: Env, c: Conf) => putJ(env, K_CONF, c);
const loadLast = (env: Env) => getJ<Record<string, number>>(env, K_LAST, {});
const saveLast = (env: Env, l: Record<string, number>) => putJ(env, K_LAST, l);
export const loadLog = (env: Env) => getJ<LogRow[]>(env, K_LOG, []);
async function addLog(env: Env, rows: string[]) {
  if (!rows.length) return;
  const l = await loadLog(env);
  const now = Date.now();
  l.unshift(...rows.map((m) => ({ t: now, m })));
  await putJ(env, K_LOG, l.slice(0, 80));
}

/* ===================== Katalog ===================== */

const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

async function uzumListings(env: Env): Promise<Listing[]> {
  const out: Listing[] = [];
  const seen = new Set<number>();
  for (const a of await uzumAccounts(env)) {
    for (const s of await uzumShops(env, a.id).catch(() => [])) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      for (let page = 0; page < 30; page++) {
        const r = await uzumGet<any>(env, a.id, `/seller/shop/${s.id}/product/getProducts?${qs({ page, size: 100, filter: "ALL" })}`);
        const list: any[] = r?.productList ?? [];
        for (const p of list) {
          for (const k of p.skuList ?? []) {
            if (k.archived) continue;
            const variant = String(k.skuTitle || k.characteristics || "").trim();
            out.push({
              k: `uz:${k.skuId}`,
              mp: "uz",
              shop: s.name,
              code: String(k.sellerItemCode || k.skuFullTitle || ""),
              title: String(k.productTitle || p.title || "") + (variant ? ` · ${variant}` : ""),
              img: k.previewImage ? `${k.previewImage}/t_product_80_low.jpg` : p.previewImg,
              qty: k.quantityFbs == null ? null : Number(k.quantityFbs),
              ref: { acc: a.id, shopId: s.id, skuId: Number(k.skuId), barcode: k.barcode ? String(k.barcode) : "", productTitle: k.productTitle, skuTitle: k.skuTitle ?? "" },
            });
          }
        }
        if (list.length < 100) break;
      }
    }
  }
  return out;
}

async function ozon(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch("https://api-seller.ozon.ru" + path, {
    method: "POST",
    headers: { "Client-Id": env.OZON_CLIENT_ID ?? "", "Api-Key": env.OZON_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Ozon ${path} ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

async function ozonListings(env: Env): Promise<Listing[]> {
  if (!env.OZON_CLIENT_ID || !env.OZON_API_KEY) return [];
  const out: Listing[] = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const r = await ozon(env, "/v4/product/info/stocks", { filter: { visibility: "ALL" }, limit: 1000, cursor });
    const items: any[] = r.items ?? [];
    for (const it of items) {
      const st = (it.stocks ?? []).filter((x: any) => x.type === "fbs");
      out.push({
        k: `oz:${it.offer_id}`,
        mp: "oz",
        shop: "Ozon",
        code: String(it.offer_id),
        title: String(it.offer_id),
        qty: st.reduce((n: number, x: any) => n + Number(x.present ?? 0) - Number(x.reserved ?? 0), 0),
        ref: { offer: String(it.offer_id), pid: Number(it.product_id) },
      });
    }
    cursor = r.cursor ?? "";
    if (!cursor || items.length < 1000) break;
  }
  // Nomlar va rasmlar
  const ids = out.map((x) => x.ref.pid);
  for (let i = 0; i < ids.length; i += 1000) {
    try {
      const r = await ozon(env, "/v3/product/info/list", { product_id: ids.slice(i, i + 1000) });
      for (const p of r.items ?? []) {
        const l = out.find((x) => x.ref.pid === Number(p.id));
        if (!l) continue;
        if (p.name) l.title = String(p.name);
        const img = Array.isArray(p.primary_image) ? p.primary_image[0] : p.primary_image || (p.images ?? [])[0];
        if (img) l.img = String(img);
      }
    } catch (e) {
      console.log("ozon nomlar:", (e as Error).message);
    }
  }
  return out;
}

async function wbReq(env: Env, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Authorization: env.WB_API_TOKEN ?? "", "content-type": "application/json", ...(init.headers ?? {}) } });
  const t = await res.text();
  if (!res.ok) throw new Error(`WB ${url.replace(/^https:\/\/[^/]+/, "")} ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

async function wbWarehouse(env: Env, conf: Conf): Promise<number | undefined> {
  if (conf.wbWh) return conf.wbWh;
  const whs: any[] = await wbReq(env, "https://marketplace-api.wildberries.ru/api/v3/warehouses");
  return whs[0]?.id ? Number(whs[0].id) : undefined;
}

async function wbListings(env: Env, conf: Conf): Promise<Listing[]> {
  if (!env.WB_API_TOKEN) return [];
  const out: Listing[] = [];
  let cursor: any = { limit: 100 };
  for (let i = 0; i < 50; i++) {
    const r = await wbReq(env, "https://content-api.wildberries.ru/content/v2/get/cards/list", {
      method: "POST",
      body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }),
    });
    const cards: any[] = r.cards ?? [];
    for (const c of cards) {
      for (const sz of c.sizes ?? []) {
        out.push({
          k: `wb:${sz.chrtID}`,
          mp: "wb",
          shop: "Wildberries",
          code: String(c.vendorCode ?? ""),
          title: String(c.title ?? c.vendorCode ?? ""),
          img: c.photos?.[0]?.tm || c.photos?.[0]?.c246x328,
          qty: 0,
          ref: { chrtId: Number(sz.chrtID), barcode: String(sz.skus?.[0] ?? ""), nmID: c.nmID },
        });
      }
    }
    if (cards.length < 100 || !r.cursor) break;
    cursor = { limit: 100, updatedAt: r.cursor.updatedAt, nmID: r.cursor.nmID };
  }
  const wh = await wbWarehouse(env, conf);
  if (wh) {
    const bars = out.map((x) => x.ref.barcode).filter(Boolean) as string[];
    for (let i = 0; i < bars.length; i += 1000) {
      const r = await wbReq(env, `https://marketplace-api.wildberries.ru/api/v3/stocks/${wh}`, { method: "POST", body: JSON.stringify({ skus: bars.slice(i, i + 1000) }) });
      for (const s of r.stocks ?? []) {
        const it = out.find((x) => x.ref.barcode === String(s.sku));
        if (it) it.qty = Number(s.amount ?? 0);
      }
    }
  }
  return out;
}

let CAT: { t: number; list: Listing[]; errs: string[] } | null = null;

/** Uchala market kartochkalari (5 daqiqa keshda) */
export async function catalog(env: Env, force = false): Promise<{ list: Listing[]; errs: string[] }> {
  if (!force && CAT && Date.now() - CAT.t < 5 * 60e3) return CAT;
  const conf = await loadConf(env);
  const errs: string[] = [];
  const safe = async (name: string, f: () => Promise<Listing[]>) => {
    try {
      return await f();
    } catch (e) {
      errs.push(`${name}: ${(e as Error).message}`);
      return null;
    }
  };
  const [uz, oz, wb] = await Promise.all([safe("Uzum", () => uzumListings(env)), safe("Ozon", () => ozonListings(env)), safe("WB", () => wbListings(env, conf))]);
  // Biror market o'qilmasa — oldingi ma'lumotini saqlab qolamiz (sinxron shu market bo'yicha o'tkazib yuboriladi)
  const prev = CAT?.list ?? [];
  const keep = (mp: Mp, l: Listing[] | null) => (l ?? prev.filter((x) => x.mp === mp).map((x) => ({ ...x, qty: null })));
  CAT = { t: Date.now(), list: [...keep("uz", uz), ...keep("oz", oz), ...keep("wb", wb)], errs };
  return CAT;
}

/* ===================== Moslik (taklif) ===================== */

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !/^(для|лица|кожи|with|and|the|uchun|bilan|мл|ml)$/.test(w));

/** Listing master nomiga qanchalik o'xshash (0..1) */
export function score(name: string, l: Listing): number {
  const ws = words(name);
  if (!ws.length) return 0;
  const hay = (l.title + " " + l.code).toLowerCase().replace(/[^a-z0-9а-яё]/g, "");
  let hit = 0;
  for (const w of ws) if (hay.includes(w)) hit++;
  const nums = (name.match(/\d{2,4}/g) ?? []).filter((n) => hay.includes(n)).length;
  return hit / ws.length + nums * 0.05;
}

/* ===================== Yozish (marketlarga qoldiq) ===================== */

async function ozonWarehouse(env: Env, conf: Conf): Promise<number | undefined> {
  if (conf.ozWh) return conf.ozWh;
  for (const p of ["/v2/warehouse/list", "/v1/warehouse/list"]) {
    try {
      const r = await ozon(env, p, p.startsWith("/v2") ? { limit: 100 } : {});
      const l: any[] = r.result ?? r.warehouses ?? [];
      const w = l.find((x) => !x.is_rfbs && String(x.status ?? "").toLowerCase() !== "disabled") ?? l[0];
      if (w?.warehouse_id) return (conf.ozWh = Number(w.warehouse_id));
    } catch {}
  }
  // Zaxira: oxirgi FBS jo'natmalardan
  try {
    const to = new Date(), since = new Date(Date.now() - 60 * 864e5);
    const r = await ozon(env, "/v3/posting/fbs/list", { dir: "DESC", filter: { since: since.toISOString(), to: to.toISOString() }, limit: 20, offset: 0 });
    const w = (r.result?.postings ?? []).map((p: any) => p.delivery_method?.warehouse_id).find(Boolean);
    if (w) return (conf.ozWh = Number(w));
  } catch {}
  return undefined;
}

type Push = { l: Listing; qty: number };

async function pushOzon(env: Env, conf: Conf, items: Push[]): Promise<Map<string, string | null>> {
  const res = new Map<string, string | null>();
  if (!items.length) return res;
  const wh = await ozonWarehouse(env, conf);
  if (!wh) {
    for (const i of items) res.set(i.l.k, "Ozon ombori topilmadi");
    return res;
  }
  for (let i = 0; i < items.length; i += 100) {
    const part = items.slice(i, i + 100);
    try {
      const r = await ozon(env, "/v2/products/stocks", { stocks: part.map((x) => ({ offer_id: x.l.ref.offer, product_id: x.l.ref.pid, stock: x.qty, warehouse_id: wh })) });
      for (const x of r.result ?? []) {
        const l = part.find((p) => p.l.ref.offer === String(x.offer_id));
        if (l) res.set(l.l.k, x.updated ? null : (x.errors ?? []).map((e: any) => e.message || e.code).join("; ") || "yangilanmadi");
      }
      for (const p of part) if (!res.has(p.l.k)) res.set(p.l.k, null);
    } catch (e) {
      for (const p of part) res.set(p.l.k, (e as Error).message);
    }
  }
  return res;
}

async function pushWb(env: Env, conf: Conf, items: Push[]): Promise<Map<string, string | null>> {
  const res = new Map<string, string | null>();
  if (!items.length) return res;
  const wh = await wbWarehouse(env, conf);
  if (!wh) {
    for (const i of items) res.set(i.l.k, "WB ombori topilmadi");
    return res;
  }
  for (let i = 0; i < items.length; i += 1000) {
    const part = items.slice(i, i + 1000);
    const url = `https://marketplace-api.wildberries.ru/api/v3/stocks/${wh}`;
    try {
      await wbReq(env, url, { method: "PUT", body: JSON.stringify({ stocks: part.map((x) => ({ sku: x.l.ref.barcode, amount: x.qty })) }) });
      for (const p of part) res.set(p.l.k, null);
    } catch (e) {
      // Yangi formatda chrtId talab qilinsa
      try {
        await wbReq(env, url, { method: "PUT", body: JSON.stringify({ stocks: part.map((x) => ({ chrtId: x.l.ref.chrtId, amount: x.qty })) }) });
        for (const p of part) res.set(p.l.k, null);
      } catch {
        for (const p of part) res.set(p.l.k, (e as Error).message);
      }
    }
  }
  return res;
}

/**
 * Uzum'ga FBS qoldiq yozish — Uzum Seller OpenAPI orqali.
 * Kabinetdagi API kalit(lar) Coolify'da UZUM_API_TOKEN ga yoziladi (bir nechta bo'lsa — vergul bilan).
 */
async function pushUzum(env: Env, items: Push[]): Promise<Map<string, string | null>> {
  const res = new Map<string, string | null>();
  if (!items.length) return res;
  const tokens = String((env as any).UZUM_API_TOKEN ?? "").split(/[,\s]+/).filter(Boolean);
  if (!tokens.length) {
    for (const i of items) res.set(i.l.k, "Uzum API kaliti kiritilmagan (UZUM_API_TOKEN)");
    return res;
  }
  const byShop = new Map<number, Push[]>();
  for (const i of items) byShop.set(i.l.ref.shopId, [...(byShop.get(i.l.ref.shopId) ?? []), i]);
  for (const [, list] of byShop) {
    let lastErr = "";
    let done = false;
    for (const tok of tokens) {
      try {
        const r = await fetch("https://api-seller.uzum.uz/api/seller-openapi/v2/fbs/sku/stocks", {
          method: "POST",
          headers: { Authorization: tok, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            skuAmountList: list.map((x) => ({ skuId: x.l.ref.skuId, skuTitle: x.l.ref.skuTitle, productTitle: x.l.ref.productTitle, barcode: x.l.ref.barcode, amount: x.qty, fbsLinked: true, dbsLinked: false })),
          }),
        });
        const t = await r.text();
        if (r.ok) {
          done = true;
          break;
        }
        lastErr = `Uzum ${r.status}: ${t.slice(0, 150)}`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    for (const p of list) res.set(p.l.k, done ? null : lastErr || "Uzum'ga yozilmadi");
  }
  return res;
}

async function pushAll(env: Env, conf: Conf, items: Push[]): Promise<Map<string, string | null>> {
  const [a, b, c] = await Promise.all([
    pushUzum(env, items.filter((x) => x.l.mp === "uz")),
    pushOzon(env, conf, items.filter((x) => x.l.mp === "oz")),
    pushWb(env, conf, items.filter((x) => x.l.mp === "wb")),
  ]);
  return new Map([...a, ...b, ...c]);
}

/* ===================== Sinxronlash ===================== */

const MPN: Record<Mp, string> = { uz: "Uzum", oz: "Ozon", wb: "WB" };

/**
 * Bitta aylanish. force=true — o'zgarish bo'lmasa ham hamma kartochkaga qayta yozadi.
 * only — faqat shu master(lar) uchun (qo'lda son o'zgartirilganda).
 */
export async function stockSync(env: Env, opts: { force?: boolean; only?: string[]; manual?: boolean } = {}): Promise<{ changed: number; errors: string[] }> {
  const conf = await loadConf(env);
  if (!conf.on && !opts.manual) return { changed: 0, errors: [] };
  const { list, errs } = await catalog(env, true);
  const byK = new Map(list.map((l) => [l.k, l]));
  const items = await loadItems(env);
  const last = await loadLast(env);
  const log: string[] = [];
  const pushes: Push[] = [];
  const touched = new Map<string, Master>();
  for (const m of items) {
    if (!m.on || !m.links.length) continue;
    if (opts.only && !opts.only.includes(m.id)) continue;
    let delta = 0;
    for (const k of m.links) {
      const l = byK.get(k);
      if (!l || l.qty == null || last[k] == null) continue;
      const d = l.qty - last[k];
      if (d !== 0) {
        delta += d;
        log.push(`${d < 0 ? "🛒" : "↩️"} ${m.name}: ${MPN[l.mp]}${l.mp === "uz" ? " · " + l.shop : ""} ${d > 0 ? "+" : ""}${d}`);
      }
    }
    const before = m.qty;
    m.qty = Math.max(0, m.qty + delta);
    const need = opts.force || delta !== 0 || m.links.some((k) => last[k] == null || (byK.get(k)?.qty != null && byK.get(k)!.qty !== m.qty));
    if (!need) continue;
    if (before !== m.qty) touched.set(m.id, m);
    for (const k of m.links) {
      const l = byK.get(k);
      if (l && l.qty != null) pushes.push({ l, qty: m.qty });
    }
  }
  const res = await pushAll(env, conf, pushes);
  const errors = [...errs];
  for (const p of pushes) {
    const err = res.get(p.l.k);
    if (err) {
      last[p.l.k] = p.l.qty ?? last[p.l.k]; // yozilmadi — marketdagi haqiqiy qiymatdan davom etamiz
      errors.push(`${MPN[p.l.mp]} ${p.l.code}: ${err}`);
    } else {
      last[p.l.k] = p.qty;
      p.l.qty = p.qty;
    }
  }
  await saveItems(env, items);
  await saveLast(env, last);
  conf.lastRun = Date.now();
  conf.lastErr = [...new Set(errors)].slice(0, 10);
  await saveConf(env, conf);
  await addLog(env, log);
  return { changed: touched.size, errors: conf.lastErr };
}

/** Kartochka bog'langanda/uzilganda uning "oxirgi" qiymatini tozalash */
export async function forgetLast(env: Env, keys: string[]) {
  const last = await loadLast(env);
  for (const k of keys) delete last[k];
  await saveLast(env, last);
}

/** Admin sinovi: kartochkaga uning HOZIRGI qoldig'ini qayta yozadi (son o'zgarmaydi) — yozish ishlashini tekshirish uchun */
export async function testPush(env: Env, k: string): Promise<Record<string, unknown>> {
  const conf = await loadConf(env);
  const { list } = await catalog(env, true);
  const l = list.find((x) => x.k === k);
  if (!l || l.qty == null) return { ok: false, error: "kartochka yoki qoldiq topilmadi" };
  const r = await pushAll(env, conf, [{ l, qty: l.qty }]);
  await saveConf(env, conf);
  return { ok: !r.get(k), k, qty: l.qty, error: r.get(k) ?? null, ozWh: conf.ozWh ?? null };
}
