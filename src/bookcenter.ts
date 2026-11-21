/**
 * 🎯 Bron markazi — barcha nakladnoylar bitta ekranda:
 *  🚚 FBS: yig'ishdagilar (ta'minlash kerak), faol ta'minlashlar vaqti, avto bron holati
 *  📦 FBO va ↩️ qaytarishlar: vaqt bormi / yo'qmi / qidirilyaptimi (⚡)
 * Har bir qatordan bitta bosishda — vaqt tanlash yoki avto bron.
 */
import type { Env } from "./types";
import { escapeHtml } from "./telegram";
import { fmtTime } from "./format";
import { uzumAccounts, uzumGet, uzumInvoices, uzumSellerId, uzumShops, type UzInvoice } from "./uzum";

type Btn = { text: string; callback_data: string; style?: string };
const qs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const t = (env: Env, ms: number) => fmtTime(env, new Date(ms).toISOString());

export async function bookCenter(env: Env): Promise<{ text: string; reply_markup: { inline_keyboard: Btn[][] } }> {
  const L = ["🎯 <b>Bron markazi</b>", "<i>Barcha nakladnoylar va bronlar bitta joyda</i>", ""];
  const rows: Btn[][] = [];
  const accs = await uzumAccounts(env);

  // 🚚 FBS
  L.push("🚚 <b>FBS</b>");
  for (const a of accs) {
    try {
      const shops = await uzumShops(env, a.id);
      const ids = shops.map((s) => s.id).join(",");
      const c = await uzumGet<any>(env, a.id, `/seller/fbs/orders/count?${qs({ scheme: "FBS", statuses: "CREATED", shopIds: ids, places: "STOCK,DROP_OFF" })}`);
      const cnt = (st: string) => Number((c?.ordersCount ?? []).find((x: any) => x.status === st)?.counter ?? 0);
      const fresh = cnt("CREATED"), pck = cnt("PACKING");
      const sellerId = await uzumSellerId(env, a.id);
      const inv = await uzumGet<any[]>(env, a.id, `/seller/fbs/invoice?${qs({ sellerId, statuses: "CREATED,ACCEPTANCE_IN_PROGRESS", page: 0, size: 5 })}`).catch(() => []);
      const raw = await env.STATE.get(`fbswatch:${a.id}`);
      const w = raw ? JSON.parse(raw) : null;
      const who = accs.length > 1 ? ` · 👤 ${escapeHtml(a.label)}` : "";
      L.push(`🆕 yangi <b>${fresh}</b> · 📦 yig'ishda <b>${pck}</b>${who}`);
      for (const x of (Array.isArray(inv) ? inv : []).slice(0, 3)) {
        const ts = x.timeSlot?.timeFrom ? `${t(env, Number(x.timeSlot.timeFrom))}–${t(env, Number(x.timeSlot.timeTo)).split(" ")[1]}` : "vaqt yo'q";
        L.push(`   🧾 № ${escapeHtml(String(x.number ?? x.id))} · ✅ ${ts} · ${x.numberOrders ?? 0} ta`);
      }
      if (w) L.push(`   ${w.auto ? "⚡ Avto bron" : "🔔 Kuzatuv"}: ${escapeHtml(cut(String(w.label), 40))}`);
      const r: Btn[] = [];
      if (fresh) r.push({ text: `🆕 Yangilar (${fresh})`, callback_data: `u:fs:${a.id}:NEW:0` });
      if (pck) r.push({ text: `🧾 Ta'minlashga (${pck})`, callback_data: `u:ft:${a.id}`, style: "success" });
      if (r.length) rows.push(r);
      if (w) rows.push([{ text: `${w.auto ? "⚡ FBS avto bron" : "🔔 FBS kuzatuv"} — holat`, callback_data: `u:fws:${a.id}`, style: "primary" }]);
      else if (pck) rows.push([{ text: "📍 FBS avto bron qo'yish", callback_data: `u:ft:${a.id}` }]);
    } catch (e) {
      L.push(`⚠️ ${escapeHtml(cut((e as Error).message, 80))}`);
    }
  }

  // 📦 FBO + ↩️ qaytarishlar
  L.push("", "📦 <b>FBO va qaytarishlar</b>");
  const wl = await env.STATE.list({ prefix: "uwatch:" });
  const watched = new Map<string, boolean>();
  for (const k of wl.keys) {
    const [, kind, shop, inv] = k.name.split(":");
    const raw = await env.STATE.get(k.name);
    watched.set(`${kind}:${shop}:${inv}`, raw ? !!JSON.parse(raw).auto : false);
  }
  let any = false;
  for (const a of accs) {
    for (const s of await uzumShops(env, a.id).catch(() => [])) {
      const lists = await Promise.all((["f", "r"] as const).map((k) => uzumInvoices(env, k, s.id).catch(() => [] as UzInvoice[])));
      const all = [...lists[0], ...lists[1]];
      if (!all.length) continue;
      any = true;
      L.push(`🛍 <b>${escapeHtml(s.name)}</b>`);
      for (const i of all.slice(0, 6)) {
        const key = `${i.kind}:${s.id}:${i.id}`;
        const w = watched.get(key);
        const icon = i.kind === "f" ? "📄" : "↩️";
        const st = i.slot ? `✅ ${t(env, i.slot.from)}` : w !== undefined ? (w ? "⚡ avto bron" : "🔍 qidirilmoqda") : "⏳ vaqt yo'q";
        const warn = i.freeUntil && i.freeUntil < Date.now() ? " · 💸 pullik saqlash" : "";
        L.push(`   ${icon} № ${escapeHtml(i.number)} · ${st}${warn}`);
        if (i.slot) rows.push([{ text: `${icon} №…${i.number.slice(-4)} · ✅ ${t(env, i.slot.from)}`, callback_data: `u:i:${i.kind}:${s.id}:${i.id}:0` }]);
        else if (w !== undefined) rows.push([{ text: `${icon} №…${i.number.slice(-4)} · ${w ? "⚡ avto bron" : "🔍 qidiruv"} — holat`, callback_data: `u:ws:${i.kind}:${s.id}:${i.id}`, style: "primary" }]);
        else
          rows.push([
            { text: `${icon} №…${i.number.slice(-4)} · 🕒 vaqt tanlash`, callback_data: `u:i:${i.kind}:${s.id}:${i.id}:0` },
            { text: "⚡ Avto bron", callback_data: `u:fbp:${i.kind}:${s.id}:${i.id}:x`, style: "success" },
          ]);
      }
    }
  }
  if (!any) L.push("Faol nakladnoy yo'q ✅");
  L.push("", `<i>🔄 ${t(env, Date.now())}</i>`);
  rows.push([{ text: "🔄 Yangilash", callback_data: "u:bm" }, { text: "🔔 Kuzatuvlar", callback_data: "u:wl" }]);
  rows.push([{ text: "🟪 Uzum Market", callback_data: "u:home" }, { text: "🏠 Menyu", callback_data: "m:home" }]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows.slice(0, 40) } };
}
