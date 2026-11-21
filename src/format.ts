import type { Env, Order } from "./types";
import { escapeHtml } from "./telegram";
import { ozonStatusUz } from "./ozon";
import { wbStatusUz } from "./wb";

export const MP_NAME = { ozon: "Ozon", wb: "Wildberries" } as const;
export const MP_ICON = { ozon: "🔵", wb: "🟣" } as const;

export function tzOffset(env: Env): number {
  return Number(env.TIMEZONE_OFFSET_HOURS ?? "5");
}

/** "14.11 19:59" ko'rinishida (Toshkent vaqti) */
export function fmtTime(env: Env, iso?: string): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + tzOffset(env) * 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function fmtMoney(n: number, cur: string): string {
  const s = Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");
  return cur === "UZS" ? `${s} so'm` : `${s} ${cur}`;
}

export function statusUz(o: Order): string {
  return o.mp === "ozon" ? ozonStatusUz(o.status) : wbStatusUz(o.status);
}

export function itemsLine(o: Order): string {
  return o.items.map((i) => `${i.name} — ${i.qty} dona`).join("; ");
}

/** Vidjet yoki eski usuldagi xabar uchun matn (HTML) */
export function orderText(env: Env, o: Order, header = "🆕 Yangi buyurtma"): string {
  const lines = [
    `<b>${header}</b> · ${MP_ICON[o.mp]} ${MP_NAME[o.mp]}`,
    `№ <code>${escapeHtml(o.id)}</code>`,
    ...o.items.map((i) => `📦 ${escapeHtml(i.name)}\n     <i>${escapeHtml(i.article)}</i> × ${i.qty}`),
    `💰 ${fmtMoney(o.price, o.currency)}`,
    `📍 ${escapeHtml(o.city)}`,
    `🕒 Qabul: ${fmtTime(env, o.createdAt)}`,
  ];
  if (o.deadline) lines.push(`⏰ <b>Topshirish: ${fmtTime(env, o.deadline)} gacha</b>`);
  lines.push(`📌 ${statusUz(o)}`);
  return lines.join("\n");
}

/** Vidjet holati (chat_data, maksimal 1024 bayt) */
export function widgetData(env: Env, o: Order, note = ""): string {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const data = {
    m: MP_NAME[o.mp],
    k: o.mp,
    n: o.id,
    i: o.items.slice(0, 3).map((x) => [cut(x.name, 70), x.qty]),
    p: fmtMoney(o.price, o.currency),
    c: cut(o.city, 40),
    t: fmtTime(env, o.createdAt),
    d: o.deadline ? fmtTime(env, o.deadline) : "",
    s: statusUz(o),
    sh: o.canShip ? 1 : 0,
    x: cut(note, 60),
  };
  let json = JSON.stringify(data);
  // Xavfsizlik uchun: 1024 baytdan oshsa nomlarni qisqartiramiz
  while (new TextEncoder().encode(json).length > 1000 && data.i.length) {
    data.i = data.i.map(([n, q]) => [cut(String(n), Math.max(15, String(n).length - 15)), q]);
    json = JSON.stringify(data);
    if (data.i.every(([n]) => String(n).length <= 15)) break;
  }
  return json;
}
