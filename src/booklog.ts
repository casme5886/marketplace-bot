/** 📒 Olingan slotlar jurnali (Mini App «Olingan slotlar» uchun) — har do'kon bo'yicha oxirgi 30 ta */
import type { Env } from "./types";

export interface BookRec {
  shopId: number;
  kind: string; // f — FBO, r — qaytarish
  invId: number;
  invNo: string;
  from: number;
  to: number;
  stock: string;
  auto: boolean;
  t: number;
}

export async function logBooking(env: Env, r: Omit<BookRec, "t">) {
  try {
    const key = `bklog:${r.shopId}`;
    const list: BookRec[] = JSON.parse((await env.STATE.get(key)) ?? "[]");
    list.unshift({ ...r, t: Date.now() });
    await env.STATE.put(key, JSON.stringify(list.slice(0, 30)));
  } catch (e) {
    console.log("booklog:", (e as Error).message);
  }
}

export async function bookings(env: Env, shopIds: number[]): Promise<BookRec[]> {
  const out: BookRec[] = [];
  for (const id of shopIds) out.push(...(JSON.parse((await env.STATE.get(`bklog:${id}`)) ?? "[]") as BookRec[]));
  return out.sort((a, b) => b.t - a.t);
}
