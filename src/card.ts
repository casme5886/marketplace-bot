/**
 * Buyurtma kartochkasi: holatga qarab o'zgaradigan tugmalar.
 *  1) Yangi        → [✅ Qabul qilish va yig'ish] [❌ Bekor qilish]
 *  2) Yig'ildi     → [🏷 Yorliq] [🚚 Jo'natmaga qo'shish / Postavkani topshirish]
 *  3) Topshirildi  → [📄 Akt / 📦 Postavka QR] [🏷 Yorliq]
 *  4) Yetkazilmoqda / bekor → faqat 🔍 Batafsil
 */
import type { Env, StoredOrder } from "./types";
import { escapeHtml } from "./telegram";
import { fmtMoney, fmtTime, MP_ICON, MP_NAME, statusUz } from "./format";
import { OZON_CANCEL_REASONS } from "./ozon";

export type Stage = "new" | "packed" | "handed" | "done" | "cancelled";

export function stageOf(so: StoredOrder): Stage {
  const o = so.order;
  if (so.cancelled || o.status === "cancelled" || o.status === "cancel" || o.status === "reject") return "cancelled";
  if (o.mp === "ozon") {
    if (o.status === "delivering" || o.status === "delivered") return "done";
    if (so.handed || o.status === "handed") return "handed";
    if (o.status === "awaiting_deliver") return "packed";
    return "new";
  }
  if (["complete", "deliver", "receive"].includes(o.status) && !so.handed) return "done";
  if (so.handed) return "handed";
  if (o.status === "confirm" || so.supply) return "packed";
  return "new";
}

const HEADER: Record<Stage, string> = {
  new: "🆕 Yangi buyurtma",
  packed: "📦 Yig'ildi",
  handed: "🚚 Topshirishga tayyor",
  done: "✅ Yetkazilmoqda",
  cancelled: "❌ Bekor qilindi",
};

function hint(so: StoredOrder, st: Stage): string {
  const oz = so.order.mp === "ozon";
  switch (st) {
    case "new":
      return "👉 Qabul qilib, yig'ishga oling";
    case "packed":
      return oz
        ? "👉 Yorliqni qutiga yopishtiring, so'ng «🚚 Jo'natmaga qo'shish»"
        : "👉 Stikerni yopishtiring, so'ng «🚚 Postavkani topshirish»";
    case "handed":
      return oz ? "👉 Akt va buyurtmani topshirish punktiga olib boring" : "👉 Postavka QR-kodi bilan punktga olib boring";
    case "done":
      return "Punkt qabul qildi — mijozga ketmoqda";
    default:
      return "Bu buyurtma endi bajarilmaydi";
  }
}

/** Kartochka matni. detail=true — artikul, raqam, vaqtlar */
export function cardText(env: Env, so: StoredOrder, detail = false, note = ""): string {
  const o = so.order;
  const st = stageOf(so);
  const L = [`<b>${HEADER[st]}</b> · ${MP_ICON[o.mp]} ${MP_NAME[o.mp]}`, ""];
  for (const i of o.items) L.push(`📦 <b>${escapeHtml(i.name)}</b> × ${i.qty}`);
  L.push(`💰 ${fmtMoney(o.price, o.currency)}  ·  📍 ${escapeHtml(o.city)}`);
  if (o.deadline && (st === "new" || st === "packed" || st === "handed")) {
    const late = new Date(o.deadline).getTime() < Date.now();
    L.push(`${late ? "🚨 Muddat o'tgan" : "⏰ Topshirish"}: <b>${fmtTime(env, o.deadline)}</b>${late ? "" : " gacha"}`);
  }
  if (detail) {
    L.push("", `№ <code>${escapeHtml(o.id)}</code>`);
    for (const i of o.items) L.push(`🔖 Artikul: <code>${escapeHtml(i.article)}</code>`);
    L.push(`🕒 Qabul qilingan: ${fmtTime(env, o.createdAt)}`, `📌 Holat: ${escapeHtml(statusUz(o))}`);
    if (so.supply) L.push(`📦 Postavka: <code>${escapeHtml(so.supply)}</code>`);
    if (so.handed && o.mp === "ozon") L.push(`🚚 Jo'natma: <code>${escapeHtml(so.handed)}</code>`);
  }
  L.push("", `<i>${hint(so, st)}</i>`);
  if (note) L.push(`\n${escapeHtml(note)}`);
  return L.join("\n");
}

type Btn = { text: string; callback_data: string };

/** Holatga mos tugmalar */
export function cardKeyboard(so: StoredOrder, detail = false): { inline_keyboard: Btn[][] } {
  const o = so.order;
  const k = (a: string) => `k:${a}:${o.mp}:${o.id}`;
  const oz = o.mp === "ozon";
  const st = stageOf(so);
  const rows: Btn[][] = [];
  if (st === "new") {
    rows.push([{ text: "✅ Qabul qilish va yig'ish", callback_data: k("acc") }]);
    rows.push([{ text: "❌ Bekor qilish", callback_data: k("cx") }]);
  } else if (st === "packed") {
    rows.push([
      { text: oz ? "🏷 Yorliq" : "🏷 Stiker", callback_data: k("lbl") },
      { text: oz ? "🚚 Jo'natmaga qo'shish" : "🚚 Postavkani topshirish", callback_data: k("hand") },
    ]);
  } else if (st === "handed") {
    rows.push([
      oz ? { text: "📄 Akt", callback_data: k("act") } : { text: "📦 Postavka QR", callback_data: k("qr") },
      { text: oz ? "🏷 Yorliq" : "🏷 Stiker", callback_data: k("lbl") },
    ]);
  }
  rows.push([detail ? { text: "🔼 Qisqa", callback_data: k("min") } : { text: "🔍 Batafsil", callback_data: k("det") }]);
  return { inline_keyboard: rows };
}

/** ❌ bosilganda: sabab tanlash (Ozon) yoki darhol tasdiqlash (WB) */
export function cancelReasonKeyboard(so: StoredOrder): { inline_keyboard: Btn[][] } {
  const o = so.order;
  const rows: Btn[][] = [];
  if (o.mp === "ozon") {
    for (const r of OZON_CANCEL_REASONS) rows.push([{ text: r.text, callback_data: `k:cr:${o.mp}:${o.id}:${r.id}` }]);
  } else {
    rows.push([{ text: "🗑 Ha, bekor qilish", callback_data: `k:cy:${o.mp}:${o.id}:0` }]);
  }
  rows.push([{ text: "⬅️ Yo'q, ortga", callback_data: `k:back:${o.mp}:${o.id}` }]);
  return { inline_keyboard: rows };
}

export function cancelConfirmKeyboard(so: StoredOrder, reason: string): { inline_keyboard: Btn[][] } {
  const o = so.order;
  return {
    inline_keyboard: [
      [{ text: "🗑 Ha, bekor qilish", callback_data: `k:cy:${o.mp}:${o.id}:${reason}` }],
      [{ text: "⬅️ Yo'q, ortga", callback_data: `k:back:${o.mp}:${o.id}` }],
    ],
  };
}

export function handConfirmKeyboard(so: StoredOrder): { inline_keyboard: Btn[][] } {
  const o = so.order;
  return {
    inline_keyboard: [
      [{ text: "🚚 Ha, topshiraman", callback_data: `k:handy:${o.mp}:${o.id}` }],
      [{ text: "⬅️ Yo'q, ortga", callback_data: `k:back:${o.mp}:${o.id}` }],
    ],
  };
}
