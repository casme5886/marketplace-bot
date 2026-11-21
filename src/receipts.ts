/**
 * 🧾 Karta orqali to'lov: mijoz kartaga o'tkazadi → ilovada chek suratini yuboradi →
 * admin ilovada chekni ko'radi va «Tasdiqlash» bosadi → obuna uzayadi.
 * Karta raqami va egasi admin panelda kiritiladi (KV: svc:card, svc:cardname).
 */
import type { Env } from "./types";
import * as CL from "./clients";
import { getOwner } from "./auth";
import { escapeHtml, sendDocument } from "./telegram";
import { notify, appMarkup } from "./notify";
import { MONTH_DAYS, payOptions, priceUzs } from "./payments";

export interface Receipt {
  id: string;
  uid: number;
  name: string;
  months: number;
  sum: number;
  t: number;
  status: "pending" | "ok" | "no";
  by?: number;
  at?: number;
}

const LIST = "rcpt:list";
const MAX_IMG = 1_500_000; // base64 belgilar (~1.1 MB)

export async function cardInfo(env: Env) {
  const [card, name] = await Promise.all([env.STATE.get("svc:card"), env.STATE.get("svc:cardname")]);
  return { card: card ?? "", name: name ?? "" };
}

export async function setCard(env: Env, card: string, name: string) {
  const digits = card.replace(/\D/g, "");
  if (digits && (digits.length < 16 || digits.length > 19)) throw new Error("Karta raqami 16 xonali bo'lsin");
  if (digits) await env.STATE.put("svc:card", digits.replace(/(\d{4})(?=\d)/g, "$1 "));
  else await env.STATE.delete("svc:card");
  if (name.trim()) await env.STATE.put("svc:cardname", name.trim().slice(0, 60));
  else await env.STATE.delete("svc:cardname");
}

async function list(env: Env): Promise<Receipt[]> {
  return JSON.parse((await env.STATE.get(LIST)) ?? "[]");
}
async function saveList(env: Env, l: Receipt[]) {
  await env.STATE.put(LIST, JSON.stringify(l.slice(0, 200)));
}

/** Mijoz chek yubordi (rasm: data:image/jpeg;base64,...) */
export async function submitReceipt(env: Env, uid: number, months: number, dataUrl: string): Promise<Receipt> {
  const c = await CL.getClient(env, uid);
  if (!c) throw new Error("Avval botda ro'yxatdan o'ting");
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Chek surati topilmadi");
  if (m[2].length > MAX_IMG) throw new Error("Surat juda katta");
  const l = await list(env);
  if (l.filter((r) => r.uid === uid && r.status === "pending").length >= 2) throw new Error("Oldingi chekingiz hali ko'rib chiqilmoqda");
  const opt = (await payOptions(env)).find((x) => x.months === months) ?? { months: 1, sum: await priceUzs(env) };
  const r: Receipt = { id: crypto.randomUUID().slice(0, 8), uid, name: c.name, months: opt.months, sum: opt.sum, t: Date.now(), status: "pending" };
  await env.STATE.put(`rcpt:img:${r.id}`, JSON.stringify({ mime: m[1], data: m[2] }), { expirationTtl: 90 * 86400 });
  l.unshift(r);
  await saveList(env, l);
  // Adminga: chek surati + ilovada ochish
  const owner = await getOwner(env);
  if (owner) {
    const caption = `🧾 Yangi to'lov cheki\n👤 ${c.name} · ${uid}\n💰 ${r.sum.toLocaleString("ru-RU")} so'm · ${r.months} oy\nIlovada: Admin panel → To'lov cheklari`;
    const bin = Uint8Array.from(atob(m[2]), (x) => x.charCodeAt(0));
    const mk = await appMarkup(env, { inline_keyboard: [] }, "admin");
    await sendDocument(env, owner, bin, `chek-${r.id}.${m[1].split("/")[1]}`, m[1], caption, mk?.inline_keyboard?.length ? mk : undefined).catch(() =>
      notify(env, owner, escapeHtml(caption), {}, "admin").catch(() => {}),
    );
  }
  return r;
}

export async function receiptsFor(env: Env, uid?: number) {
  const l = await list(env);
  return uid ? l.filter((r) => r.uid === uid).slice(0, 5) : l.slice(0, 60);
}

export async function receiptImage(env: Env, id: string): Promise<string> {
  const raw = await env.STATE.get(`rcpt:img:${id}`);
  if (!raw) throw new Error("Surat topilmadi");
  const x = JSON.parse(raw);
  return `data:${x.mime};base64,${x.data}`;
}

/** Admin: tasdiqlash yoki rad etish */
export async function decideReceipt(env: Env, by: number, id: string, ok: boolean, note = ""): Promise<string> {
  const l = await list(env);
  const r = l.find((x) => x.id === id);
  if (!r) throw new Error("Chek topilmadi");
  if (r.status !== "pending") throw new Error(r.status === "ok" ? "Allaqachon tasdiqlangan" : "Allaqachon rad etilgan");
  r.status = ok ? "ok" : "no";
  r.by = by;
  r.at = Date.now();
  await saveList(env, l);
  if (ok) {
    await CL.extendSub(env, r.uid, r.months * MONTH_DAYS);
    return `Tasdiqlandi: +${r.months * MONTH_DAYS} kun`;
  }
  await notify(env, r.uid, `❌ To'lov cheki tasdiqlanmadi.${note ? `\n${escapeHtml(note)}` : ""}\nSavol bo'lsa, admin bilan bog'laning.`, {}, "profile").catch(() => {});
  return "Rad etildi";
}
