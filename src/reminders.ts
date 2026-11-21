/**
 * ⏰ Bron eslatmalari: band qilingan vaqtdan 1 soat oldin «olib borish vaqti» xabari.
 * KV: remind:{at}:{rnd} → { chatId (0 — hamma), at, to, title, place, cb, extra? }
 */
import { notify } from "./notify";
import type { Env } from "./types";
import { escapeHtml, sendText } from "./telegram";
import { listAuthorizedChats } from "./auth";
import { fmtTime } from "./format";

export interface Reminder {
  chatId: number;
  at: number; // slot boshlanishi (ms)
  to: number; // slot tugashi (ms)
  title: string;
  place: string;
  cb?: string; // «Ochish» tugmasi
  labels?: string; // «🏷 Yorliqlar» tugmasi (FBS)
  shopId?: number; // mijoz do'koni bo'lsa — eslatma o'sha mijozga
}

const BEFORE = 3600e3;

export async function scheduleReminder(env: Env, r: Reminder) {
  if (!r.at || r.at - BEFORE < Date.now() - 60e3) return; // vaqt allaqachon yaqin/o'tgan
  const ttl = Math.max(120, Math.round((r.to - Date.now()) / 1000) + 3600);
  await env.STATE.put(`remind:${r.at}:${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(r), { expirationTtl: ttl });
}

/** Har daqiqada: vaqti kelgan eslatmalarni yuborish */
export async function checkReminders(env: Env): Promise<number> {
  const page = await env.STATE.list({ prefix: "remind:" });
  let n = 0;
  for (const k of page.keys) {
    const at = Number(k.name.split(":")[1]);
    if (!at || Date.now() < at - BEFORE) continue;
    const raw = await env.STATE.get(k.name);
    await env.STATE.delete(k.name);
    if (!raw) continue;
    const r: Reminder = JSON.parse(raw);
    if (Date.now() > r.to) continue; // vaqt o'tib ketgan
    const t1 = fmtTime(env, new Date(r.at).toISOString());
    const t2 = fmtTime(env, new Date(r.to).toISOString()).split(" ")[1];
    const text = [
      `⏰ <b>Eslatma: topshirish vaqti yaqinlashdi!</b>`,
      "",
      r.title,
      `📍 <b>Olib borasiz:</b> ${escapeHtml(r.place)}`,
      `🕒 <b>${t1}–${t2}</b> — soat <b>${t2}</b> gacha yetkazing`,
    ].join("\n");
    const rows: { text: string; callback_data: string }[][] = [];
    if (r.labels) rows.push([{ text: "🏷 Yorliqlar (PDF)", callback_data: r.labels }]);
    if (r.cb) rows.push([{ text: "📄 Ochish", callback_data: r.cb }]);
    const cu = !r.chatId && r.shopId ? Number(await env.STATE.get(`clshop:${r.shopId}`)) : 0;
    const chats = r.chatId ? [r.chatId] : cu ? [cu] : await listAuthorizedChats(env);
    for (const c of chats) await notify(env, c, text, rows.length ? { reply_markup: { inline_keyboard: rows } } : {}, "tasks").catch(() => {});
    n++;
  }
  return n;
}
