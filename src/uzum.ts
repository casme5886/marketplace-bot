/**
 * Uzum Market — FBO va qaytarish nakladnoylariga vaqt (slot) tanlash. Bir nechta profil (akkaunt) qo'llanadi.
 * Uzum'ning rasmiy API'sida slot yo'q, shuning uchun sotuvchi kabineti ishlatadigan so'rovlar qo'llanadi:
 *  - do'konlar:      GET  /api/seller/shop/
 *  - nakladnoylar:   GET  /api/seller/shop/{shopId}/invoice  |  /return
 *  - bo'sh slotlar:  POST .../v2/invoice/time-slot/get  |  .../return/time-slot/get
 *  - band qilish:    POST .../v2/invoice/time-slot/set  |  .../return/time-slot/set
 * Profillar KV da: login + shifrlangan parol (AES-GCM) + tokenlar. Sessiya tugasa — bot o'zi qayta kiradi.
 */
import type { Env } from "./types";

const BASE = "https://api-seller.uzum.uz/api";
const CLIENT = "Basic " + btoa("b2b-front:clientSecret");
const ACC_KEY = "uzum:accounts";
const MAP_KEY = "uzum:shopacc"; // do'kon -> profil

/* ---------- Profillar ---------- */

export interface UzAccount {
  id: string; // a1, a2, ... yoki "env"
  login: string;
  label: string; // do'kon nomlari
  enc?: string; // shifrlangan parol (eslab qolinsa)
  named?: boolean; // nom rekvizitlardan olingan
}

/** Login (telefon yoki email) ni Uzum kutgan ko'rinishga keltirish */
function normLogin(s: string): string {
  const t = s.trim();
  if (/[a-z@]/i.test(t)) return t;
  const d = t.replace(/[^\d]/g, "");
  return d.length === 9 ? "998" + d : d;
}

export const maskLogin = (l: string) => (/@/.test(l) ? l.replace(/^(.{2}).*(@.*)$/, "$1***$2") : l.replace(/^(\d{5})\d+(\d{2})$/, "$1***$2"));

/** 🛎 Mijozlar uchun xizmat hisobi (slot xizmati) — ID si */
export const svcAccId = async (env: Env) => (await env.STATE.get("svc:acc")) ?? "";

/** Xodimlar ko'radigan profillar (xizmat hisobi — mijozlarniki, bu yerda ko'rinmaydi) */
export async function uzumAccounts(env: Env): Promise<UzAccount[]> {
  const svc = await svcAccId(env);
  return (await uzumAllAccounts(env)).filter((a) => a.id !== svc);
}

/** Barcha profillar, xizmat hisobi bilan birga */
export async function uzumAllAccounts(env: Env): Promise<UzAccount[]> {
  const raw = await env.STATE.get(ACC_KEY);
  let list: UzAccount[] = raw ? JSON.parse(raw) : [];
  // Eski versiyadan ko'chirish (bitta profil)
  if (!raw) {
    const oldTok = await env.STATE.get("uzum:tokens");
    if (oldTok) {
      const login = (await env.STATE.get("uzum:account")) ?? "uzum";
      list = [{ id: "a1", login, label: "Uzum profil 1" }];
      await env.STATE.put(`uzum:tok:a1`, oldTok);
      await env.STATE.put(ACC_KEY, JSON.stringify(list));
      await env.STATE.delete("uzum:tokens");
      await env.STATE.delete("uzum:account");
    }
  }
  if (env.UZUM_LOGIN && env.UZUM_PASSWORD && !list.some((a) => a.id === "env")) {
    list.unshift({ id: "env", login: normLogin(env.UZUM_LOGIN), label: "Uzum profil (.dev.vars)" });
  }
  return list;
}

async function saveAccounts(env: Env, list: UzAccount[]) {
  await env.STATE.put(ACC_KEY, JSON.stringify(list.filter((a) => a.id !== "env")));
}

export async function uzumEnabled(env: Env): Promise<boolean> {
  return (await uzumAllAccounts(env)).length > 0;
}

/* ---------- Parolni shifrlash (AES-GCM, kalit — bot sirlaridan) ---------- */

async function cryptoKey(env: Env): Promise<CryptoKey> {
  const seed = new TextEncoder().encode(`${env.TELEGRAM_BOT_TOKEN}|${env.ADMIN_PASSWORD}|uzum-v1`);
  const hash = await crypto.subtle.digest("SHA-256", seed);
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encrypt(env: Env, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}
export async function decrypt(env: Env, data: string): Promise<string> {
  const u = unb64(data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, await cryptoKey(env), u.slice(12));
  return new TextDecoder().decode(pt);
}

/* ---------- Kirish ---------- */

interface Tokens {
  access: string;
  refresh: string;
  exp: number; // ms
}

async function oauth(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { Authorization: CLIENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (/invalid_grant|bad credentials/i.test(text) && body.grant_type === "password") throw new Error("Login yoki parol noto'g'ri");
    throw new Error(`Uzum kirish xatosi ${res.status}: ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text);
  const p = j.payload ?? j;
  const access = p.access_token ?? p.accessToken ?? p.access;
  const refresh = p.refresh_token ?? p.refreshToken ?? p.refresh;
  if (!access) throw new Error("Uzum token qaytarmadi (SMS tasdiqlash so'ralayotgan bo'lishi mumkin)");
  const ttl = Number(p.expires_in ?? p.expiresIn ?? 3600);
  return { access, refresh, exp: Date.now() + Math.max(60, ttl - 60) * 1000 };
}

const passwordGrant = (login: string, password: string) => oauth({ grant_type: "password", username: normLogin(login), password, referer: "" });

async function getToken(env: Env, accId: string, force = false): Promise<string> {
  const key = `uzum:tok:${accId}`;
  const raw = await env.STATE.get(key);
  const t: Tokens | null = raw ? JSON.parse(raw) : null;
  if (t && !force && t.exp > Date.now()) return t.access;
  const acc = (await uzumAllAccounts(env)).find((a) => a.id === accId);
  if (!acc) throw new Error("Uzum profili topilmadi — qayta qo'shing");
  let fresh: Tokens | null = null;
  const errs: string[] = [];
  if (t?.refresh) {
    try {
      fresh = await oauth({ grant_type: "refresh_token", refresh_token: t.refresh });
    } catch (e) {
      errs.push((e as Error).message);
    }
  }
  // Saqlangan parol bilan qayta kirish
  if (!fresh) {
    let pass: string | undefined;
    if (acc.id === "env") pass = env.UZUM_PASSWORD;
    else if (acc.enc) pass = await decrypt(env, acc.enc).catch(() => undefined);
    if (pass) {
      try {
        fresh = await passwordGrant(acc.login, pass);
      } catch (e) {
        errs.push((e as Error).message);
      }
    }
  }
  if (!fresh) {
    await env.STATE.delete(key);
    throw new Error(
      `«${acc.label}» profili sessiyasi tugagan — «⚙️ Profillar» orqali parolni qayta kiriting.` + (errs.length ? ` (${errs.join("; ").slice(0, 150)})` : ""),
    );
  }
  await env.STATE.put(key, JSON.stringify(fresh));
  return fresh.access;
}

/* ---------- 🚦 So'rovlar tezligini cheklash (Uzum bloklamasligi uchun) ----------
 * Har bir profil bo'yicha: bir vaqtda ko'pi bilan 4 ta so'rov, ketma-ket so'rovlar orasida kamida 150 ms (≈6–7 so'rov/soniya).
 * Uzum 429/503 qaytarsa — profil «sovitiladi» (Retry-After yoki 30 s), bu vaqtda fon tekshiruvlari kutadi.
 */
const LIMIT = { conc: 4, gap: 150, maxWait: 8000 };
type Lane = { active: number; q: (() => void)[]; last: number; cool: number };
const lanes = new Map<string, Lane>();
const lane = (acc: string) => {
  let l = lanes.get(acc);
  if (!l) lanes.set(acc, (l = { active: 0, q: [], last: 0, cool: 0 }));
  return l;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Profil hozir Uzum tomonidan cheklanganmi (fon tekshiruvlari o'tkazib yuborsin) */
export const uzumCooling = (accId: string) => lane(accId.split("|")[0]).cool > Date.now();
async function acquire(acc: string) {
  const l = lane(acc);
  while (l.active >= LIMIT.conc) await new Promise<void>((r) => l.q.push(r));
  l.active++;
  const now = Date.now();
  if (l.cool - now > LIMIT.maxWait) {
    release(acc);
    throw new Error("Uzum hozir band — bir ozdan keyin qayta urinib ko'ring");
  }
  const start = Math.max(now, l.last + LIMIT.gap, l.cool);
  l.last = start;
  if (start > now) await sleep(start - now);
}
function release(acc: string) {
  const l = lane(acc);
  l.active = Math.max(0, l.active - 1);
  l.q.shift()?.();
}

async function uz<T = any>(env: Env, accId0: string, path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const accId = accId0.split("|")[0]; // "acc|u123" — mijoz doirasi, so'rov asl profil bilan
  const tok = await getToken(env, accId);
  await acquire(accId);
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Accept-Language": "uz", ...(init.headers ?? {}) },
    });
  } finally {
    release(accId);
  }
  if (res.status === 429 || res.status === 503) {
    const ra = Number(res.headers.get("retry-after")) || 30;
    lane(accId).cool = Date.now() + Math.min(ra, 300) * 1000;
    console.log(`🚦 Uzum ${res.status}: «${accId}» ${ra}s kutadi`);
    if (retry && ra <= 5) {
      await sleep(ra * 1000);
      return uz<T>(env, accId, path, init, false);
    }
    throw new Error("Uzum hozir band — bir ozdan keyin qayta urinib ko'ring");
  }
  if (res.status === 401 && retry) {
    await getToken(env, accId, true);
    return uz<T>(env, accId, path, init, false);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j.errors?.map((e: any) => e.detailMessage || e.message || e.code).join("; ") || msg;
    } catch {}
    throw new Error(`Uzum ${res.status}: ${msg}`);
  }
  if (!text) return {} as T;
  const j = JSON.parse(text);
  return (j && typeof j === "object" && "payload" in j && !Array.isArray(j) ? j.payload : j) as T;
}

/* ---------- Do'konlar ---------- */

export interface UzShop {
  id: number;
  name: string;
  acc: string;
}

async function fetchShops(env: Env, accId: string): Promise<UzShop[]> {
  const r = await uz<any[]>(env, accId, "/seller/shop/");
  return (Array.isArray(r) ? r : []).map((x) => ({ id: Number(x.id), name: String(x.shopTitle ?? x.title ?? x.name ?? x.id), acc: accId }));
}

/** Profil do'konlari (kesh 1 kun). UZUM_SHOPS berilgan bo'lsa va shu profilda mos do'kon bo'lsa — faqat ular */
export async function uzumShops(env: Env, accId: string): Promise<UzShop[]> {
  const ck = `uzum:shops:${accId}`;
  const cached = await env.STATE.get(ck);
  let shops: UzShop[];
  if (cached) shops = JSON.parse(cached);
  else {
    shops = await fetchShops(env, accId);
    await env.STATE.put(ck, JSON.stringify(shops), { expirationTtl: 86400 });
    const map: Record<string, string> = JSON.parse((await env.STATE.get(MAP_KEY)) ?? "{}");
    for (const s of shops) map[s.id] = accId;
    await env.STATE.put(MAP_KEY, JSON.stringify(map));
  }
  if (accId === (await svcAccId(env))) return shops; // xizmat hisobi — mijoz do'konlari, filtr yo'q
  const only = (env.UZUM_SHOPS ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean);
  const mine = shops.filter((s) => only.includes(s.id));
  return mine.length ? mine : shops;
}

/** Xizmat hisobining do'konlari — har doim yangidan (mijoz ulaganda) */
export async function uzumShopsFresh(env: Env, accId: string): Promise<UzShop[]> {
  await env.STATE.delete(`uzum:shops:${accId}`);
  return uzumShops(env, accId);
}
/** Do'konni profilga biriktirish (ro'yxatda ko'rinmasa ham kirish huquqi bo'lsa) */
export async function uzumBindShop(env: Env, shopId: number, accId: string) {
  const map: Record<string, string> = JSON.parse((await env.STATE.get(MAP_KEY)) ?? "{}");
  map[shopId] = accId;
  await env.STATE.put(MAP_KEY, JSON.stringify(map));
}
/** Profil shu do'kon nakladnoylarini ko'ra oladimi */
export async function uzumCanSeeShop(env: Env, accId: string, shopId: number): Promise<boolean> {
  try {
    await uz<any>(env, accId, `/seller/shop/${shopId}/invoice?page=0&size=1`);
    return true;
  } catch {
    return false;
  }
}

/** Do'kon qaysi profilga tegishli */
async function accOf(env: Env, shopId: number): Promise<string> {
  const map: Record<string, string> = JSON.parse((await env.STATE.get(MAP_KEY)) ?? "{}");
  if (map[shopId]) return map[shopId];
  for (const a of await uzumAllAccounts(env)) {
    const shops = await uzumShops(env, a.id).catch(() => []);
    if (shops.some((s) => s.id === shopId)) return a.id;
  }
  throw new Error("Bu do'kon hech bir ulangan profilga tegishli emas");
}

export async function shopName(env: Env, shopId: number): Promise<string> {
  const acc = await accOf(env, shopId);
  const raw = await env.STATE.get(`uzum:shops:${acc}`);
  return ((raw ? JSON.parse(raw) : []) as UzShop[]).find((s) => s.id === shopId)?.name ?? String(shopId);
}

/** Yangi profil qo'shish (yoki parolini yangilash). remember=true — parol shifrlangan holda saqlanadi */
export async function uzumAddAccount(env: Env, login: string, password: string, remember = true): Promise<UzAccount> {
  const tok = await passwordGrant(login, password);
  const list = await uzumAllAccounts(env);
  const norm = normLogin(login);
  let acc = list.find((a) => a.login === norm && a.id !== "env");
  if (!acc) {
    let n = 1;
    while (list.some((a) => a.id === `a${n}`)) n++;
    acc = { id: `a${n}`, login: norm, label: `Uzum profil ${n}` };
    list.push(acc);
  }
  acc.enc = remember ? await encrypt(env, password) : undefined;
  await env.STATE.put(`uzum:tok:${acc.id}`, JSON.stringify(tok));
  await env.STATE.delete(`uzum:shops:${acc.id}`);
  const nm = await ownerName(env, acc.id).catch(() => null);
  if (nm) {
    acc.label = nm;
    acc.named = true;
  }
  await saveAccounts(env, list);
  return acc;
}

export async function uzumRemoveAccount(env: Env, accId: string): Promise<void> {
  const list = (await uzumAllAccounts(env)).filter((a) => a.id !== accId);
  await saveAccounts(env, list);
  await env.STATE.delete(`uzum:tok:${accId}`);
  await env.STATE.delete(`uzum:shops:${accId}`);
  const map: Record<string, string> = JSON.parse((await env.STATE.get(MAP_KEY)) ?? "{}");
  for (const k of Object.keys(map)) if (map[k] === accId) delete map[k];
  await env.STATE.put(MAP_KEY, JSON.stringify(map));
}

/* ---------- Nakladnoylar ---------- */

/** f — FBO (omborga yetkazish), r — qaytarish (ombordan olish), s — FBS (keyin) */
export type UzKind = "f" | "r" | "s";
export const KIND_NAME: Record<UzKind, string> = { f: "📦 FBO ta'minlash", r: "↩️ Qaytarish", s: "🚚 FBS" };

export interface UzInvoice {
  kind: UzKind;
  id: number;
  number: string;
  created: string;
  status: string; // CREATED, ASSEMBLED, ...
  statusText: string;
  qty: number;
  price: number;
  pool: string;
  stock: string;
  type?: string; // qaytarish turi: FBS / Yaroqsiz ...
  freeUntil?: number; // qaytarish: bepul saqlash tugash vaqti
  slot?: { from: number; to: number };
  updatesLeft?: number;
}

/** Yakunlangan (vaqt tanlab bo'lmaydigan) holatlar */
const DONE = /ACCEPT|CANCEL|DECLIN|REJECT|CLOSED|ARCHIV|COMPLETE|ISSUED|RETURNED|DONE/i;

const RET_STATUS: Record<string, string> = {
  CREATED: "Yaratilgan",
  ASSEMBLING: "Yig'ilmoqda",
  ASSEMBLED: "Berishga tayyor",
  COMPLETED: "Berildi",
  CANCELED: "Bekor qilingan",
};
const RET_TYPE: Record<string, string> = { FBS: "FBS qaytarish", DEFECTED: "Yaroqsiz", DEFECT: "Yaroqsiz", FBO: "FBO qaytarish", SELLER: "Talabnoma" };

const slotOf = (x: any) =>
  x?.timeSlotReservation?.timeFrom ? { from: Number(x.timeSlotReservation.timeFrom), to: Number(x.timeSlotReservation.timeTo) } : undefined;

export async function uzumInvoices(env: Env, kind: UzKind, shopId: number, all = false): Promise<UzInvoice[]> {
  let list: UzInvoice[] = [];
  if (kind === "f") {
    const r = await uz<any[]>(env, await accOf(env, shopId), `/seller/shop/${shopId}/invoice?page=0&size=30`);
    list = (Array.isArray(r) ? r : []).map((x) => ({
      kind,
      id: Number(x.id),
      // Kabinetda 12 xonali ko'rinadi (oxirgi nazorat raqamisiz)
      number: ((n: string) => (n.length === 13 ? n.slice(0, 12) : n))(String(x.invoiceNumber ?? x.id)),
      created: String(x.dateCreated ?? ""),
      status: String(x.invoiceStatus?.value ?? x.status ?? ""),
      statusText: String(x.invoiceStatus?.text ?? x.status ?? ""),
      qty: Number(x.totalToStock ?? 0),
      price: Number(x.fullPrice ?? 0),
      pool: String(x.stock?.poolSource ?? "FULLFILMENT"),
      stock: String(x.stock?.title ?? "Ombor"),
      slot: slotOf(x),
      updatesLeft: x.remainingAmountOfUpdates ?? undefined,
    }));
  } else if (kind === "r") {
    const r = await uz<any[]>(env, await accOf(env, shopId), `/seller/shop/${shopId}/return?page=0&size=30`);
    list = (Array.isArray(r) ? r : []).map((x) => ({
      kind,
      id: Number(x.id),
      number: String(x.id),
      created: x.dateCreated ? new Date(Number(x.dateCreated)).toISOString() : "",
      status: String(x.status ?? ""),
      statusText: RET_STATUS[x.status] ?? String(x.status ?? ""),
      qty: Number(x.totalAmount ?? x.amount ?? 0),
      price: Number(x.totalPrice ?? 0),
      pool: String(x.stock?.poolSource ?? ""),
      stock: String(x.stock?.title ?? "Ombor"),
      type: RET_TYPE[x.type] ?? String(x.type ?? ""),
      freeUntil: x.paidStorage?.startDate ? Number(x.paidStorage.startDate) : undefined,
      slot: slotOf(x),
      updatesLeft: x.remainingAmountOfUpdates ?? undefined,
    }));
  } else {
    throw new Error("FBS nakladnoylari hali ulanmagan");
  }
  return all ? list : list.filter((i) => !DONE.test(i.status));
}

export async function uzumInvoice(env: Env, kind: UzKind, shopId: number, invoiceId: number): Promise<UzInvoice | null> {
  return (await uzumInvoices(env, kind, shopId, true)).find((i) => i.id === invoiceId) ?? null;
}

/* ---------- Slotlar ---------- */

export interface UzSlot {
  from: number;
  to: number;
}

/** Turga qarab manzil: FBO — v2/invoice, qaytarish — return */
const slotPath = (kind: UzKind, shopId: number, op: "get" | "set") =>
  kind === "r" ? `/seller/shop/${shopId}/return/time-slot/${op}` : `/seller/shop/${shopId}/v2/invoice/time-slot/${op}`;

export async function uzumSlots(env: Env, shopId: number, inv: UzInvoice): Promise<UzSlot[]> {
  const body: Record<string, unknown> = { invoiceIds: [inv.id], timeFrom: Date.now() };
  if (inv.kind === "f") body.poolSource = inv.pool;
  const r = await uz<any>(env, await accOf(env, shopId), slotPath(inv.kind, shopId, "get"), { method: "POST", body: JSON.stringify(body) });
  const slots: any[] = r?.timeSlots ?? [];
  return slots.map((s) => ({ from: Number(s.timeFrom), to: Number(s.timeTo) })).sort((a, b) => a.from - b.from);
}

/** Slotni band qilish (yoki o'zgartirish) */
export async function uzumReserve(env: Env, kind: UzKind, shopId: number, invoiceId: number, from: number, to: number): Promise<void> {
  await uz(env, await accOf(env, shopId), slotPath(kind, shopId, "set"), {
    method: "POST",
    body: JSON.stringify({ invoiceIds: [invoiceId], timeFrom: from, timeTo: to }),
  });
}

/** 🛡 Xavfsizlik: saqlangan login va parollarni ochish (faqat bot paroli tasdiqlangandan keyin chaqiriladi) */
export async function uzumRevealCredentials(env: Env): Promise<{ id: string; label: string; login: string; password: string | null }[]> {
  const out: { id: string; label: string; login: string; password: string | null }[] = [];
  for (const a of await uzumAllAccounts(env)) {
    let password: string | null = null;
    if (a.id === "env") password = env.UZUM_PASSWORD ?? null;
    else if (a.enc) password = await decrypt(env, a.enc).catch(() => null);
    out.push({ id: a.id, label: a.label, login: a.login, password });
  }
  return out;
}

/** Rekvizitlardagi F.I.Sh.: "Familiya I. O." (masalan: Gayratillayev S. S.) */
async function ownerName(env: Env, accId: string): Promise<string | null> {
  const r = await uz<any>(env, accId, "/seller/personalDetails");
  const pick = (d: any) => (d?.lastName ? d : null);
  const d = pick(r?.entrepreneurDetailsDto) ?? pick(r?.legalEntityDetailsDto) ?? pick(r?.personalDetailsDto);
  if (!d) return r?.entrepreneurDetailsDto?.accountName ?? null;
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
  const ini = (x?: string) => (x ? `${x.trim().charAt(0).toUpperCase()}.` : "");
  return [cap(String(d.lastName).trim()), ini(d.firstName), ini(d.patronymic)].filter(Boolean).join(" ");
}

/** Hali rekvizit nomi olinmagan profillarni nomlash (bir marta) */
export async function ensureNames(env: Env): Promise<void> {
  const list = await uzumAllAccounts(env);
  let changed = false;
  for (const a of list) {
    if (a.named) continue;
    const nm = await ownerName(env, a.id).catch(() => null);
    if (nm) {
      a.label = nm;
      a.named = true;
      changed = true;
    }
  }
  if (changed) await saveAccounts(env, list);
}

/* ---------- FBS (kabinet so'rovlari) ---------- */

/** Umumiy GET (FBS bo'limi uchun) */
export async function uzumGet<T = any>(env: Env, accId: string, path: string): Promise<T> {
  return uz<T>(env, accId, path);
}

export async function uzumPost<T = any>(env: Env, accId: string, path: string, body: unknown): Promise<T> {
  return uz<T>(env, accId, path, { method: "POST", body: JSON.stringify(body) });
}

/** FBS yorlig'i (58×40) — PDF baytlari */
export async function uzumFbsLabel(env: Env, accId: string, orderId: number, size = "LARGE"): Promise<Uint8Array> {
  const r = await uz<any>(env, accId, `/seller/fbs/order/${orderId}/labels/print?size=${size}`);
  return pdfBytes(String(r?.document ?? ""));
}
/** FBS ta'minlashning barcha yorliqlari — bitta PDF (Uzum bersa) */
export async function uzumFbsInvoiceLabels(env: Env, accId: string, invoiceId: number, size = "LARGE"): Promise<Uint8Array> {
  const r = await uz<any>(env, accId, `/seller/fbs/invoice/${invoiceId}/labels/print?size=${size}`);
  return pdfBytes(String(r?.document ?? ""));
}
function pdfBytes(s: string): Uint8Array {
  if (!s) throw new Error("Uzum PDF qaytarmadi");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Profilning sotuvchi ID si (FBS ta'minlashlar uchun kerak) — tokenni tekshirish orqali */
export async function uzumSellerId(env: Env, accId0: string): Promise<number> {
  const accId = accId0.split("|")[0];
  const ck = `uzum:seller:${accId}`;
  const c = await env.STATE.get(ck);
  if (c) return Number(c);
  const tok = await getToken(env, accId);
  const res = await fetch(`${BASE}/auth/seller/check_token`, {
    method: "POST",
    headers: { Authorization: CLIENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tok }).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  const id = Number(j.sellerId ?? j.payload?.sellerId ?? 0);
  if (!id) throw new Error("Uzum sotuvchi ID sini aniqlab bo'lmadi");
  await env.STATE.put(ck, String(id), { expirationTtl: 30 * 86400 });
  return id;
}

/** FBS: buyurtmani yig'ishga o'tkazish (Yangi -> Yig'ishda) */
export async function uzumFbsConfirm(env: Env, accId: string, orderId: number): Promise<void> {
  await uz(env, accId, `/seller/fbs/order/${orderId}/confirm`, { method: "POST" });
}

/** FBS: buyurtmani bekor qilish. reason: OUT_OF_STOCK | OUT_OF_PACKAGE | OUT_OF_TIME */
export async function uzumFbsCancel(env: Env, accId: string, orderId: number, reason: string): Promise<void> {
  await uz(env, accId, `/seller/fbs/order/${orderId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
}
