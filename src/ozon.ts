import type { Env, Order } from "./types";

/**
 * Ozon Seller API (https://docs.ozon.ru/api/seller/)
 * Kerakli huquq: FBS buyurtmalar (postings).
 */
const BASE = "https://api-seller.ozon.ru";

async function ozon<T = any>(env: Env, path: string, body: unknown, raw = false): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Client-Id": env.OZON_CLIENT_ID ?? "",
      "Api-Key": env.OZON_API_KEY ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ozon ${path} ${res.status}: ${t.slice(0, 300)}`);
  }
  return (raw ? res.arrayBuffer() : res.json()) as Promise<T>;
}

export function ozonEnabled(env: Env): boolean {
  return Boolean(env.OZON_CLIENT_ID && env.OZON_API_KEY);
}

const STATUS_UZ: Record<string, string> = {
  awaiting_registration: "Ro'yxatga olinmoqda",
  acceptance_in_progress: "Qabul qilinmoqda",
  awaiting_approve: "Tasdiqlash kutilmoqda",
  awaiting_packaging: "Yig'ishni kutmoqda",
  awaiting_deliver: "Topshirishni kutmoqda",
  handed: "Jo'natmaga qo'shildi — punktga olib boring",
  delivering: "Yetkazilmoqda",
  delivered: "Yetkazildi",
  cancelled: "Bekor qilindi",
};
export const ozonStatusUz = (s: string) => STATUS_UZ[s] ?? s;

/** v4 da narx {amount, currency} obyekt bo'lishi mumkin */
const money = (v: any) => Number(typeof v === "object" && v ? v.amount ?? 0 : v ?? 0) || 0;

function toOrder(p: any): Order {
  const a = p.analytics_data ?? {};
  const city = [a.city, a.region].filter(Boolean).join(", ") || p.delivery_method?.warehouse || "—";
  const products: any[] = p.products ?? [];
  return {
    mp: "ozon",
    id: p.posting_number,
    status: p.status,
    items: products.map((x) => ({ name: x.name, article: x.offer_id, qty: x.quantity })),
    price: products.reduce((s, x) => s + money(x.price) * Number(x.quantity ?? 1), 0),
    currency: (typeof products[0]?.price === "object" && products[0]?.price?.currency) || products[0]?.currency_code || "UZS",
    city,
    createdAt: p.in_process_at ?? new Date().toISOString(),
    // "Kechiktirilmagan jo'natish sanasi" (kabinetdagi muddat); bo'lmasa shipment_date
    deadline: p.shipment_date_without_delay || p.shipment_date,
    canShip: p.status === "awaiting_packaging",
    readyToHandover: p.status === "awaiting_deliver",
    deliveryMethodId: p.delivery_method?.id,
  };
}

/** Javobdan jo'natmalar ro'yxatini olish (v3: result.postings, v4: postings) */
function pickPostings(r: any): { postings: any[]; cursor: string; hasNext: boolean } {
  const body = r?.result && !Array.isArray(r?.postings) ? r.result : r ?? {};
  const postings: any[] = Array.isArray(body.postings) ? body.postings : [];
  return { postings, cursor: typeof body.cursor === "string" ? body.cursor : "", hasNext: body.has_next === true };
}

/** Faqat siz tomonda ish kutayotgan holatlar (yetkazilayotgan/yetkazilganlar emas) */
const PENDING = new Set(["awaiting_approve", "awaiting_packaging", "awaiting_deliver"]);

/**
 * Bajarilmagan (yig'ish va topshirishni kutayotgan) FBS buyurtmalar.
 * Ozon 2026-yil 31-avgustda v3 ni o'chirgan — v4 (cursor bilan) ishlatiladi.
 * v4/unfulfilled ishlamasa — v4/list (oxirgi 14 kun) dan filtrlaymiz.
 */
export async function ozonUnfulfilled(env: Env): Promise<Order[]> {
  const now = Date.now();
  const withData = { analytics_data: true, financial_data: false };
  const collect = async (path: string, filter: Record<string, unknown>) => {
    const out: any[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const r = await ozon(env, path, { dir: "ASC", cursor, filter, limit: 100, with: withData });
      const p = pickPostings(r);
      out.push(...p.postings);
      if (!p.hasNext || !p.cursor || p.cursor === cursor || !p.postings.length) break;
      cursor = p.cursor;
    }
    return out;
  };
  try {
    const postings = await collect("/v4/posting/fbs/unfulfilled/list", {
      cutoff_from: new Date(now - 14 * 864e5).toISOString(),
      cutoff_to: new Date(now + 30 * 864e5).toISOString(),
    });
    return postings.filter((p) => PENDING.has(p.status)).map(toOrder);
  } catch (e) {
    console.log("v4 unfulfilled failed, fallback to v4 list:", (e as Error).message);
    const postings = await collect("/v4/posting/fbs/list", {
      since: new Date(now - 14 * 864e5).toISOString(),
      to: new Date(now + 864e5).toISOString(),
    });
    return postings.filter((p) => PENDING.has(p.status)).map(toOrder);
  }
}

export async function ozonGet(env: Env, postingNumber: string): Promise<{ order: Order; raw: any }> {
  const r = await ozon(env, "/v3/posting/fbs/get", {
    posting_number: postingNumber,
    with: { analytics_data: true },
  });
  return { order: toOrder(r.result), raw: r.result };
}

/** "Yig'ishga olish": buyurtmani bitta qutiga yig'ilgan deb belgilaydi (awaiting_packaging -> awaiting_deliver) */
export async function ozonShip(env: Env, postingNumber: string): Promise<void> {
  const { raw } = await ozonGet(env, postingNumber);
  const products = (raw.products ?? []).map((x: any) => ({ product_id: x.sku, quantity: x.quantity }));
  await ozon(env, "/v4/posting/fbs/ship", {
    posting_number: postingNumber,
    packages: [{ products }],
    with: { additional_data: false },
  });
}

/**
 * Yorliq (PDF). Ozon 2026-yil 2-noyabrda eski /v2/posting/fbs/package-label ni o'chirdi.
 * Yangi tartib: vazifa yaratish -> holatini kutish -> file_url dan PDF yuklab olish.
 */
export async function ozonLabel(env: Env, postingNumber: string | string[]): Promise<ArrayBuffer> {
  const list = Array.isArray(postingNumber) ? postingNumber.slice(0, 20) : [postingNumber];
  const created = await ozon(env, "/v3/posting/fbs/package-label/create", { posting_numbers: list });
  const tasks: any[] = created.tasks ?? created.result?.tasks ?? [];
  const task = tasks.find((t) => t.task_type === "small_label") ?? tasks.find((t) => t.task_type === "big_label") ?? tasks[0];
  if (!task?.task_id) throw new Error("Ozon yorliq vazifasini yaratmadi, birozdan keyin qayta urinib ko'ring");
  for (let i = 0; i < 20; i++) {
    const r = await ozon(env, "/v2/posting/fbs/package-label/get", { task_id: task.task_id });
    const res = r.result ?? r;
    const status = typeof res.status === "object" ? res.status?.code : res.status;
    if (res.error || status === "failed" || status === "error") throw new Error(`Ozon yorliq xatosi: ${JSON.stringify(res.error ?? status)}`);
    if (status === "completed" && res.file_url) {
      const f = await fetch(res.file_url);
      if (!f.ok) throw new Error(`Yorliq faylini yuklab bo'lmadi: ${f.status}`);
      return f.arrayBuffer();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Ozon yorliqni hali tayyorlayapti — 1 daqiqadan keyin qayta bosing");
}

/**
 * "Yukni jo'natish": topshirishga tayyor (awaiting_deliver) buyurtmalar uchun jo'natma (otgruzka) yaratish va tasdiqlash.
 * Natijada akt PDF qaytariladi (iloji bo'lsa).
 */
export async function ozonHandover(env: Env, deliveryMethodId: number): Promise<{ carriageId: number; act?: ArrayBuffer }> {
  const today = new Date().toISOString();
  const c = await ozon(env, "/v1/carriage/create", { delivery_method_id: deliveryMethodId, departure_date: today });
  const carriageId = Number(c.carriage_id ?? c.result?.carriage_id ?? c.id);
  if (!carriageId) throw new Error("Ozon jo'natma raqamini qaytarmadi: " + JSON.stringify(c).slice(0, 200));
  await ozon(env, "/v1/carriage/approve", { carriage_id: carriageId, containers_count: 1 });
  let act: ArrayBuffer | undefined;
  try {
    act = await ozon<ArrayBuffer>(env, "/v2/posting/fbs/act/get-pdf", { id: carriageId }, true);
  } catch (e) {
    console.log("act pdf:", (e as Error).message);
  }
  return { carriageId, act };
}

/* ===================== Statistika uchun ===================== */

/** Davr ichida yaratilgan barcha FBS jo'natmalar (har qanday holatda), xom ko'rinishda */
export async function ozonPostingsRange(env: Env, since: Date, to: Date): Promise<any[]> {
  const out: any[] = [];
  let cursor = "";
  for (let page = 0; page < 30; page++) {
    const r = await ozon(env, "/v4/posting/fbs/list", {
      dir: "DESC",
      cursor,
      filter: { since: since.toISOString(), to: to.toISOString() },
      limit: 100,
      with: { analytics_data: true, financial_data: false },
    });
    const p = pickPostings(r);
    out.push(...p.postings);
    if (!p.hasNext || !p.cursor || p.cursor === cursor || !p.postings.length) break;
    cursor = p.cursor;
  }
  return out;
}

/** Davrdagi qaytarishlar (FBS va boshqalar) — /v1/returns/list */
export async function ozonReturns(env: Env, since: Date, to: Date): Promise<any[]> {
  const out: any[] = [];
  let lastId = 0;
  for (let page = 0; page < 10; page++) {
    const r = await ozon(env, "/v1/returns/list", {
      filter: { logistic_return_date: { time_from: since.toISOString(), time_to: to.toISOString() } },
      limit: 500,
      last_id: lastId,
    });
    const list: any[] = r.returns ?? r.result?.returns ?? [];
    out.push(...list);
    if (!r.has_next || !list.length) break;
    lastId = Number(list[list.length - 1].id) || 0;
    if (!lastId) break;
  }
  return out;
}

export const ozonMoney = money;

/** Topshirish akti (PDF) jo'natma raqami bo'yicha */
export async function ozonActPdf(env: Env, carriageId: number): Promise<ArrayBuffer> {
  return ozon<ArrayBuffer>(env, "/v2/posting/fbs/act/get-pdf", { id: carriageId }, true);
}

/** Ozon bekor qilish sabablari (sotuvchi tomonidan) */
export const OZON_CANCEL_REASONS: { id: number; text: string }[] = [
  { id: 352, text: "📭 Tovar qolmagan" },
  { id: 400, text: "💔 Faqat nuqsonli tovar qoldi" },
  { id: 402, text: "✏️ Boshqa sabab" },
];

/** Buyurtmani bekor qilish */
export async function ozonCancel(env: Env, postingNumber: string, reasonId: number): Promise<void> {
  await ozon(env, "/v2/posting/fbs/cancel", {
    posting_number: postingNumber,
    cancel_reason_id: reasonId,
    cancel_reason_message: reasonId === 402 ? "Sotuvchi tomonidan bekor qilindi" : "",
  });
}
