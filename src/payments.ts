/**
 * 💳 Obuna to'lovi — Telegram Payments orqali (provayder: Click yoki Payme).
 * Sozlash: BotFather → /mybots → bot → Payments → Click (yoki Payme) → token.
 * Tokenni .dev.vars (yoki Cloudflare secret) ga PAYMENT_PROVIDER_TOKEN=... deb yozing.
 * Narx: «🛎 Slot xizmati → 💰 Narx» dagi birinchi son (masalan «99 000 so'm/oy» → 99000).
 */
import type { Env } from "./types";
import { tg, escapeHtml } from "./telegram";
import * as CL from "./clients";
import { getOwner } from "./auth";
import { notify } from "./notify";

export const MONTH_DAYS = 30;
const PACKS: Record<string, { months: number; off: number }> = { "1": { months: 1, off: 0 }, "3": { months: 3, off: 0.1 } }; // 3 oy — 10% chegirma

export async function priceUzs(env: Env): Promise<number> {
  const p = (await CL.svcSettings(env)).price;
  const n = Number(String(p).replace(/[^\d]/g, "").slice(0, 9));
  return n >= 1000 ? n : 0;
}

export async function payReady(env: Env) {
  return !!(env as any).PAYMENT_PROVIDER_TOKEN && (await priceUzs(env)) > 0;
}

export async function payOptions(env: Env) {
  const base = await priceUzs(env);
  return Object.entries(PACKS).map(([k, v]) => ({ id: k, months: v.months, sum: Math.round((base * v.months * (1 - v.off)) / 100) * 100, off: v.off }));
}

/** Mini App uchun to'lov havolasi (Telegram ichida openInvoice bilan ochiladi) */
export async function createPayLink(env: Env, uid: number, pack: string): Promise<string> {
  const token = (env as any).PAYMENT_PROVIDER_TOKEN as string | undefined;
  if (!token) throw new Error("Onlayn to'lov hali ulanmagan — «To'lov qildim» orqali yuboring");
  const c = await CL.getClient(env, uid);
  if (!c) throw new Error("Avval botda ro'yxatdan o'ting");
  const opt = (await payOptions(env)).find((x) => x.id === pack);
  if (!opt || !opt.sum) throw new Error("Narx belgilanmagan");
  const r: any = await tg(env, "createInvoiceLink", {
    title: `MarketHub obuna — ${opt.months} oy`,
    description: `Uzum FBO/FBS slotlarini avtomatik band qilish · ${opt.months * MONTH_DAYS} kun`,
    payload: `sub:${uid}:${opt.months}:${opt.sum}`,
    provider_token: token,
    currency: "UZS",
    prices: [{ label: `${opt.months} oy`, amount: opt.sum * 100 }],
  });
  return typeof r === "string" ? r : r?.result ?? r;
}

/** pre_checkout_query — to'lovdan oldin tekshirish (10 s ichida javob kerak) */
export async function onPreCheckout(env: Env, q: any) {
  const [kind, uid, months, sum] = String(q.invoice_payload ?? "").split(":");
  let ok = kind === "sub" && Number(uid) === Number(q.from?.id) && Number(q.total_amount) === Number(sum) * 100 && q.currency === "UZS";
  if (ok) ok = !!(await CL.getClient(env, Number(uid)));
  await tg(env, "answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: "To'lov ma'lumotlari mos kelmadi. Ilovadan qayta urinib ko'ring." });
  void months;
}

/** successful_payment — obunani uzaytirish (bir to'lov bir marta) */
export async function onPaid(env: Env, m: any) {
  const p = m.successful_payment;
  const [kind, uid, months, sum] = String(p?.invoice_payload ?? "").split(":");
  if (kind !== "sub") return;
  const ch = String(p.telegram_payment_charge_id ?? "");
  if (ch && (await env.STATE.get(`paid:${ch}`))) return;
  if (ch) await env.STATE.put(`paid:${ch}`, `${uid}:${months}:${sum}`, { expirationTtl: 400 * 86400 });
  await CL.extendSub(env, Number(uid), Number(months) * MONTH_DAYS);
  const owner = await getOwner(env);
  const c = await CL.getClient(env, Number(uid));
  if (owner)
    await notify(env, owner, `💳 <b>Onlayn to'lov</b>\n👤 ${escapeHtml(c?.name ?? String(uid))} · <code>${uid}</code>\n💰 ${Number(sum).toLocaleString("ru-RU")} so'm · ${months} oy\n🧾 ${escapeHtml(p.provider_payment_charge_id ?? "")}`, {}, "admin").catch(() => {});
}
