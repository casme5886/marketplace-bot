import type { Env } from "./types";
import { uzumAccounts, uzumGet, uzumShops } from "./uzum";

/**
 * 🏬 Umumiy FBS ombor — 1-bosqich: uchala marketdagi mahsulotlar katalogi (artikul + FBS qoldiq).
 * Keyingi bosqichda shu katalog asosida mahsulotlar bog'lanadi va qoldiq sinxronlanadi.
 */

export interface CatItem {
  mp: "uzum" | "ozon" | "wb";
  id: string; // uzum: skuId, ozon: offer_id, wb: chrtID
  article: string; // solishtirish uchun artikul
  barcode?: string;
  title: string;
  fbs: number | null; // FBS qoldiq (noma'lum bo'lsa null)
  shop?: string;
  extra?: Record<string, unknown>;
}

const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export async function uzumCatalog(env: Env, sample: any[]): Promise<CatItem[]> {
  const out: CatItem[] = [];
  for (const a of await uzumAccounts(env)) {
    for (const s of await uzumShops(env, a.id).catch(() => [])) {
      for (let page = 0; page < 20; page++) {
        const r = await uzumGet<any>(env, a.id, `/seller/shop/${s.id}/product/getProducts?${qs({ page, size: 100, filter: "ALL" })}`);
        const list: any[] = r?.productList ?? [];
        for (const p of list) {
          if (sample.length < 2) sample.push({ product: { ...p, skuList: undefined }, sku: p.skuList?.[0] });
          for (const k of p.skuList ?? []) {
            if (k.archived) continue;
            out.push({
              mp: "uzum",
              id: String(k.skuId),
              article: String(k.skuTitle ?? k.article ?? k.sellerItemCode ?? ""),
              barcode: k.barcode ? String(k.barcode) : undefined,
              title: String(k.skuFullTitle || k.productTitle || p.title || ""),
              fbs: k.quantityFbs == null ? null : Number(k.quantityFbs),
              shop: s.name,
              extra: { shopId: s.id, acc: a.id, productId: p.productId ?? p.id },
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
  if (!res.ok) throw new Error(`Ozon ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function ozonCatalog(env: Env, sample: any[]): Promise<CatItem[]> {
  if (!env.OZON_CLIENT_ID || !env.OZON_API_KEY) return [];
  const out: CatItem[] = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const r = await ozon(env, "/v4/product/info/stocks", { filter: { visibility: "ALL" }, limit: 1000, cursor });
    const items: any[] = r.items ?? [];
    for (const it of items) {
      if (sample.length < 2) sample.push(it);
      const st = (it.stocks ?? []).filter((x: any) => x.type === "fbs");
      out.push({
        mp: "ozon",
        id: String(it.offer_id),
        article: String(it.offer_id),
        title: "",
        fbs: st.length ? st.reduce((n: number, x: any) => n + Number(x.present ?? 0) - Number(x.reserved ?? 0), 0) : 0,
        extra: { productId: it.product_id },
      });
    }
    cursor = r.cursor ?? "";
    if (!cursor || items.length < 1000) break;
  }
  try {
    const wh = await ozon(env, "/v1/warehouse/list", {});
    sample.push({ warehouses: (wh.result ?? []).map((w: any) => ({ id: w.warehouse_id, name: w.name, rfbs: w.is_rfbs, status: w.status })) });
  } catch (e) {
    sample.push({ warehouses_error: (e as Error).message });
  }
  return out;
}

async function wbReq(env: Env, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Authorization: env.WB_API_TOKEN ?? "", "content-type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`WB ${url.replace(/^https:\/\/[^/]+/, "")} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : {};
}

export async function wbCatalog(env: Env, sample: any[]): Promise<CatItem[]> {
  if (!env.WB_API_TOKEN) return [];
  const out: CatItem[] = [];
  let cursor: any = { limit: 100 };
  for (let i = 0; i < 30; i++) {
    const r = await wbReq(env, "https://content-api.wildberries.ru/content/v2/get/cards/list", {
      method: "POST",
      body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }),
    });
    const cards: any[] = r.cards ?? [];
    for (const c of cards) {
      if (sample.length < 2) sample.push(c);
      for (const sz of c.sizes ?? []) {
        out.push({
          mp: "wb",
          id: String(sz.chrtID),
          article: String(c.vendorCode ?? ""),
          barcode: sz.skus?.[0] ? String(sz.skus[0]) : undefined,
          title: String(c.title ?? ""),
          fbs: null,
          extra: { nmID: c.nmID, skus: sz.skus },
        });
      }
    }
    if (cards.length < 100 || !r.cursor) break;
    cursor = { limit: 100, updatedAt: r.cursor.updatedAt, nmID: r.cursor.nmID };
  }
  // FBS qoldiq: sotuvchi omborlari bo'yicha
  try {
    const whs: any[] = await wbReq(env, "https://marketplace-api.wildberries.ru/api/v3/warehouses");
    sample.push({ warehouses: whs.map((w) => ({ id: w.id, name: w.name, officeId: w.officeId })) });
    const bars = out.map((x) => x.barcode).filter(Boolean) as string[];
    for (const w of whs) {
      for (let i = 0; i < bars.length; i += 1000) {
        const r = await wbReq(env, `https://marketplace-api.wildberries.ru/api/v3/stocks/${w.id}`, { method: "POST", body: JSON.stringify({ skus: bars.slice(i, i + 1000) }) });
        for (const s of r.stocks ?? []) {
          const it = out.find((x) => x.barcode === String(s.sku));
          if (it) it.fbs = (it.fbs ?? 0) + Number(s.amount ?? 0);
        }
      }
    }
  } catch (e) {
    sample.push({ stocks_error: (e as Error).message });
  }
  return out;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9А-ЯЁ]/g, "");

/** Admin: katalog va avtomatik moslik hisoboti */
export async function catalogReport(env: Env) {
  const samples: Record<string, any[]> = { uzum: [], ozon: [], wb: [] };
  const errors: string[] = [];
  const run = async (k: "uzum" | "ozon" | "wb", f: (e: Env, s: any[]) => Promise<CatItem[]>) => {
    try {
      return await f(env, samples[k]);
    } catch (e) {
      errors.push(`${k}: ${(e as Error).message}`);
      return [] as CatItem[];
    }
  };
  const [uz, oz, wb] = await Promise.all([run("uzum", uzumCatalog), run("ozon", ozonCatalog), run("wb", wbCatalog)]);
  const by = (l: CatItem[]) => new Map(l.filter((x) => x.article).map((x) => [norm(x.article), x]));
  const mo = by(oz), mw = by(wb);
  const matched = uz.filter((u) => mo.has(norm(u.article)) || mw.has(norm(u.article))).map((u) => ({
    article: u.article,
    uzum: u.fbs,
    ozon: mo.get(norm(u.article))?.fbs ?? "—",
    wb: mw.get(norm(u.article))?.fbs ?? "—",
  }));
  return {
    counts: { uzum: uz.length, ozon: oz.length, wb: wb.length, matched: matched.length },
    errors,
    matched,
    uzum: uz.map((x) => ({ a: x.article, b: x.barcode, t: x.title.slice(0, 60), f: x.fbs, s: x.shop })),
    ozon: oz.map((x) => ({ a: x.article, f: x.fbs })),
    wb: wb.map((x) => ({ a: x.article, b: x.barcode, t: x.title.slice(0, 60), f: x.fbs })),
    samples,
  };
}
