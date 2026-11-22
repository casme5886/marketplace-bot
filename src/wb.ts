import type { Env, Order } from "./types";

/**
 * Wildberries Marketplace API (https://dev.wildberries.ru/openapi/orders-fbs)
 * Token toifasi: "Marketplace" (FBS buyurtmalar).
 */
const BASE = "https://marketplace-api.wildberries.ru";

async function wb<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: env.WB_API_TOKEN ?? "",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`WB ${path} ${res.status}: ${t.slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export function wbEnabled(env: Env): boolean {
  return Boolean(env.WB_API_TOKEN);
}

const STATUS_UZ: Record<string, string> = {
  new: "Yangi",
  confirm: "Yig'ilmoqda",
  complete: "Yetkazishda",
  cancel: "Bekor qilindi",
  deliver: "Yetkazishda",
  receive: "Qabul qilindi",
  reject: "Rad etildi",
};
export const wbStatusUz = (s: string) => STATUS_UZ[s] ?? s;

// ISO 4217 raqamli kodlar
const CUR: Record<number, string> = { 860: "UZS", 643: "RUB", 398: "KZT", 933: "BYN", 417: "KGS" };

function toOrder(o: any): Order {
  const priceMinor = Number(o.convertedPrice ?? o.price ?? 0);
  const currencyCode = Number(o.convertedCurrencyCode ?? o.currencyCode ?? 860);
  const offices: string[] = o.offices ?? [];
  return {
    mp: "wb",
    id: String(o.id),
    status: "new",
    items: [{ name: o.article ?? `nmId ${o.nmId}`, article: o.article ?? String(o.nmId ?? ""), qty: 1 }],
    price: priceMinor / 100,
    currency: CUR[currencyCode] ?? "UZS",
    city: offices.join(", ") || o.address?.city || "—",
    createdAt: o.createdAt ?? new Date().toISOString(),
    deadline: undefined,
    canShip: true,
  };
}

/** Yangi (hali yig'ishga olinmagan) buyurtmalar */
export async function wbNew(env: Env): Promise<Order[]> {
  const r = await wb(env, "/api/v3/orders/new");
  return (r.orders ?? []).map(toOrder);
}

/**
 * Yig'ishdagi (confirm) va topshirilib, WB qabulini kutayotgan (complete + waiting) buyurtmalar.
 * Oxirgi 14 kunlik buyurtmalar ro'yxatidan olinadi, holati /orders/status orqali aniqlanadi.
 */
export async function wbActive(env: Env): Promise<Order[]> {
  const dateFrom = Math.floor(Date.now() / 1000) - 14 * 86400;
  const all: any[] = [];
  let next = 0;
  for (let i = 0; i < 10; i++) {
    const r = await wb(env, `/api/v3/orders?limit=1000&next=${next}&dateFrom=${dateFrom}`);
    const list: any[] = r.orders ?? [];
    all.push(...list);
    if (list.length < 1000 || !r.next) break;
    next = r.next;
  }
  if (!all.length) return [];
  const st = new Map<number, { s: string; w: string }>();
  for (let i = 0; i < all.length; i += 1000) {
    const r = await wb(env, "/api/v3/orders/status", { method: "POST", body: JSON.stringify({ orders: all.slice(i, i + 1000).map((o) => o.id) }) });
    for (const x of r.orders ?? []) st.set(Number(x.id), { s: String(x.supplierStatus ?? ""), w: String(x.wbStatus ?? "") });
  }
  const out: Order[] = [];
  for (const o of all) {
    const x = st.get(Number(o.id));
    if (!x) continue;
    if (x.s === "confirm") out.push({ ...toOrder(o), status: "confirm", canShip: false });
    else if (x.s === "complete" && x.w === "waiting") out.push({ ...toOrder(o), status: "handed", canShip: false });
  }
  return out;
}

/** "Yig'ishga olish": bugungi postavkaga qo'shadi (new -> confirm) */
export async function wbShip(env: Env, orderId: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `wbsupply:${today}`;
  let supplyId = await env.STATE.get(key);
  if (!supplyId) {
    const s = await wb(env, "/api/v3/supplies", {
      method: "POST",
      body: JSON.stringify({ name: `Bot ${today}` }),
    });
    supplyId = String(s.id);
    await env.STATE.put(key, supplyId, { expirationTtl: 3 * 86400 });
  }
  await wb(env, `/api/v3/supplies/${supplyId}/orders/${orderId}`, { method: "PATCH" });
  return supplyId;
}

/** Buyurtmani bekor qilish */
export async function wbCancel(env: Env, orderId: string): Promise<void> {
  await wb(env, `/api/v3/orders/${orderId}/cancel`, { method: "PATCH" });
}

/** Postavka QR-kodi (PNG) */
export async function wbSupplyQr(env: Env, supplyId: string): Promise<Uint8Array> {
  const r = await wb(env, `/api/v3/supplies/${supplyId}/barcode?type=png`);
  if (!r.file) throw new Error("WB postavka QR-kodini bermadi");
  return b64ToBytes(r.file);
}

/** Stiker (PNG, 58x40) */
const b64ToBytes = (b64: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export async function wbLabel(env: Env, orderId: string): Promise<Uint8Array> {
  const all = await wbLabels(env, [orderId]);
  if (!all.length) throw new Error("WB stiker topilmadi (buyurtma avval yig'ishga olinishi kerak)");
  return all[0].png;
}

/** Bir nechta stiker birdan (maks. 100) */
export async function wbLabels(env: Env, orderIds: string[]): Promise<{ id: string; png: Uint8Array }[]> {
  const r = await wb(env, "/api/v3/orders/stickers?type=png&width=58&height=40", {
    method: "POST",
    body: JSON.stringify({ orders: orderIds.slice(0, 100).map(Number) }),
  });
  return (r.stickers ?? []).filter((x: any) => x.file).map((x: any) => ({ id: String(x.orderId), png: b64ToBytes(x.file) }));
}

/** Buyurtmalar holatini tekshirish */
export async function wbStatuses(env: Env, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const r = await wb(env, "/api/v3/orders/status", {
    method: "POST",
    body: JSON.stringify({ orders: ids.map(Number) }),
  });
  const out: Record<string, string> = {};
  for (const o of r.orders ?? []) out[String(o.id)] = o.supplierStatus;
  return out;
}

/** Bugungi postavka ID (bot yaratgan) */
export async function wbTodaySupply(env: Env): Promise<string | null> {
  return env.STATE.get(`wbsupply:${new Date().toISOString().slice(0, 10)}`);
}

/** "Yukni jo'natish": postavkani yopib, yetkazishga topshirish + postavka QR-kodi (PNG) */
export async function wbHandover(env: Env, supplyId: string): Promise<{ qr?: Uint8Array }> {
  await wb(env, `/api/v3/supplies/${supplyId}/deliver`, { method: "PATCH" });
  await env.STATE.delete(`wbsupply:${new Date().toISOString().slice(0, 10)}`);
  try {
    const r = await wb(env, `/api/v3/supplies/${supplyId}/barcode?type=png`);
    if (r.file) return { qr: b64ToBytes(r.file) };
  } catch (e) {
    console.log("supply barcode:", (e as Error).message);
  }
  return {};
}
