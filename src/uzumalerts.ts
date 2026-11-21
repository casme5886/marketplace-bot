/**
 * 🔔 Uzum avtomatik xabarlari:
 *  1) Yangi FBS buyurtma tushsa — darhol xabar (tugmalar: yig'ishga o'tkazish / bekor qilish).
 *  2) Qoldiq kamaysa — Uzum omborida (FBO) yoki o'zingizda (FBS) 5 donadan kam qolsa yoki tugasa.
 */
import { notify } from "./notify";
import type { Env } from "./types";
import { escapeHtml, sendText } from "./telegram";
import { fmtTime } from "./format";
import { listAuthorizedChats } from "./auth";
import { uzumAccounts, uzumFbsConfirm, uzumGet, uzumShops } from "./uzum";
import { skuLine } from "./uzumfbs";

type Btn = { text: string; callback_data: string; style?: string };
const qs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ")} so'm`;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function broadcast(env: Env, text: string, rows: Btn[][]) {
  for (const chat of await listAuthorizedChats(env)) {
    await notify(env, chat, text, { reply_markup: { inline_keyboard: rows } }, "orders").catch((e) => console.log("xabar:", (e as Error).message));
  }
}

/* ---------- 1) Yangi FBS buyurtmalar ---------- */

export async function checkUzumNewFbs(env: Env): Promise<number> {
  let sent = 0;
  for (const a of await uzumAccounts(env)) {
    try {
      const shops = await uzumShops(env, a.id);
      const ids = shops.map((s) => s.id).join(",");
      const names = new Map(shops.map((s) => [s.id, s.name]));
      const cnt = await uzumGet<any>(env, a.id, `/seller/fbs/orders/count?${qs({ scheme: "FBS", statuses: "CREATED", shopIds: ids, places: "STOCK,DROP_OFF" })}`);
      const created = Number((cnt?.ordersCount ?? []).find((x: any) => x.status === "CREATED")?.counter ?? 0);
      const key = `uzfbs:seen:${a.id}`;
      const raw = await env.STATE.get(key);
      const seen: string[] = raw ? JSON.parse(raw) : [];
      if (!created) {
        if (!raw) await env.STATE.put(key, "[]");
        continue;
      }
      const orders: any[] = [];
      for (let page = 0; page < 3; page++) {
        const r = await uzumGet<any>(env, a.id, `/seller/fbs/v2/orders?${qs({ page, size: 20, sortBy: "CREATED_DATE", sortOrder: "DESC", scheme: "FBS", statuses: "CREATED", shopIds: ids, places: "STOCK,DROP_OFF" })}`);
        const l: any[] = r?.orders ?? [];
        orders.push(...l);
        if (l.length < 20) break;
      }
      const fresh = orders.filter((o) => !seen.includes(String(o.id)));
      const next = [...orders.map((o) => String(o.id)), ...seen.filter((x) => !orders.some((o) => String(o.id) === x))].slice(0, 500);
      await env.STATE.put(key, JSON.stringify(next));
      if (!raw) continue; // birinchi ishga tushish — eski buyurtmalar haqida yozmaymiz
      for (const o of fresh.reverse()) {
        const L = [`🆕 <b>Uzum FBS — yangi buyurtma!</b>`, "", `№ <code>${o.id}</code> · 🛍 <b>${escapeHtml(names.get(o.shopId) ?? String(o.shopId))}</b>`];
        for (const it of (o.orderItems ?? []).slice(0, 5)) L.push(`   🏷 <b>${escapeHtml(cut(skuLine(it), 50))}</b> × ${it.amount ?? 1}`);
        L.push(`   💰 ${money(Number(o.price ?? 0))}`);
        if (o.deliverUntil) L.push(`   ⏰ Topshirish: <b>${fmtTime(env, new Date(Number(o.deliverUntil)).toISOString())}</b> gacha`);
        await broadcast(env, L.join("\n"), [
          [{ text: "📦 Yig'ishga o'tkazish", callback_data: `u:fcn:${a.id}:${o.id}`, style: "success" }],
          [{ text: "🆕 Barcha yangilar", callback_data: `u:fs:${a.id}:NEW:0` }, { text: "❌ Bekor qilish", callback_data: `u:fxo:${a.id}:${o.id}`, style: "danger" }],
        ]);
        sent++;
      }
    } catch (e) {
      console.log("uzum fbs yangi:", (e as Error).message);
    }
  }
  return sent;
}

/** Xabardagi «Yig'ishga o'tkazish» tugmasi */
export async function confirmFromNotice(env: Env, acc: string, id: number) {
  let text: string;
  try {
    await uzumFbsConfirm(env, acc, id);
    text = `✅ № <code>${id}</code> yig'ishga o'tkazildi.\n\nYig'ib bo'lgach — ta'minlashga o'tkazing 👇`;
  } catch (e) {
    text = `⚠️ № <code>${id}</code> ni yig'ishga o'tkazib bo'lmadi: ${escapeHtml(cut((e as Error).message, 150))}`;
  }
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧾 Ta'minlashga o'tkazish", callback_data: `u:ft:${acc}` }, { text: "🏷 Yorliq (PDF)", callback_data: `u:flo:${acc}:${id}` }],
        [{ text: "📦 Yig'ishdagilar", callback_data: `u:fs:${acc}:PCK:0` }, { text: "🏠 Menyu", callback_data: "m:home" }],
      ],
    },
  };
}

/* ---------- 2) Qoldiq ogohlantirishi ---------- */

export const STOCK_LOW = 5;
interface Snap {
  a: number; // Uzum omborida (FBO)
  f: number; // o'zingizda (FBS)
  s: number; // jami sotilgan
  s0: number; // sotuv hisobini boshlagandagi soni
  t0: number; // ... va vaqti
}

export async function checkStock(env: Env): Promise<number> {
  const snapRaw = await env.STATE.get("stock:snap");
  const first = !snapRaw;
  const snap: Record<string, Snap> = snapRaw ? JSON.parse(snapRaw) : {};
  const alerts: { shop: string; acc: string; line: string }[] = [];
  for (const a of await uzumAccounts(env)) {
    for (const s of await uzumShops(env, a.id).catch(() => [])) {
      try {
        for (let page = 0; page < 20; page++) {
          const r = await uzumGet<any>(env, a.id, `/seller/shop/${s.id}/product/getProducts?${qs({ page, size: 100, filter: "ALL" })}`);
          const list: any[] = r?.productList ?? [];
          for (const p of list) {
            for (const k of p.skuList ?? []) {
              if (k.archived) continue;
              const id = String(k.skuId);
              const cur = { a: Number(k.quantityActive ?? 0), f: Number(k.quantityFbs ?? 0), s: Number(k.quantitySold ?? 0) };
              const prev = snap[id];
              // Sotuv tezligi: oxirgi 14 kun ichidagi o'rtacha (kuniga)
              let s0 = prev?.s0 ?? cur.s, t0 = prev?.t0 ?? Date.now();
              if (Date.now() - t0 > 14 * 86400e3) (s0 = prev?.s ?? cur.s), (t0 = Date.now() - 86400e3);
              snap[id] = { ...cur, s0, t0 };
              if (first || !prev) continue;
              const days = Math.max(1, (Date.now() - t0) / 86400e3);
              const perDay = (cur.s - s0) / days;
              const left = (q: number) => (perDay > 0.2 ? ` · ≈${Math.max(0, Math.round(q / perDay))} kunlik (kuniga ~${perDay < 1 ? perDay.toFixed(1) : Math.round(perDay)} ta)` : "");
              const name = escapeHtml(cut(String(k.skuFullTitle || k.skuTitle || k.productTitle || id), 45));
              for (const [where, was, now] of [["🏭 Uzum omborida", prev.a, cur.a], ["🏠 FBS (o'zingizda)", prev.f, cur.f]] as [string, number, number][]) {
                if (was > 0 && now === 0) alerts.push({ shop: s.name, acc: a.id, line: `🔴 <b>${name}</b> — ${where} <b>tugadi</b>` });
                else if (was > STOCK_LOW && now > 0 && now <= STOCK_LOW) alerts.push({ shop: s.name, acc: a.id, line: `🟠 <b>${name}</b> — ${where} <b>${now} dona</b> qoldi${left(now)}` });
              }
            }
          }
          if (list.length < 100) break;
        }
      } catch (e) {
        console.log("qoldiq:", s.name, (e as Error).message);
      }
    }
  }
  await env.STATE.put("stock:snap", JSON.stringify(snap));
  if (!alerts.length) return 0;
  const L = ["⚠️ <b>Uzum: qoldiq kamaymoqda</b>", ""];
  for (const shop of [...new Set(alerts.map((x) => x.shop))]) {
    L.push(`🛍 <b>${escapeHtml(shop)}</b>`);
    for (const x of alerts.filter((y) => y.shop === shop).slice(0, 15)) L.push(x.line);
    L.push("");
  }
  L.push(`<i>Chegara: ${STOCK_LOW} dona. Ta'minlashni o'z vaqtida qiling.</i>`);
  await broadcast(env, L.join("\n").slice(0, 4000), [[{ text: "📦 FBO ta'minlash", callback_data: "u:fbo", style: "primary" }, { text: "🏠 Menyu", callback_data: "m:home" }]]);
  return alerts.length;
}
