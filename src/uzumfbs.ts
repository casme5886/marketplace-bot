/**
 * 🟪 Uzum Market: bosh ekran (FBO / FBS / DBS) va FBS bo'limi.
 * FBS: holatlar bo'yicha buyurtmalar soni, buyurtmalar ro'yxati va FBS ta'minlashlar (nakladnoylar) vaqti bilan.
 * Callback'lar: u:home | u:fbs | u:fa:{acc} | u:fs:{acc}:{status}:{page} | u:fi:{acc}:{page} | u:dbs
 */
import { notify } from "./notify";
import type { Env } from "./types";
import { escapeHtml, sendDocument, sendText } from "./telegram";
import { scheduleReminder } from "./reminders";
import { fmtTime } from "./format";
import { uzumAccounts, uzumCooling, uzumFbsCancel, uzumFbsConfirm, uzumFbsInvoiceLabels, uzumFbsLabel, uzumGet, uzumPost, uzumSellerId, uzumShops } from "./uzum";

type Btn = { text: string; callback_data: string; style?: string };
export interface FScreen {
  text: string;
  reply_markup: { inline_keyboard: Btn[][] };
}
const back = (to: string, text = "⬅️ Orqaga"): Btn => ({ text, callback_data: to });

/** Kabinetdagi tablar bilan bir xil tartib */
export const FBS_STATUSES: { s: string; t: string; icon: string }[] = [
  { s: "CREATED", t: "Yangilar", icon: "🆕" },
  { s: "PACKING", t: "Yig'ishdagilar", icon: "📦" },
  { s: "PENDING_DELIVERY", t: "Ta'minlashda", icon: "🚚" },
  { s: "DELIVERED", t: "Uzum qabul qilgan", icon: "✅" },
  { s: "DELIVERED_TO_CUSTOMER_DELIVERY_POINT", t: "Topshirishni kutyapti", icon: "🛍" },
  { s: "COMPLETED", t: "Topshirilganlar", icon: "🎉" },
  { s: "CANCELED", t: "Bekor qilinganlar", icon: "❌" },
  { s: "RETURNED", t: "Qaytarishlar", icon: "↩️" },
];
const SHORT: Record<string, string> = {
  CREATED: "NEW",
  PACKING: "PCK",
  PENDING_DELIVERY: "PND",
  DELIVERED: "DLV",
  DELIVERED_TO_CUSTOMER_DELIVERY_POINT: "DP",
  COMPLETED: "CMP",
  CANCELED: "CNL",
  RETURNED: "RET",
};
const LONG = Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [v, k]));

const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ")} so'm`;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const qs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

/** Tovar qatori: SKU nomi + (bir nechta modeli bo'lsa) model. Mahsulot nomi ko'rsatilmaydi. */
export function skuLine(it: any): string {
  const sku = String(it.skuTitle ?? it.sellerSkuCode ?? it.barcode ?? "SKU").trim();
  // Model/variant: nom oxiridagi "(Model:: 13 Pro)" yoki "(Rang: qora, Hajm: 50 ml)" qismi
  const m = String(it.title ?? "").match(/\(([^()]*:[^()]*)\)\s*$/);
  let model = m ? m[1].split(",").map((x) => x.split(/::?/).slice(1).join(":").trim()).filter(Boolean).join(", ") : "";
  if (!model && it.sellerSkuCode && String(it.sellerSkuCode).trim() !== sku) model = String(it.sellerSkuCode).trim();
  return model ? `${sku} · ${model}` : sku;
}

async function shopIds(env: Env, acc: string) {
  // Mijoz doirasi "svcAcc|u<uid>": faqat shu mijozning do'konlari
  const m = acc.match(/\|u(\d+)$/);
  if (m) {
    const raw = await env.STATE.get(`cl:${m[1]}`);
    const cs: { id: number; name: string }[] = raw ? JSON.parse(raw).shops ?? [] : [];
    if (!cs.length) throw new Error("Do'kon ulanmagan");
    return { ids: cs.map((s) => s.id).join(","), names: new Map(cs.map((s) => [s.id, s.name])) };
  }
  const shops = await uzumShops(env, acc);
  return { ids: shops.map((s) => s.id).join(","), names: new Map(shops.map((s) => [s.id, s.name])) };
}

async function counts(env: Env, acc: string): Promise<Record<string, number>> {
  const { ids } = await shopIds(env, acc);
  const r = await uzumGet<any>(env, acc, `/seller/fbs/orders/count?${qs({ scheme: "FBS", statuses: "CREATED", shopIds: ids, places: "STOCK,DROP_OFF" })}`);
  const out: Record<string, number> = {};
  for (const x of r?.ordersCount ?? []) out[x.status] = Number(x.counter ?? 0);
  return out;
}

/* ---------- 🟪 Uzum Market bosh ekrani ---------- */

export async function uzumHome(env: Env): Promise<FScreen> {
  const accs = await uzumAccounts(env);
  let fresh = 0, packing = 0, err = "";
  for (const a of accs) {
    try {
      const c = await counts(env, a.id);
      fresh += c.CREATED ?? 0;
      packing += c.PACKING ?? 0;
    } catch (e) {
      err = (e as Error).message;
    }
  }
  const L = ["<b>🟪 Uzum Market</b>", "", "Ishlash modelini tanlang 👇", ""];
  L.push(`🚚 <b>FBS</b> — o'z omboringizdan: 🆕 yangi <b>${fresh}</b> · 📦 yig'ishda <b>${packing}</b>`);
  L.push("📦 <b>FBO</b> — Uzum omboridan: ta'minlash va qaytarishlarga vaqt tanlash");
  L.push("🏍 <b>DBS</b> — o'zingiz yetkazasiz: <i>tez kunda</i>");
  if (err) L.push("", `⚠️ ${escapeHtml(cut(err, 150))}`);
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎯 Bron markazi — barcha nakladnoylar", callback_data: "u:bm", style: "primary" }],
        [
          { text: `🚚 FBS${fresh + packing ? ` (${fresh + packing})` : ""}`, callback_data: "u:fbs", style: "success" },
          { text: "📦 FBO", callback_data: "u:fbo", style: "primary" },
        ],
        [{ text: "🏍 DBS · tez kunda", callback_data: "u:dbs", style: "danger" }],
        [{ text: "🔎 Yo'qolgan tovarlarni topish", callback_data: "u:lost" }],
        [{ text: "⚙️ Profillar", callback_data: "u:am" }, { text: "🔔 Kuzatuvlar", callback_data: "u:wl" }],
        [back("m:home", "🏠 Menyu")],
      ],
    },
  };
}

export function dbsScreen(): FScreen {
  return {
    text: "🏍 <b>DBS</b> — buyurtmani o'zingiz mijozga yetkazasiz.\n\n⏳ Bu bo'lim <b>tez kunda</b> qo'shiladi.",
    reply_markup: { inline_keyboard: [[back("u:home")]] },
  };
}

/* ---------- 🚚 FBS ---------- */

/** FBS: profil tanlash (bitta bo'lsa — darhol holatlar) */
export async function fbsRoot(env: Env): Promise<FScreen> {
  const accs = await uzumAccounts(env);
  if (accs.length === 1) return fbsAccount(env, accs[0].id, false);
  return {
    text: "<b>🚚 Uzum FBS</b>\n\nProfilni tanlang 👇",
    reply_markup: { inline_keyboard: [...accs.map((a) => [{ text: `👤 ${a.label}`, callback_data: `u:fa:${a.id}` }]), [back("u:home")]] },
  };
}

export async function fbsAccount(env: Env, acc: string, multi = true): Promise<FScreen> {
  const a = (await uzumAccounts(env)).find((x) => x.id === acc);
  const c = await counts(env, acc);
  const L = [`<b>🚚 Uzum FBS</b>${a ? ` · 👤 ${escapeHtml(a.label)}` : ""}`, ""];
  for (const st of FBS_STATUSES) L.push(`${st.icon} ${st.t}: <b>${c[st.s] ?? 0}</b>`);
  L.push("", `<i>🔄 ${fmtTime(env, new Date().toISOString())}</i>`);
  const btn = (st: (typeof FBS_STATUSES)[number]): Btn => ({ text: `${st.icon} ${st.t} (${c[st.s] ?? 0})`, callback_data: `u:fs:${acc}:${SHORT[st.s]}:0` });
  const rows: Btn[][] = [];
  for (let i = 0; i < 6; i += 2) rows.push([btn(FBS_STATUSES[i]), btn(FBS_STATUSES[i + 1])]);
  rows.push([btn(FBS_STATUSES[6]), btn(FBS_STATUSES[7])]);
  if (c.CREATED) rows.unshift([{ text: `📦 Yangilarni yig'ishga o'tkazish (${c.CREATED})`, callback_data: `u:fs:${acc}:NEW:0`, style: "success" }]);
  if (c.PACKING) rows.unshift([{ text: `🧾 Yig'ishdagilarni ta'minlashga o'tkazish (${c.PACKING})`, callback_data: `u:ft:${acc}`, style: "primary" }]);
  if (await env.STATE.get(fwKey(acc))) rows.push([{ text: "🔔 FBS slot kuzatilmoqda — ko'rish", callback_data: `u:fws:${acc}`, style: "primary" }]);
  rows.push([{ text: "🧾 Ta'minlashlar (nakladnoylar)", callback_data: `u:fi:${acc}:0` }]);
  rows.push([back(multi ? "u:fbs" : "u:home"), { text: "🔄 Yangilash", callback_data: `u:fa:${acc}` }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

const PAGE = 8;

export async function fbsOrders(env: Env, acc: string, short: string, page: number, note = ""): Promise<FScreen> {
  const status = LONG[short] ?? "CREATED";
  const meta = FBS_STATUSES.find((x) => x.s === status)!;
  const { ids, names } = await shopIds(env, acc);
  const r = await uzumGet<any>(
    env,
    acc,
    `/seller/fbs/v2/orders?${qs({ page, size: PAGE, sortBy: "CREATED_DATE", sortOrder: "DESC", scheme: "FBS", statuses: status, shopIds: ids, places: "STOCK,DROP_OFF" })}`,
  );
  const orders: any[] = r?.orders ?? [];
  const total = Number((await counts(env, acc))[status] ?? orders.length);
  const L = [`<b>${meta.icon} FBS · ${meta.t}</b> (${total})`, ""];
  if (note) L.push(note, "");
  if (!orders.length) L.push("Bu holatda buyurtma yo'q ✅");
  for (const o of orders) {
    const items: any[] = o.orderItems ?? [];
    L.push(`№ <code>${escapeHtml(String(o.id))}</code> · 🛍 <b>${escapeHtml(names.get(o.shopId) ?? String(o.shopId))}</b>`);
    for (const it of items.slice(0, 5)) L.push(`   🏷 <b>${escapeHtml(cut(skuLine(it), 50))}</b> × ${it.amount ?? 1}`);
    if (items.length > 5) L.push(`   … yana ${items.length - 5} ta`);
    const dl = o.deliverUntil ? ` · ⏰ ${fmtTime(env, new Date(Number(o.deliverUntil)).toISOString())} gacha` : "";
    L.push(`   💰 ${money(Number(o.price ?? 0))}${status === "PACKING" || status === "CREATED" ? dl : ""}`, "");
  }
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const rows: Btn[][] = [];
  // 🆕 Yangilar: har bir buyurtmani yoki hammasini yig'ishga o'tkazish
  if (status === "CREATED" && orders.length) {
    for (const o of orders) {
      const nm = cut(o.orderItems?.[0] ? skuLine(o.orderItems[0]) : "", 26);
      rows.push([{ text: `📦 Yig'ishga o'tkazish · №${o.id} · ${nm}`, callback_data: `u:fc:${acc}:${o.id}`, style: "success" }]);
    }
    if (total > 1) rows.push([{ text: `✅ Hammasini yig'ishga o'tkazish (${total})`, callback_data: `u:fca:${acc}`, style: "primary" }]);
  }
  if (status === "PACKING" && orders.length) {
    rows.push([{ text: `🧾 Ta'minlashga o'tkazish (${total})`, callback_data: `u:ft:${acc}`, style: "success" }]);
    rows.push([{ text: `🏷 Yorliqlar — PDF (${Math.min(total, 20)} ta)`, callback_data: `u:flp:${acc}`, style: "primary" }]);
  }
  if (["CREATED", "PACKING", "PENDING_DELIVERY"].includes(status) && orders.length) rows.push([{ text: "❌ Buyurtmani bekor qilish", callback_data: `u:fx:${acc}`, style: "danger" }]);
  if (pages > 1) {
    rows.push([
      { text: "◀️", callback_data: `u:fs:${acc}:${short}:${(page - 1 + pages) % pages}` },
      { text: `${page + 1} / ${pages}`, callback_data: `u:fs:${acc}:${short}:${page}` },
      { text: "▶️", callback_data: `u:fs:${acc}:${short}:${(page + 1) % pages}` },
    ]);
  }
  rows.push([back(`u:fa:${acc}`), { text: "🔄 Yangilash", callback_data: `u:fs:${acc}:${short}:${page}` }]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

/** 🧾 FBS ta'minlashlar (nakladnoylar) — vaqti va holati bilan */
export async function fbsInvoices(env: Env, acc: string, page: number, note = ""): Promise<FScreen> {
  const sellerId = await uzumSellerId(env, acc);
  const r = await uzumGet<any[]>(
    env,
    acc,
    `/seller/fbs/invoice?${qs({ sellerId, statuses: "CREATED,ACCEPTANCE_IN_PROGRESS,ACCEPTED,CANCELLED", page, size: PAGE })}`,
  );
  const list: any[] = Array.isArray(r) ? r : [];
  const L = ["<b>🧾 FBS ta'minlashlar</b>", ""];
  if (note) L.unshift(note, "");
  if (!list.length) L.push("Ta'minlash yo'q.");
  for (const x of list) {
    const ts = x.timeSlot?.timeFrom
      ? `${fmtTime(env, new Date(Number(x.timeSlot.timeFrom)).toISOString())}–${fmtTime(env, new Date(Number(x.timeSlot.timeTo)).toISOString()).split(" ")[1]}`
      : "vaqt tanlanmagan";
    const st = x.status?.value === "ACCEPTED" ? "✅" : x.status?.value === "CANCELLED" ? "❌" : x.status?.value === "CREATED" ? "🆕" : "⏳";
    L.push(`${st} <b>№ ${escapeHtml(String(x.number ?? x.id))}</b> · ${escapeHtml(String(x.status?.text ?? ""))}`);
    L.push(`   🕒 ${ts} · 📍 ${escapeHtml(cut(String(x.stock?.title ?? ""), 30))}`);
    L.push(`   📦 ${x.numberAcceptedOrders ?? 0}/${x.numberOrders ?? 0} buyurtma · 💰 ${money(Number(x.fullPrice ?? 0))}`, "");
  }
  const rows: Btn[][] = [];
  for (const x of list.filter((y) => ["CREATED", "ACCEPTANCE_IN_PROGRESS"].includes(y.status?.value)).slice(0, 5)) {
    rows.push([{ text: `🏷 № ${x.number ?? x.id} — yorliqlar (PDF)`, callback_data: `u:flb:${acc}:${x.id}`, style: "primary" }]);
  }
  const nav: Btn[] = [];
  if (page > 0) nav.push({ text: "◀️ Yangiroq", callback_data: `u:fi:${acc}:${page - 1}` });
  if (list.length === PAGE) nav.push({ text: "Eskiroq ▶️", callback_data: `u:fi:${acc}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([back(`u:fa:${acc}`), { text: "🔄 Yangilash", callback_data: `u:fi:${acc}:${page}` }]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

/* ---------- Yig'ishga o'tkazish ---------- */

/** Bitta buyurtma */
export async function fbsConfirmOne(env: Env, acc: string, orderId: number): Promise<FScreen> {
  let note: string;
  try {
    await uzumFbsConfirm(env, acc, orderId);
    note = "✅ Buyurtma yig'ishga o'tkazildi. Endi «📦 Yig'ishdagilar» bo'limida.";
  } catch (e) {
    note = `⚠️ Yig'ishga o'tkazib bo'lmadi: ${escapeHtml(cut((e as Error).message, 150))}`;
  }
  return fbsOrders(env, acc, "NEW", 0, note);
}

/** Hammasini o'tkazishdan oldin tasdiqlash */
export async function fbsConfirmAllAsk(env: Env, acc: string): Promise<FScreen> {
  const n = (await counts(env, acc)).CREATED ?? 0;
  return {
    text: `❓ <b>${n}</b> ta yangi FBS buyurtmani yig'ishga o'tkazaymi?\n\n<i>Shundan keyin ularni belgilangan muddatgacha yig'ib, topshirishingiz kerak bo'ladi.</i>`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ha, hammasini yig'ishga", callback_data: `u:fcy:${acc}`, style: "success" }],
        [{ text: "❌ Yo'q", callback_data: `u:fs:${acc}:NEW:0`, style: "danger" }],
      ],
    },
  };
}

export async function fbsConfirmAll(env: Env, acc: string): Promise<FScreen> {
  const { ids } = await shopIds(env, acc);
  let ok = 0;
  const fail: string[] = [];
  for (let round = 0; round < 10; round++) {
    const r = await uzumGet<any>(env, acc, `/seller/fbs/v2/orders?${qs({ page: 0, size: 20, sortBy: "CREATED_DATE", sortOrder: "ASC", scheme: "FBS", statuses: "CREATED", shopIds: ids, places: "STOCK,DROP_OFF" })}`);
    const list: any[] = (r?.orders ?? []).filter((o: any) => !fail.includes(String(o.id)));
    if (!list.length) break;
    for (const o of list) {
      try {
        await uzumFbsConfirm(env, acc, Number(o.id));
        ok++;
      } catch (e) {
        fail.push(String(o.id));
      }
    }
  }
  const note = `✅ ${ok} ta buyurtma yig'ishga o'tkazildi.` + (fail.length ? `\n⚠️ O'tmadi: ${fail.slice(0, 5).join(", ")}` : "");
  return fbsOrders(env, acc, "PCK", 0, note);
}

/* ---------- 🧾 Ta'minlashga o'tkazish (FBS nakladnoy yaratish) ---------- */
// u:ft:{acc} → tanlash · u:ftt:{acc}:{id} belgi · u:fta:{acc}:{1|0} hammasi/hech biri
// u:ftp:{acc} → viloyat · u:ftr:{acc}:{ri} → tuman · u:ftq:{acc}:{ri}:{di}:{page} → joy · u:ftd:{acc}:{p} → vaqt · u:fts:{acc}:{p}:{s} → tasdiq · u:fty → yaratish

const selKey = (acc: string) => `fbssel:${acc}`;
const ptsKey = (acc: string) => `fbspts:${acc}`;
const slotKey = (acc: string, p: number) => `fbsslots:${acc}:${p}`;
const POINT_TYPE: Record<string, string> = { DROP_OFF_POINT: "📦 Qabul punkti", ISSUE_POINT: "📮 Topshirish punkti", FRANCHISE: "🏬 Franshiza punkti", CROSS_DOCK: "🔀 Kross-dok", WAREHOUSE: "🏭 Ombor", STOCK: "🏭 Ombor" };
const WD = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

async function packingOrders(env: Env, acc: string): Promise<any[]> {
  const { ids } = await shopIds(env, acc);
  const all: any[] = [];
  for (let page = 0; page < 5; page++) {
    const r = await uzumGet<any>(env, acc, `/seller/fbs/v2/orders?${qs({ page, size: 20, sortBy: "CREATED_DATE", sortOrder: "ASC", scheme: "FBS", statuses: "PACKING", shopIds: ids, places: "STOCK,DROP_OFF" })}`);
    const list: any[] = r?.orders ?? [];
    all.push(...list);
    if (list.length < 20) break;
  }
  return all;
}

async function getSel(env: Env, acc: string): Promise<number[]> {
  return JSON.parse((await env.STATE.get(selKey(acc))) ?? "[]");
}
const putSel = (env: Env, acc: string, s: number[]) => env.STATE.put(selKey(acc), JSON.stringify(s), { expirationTtl: 3600 });

/** 1-qadam: qaysi buyurtmalar ta'minlashga kiradi (boshida hammasi belgilangan) */
export async function supplySelectScreen(env: Env, acc: string, mode: "init" | "keep" | "all" | "none" | number = "init"): Promise<FScreen> {
  const orders = await packingOrders(env, acc);
  const allIds = orders.map((o) => Number(o.id));
  let sel = mode === "init" || mode === "all" ? allIds : mode === "none" ? [] : (await getSel(env, acc)).filter((x) => allIds.includes(x));
  if (typeof mode === "number") sel = sel.includes(mode) ? sel.filter((x) => x !== mode) : [...sel, mode];
  await putSel(env, acc, sel);
  const { names } = await shopIds(env, acc);
  const L = ["🧾 <b>Ta'minlashga o'tkazish</b>", "", "1️⃣ Ta'minlashga kiradigan buyurtmalarni belgilang:", ""];
  if (!orders.length) L.push("📦 Yig'ishdagi buyurtma yo'q. Avval yangilarini yig'ishga o'tkazing.");
  for (const o of orders) {
    const on = sel.includes(Number(o.id));
    L.push(`${on ? "✅" : "⬜"} № <code>${o.id}</code> · 🛍 <b>${escapeHtml(names.get(o.shopId) ?? String(o.shopId))}</b>`);
    for (const it of (o.orderItems ?? []).slice(0, 2)) L.push(`   🏷 ${escapeHtml(cut(skuLine(it), 45))} × ${it.amount ?? 1}`);
  }
  const rows: Btn[][] = orders.slice(0, 40).map((o) => {
    const on = sel.includes(Number(o.id));
    return [{ text: `${on ? "✅" : "⬜"} №${o.id} · ${cut(o.orderItems?.[0] ? skuLine(o.orderItems[0]) : "", 28)}`, callback_data: `u:ftt:${acc}:${o.id}` }];
  });
  if (orders.length > 1) rows.push([{ text: "☑️ Hammasi", callback_data: `u:fta:${acc}:1` }, { text: "⬜ Hech biri", callback_data: `u:fta:${acc}:0` }]);
  if (sel.length) rows.push([{ text: `➡️ Davom etish — topshirish joyi (${sel.length} ta)`, callback_data: `u:ftp:${acc}`, style: "success" }]);
  rows.push([back(`u:fs:${acc}:PCK:0`)]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

function hoursLine(p: any): string {
  const wh = p.workingHours ?? {};
  const days = WD.filter((d) => wh[d]);
  if (!days.length) return "";
  const h = (d: string) => `${wh[d].open}–${wh[d].close}`;
  const same = days.every((d) => h(d) === h(days[0]));
  if (same) return `${days.length === 7 ? "har kuni" : `${days.length} kun haftada`} ${h(days[0])}`;
  const today = WD[new Date(Date.now() + 5 * 3600e3).getUTCDay()];
  return wh[today] ? `bugun ${h(today)}` : "bugun yopiq";
}


/* Manzildan viloyat va tumanni ajratish */
const AP = /[ʻʼ‘’`´']/g;
const TV = "Toshkent viloyati";
const CITY_REGION: Record<string, string> = {
  buxoro: "Buxoro", "g'ijduvon": "Buxoro", kogon: "Buxoro", andijon: "Andijon", asaka: "Andijon", xonobod: "Andijon",
  samarqand: "Samarqand", "kattaqo'rg'on": "Samarqand", urgut: "Samarqand", namangan: "Namangan", chust: "Namangan",
  "farg'ona": "Farg'ona", "qo'qon": "Farg'ona", "marg'ilon": "Farg'ona", quvasoy: "Farg'ona", qarshi: "Qashqadaryo",
  shahrisabz: "Qashqadaryo", termiz: "Surxondaryo", denov: "Surxondaryo", urganch: "Xorazm", xiva: "Xorazm",
  nukus: "Qoraqalpog'iston", jizzax: "Jizzax", guliston: "Sirdaryo", yangiyer: "Sirdaryo", navoiy: "Navoiy",
  zarafshon: "Navoiy",
  chirchiq: TV, angren: TV, olmaliq: TV, nurafshon: TV, nurafshan: TV, bekobod: TV, "yangiyo'l": TV, piskent: TV,
  "qora xitoy": TV, "g'azalkent": TV, "oqqo'rg'on": TV, "oqqorg'on": TV, "do'stobod": TV, olmazor: TV, "ko'ksaroy": TV,
  gulbaxor: TV, nazarbek: TV, eshonguzar: TV, keles: TV, parkent: TV, "bo'ka": TV, chinoz: TV, ohangaron: TV,
  oxangaron: TV, yangibozor: TV, zangiota: TV, "qibray": TV, "to'ytepa": TV, "yangiobod": TV, "bo'stonliq": TV,
};
const cap = (w: string) => w.replace(/(^|[\s-])([a-zа-яё])/g, (_m, p1, c) => p1 + c.toUpperCase());
const DISTRICT_FIX: Record<string, string> = { shayxontoxur: "shayxontohur", "mirzo ulugbek": "mirzo ulug'bek", "sirgali": "sirg'ali" };
const cityName = (seg: string) => seg.replace(/\s*\b(sh\.*|shahri|shahar|sh)\s*\.*$/i, "").trim();
function regionOf(address: string): { region: string; district: string } {
  const a = String(address).replace(AP, "'").replace(/^\s*sh\.\s*/i, "").replace(/\.\./g, ".,");
  const low = a.toLowerCase();
  if (/курьер|kuryer|tezkor/.test(low)) return { region: "🚚 Kuryer olib ketadi", district: "Kuryer" };
  const segs = low.split(",").map((x) => x.trim()).filter(Boolean);
  const first = segs[0] ?? "";
  const tumanOf = (list: string[]) => {
    for (const sg of list) {
      if (!/\btumani\b/.test(sg)) continue;
      let n = sg.replace(/^.*?\b(sh\.+|shahri|shahar)\s*/, "").replace(/\s*\btumani\b.*$/, "").trim();
      n = DISTRICT_FIX[n] ?? n;
      if (n) return cap(n) + " tumani";
    }
    return "";
  };
  // Toshkent shahri
  if (/^toshkent\s*(sh\b|sh\.|shahri|shahar)/.test(first)) return { region: "Toshkent shahri", district: tumanOf(segs) || "Tuman ko'rsatilmagan" };
  // "... viloyati, X shahri/tumani"
  const vm = first.match(/^(.+?)\s+viloyati/);
  if (vm) {
    const region = vm[1] === "toshkent" ? TV : cap(vm[1]) + " viloyati";
    const sec = segs[1] ?? "";
    const district = /\btumani\b/.test(sec) ? tumanOf([sec]) : /\b(sh\.*|shahri|shahar)\b/.test(sec) ? cap(cityName(sec)) + " shahri" : "Tuman ko'rsatilmagan";
    return { region, district };
  }
  if (/qoraqalpog/.test(low)) return { region: "Qoraqalpog'iston", district: tumanOf(segs) || "Tuman ko'rsatilmagan" };
  // "X sh., ..." yoki "Piskent, ..."
  const city = cityName(first);
  const reg = CITY_REGION[city];
  const region = reg === TV ? TV : reg ? reg + " viloyati" : "Boshqa";
  return { region, district: cap(city) + (/^(sh|shahri|shahar)$/.test(first.split(/\s+/).pop()!.replace(/\./g, "")) ? " shahri" : "") };
}

const MOBILE = "🚐 Ko'chma qabul punktlari";
const isMobile = (x: { address: string }) => /ko.?chma/i.test(String(x.address).replace(AP, "'"));
const inRegion = (x: Pt, r: string) => (r === MOBILE ? isMobile(x) : x.region === r);
const ptType = (x: { type: string; address: string }) => (isMobile(x) ? "🚐 Ko'chma qabul punkti" : POINT_TYPE[x.type] ?? x.type);
const distKm = (a: Pt, b: Pt) => Math.hypot((Number(a.lat) - Number(b.lat)) * 111, (Number(a.lon) - Number(b.lon)) * 84);

type Pt = { uuid: string; address: string; type: string; hours: string; region: string; district: string; ok?: boolean; lat?: number; lon?: number };
async function loadPts(env: Env, acc: string): Promise<Pt[]> {
  return JSON.parse((await env.STATE.get(ptsKey(acc))) ?? "[]");
}
const groupCount = (arr: string[]) => {
  const m = new Map<string, number>();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
const head = (sel: number) => ["🧾 <b>Ta'minlashga o'tkazish</b>", "", `2️⃣ <b>${sel}</b> ta buyurtmani qayerga topshirasiz?`, ""];

/** Barcha topshirish joylarini Uzumdan olib, KV ga saqlash */
async function fetchPoints(env: Env, acc: string, sel: number[]): Promise<{ slim: Pt[]; okCount: number }> {
  const sellerId = await uzumSellerId(env, acc);
  // Barcha joylar (kabinetdagi «Faqat moslarini ko'rish» o'chiq holati) + mos joylar belgisi
  const q = qs({ sellerId, customerOrderIds: sel.join(",") });
  const [allR, okR] = await Promise.all([
    uzumGet<any>(env, acc, `/seller/fbs/v1/drop-off/invoice-points/latest-delivery?${q}`).catch(() => null),
    uzumGet<any>(env, acc, `/seller/fbs/v1/drop-off/invoice-points?${q}`).catch(() => null),
  ]);
  const okSet = new Set<string>((okR?.dropOffPoints ?? []).map((x: any) => x.uuid));
  let pts: any[] = allR?.dropOffPoints?.length ? allR.dropOffPoints : okR?.dropOffPoints ?? [];
  const last = await env.STATE.get(`fbslastdop:${acc}`);
  if (last) pts = [...pts.filter((x) => x.uuid === last), ...pts.filter((x) => x.uuid !== last)];
  const slim: Pt[] = pts.map((x) => ({
    uuid: x.uuid,
    address: String(x.address ?? ""),
    type: x.type,
    hours: hoursLine(x),
    ok: okSet.has(x.uuid),
    lat: x.latitude,
    lon: x.longitude,
    ...regionOf(x.address ?? ""),
  }));
  // Tumani yozilmagan joylar — koordinatasi bo'yicha eng yaqin joyning tumani (5 km gacha)
  for (const x of slim) {
    if (x.district !== "Tuman ko'rsatilmagan" || !x.lat || !x.lon) continue;
    let best: Pt | null = null;
    let bd = 5;
    for (const y of slim) {
      if (y === x || y.region !== x.region || !y.lat || !y.lon || y.district === "Tuman ko'rsatilmagan") continue;
      const d = distKm(x, y);
      if (d < bd) (bd = d), (best = y);
    }
    if (best) x.district = best.district;
  }
  await env.STATE.put(ptsKey(acc), JSON.stringify(slim), { expirationTtl: 3600 });
  const cnt = groupCount(slim.map((x) => x.region));
  if (slim.some(isMobile)) cnt.set(MOBILE, 1);
  const regs = [...cnt.keys()].sort((x, y) => (x.startsWith("🚚") ? -1 : y.startsWith("🚚") ? 1 : x === MOBILE ? -1 : y === MOBILE ? 1 : x === "Toshkent shahri" ? -1 : y === "Toshkent shahri" ? 1 : x === "Toshkent viloyati" ? -1 : y === "Toshkent viloyati" ? 1 : x === "Boshqa" ? 1 : y === "Boshqa" ? -1 : x.localeCompare(y)));
  await env.STATE.put(`fbsregs:${acc}`, JSON.stringify(regs), { expirationTtl: 3600 });
  await env.STATE.put(`fbsokn:${acc}`, String(okSet.size), { expirationTtl: 3600 });
  return { slim, okCount: okSet.size };
}

/** 2: hozir bo'sh vaqti bor qabul punktlari (mos joylar), pastida — barcha joylardan tanlash */
export async function supplyAvailableScreen(env: Env, acc: string): Promise<FScreen> {
  const sel = await getSel(env, acc);
  if (!sel.length) return supplySelectScreen(env, acc, "init");
  const { slim } = await fetchPoints(env, acc, sel);
  const cand = slim.map((x, i) => ({ x, i })).filter((c) => c.x.ok).slice(0, 25);
  const found: { i: number; x: Pt; slots: any[] }[] = [];
  for (let k = 0; k < cand.length; k += 5) {
    await Promise.all(
      cand.slice(k, k + 5).map(async ({ x, i }) => {
        const r = await uzumGet<any>(env, acc, `/seller/fbs/invoice/time-slot?${qs({ dopId: x.uuid, sellerOrderIds: sel.join(",") })}`).catch(() => null);
        const slots: any[] = (r?.timeSlots ?? []).filter((s: any) => Number(s.remainingCapacity ?? 1) > 0).sort((p: any, q: any) => Number(p.timeFrom) - Number(q.timeFrom));
        if (slots.length) found.push({ i, x, slots });
      }),
    );
  }
  found.sort((p, q) => Number(p.slots[0].timeFrom) - Number(q.slots[0].timeFrom));
  for (const f of found) await env.STATE.put(slotKey(acc, f.i), JSON.stringify(f.slots.map((s) => ({ uuid: s.uuid, timeFrom: s.timeFrom, timeTo: s.timeTo, left: s.remainingCapacity }))), { expirationTtl: 3600 });
  const last = await env.STATE.get(`fbslastdop:${acc}`);
  const L = head(sel.length);
  const rows: Btn[][] = [];
  if (found.length) {
    L.push(`🟢 Hozir bo'sh vaqti bor qabul punktlari: <b>${found.length}</b> ta`, "");
    for (const f of found.slice(0, 12)) {
      L.push(`${f.x.uuid === last ? "⭐ " : "📍 "}${escapeHtml(f.x.address)}`, `   ${ptType(f.x)} · 🕒 eng yaqini: <b>${slotLabel(env, f.slots[0])}</b>`, "");
      rows.push([{ text: `${f.x.uuid === last ? "⭐" : "🟢"} ${slotLabel(env, f.slots[0])} · ${cut(f.x.address.replace(/^[^,]*(shahri|shahar|sh\.)\s*,\s*/i, ""), 30)}`, callback_data: `u:ftd:${acc}:${f.i}` }]);
    }
  } else {
    L.push("😔 Hozir mos qabul punktlarida bo'sh vaqt yo'q.", "", "👇 <b>FBS joy tanlash</b> orqali tuman yoki joyni tanlang — vaqt ochilishi bilan bot <b>avtomatik bron qiladi</b>.");
  }
  rows.push([{ text: `📍 FBS joy tanlash — barcha joylar (${slim.length})`, callback_data: `u:ftg:${acc}`, style: "primary" }]);
  rows.push([back(`u:ftk:${acc}`), { text: "🔄 Yangilash", callback_data: `u:ftp:${acc}` }]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

/** 2a: viloyat / Toshkent shahri tanlash (barcha joylar) */
export async function supplyRegionsScreen(env: Env, acc: string, watch = false): Promise<FScreen> {
  const sel = await getSel(env, acc);
  if (!sel.length) return supplySelectScreen(env, acc, "init");
  let slim = await loadPts(env, acc);
  let okCount = Number((await env.STATE.get(`fbsokn:${acc}`)) ?? 0);
  if (!slim.length || !(await env.STATE.get(`fbsregs:${acc}`))) ({ slim, okCount } = await fetchPoints(env, acc, sel));
  const allRegs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  // Oddiy rejimda — faqat topshirsa bo'ladigan (mos) joylar; avtomatik bronda — hammasi
  const view = watch ? slim : slim.filter((x) => x.ok);
  const cnt = groupCount(view.map((x) => x.region));
  cnt.set(MOBILE, view.filter(isMobile).length);
  const regs = allRegs.map((g, i) => ({ g, i })).filter((r) => cnt.get(r.g));
  const last = await env.STATE.get(`fbslastdop:${acc}`);
  const L = head(sel.length);
  if (!slim.length) L.push("⚠️ Bu buyurtmalar uchun topshirish joyi topilmadi.");
  else if (watch) {
    L.splice(0, L.length, "📍 <b>FBS joy tanlash — avtomatik bron</b>", "", `Barcha <b>${slim.length}</b> ta joy. Shahar yoki viloyatni tanlang 👇`, "", "<i>Keyin tumanlarni belgilaysiz va vaqtni tanlaysiz — o'sha tumanda joy chiqishi bilan bot avtomatik bron qiladi.</i>");
  } else if (!view.length) L.push("😔 Bu buyurtmalarni hozir topshirsa bo'ladigan joy yo'q.", "", "👇 <b>FBS joy tanlash</b> orqali tumanni belgilang — joy chiqishi bilan bot avtomatik bron qiladi.");
  else L.push(`📍 Topshirsa bo'ladigan joylar: <b>${view.length}</b> ta. Shahar yoki viloyatni tanlang 👇`);
  const rows: Btn[][] = [];
  const li = last ? slim.findIndex((x) => x.uuid === last) : -1;
  if (li >= 0 && !watch && slim[li].ok) {
    L.push("", `⭐ Oxirgi marta: ${escapeHtml(cut(slim[li].address, 90))}`);
    rows.push([{ text: `⭐ Oxirgi joy: ${cut(slim[li].address, 34)}`, callback_data: `u:ftd:${acc}:${li}`, style: "success" }]);
  }
  const btns: Btn[] = regs.map(({ g, i }) => ({
    text: `${g.startsWith("🚚") || g === MOBILE ? "" : g === "Toshkent shahri" ? "🏙 " : "🗺 "}${g} (${cnt.get(g) ?? 0})`,
    callback_data: watch ? `u:fwn:${acc}:${i}` : `u:ftr:${acc}:${i}`,
    ...(g === "Toshkent shahri" ? { style: "primary" } : {}),
  }));
  const solo = regs.filter(({ g }) => g.startsWith("🚚") || g === MOBILE || g === "Toshkent shahri").length;
  for (let k = 0; k < solo; k++) rows.push([btns.shift()!]);
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  if (watch) rows.push([back(`u:ftg:${acc}`)]);
  else {
    rows.push([{ text: `📍 FBS joy tanlash — avtomatik bron (${slim.length} joy)`, callback_data: `u:fwR:${acc}`, style: "success" }]);
    rows.push([back(`u:ftk:${acc}`), { text: "🔄 Yangilash", callback_data: `u:ftG:${acc}` }]);
  }
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function supplyRegionsRefresh(env: Env, acc: string): Promise<FScreen> {
  const sel = await getSel(env, acc);
  if (sel.length) await fetchPoints(env, acc, sel);
  return supplyRegionsScreen(env, acc);
}

const sortDistricts = (d: string[]) => d.sort((x, y) => (x === "Tuman ko'rsatilmagan" ? 1 : y === "Tuman ko'rsatilmagan" ? -1 : x.localeCompare(y)));

/** 2b: tuman tanlash */
export async function supplyDistrictsScreen(env: Env, acc: string, ri: number): Promise<FScreen> {
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const region = regs[ri];
  const pts = (await loadPts(env, acc)).filter((x) => inRegion(x, region) && x.ok);
  if (!region || !pts.length) return supplyRegionsScreen(env, acc);
  if (region === MOBILE) {
    await env.STATE.delete(`fbsds:${acc}:${ri}`);
    return supplyPointsScreen(env, acc, ri, 0, 0);
  }
  const cnt = groupCount(pts.map((x) => x.district));
  const ds = sortDistricts([...cnt.keys()]);
  if (ds.length === 1) return supplyPointsScreen(env, acc, ri, 0, 0);
  await env.STATE.put(`fbsds:${acc}:${ri}`, JSON.stringify(ds), { expirationTtl: 3600 });
  const sel = await getSel(env, acc);
  const L = head(sel.length);
  L.push(`${region === "Toshkent shahri" ? "🏙" : "🗺"} <b>${escapeHtml(region)}</b> — ${pts.length} ta joy. Tumanni tanlang 👇`);
  const btns: Btn[] = ds.map((d, i) => ({ text: `📍 ${d} (${cnt.get(d)})`, callback_data: `u:ftq:${acc}:${ri}:${i + 1}:0` }));
  const rows: Btn[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([{ text: `📋 Barcha tumanlar (${pts.length})`, callback_data: `u:ftq:${acc}:${ri}:0:0` }]);
  rows.push([{ text: "⚡ Punktlarni belgilab avtomatik bron", callback_data: `u:fwn:${acc}:${ri}`, style: "success" }]);
  rows.push([back(`u:ftg:${acc}`, "⬅️ Viloyatlar")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

const PT_PAGE = 6;

/** 2c: tanlangan tumandagi joylar. di=0 — barcha tumanlar */
export async function supplyPointsScreen(env: Env, acc: string, ri: number, di: number, page: number): Promise<FScreen> {
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const region = regs[ri];
  const ds: string[] = JSON.parse((await env.STATE.get(`fbsds:${acc}:${ri}`)) ?? "[]");
  const district = di > 0 ? ds[di - 1] : "";
  const all = await loadPts(env, acc);
  const last = await env.STATE.get(`fbslastdop:${acc}`);
  const list = all
    .map((x, i) => ({ ...x, i }))
    .filter((x) => inRegion(x, region) && x.ok && (!district || x.district === district))
    .sort((x, y) => Number(y.uuid === last) - Number(x.uuid === last) || Number(!!y.ok) - Number(!!x.ok));
  if (!region || !list.length) return supplyRegionsScreen(env, acc);
  const pages = Math.max(1, Math.ceil(list.length / PT_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const sel = await getSel(env, acc);
  const L = head(sel.length);
  L.push(`📍 <b>${escapeHtml(region)}${district ? ` · ${escapeHtml(district)}` : ""}</b> — ${list.length} ta joy`, "<i>✅ — buyurtmalaringizga mos joy (kabinetdagi «Faqat moslari»)</i>", "");
  const rows: Btn[][] = [];
  list.slice(page * PT_PAGE, page * PT_PAGE + PT_PAGE).forEach((x, k) => {
    const n = page * PT_PAGE + k + 1;
    const star = x.uuid === last ? "⭐ " : "";
    L.push(`<b>${n}.</b> ${star}${x.ok ? "✅ " : ""}${escapeHtml(x.address)}`, `   ${ptType(x)}${x.hours ? ` · 🕒 ${x.hours}` : ""}`, "");
    rows.push([{ text: `${n}. ${star}${x.ok ? "✅ " : ""}${cut(x.address.replace(/^[^,]*(shahri|shahar|sh\.)\s*,\s*/i, ""), 42)}`, callback_data: `u:ftd:${acc}:${x.i}` }]);
  });
  if (pages > 1) {
    const cb = (pg: number) => `u:ftq:${acc}:${ri}:${di}:${pg}`;
    rows.push([{ text: "◀️", callback_data: cb((page - 1 + pages) % pages) }, { text: `${page + 1} / ${pages}`, callback_data: cb(page) }, { text: "▶️", callback_data: cb((page + 1) % pages) }]);
  }
  rows.push([{ text: `⚡ ${district ? "Shu tumanda" : "Shu hududda"} joy chiqsa — avtomatik bron`, callback_data: `u:fwa:${acc}:${ri}:${di}`, style: "success" }]);
  rows.push([ds.length > 1 ? back(`u:ftr:${acc}:${ri}`, "⬅️ Tumanlar") : back(`u:ftg:${acc}`, "⬅️ Viloyatlar")]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

async function getPoint(env: Env, acc: string, p: number): Promise<any | null> {
  const pts: any[] = JSON.parse((await env.STATE.get(ptsKey(acc))) ?? "[]");
  return pts[p] ?? null;
}

function slotLabel(env: Env, s: any): string {
  const a = new Date(Number(s.timeFrom) + 5 * 3600e3);
  const b = fmtTime(env, new Date(Number(s.timeTo)).toISOString()).split(" ")[1];
  const t = fmtTime(env, new Date(Number(s.timeFrom)).toISOString()).split(" ")[1];
  return `${a.getUTCDate()}-${MONTHS[a.getUTCMonth()]} ${t}–${b}`;
}

/** 3-qadam: vaqt (slot) tanlash */
export async function supplySlotsScreen(env: Env, acc: string, p: number): Promise<FScreen> {
  const pt = await getPoint(env, acc, p);
  const sel = await getSel(env, acc);
  if (!pt || !sel.length) return supplyRegionsScreen(env, acc);
  const r = await uzumGet<any>(env, acc, `/seller/fbs/invoice/time-slot?${qs({ dopId: pt.uuid, sellerOrderIds: sel.join(",") })}`);
  const slots: any[] = (r?.timeSlots ?? []).filter((s: any) => Number(s.remainingCapacity ?? 1) > 0);
  await env.STATE.put(slotKey(acc, p), JSON.stringify(slots.map((s) => ({ uuid: s.uuid, timeFrom: s.timeFrom, timeTo: s.timeTo, left: s.remainingCapacity }))), { expirationTtl: 3600 });
  const L = ["🧾 <b>Ta'minlashga o'tkazish</b>", "", `📍 ${escapeHtml(pt.address)}`, `   ${ptType(pt)}${pt.hours ? ` · 🕒 ${pt.hours}` : ""}`, "", "3️⃣ Topshirish vaqtini tanlang 👇"];
  if (!slots.length) L.push("", "😔 Bu joyda bo'sh vaqt yo'q. Boshqa joyni tanlang yoki <b>🔔 kuzatish</b>ni yoqing — vaqt ochilishi bilan olib beraman.");
  const rows: Btn[][] = slots.slice(0, 20).map((s, i) => [
    { text: `🕒 ${slotLabel(env, s)} · ${s.remainingCapacity ?? "?"} joy`, callback_data: `u:fts:${acc}:${p}:${i}`, style: "primary" },
  ]);
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const ri = Math.max(0, regs.indexOf(pt.region));
  const ds: string[] = JSON.parse((await env.STATE.get(`fbsds:${acc}:${ri}`)) ?? "[]");
  const di = ds.indexOf(pt.district) + 1;
  rows.push([{ text: "⚡ Shu joyda vaqt chiqsa — avtomatik bron", callback_data: `u:fwp:${acc}:${p}`, ...(slots.length ? {} : { style: "success" }) }]);
  rows.push([back(`u:ftq:${acc}:${ri}:${di}:0`, "⬅️ Boshqa joy"), { text: "🔄 Yangilash", callback_data: `u:ftd:${acc}:${p}` }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** 4-qadam: tasdiqlash */
export async function supplyConfirmScreen(env: Env, acc: string, p: number, s: number): Promise<FScreen> {
  const pt = await getPoint(env, acc, p);
  const slot = JSON.parse((await env.STATE.get(slotKey(acc, p))) ?? "[]")[s];
  const sel = await getSel(env, acc);
  if (!pt || !slot || !sel.length) return supplySelectScreen(env, acc, "init");
  const L = [
    "❓ <b>Ta'minlash yaratilsinmi?</b>",
    "",
    `📦 Buyurtmalar: <b>${sel.length}</b> ta`,
    `   ${sel.slice(0, 15).map((x) => `<code>${x}</code>`).join(", ")}${sel.length > 15 ? " …" : ""}`,
    `📍 ${escapeHtml(pt.address)}`,
    `   ${ptType(pt)}`,
    `🕒 <b>${slotLabel(env, slot)}</b>`,
    "",
    "<i>Yaratilgach buyurtmalar «🚚 Ta'minlashda» bo'limiga o'tadi. Tovarlarni shu vaqtda topshiring.</i>",
  ];
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ha, ta'minlashni yaratish", callback_data: `u:fty:${acc}:${p}:${s}`, style: "success" }],
        [back(`u:ftd:${acc}:${p}`, "⬅️ Vaqtni o'zgartirish")],
        [{ text: "❌ Bekor qilish", callback_data: `u:fs:${acc}:PCK:0`, style: "danger" }],
      ],
    },
  };
}

export async function supplyCreate(env: Env, acc: string, p: number, s: number): Promise<FScreen> {
  const pt = await getPoint(env, acc, p);
  const slot = JSON.parse((await env.STATE.get(slotKey(acc, p))) ?? "[]")[s];
  const sel = await getSel(env, acc);
  if (!pt || !slot || !sel.length) return supplySelectScreen(env, acc, "init");
  const lock = `fbsinvlock:${acc}`;
  if (await env.STATE.get(lock)) return fbsInvoices(env, acc, 0, "⏳ Ta'minlash allaqachon yaratilmoqda — biroz kuting.");
  await env.STATE.put(lock, "1", { expirationTtl: 60 });
  let note: string;
  try {
    const sellerId = await uzumSellerId(env, acc);
    const r = await uzumPost<any>(env, acc, "/seller/fbs/invoice", {
      sellerId,
      orderIds: sel,
      dropOffPointUuid: pt.uuid,
      timeSlotUuid: slot.uuid,
      idempotencyKey: crypto.randomUUID(),
    });
    await env.STATE.put(`fbslastdop:${acc}`, pt.uuid);
    await env.STATE.delete(selKey(acc));
    const num = r?.number ?? r?.id ?? r?.invoiceNumber ?? (Array.isArray(r) ? r[0]?.number ?? r[0]?.id : "");
    const invId = Number(r?.id ?? 0);
    await scheduleReminder(env, { chatId: 0, at: Number(slot.timeFrom), to: Number(slot.timeTo), title: `🚚 FBS ta'minlash${num ? ` № ${num}` : ""} · ${sel.length} ta buyurtma`, place: pt.address, cb: `u:fi:${acc}:0`, labels: invId ? `u:flb:${acc}:${invId}` : `u:flp:${acc}` });
    note = `✅ Ta'minlash yaratildi${num ? ` — <b>№ ${escapeHtml(String(num))}</b>` : ""}\n📦 ${sel.length} ta buyurtma · 🕒 ${slotLabel(env, slot)}\n📍 ${escapeHtml(cut(pt.address, 80))}`;
  } catch (e) {
    note = `⚠️ Ta'minlash yaratilmadi: ${escapeHtml(cut((e as Error).message, 200))}`;
  } finally {
    await env.STATE.delete(lock);
  }
  return fbsInvoices(env, acc, 0, note);
}

/* ---------- ❌ Bekor qilish ---------- */

export const CANCEL_REASONS: Record<string, { code: string; t: string }> = {
  S: { code: "OUT_OF_STOCK", t: "📭 Tovar yo'q" },
  P: { code: "OUT_OF_PACKAGE", t: "📦 Qadoq yo'q" },
  T: { code: "OUT_OF_TIME", t: "⏰ Yig'ishga ulgurmayapman" },
};

/** 1-qadam: bekor qilish mumkin bo'lgan buyurtmalar ro'yxati (tanlash yoki raqam yozish) */
export async function cancelAskScreen(env: Env, acc: string): Promise<FScreen> {
  const { ids, names } = await shopIds(env, acc);
  const all: any[] = [];
  for (const st of ["CREATED", "PACKING", "PENDING_DELIVERY"]) {
    for (let page = 0; page < 3; page++) {
      const r = await uzumGet<any>(env, acc, `/seller/fbs/v2/orders?${qs({ page, size: 20, sortBy: "CREATED_DATE", sortOrder: "DESC", scheme: "FBS", statuses: st, shopIds: ids, places: "STOCK,DROP_OFF" })}`);
      const list: any[] = r?.orders ?? [];
      for (const o of list) all.push({ ...o, _st: st });
      if (list.length < 20) break;
    }
  }
  const L = ["❌ <b>Buyurtmani bekor qilish</b>", ""];
  if (!all.length) L.push("Bekor qilish mumkin bo'lgan buyurtma yo'q (yangilar, yig'ishdagilar va ta'minlashdagilar bo'sh).");
  for (const o of all.slice(0, 20)) {
    L.push(`${o._st === "CREATED" ? "🆕" : o._st === "PACKING" ? "📦" : "🚚"} № <code>${o.id}</code> · 🛍 <b>${escapeHtml(names.get(o.shopId) ?? String(o.shopId))}</b>`);
    for (const it of (o.orderItems ?? []).slice(0, 3)) L.push(`   🏷 ${escapeHtml(cut(skuLine(it), 50))} × ${it.amount ?? 1}`);
  }
  if (all.length > 20) L.push(`… yana ${all.length - 20} ta`);
  if (all.length) L.push("", "Buyurtmani tanlang 👇 yoki <b>raqamini yozing</b>.");
  const rows: Btn[][] = all.slice(0, 20).map((o) => [
    { text: `❌ №${o.id} · ${cut(o.orderItems?.[0] ? skuLine(o.orderItems[0]) : "", 28)}`, callback_data: `u:fxo:${acc}:${o.id}` },
  ]);
  rows.push([back(`u:fa:${acc}`, "⬅️ Bekor qilmaslik")]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

/** Buyurtmani raqam bo'yicha topish (yangilar va yig'ishdagilar ichidan) */
async function findOrder(env: Env, acc: string, id: number): Promise<any | null> {
  const { ids } = await shopIds(env, acc);
  for (const st of ["CREATED", "PACKING", "PENDING_DELIVERY"]) {
    for (let page = 0; page < 10; page++) {
      const r = await uzumGet<any>(env, acc, `/seller/fbs/v2/orders?${qs({ page, size: 20, sortBy: "CREATED_DATE", sortOrder: "DESC", scheme: "FBS", statuses: st, shopIds: ids, places: "STOCK,DROP_OFF" })}`);
      const list: any[] = r?.orders ?? [];
      const f = list.find((o) => Number(o.id) === id || String(o.publicId) === String(id));
      if (f) return { ...f, status: f.status ?? st };
      if (list.length < 20) break;
    }
  }
  return null;
}

/** 2-qadam: raqam yozilgach — buyurtma va 3 ta sabab */
export async function cancelReasonScreen(env: Env, acc: string, raw: string): Promise<FScreen> {
  const id = Number(String(raw).replace(/[^\d]/g, ""));
  const o = id ? await findOrder(env, acc, id) : null;
  if (!o) {
    return {
      text: `⚠️ <b>${escapeHtml(raw)}</b> raqamli buyurtma yangilar, yig'ishdagilar yoki ta'minlashdagilar orasida topilmadi.\n\nRaqamni tekshirib, qayta yozing.`,
      reply_markup: { inline_keyboard: [[{ text: "🔄 Qayta yozish", callback_data: `u:fx:${acc}` }], [back(`u:fa:${acc}`)]] },
    };
  }
  const { names } = await shopIds(env, acc);
  const L = ["❌ <b>Buyurtmani bekor qilish</b>", "", `№ <code>${o.id}</code> · 🛍 <b>${escapeHtml(names.get(o.shopId) ?? String(o.shopId))}</b>`];
  for (const it of (o.orderItems ?? []).slice(0, 5)) L.push(`   🏷 <b>${escapeHtml(cut(skuLine(it), 50))}</b> × ${it.amount ?? 1}`);
  L.push(`   💰 ${money(Number(o.price ?? 0))}`, "", "Bekor qilish sababini tanlang 👇");
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...Object.entries(CANCEL_REASONS).map(([k, v]) => [{ text: v.t, callback_data: `u:fxr:${acc}:${o.id}:${k}` }]),
        [back(`u:fa:${acc}`, "⬅️ Bekor qilmaslik")],
      ],
    },
  };
}

/** 3-qadam: sabab tanlangach — oxirgi tasdiq */
export function cancelConfirmScreen(acc: string, id: number, r: string): FScreen {
  const reason = CANCEL_REASONS[r] ?? CANCEL_REASONS.S;
  return {
    text: `❗ <b>№ ${id}</b> buyurtmani bekor qilaymi?\nSabab: <b>${reason.t}</b>\n\n<i>Bekor qilish FBS reytingingizga ta'sir qiladi va uni qaytarib bo'lmaydi.</i>`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗑 Ha, bekor qilish", callback_data: `u:fxy:${acc}:${id}:${r}`, style: "danger" }],
        [back(`u:fa:${acc}`, "⬅️ Yo'q, qoldirish")],
      ],
    },
  };
}

export async function cancelDo(env: Env, acc: string, id: number, r: string): Promise<FScreen> {
  const reason = CANCEL_REASONS[r] ?? CANCEL_REASONS.S;
  let note: string;
  try {
    await uzumFbsCancel(env, acc, id, reason.code);
    note = `🗑 № ${id} buyurtma bekor qilindi (${reason.t}).`;
  } catch (e) {
    note = `⚠️ № ${id} ni bekor qilib bo'lmadi: ${escapeHtml(cut((e as Error).message, 150))}`;
  }
  const sc = await fbsAccount(env, acc);
  sc.text = note + "\n\n" + sc.text;
  return sc;
}

/* ---------- 🔔 FBS slot kuzatuvi (FBO kabi) ---------- */
// u:fwa:{acc}:{ri}:{di} — tuman/hudud · u:fwp:{acc}:{p} — bitta joy → tasdiq
// u:fwy:{acc}:{d|p}:{a}:{b}:{auto} — yoqish · u:fws:{acc} — holat · u:fwq:{acc} — to'xtatish

interface FWatch {
  acc: string;
  chatId: number;
  orderIds: number[];
  points: Pt[];
  label: string;
  auto: boolean;
  t: number;
  sig?: string; // oxirgi xabar berilgan vaqtlar (takror yubormaslik uchun)
  ymd?: string; // "20261115" yoki "" — istalgan kun
  half?: string; // a — 12:00 gacha, p — 12:00 dan keyin, x — istalgan, h — belgilangan soatlar
  hours?: number[]; // belgilangan soatlar: 8 → 08:00–09:00
  pk?: number; // buyurtmalar holati oxirgi tekshirilgan vaqt
  split?: boolean; // ✂️ bitta joy hammasini olmasa — yaqin joylarga bo'lib topshirish
  parts?: number; // ko'pi bilan nechta joyga bo'linadi
  minPart?: number; // bitta ta'minlashda kamida nechta buyurtma
}
const tz5 = (ms: number) => new Date(ms + 5 * 3600e3);
const ymdOf = (ms: number) => tz5(ms).toISOString().slice(0, 10).replace(/-/g, "");
const ymdOne = (ymd: string) => `${Number(ymd.slice(6))}-${MONTHS[Number(ymd.slice(4, 6)) - 1]}`;
// ymd — bitta kun yoki bir nechtasi "20261117-20261118-20261119"
const ymdText = (ymd: string) => (ymd ? ymd.split("-").map(ymdOne).join(", ") : "istalgan kun");
const HALF_T: Record<string, string> = { a: "🌅 ertalab (12:00 gacha)", p: "🌇 tushdan keyin (12:00 dan)", x: "🕒 istalgan vaqt" };
const UNTIL = [10, 12, 14, 16, 18, 20];
const halfText = (h?: string, hours?: number[]) => (h === "h" && hours?.length ? `🕒 ${hoursText(hours)}` : h && /^u\d+$/.test(h) ? `⏰ soat ${h.slice(1)}:00 gacha` : HALF_T[h ?? "x"] ?? HALF_T.x);
const slotFits = (w: { ymd?: string; half?: string; hours?: number[] }, s: any) => {
  const t = Number(s.timeFrom);
  if (w.ymd && !w.ymd.split("-").includes(ymdOf(t))) return false;
  const h = tz5(t).getUTCHours();
  if (w.half === "h" && w.hours?.length) {
    // Slot vaqti belgilangan soatlardan biri bilan kesishsa — mos
    const a0 = tz5(t), b0 = tz5(Number(s.timeTo));
    const from = a0.getUTCHours() + a0.getUTCMinutes() / 60;
    const to = b0.getUTCHours() + b0.getUTCMinutes() / 60 || 24;
    return w.hours.some((x) => from < x + 1 && to > x);
  }
  if (w.half && /^u\d+$/.test(w.half)) {
    const end = tz5(Number(s.timeTo));
    return end.getUTCHours() + end.getUTCMinutes() / 60 <= Number(w.half.slice(1));
  }
  return !w.half || w.half === "x" || (w.half === "a" ? h < 12 : h >= 12);
};
const mapLink = (p: Pt) => (p.lat && p.lon ? `https://maps.google.com/maps?q=${p.lat},${p.lon}` : `https://maps.google.com/maps?q=${encodeURIComponent(p.address)}`);
const fwKey = (acc: string) => `fbswatch:${acc}`;
const MAXW = 40;

/** Bir nechta tumanni belgilash (kuzatuv uchun). t: "x" — ko'rsatish, raqam — belgini almashtirish */
export async function fbsWatchDistrictsScreen(env: Env, acc: string, ri: number, t: string): Promise<FScreen> {
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const region = regs[ri];
  const all = (await loadPts(env, acc)).filter((x) => inRegion(x, region));
  if (!region || !all.length) return supplyRegionsScreen(env, acc, true);
  const ds = sortDistricts([...new Set(all.map((x) => x.district))]);
  await env.STATE.put(`fbswds:${acc}:${ri}`, JSON.stringify(ds), { expirationTtl: 3600 });
  const key = `fbswd:${acc}:${ri}`;
  let picked: number[] = JSON.parse((await env.STATE.get(key)) ?? "[]");
  if (t !== "x") {
    const n = Number(t);
    if (n === 0) picked = picked.length === ds.length ? [] : ds.map((_, i) => i + 1);
    else picked = picked.includes(n) ? picked.filter((x) => x !== n) : [...picked, n];
    await env.STATE.put(key, JSON.stringify(picked), { expirationTtl: 3600 });
  }
  const cnt = groupCount(all.map((x) => x.district));
  const nPts = all.filter((x) => picked.some((i) => ds[i - 1] === x.district)).length;
  const L = ["⚡ <b>Avtomatik bron — tumanlar</b>", "", `${region === "Toshkent shahri" ? "🏙" : "🗺"} <b>${escapeHtml(region)}</b>`, "", "Qaysi tumanlarda joy chiqishini kutamiz? Belgilang 👇"];
  if (picked.length) L.push("", `Tanlandi: <b>${picked.length}</b> tuman · <b>${nPts}</b> ta joy`);
  const btns: Btn[] = ds.map((d, i) => ({ text: `${picked.includes(i + 1) ? "✅" : "⬜"} ${d.replace(/ tumani$/, "")} (${cnt.get(d) ?? 0})`, callback_data: `u:fwm:${acc}:${ri}:${i + 1}` }));
  const rows: Btn[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([{ text: picked.length === ds.length ? "⬜ Hech biri" : "☑️ Hammasi", callback_data: `u:fwm:${acc}:${ri}:0` }]);
  if (picked.length) rows.push([{ text: `➡️ Kun va soatni tanlash (${picked.length} tuman, ${nPts} punkt)`, callback_data: `u:fwa:${acc}:${ri}:0:m`, style: "success" }]);
  rows.push([back(`u:fwn:${acc}:${ri}`, "⬅️ Tumanlar")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Avtomatik bron: viloyatdagi tumanlar (bittasini tanlash) */
export async function fbsWatchDistrictPick(env: Env, acc: string, ri: number): Promise<FScreen> {
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const region = regs[ri];
  const all = (await loadPts(env, acc)).filter((x) => inRegion(x, region));
  if (!region || !all.length) return supplyRegionsScreen(env, acc, true);
  const ds = sortDistricts([...new Set(all.map((x) => x.district))]);
  await env.STATE.put(`fbswds:${acc}:${ri}`, JSON.stringify(ds), { expirationTtl: 3600 });
  if (region === MOBILE) return fbsWatchPointsPick(env, acc, ri, 0, "x");
  if (ds.length === 1) return fbsWatchPointsPick(env, acc, ri, 1, "x");
  const cnt = groupCount(all.map((x) => x.district));
  const btns: Btn[] = ds.map((d, i) => ({ text: `📍 ${d} (${cnt.get(d)})`, callback_data: `u:fwo:${acc}:${ri}:${i + 1}:x` }));
  const rows: Btn[][] = [[{ text: "☑️ Tumanlar bilan tanlash (bir nechta tuman)", callback_data: `u:fwm:${acc}:${ri}:x`, style: "primary" }]];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([back(`u:fwR:${acc}`, "⬅️ Viloyatlar")]);
  return {
    text: `⚡ <b>Avtomatik bron</b>\n\n${region === "Toshkent shahri" ? "🏙" : "🗺"} <b>${escapeHtml(region)}</b> — ${all.length} ta punkt\n\n📍 Tumanni bossangiz — ichidagi punktlarni belgilaysiz.\n☑️ <b>Tumanlar bilan tanlash</b> — bir nechta tumanni butunlay belgilaysiz (ulardagi barcha punktlar kuzatiladi).`,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Avtomatik bron: tumandagi punktlarni belgilash. t: "x" ko'rsatish, "a" hammasi/hech biri, raqam — punkt */
export async function fbsWatchPointsPick(env: Env, acc: string, ri: number, di: number, t: string): Promise<FScreen> {
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const wds: string[] = JSON.parse((await env.STATE.get(`fbswds:${acc}:${ri}`)) ?? "[]");
  const region = regs[ri];
  const district = wds[di - 1];
  const all = await loadPts(env, acc);
  const list = all.map((x, i) => ({ ...x, i })).filter((x) => inRegion(x, region) && (!district || x.district === district));
  if (!list.length) return fbsWatchDistrictPick(env, acc, ri);
  const key = `fbswp:${acc}`;
  const ids = list.map((x) => x.i);
  let picked: number[] = JSON.parse((await env.STATE.get(key)) ?? "[]").filter((i: number) => ids.includes(i));
  if (t === "a") picked = picked.length === ids.length ? [] : ids;
  else if (t !== "x") {
    const n = Number(t);
    picked = picked.includes(n) ? picked.filter((x) => x !== n) : [...picked, n];
  }
  await env.STATE.put(key, JSON.stringify(picked), { expirationTtl: 3600 });
  const L = ["⚡ <b>Avtomatik bron — punktlar</b>", "", `📍 <b>${escapeHtml(region)}${district ? ` · ${escapeHtml(district)}` : ""}</b> — ${list.length} ta punkt`, "", "Qaysi punktlarga topshira olasiz? Belgilang 👇", "<i>🟢 — hozir ham mos punkt</i>"];
  const rows: Btn[][] = list.slice(0, 40).map((x) => [
    {
      text: `${picked.includes(x.i) ? "✅" : "⬜"} ${x.ok ? "🟢 " : ""}${cut(x.address.replace(/^[^,]*(shahri|shahar|sh\.)\s*,\s*/i, "").replace(/^[^,]*tumani\s*,?\s*/i, ""), 40)}`,
      callback_data: `u:fwo:${acc}:${ri}:${di}:${x.i}`,
    },
  ]);
  if (list.length > 1) rows.push([{ text: picked.length === ids.length ? "⬜ Hech biri" : "☑️ Hammasi", callback_data: `u:fwo:${acc}:${ri}:${di}:a` }]);
  if (picked.length) rows.push([{ text: `➡️ Vaqtni tanlash (${picked.length} punkt)`, callback_data: `u:fwa:${acc}:${ri}:${di}:s`, style: "success" }]);
  const toD = wds.length > 1 && region !== MOBILE;
  rows.push([back(toD ? `u:fwn:${acc}:${ri}` : `u:fwR:${acc}`, toD ? "⬅️ Tumanlar" : "⬅️ Viloyatlar")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

async function watchTarget(env: Env, acc: string, mode: string, a: number, b: number): Promise<{ points: Pt[]; label: string } | null> {
  const all = await loadPts(env, acc);
  if (mode === "p") {
    const pt = all[a];
    return pt ? { points: [pt], label: pt.address } : null;
  }
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const ds: string[] = JSON.parse((await env.STATE.get(`fbsds:${acc}:${a}`)) ?? "[]");
  const region = regs[a];
  if (mode === "s") {
    const picked: number[] = JSON.parse((await env.STATE.get(`fbswp:${acc}`)) ?? "[]");
    const points = picked.map((i) => all[i]).filter(Boolean);
    const wds: string[] = JSON.parse((await env.STATE.get(`fbswds:${acc}:${a}`)) ?? "[]");
    const d = b > 0 ? wds[b - 1] : "";
    return points.length ? { points, label: `${region}${d ? ` · ${d}` : ""}` } : null;
  }
  if (mode === "m") {
    const picked: number[] = JSON.parse((await env.STATE.get(`fbswd:${acc}:${a}`)) ?? "[]");
    const wds: string[] = JSON.parse((await env.STATE.get(`fbswds:${acc}:${a}`)) ?? "[]");
    const names = picked.map((i) => wds[i - 1]).filter(Boolean);
    const points = all.filter((x) => inRegion(x, region) && names.includes(x.district));
    return region && points.length ? { points, label: `${region} · ${names.join(", ")}` } : null;
  }
  const district = b > 0 ? ds[b - 1] : "";
  const points = all.filter((x) => inRegion(x, region) && (!district || x.district === district));
  return region && points.length ? { points, label: `${region}${district ? ` · ${district}` : ""}` } : null;
}

/** Avtomatik bron: 1) sana tanlash */
export async function fbsWatchAsk(env: Env, acc: string, mode: "d" | "p" | "m" | "s", a: number, b: number): Promise<FScreen> {
  const sel = await getSel(env, acc);
  const tg = await watchTarget(env, acc, mode, a, b);
  if (!tg || !sel.length) return supplyRegionsScreen(env, acc);
  const L = [
    "⚡ <b>Avtomatik bron</b>",
    "",
    `📦 Buyurtmalar: <b>${sel.length}</b> ta`,
    `📍 ${escapeHtml(tg.label)}${mode !== "p" ? ` — <b>${tg.points.length}</b> ta joy` : ""}`,
  ];
  if (tg.points.length > MAXW) L.push(`<i>⚠️ Juda ko'p joy — birinchi ${MAXW} tasi kuzatiladi (✅ moslari birinchi).</i>`);
  const base = `${acc}:${mode}:${a}:${b}`;
  // Soat 20:00 dan keyin «bugun» — ertangi kun hisoblanadi
  const shift = tz5(Date.now()).getUTCHours() >= 20 ? 1 : 0;
  const d0 = ymdOf(Date.now() + shift * 86400e3);
  const d1 = ymdOf(Date.now() + (shift + 1) * 86400e3);
  const d2 = ymdOf(Date.now() + (shift + 2) * 86400e3);
  const three = `${d0}-${d1}-${d2}`;
  L.push("", `⚡ <b>Yaqin 3 kun</b> (${ymdText(three)}) — istalgan vaqtda joy chiqsa, darhol band qilaman.`, "<i>Aniq soat kerak bo'lsa — kunni tanlab, soatlarni belgilang.</i>");
  const rows: Btn[][] = [
    [{ text: "⚡ Yaqin 3 kun — avtomatik bron", callback_data: `u:fwy:${base}:${three}:x:1`, style: "success" }],
    [{ text: "🔔 Yaqin 3 kun — faqat xabar", callback_data: `u:fwy:${base}:${three}:x:0` }],
    [
      { text: `🕒 Bugun · ${ymdText(d0)}`, callback_data: `u:fwd:${base}:${d0}` },
      { text: `🕒 Ertaga · ${ymdText(d1)}`, callback_data: `u:fwd:${base}:${d1}` },
    ],
  ];
  rows.push([back(mode === "p" ? `u:ftd:${acc}:${a}` : mode === "m" ? `u:fwm:${acc}:${a}:x` : mode === "s" ? `u:fwo:${acc}:${a}:${b}:x` : `u:ftq:${acc}:${a}:${b}:0`)]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Avtomatik bron: 2) kun qismi tanlash → kuzatuv yoqiladi */
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const hoursText = (hs: number[]) => hs.slice().sort((x, y) => x - y).map((h) => `${hh(h)}–${hh(h + 1)}`).join(", ");

/** Avtomatik bron: 2) soatlarni belgilash (08:00–16:00, bir nechtasini). t: "x" — ko'rsatish, "a" — hammasi, raqam — soat */
export async function fbsWatchHalf(env: Env, acc: string, mode: "d" | "p" | "m" | "s", a: number, b: number, ymd: string, t = "r"): Promise<FScreen> {
  const tg = await watchTarget(env, acc, mode, a, b);
  if (!tg) return supplyRegionsScreen(env, acc);
  const key = `fbswh:${acc}`;
  let hs: number[] = t === "r" ? [] : JSON.parse((await env.STATE.get(key)) ?? "[]");
  if (t === "a") hs = hs.length === HOURS.length ? [] : [...HOURS];
  else if (/^\d+$/.test(t)) {
    const h = Number(t);
    hs = hs.includes(h) ? hs.filter((x) => x !== h) : [...hs, h];
  }
  await env.STATE.put(key, JSON.stringify(hs), { expirationTtl: 3600 });
  const base = `${acc}:${mode}:${a}:${b}:${ymd || 0}`;
  const btns: Btn[] = HOURS.map((h) => ({
    text: `${hs.includes(h) ? "✅" : "⬜"} ${hh(h)}–${hh(h + 1)}`,
    callback_data: `u:fwh:${base}:${h}`,
    ...(hs.includes(h) ? { style: "primary" } : {}),
  }));
  const rows: Btn[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([{ text: hs.length === HOURS.length ? "⬜ Hech biri" : "☑️ Hammasi", callback_data: `u:fwh:${base}:a` }]);
  if (hs.length) {
    rows.push([{ text: `⚡ Avtomatik bronni yoqish (${hs.length} soat)`, callback_data: `u:fwy:${base}:h:1`, style: "success" }]);
    rows.push([{ text: "🔔 Bron qilmasdan, faqat xabar bersin", callback_data: `u:fwy:${base}:h:0` }]);
  } else rows.push([{ text: "🕒 Istalgan vaqt — avtomatik bron", callback_data: `u:fwy:${base}:x:1` }]);
  rows.push([back(`u:fwa2:${acc}:${mode}:${a}:${b}`, "⬅️ Sana")]);
  const L = [
    "⚡ <b>Avtomatik bron</b>",
    "",
    `📍 ${escapeHtml(tg.label)}`,
    `📅 <b>${ymdText(ymd)}</b>`,
    "",
    "🕒 Qaysi soatlarda topshira olasiz? Bir nechtasini belgilang 👇",
  ];
  if (hs.length) L.push("", `Tanlandi: <b>${hoursText(hs)}</b>`);
  L.push("", "<i>Shu soatlarga to'g'ri keladigan joy chiqishi bilan bot ta'minlashni o'zi yaratadi va qayerga, qachongacha olib borishni yozib yuboradi.</i>");
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function fbsWatchAdd(env: Env, chatId: number, acc: string, mode: "d" | "p" | "m" | "s", a: number, b: number, auto: boolean, ymd = "", half = "x"): Promise<FScreen> {
  const sel = await getSel(env, acc);
  const tg = await watchTarget(env, acc, mode, a, b);
  if (!tg || !sel.length) return supplyRegionsScreen(env, acc);
  const w: FWatch = { acc, chatId, orderIds: sel, points: [...tg.points].sort((x, y) => Number(!!y.ok) - Number(!!x.ok)).slice(0, MAXW), label: tg.label, auto, t: Date.now(), ymd: ymd && ymd !== "0" ? ymd : "", half };
  if (half === "h") {
    w.hours = JSON.parse((await env.STATE.get(`fbswh:${acc}`)) ?? "[]");
    if (!w.hours?.length) w.half = "x";
  }
  await env.STATE.put(fwKey(acc), JSON.stringify(w), { expirationTtl: 3 * 86400 });
  return fbsWatchStatus(env, acc, auto ? "✅ Avtomatik bron yoqildi." : "✅ Kuzatuv yoqildi.");
}

export async function fbsWatchStatus(env: Env, acc: string, note = ""): Promise<FScreen> {
  const raw = await env.STATE.get(fwKey(acc));
  const L = ["⚡ <b>FBS avtomatik bron</b>", ""];
  if (note) L.push(note, "");
  const rows: Btn[][] = [];
  if (raw) {
    const w: FWatch = JSON.parse(raw);
    L.push(
      `📍 ${escapeHtml(w.label)}${w.points.length > 1 ? ` (${w.points.length} ta joy)` : ""}`,
      `📦 ${w.orderIds.length} ta buyurtma: ${w.orderIds.slice(0, 8).map((x) => `<code>${x}</code>`).join(", ")}${w.orderIds.length > 8 ? " …" : ""}`,
      `📅 ${ymdText(w.ymd ?? "")} · ${halfText(w.half, w.hours)}`,
      `${w.auto ? "⚡ Joy chiqsa — <b>avtomatik bron qilaman</b> va qayerga, qachongacha olib borishni yozaman" : "🔔 Joy chiqsa — <b>xabar beraman</b>"}`,
      "",
      "⏱ Har 15 soniyada tekshiryapman.",
    );
    rows.push([{ text: w.auto ? "🔔 Faqat xabar berishga o'tish" : "⚡ Avtomatik bronga o'tish", callback_data: `u:fwt:${acc}` }]);
    rows.push([{ text: "⏹ Kuzatuvni to'xtatish", callback_data: `u:fwq:${acc}`, style: "danger" }]);
    L.push("", "<i>Bosh menyuga chiqsangiz ham kuzatuv davom etadi.</i>");
  } else L.push("⏹ Faol kuzatuv yo'q.");
  rows.push([back(`u:fa:${acc}`, "🚚 FBS"), back("m:home", "🏠 Bosh menyu")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function fbsWatchToggle(env: Env, acc: string): Promise<FScreen> {
  const raw = await env.STATE.get(fwKey(acc));
  if (raw) {
    const w: FWatch = JSON.parse(raw);
    w.auto = !w.auto;
    await env.STATE.put(fwKey(acc), JSON.stringify(w), { expirationTtl: 3 * 86400 });
  }
  return fbsWatchStatus(env, acc, "✅ O'zgartirildi.");
}

export async function fbsWatchStop(env: Env, acc: string): Promise<FScreen> {
  await env.STATE.delete(fwKey(acc));
  return fbsWatchStatus(env, acc, "⏹ Kuzatuv to'xtatildi.");
}

/** Kuzatuvlar ro'yxati uchun (🔔 Kuzatuvlar ekrani) */
export async function fbsWatchList(env: Env): Promise<{ text: string; btn: Btn }[]> {
  const page = await env.STATE.list({ prefix: "fbswatch:" });
  const out: { text: string; btn: Btn }[] = [];
  for (const k of page.keys) {
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const w: FWatch = JSON.parse(raw);
    out.push({
      text: `🚚 FBS · ${escapeHtml(cut(w.label, 50))} · ${ymdText(w.ymd ?? "")} · ${w.orderIds.length} ta buyurtma ${w.auto ? "⚡" : "🔔"}`,
      btn: { text: `🚚 FBS · ${cut(w.label, 30)}`, callback_data: `u:fws:${w.acc}` },
    });
  }
  return out;
}

/** Har 15 soniyada: FBS kuzatuvlarini tekshirish */
let fbsRunning = false;
let fbsLastRun = 0;
export async function checkFbsWatches(env: Env): Promise<number> {
  if (fbsRunning) return 0; // bir vaqtda ikki marta ishlamasin (ikki marta bron bo'lmasin)
  fbsRunning = true;
  try {
    return await checkFbsWatchesInner(env);
  } finally {
    fbsRunning = false;
  }
}
const watchSeen = new Map<string, number>();
async function checkFbsWatchesInner(env: Env): Promise<number> {
  // Har 10–15 soniyada chaqiriladi — 9 s ichida takrorlanmasin
  // Xotirada (KV ga yozmaymiz — bepul limitni tejash)
  if (Date.now() - fbsLastRun < 9_000) return 0;
  fbsLastRun = Date.now();
  const page = await env.STATE.list({ prefix: "fbswatch:" });
  let found = 0;
  for (const k of page.keys) {
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const w: FWatch = JSON.parse(raw);
    if (uzumCooling(w.acc)) continue; // Uzum cheklagan — kutamiz
    // Mijoz kuzatuvi: obuna tugagan bo'lsa — to'xtatamiz
    const cm = w.acc.match(/\|u(\d+)$/);
    if (cm) {
      const cr = await env.STATE.get(`cl:${cm[1]}`);
      const sub = cr ? Number(JSON.parse(cr).sub ?? 0) : 0;
      if (!cr || !(sub > Date.now())) {
        await env.STATE.delete(k.name);
        await notify(env, w.chatId, `⛔ Obunangiz tugagani uchun FBS kuzatuvi to'xtatildi.\n📍 ${escapeHtml(w.label)}`).catch(() => {});
        continue;
      }
    }
    // Joy ko'p bo'lsa — kamroq tez-tez (so'rovlar oqimi ≈ 1 so'rov/soniya atrofida qoladi)
    const every = Math.max(14_000, w.points.length * 900);
    if (Date.now() - (watchSeen.get(k.name) ?? 0) < every) continue;
    watchSeen.set(k.name, Date.now());
    try {
      // Faqat hali yig'ishda turgan buyurtmalar
      // (har 2 daqiqada bir marta — so'rovlar ko'paymasin)
      let ids = w.orderIds;
      if (Date.now() - Number(w.pk ?? 0) > 120_000) {
        const packing = new Set((await packingOrders(env, w.acc)).map((o) => Number(o.id)));
        ids = w.orderIds.filter((x) => packing.has(x));
        w.pk = Date.now();
        if (ids.length) {
          w.orderIds = ids;
          await env.STATE.put(k.name, JSON.stringify(w), { expirationTtl: 3 * 86400 });
        }
      }
      if (!ids.length) {
        await env.STATE.delete(k.name);
        await notify(env, w.chatId, `🔔 FBS kuzatuvi to'xtadi: belgilangan buyurtmalar endi «Yig'ishdagilar»da emas.\n📍 ${escapeHtml(w.label)}`).catch(() => {});
        continue;
      }
      if (w.ymd && w.ymd.split("-").sort().at(-1)! < ymdOf(Date.now())) {
        await env.STATE.delete(k.name);
        await notify(env, w.chatId, `⌛ FBS avtomatik bron muddati tugadi: ${ymdText(w.ymd)} uchun joy chiqmadi.\n📍 ${escapeHtml(w.label)}`).catch(() => {});
        continue;
      }
      // ✂️ Bo'lib topshirish (avto): sig'im yetgan joylarga taqsimlab, darhol yaratamiz
      if (w.auto && w.split) {
        const plan = await fbsSplitPlan(env, w.acc, ids, w.points, (s) => slotFits(w, s), w.parts ?? 3, w.minPart ?? 2);
        if (!plan.parts.length) continue;
        found++;
        const res = await fbsSplitCreate(env, w.acc, w.chatId, plan.parts);
        const done = new Set(res.ok.flatMap((x) => x.part.orderIds));
        const left = ids.filter((x) => !done.has(x));
        if (left.length) {
          w.orderIds = left;
          await env.STATE.put(k.name, JSON.stringify(w), { expirationTtl: 3 * 86400 });
        } else await env.STATE.delete(k.name);
        if (res.ok.length) {
          const m = splitMessage(env, w.acc, res, left, `🎉 <b>FBS joy bron qilindi${res.ok.length > 1 ? ` — ${res.ok.length} ta joyga bo'lib` : ""}!</b>`);
          if (left.length) m.text += "\n🔎 Qolganlari uchun qidirishda davom etaman.";
          await notify(env, w.chatId, m.text, { reply_markup: { inline_keyboard: m.rows } }, "tasks").catch(() => {});
        }
        continue;
      }
      // Har bir joydagi bo'sh vaqtlar
      const hits: { p: Pt; slots: any[] }[] = [];
      for (const p of w.points) {
        const r = await uzumGet<any>(env, w.acc, `/seller/fbs/invoice/time-slot?${qs({ dopId: p.uuid, sellerOrderIds: ids.join(",") })}`).catch(() => null);
        const slots: any[] = (r?.timeSlots ?? []).filter((s: any) => Number(s.remainingCapacity ?? 1) > 0 && slotFits(w, s));
        if (slots.length) hits.push({ p, slots: slots.sort((x, y) => Number(x.timeFrom) - Number(y.timeFrom)) });
      }
      if (!hits.length) continue;
      found++;
      hits.sort((x, y) => Number(x.slots[0].timeFrom) - Number(y.slots[0].timeFrom));

      // ⚡ Avtomatik yaratish: eng yaqin vaqtdan boshlab urinib ko'ramiz
      if (w.auto) {
        const sellerId = await uzumSellerId(env, w.acc);
        const tries = hits.flatMap((h) => h.slots.slice(0, 3).map((s) => ({ p: h.p, s }))).sort((x, y) => Number(x.s.timeFrom) - Number(y.s.timeFrom)).slice(0, 5);
        for (const { p, s } of tries) {
          try {
            const r = await uzumPost<any>(env, w.acc, "/seller/fbs/invoice", { sellerId, orderIds: ids, dropOffPointUuid: p.uuid, timeSlotUuid: s.uuid, idempotencyKey: crypto.randomUUID() });
            await env.STATE.delete(k.name);
            await env.STATE.put(`fbslastdop:${w.acc}`, p.uuid);
            const num = r?.number ?? r?.id ?? "";
            const invId = Number(r?.id ?? 0);
            await scheduleReminder(env, { chatId: w.chatId, at: Number(s.timeFrom), to: Number(s.timeTo), title: `🚚 FBS ta'minlash${num ? ` № ${num}` : ""} · ${ids.length} ta buyurtma`, place: p.address, cb: `u:fi:${w.acc}:0`, labels: invId ? `u:flb:${w.acc}:${invId}` : `u:flp:${w.acc}` });
            const until = fmtTime(env, new Date(Number(s.timeTo)).toISOString()).split(" ")[1];
            await notify(
              env,
              w.chatId,
              [
                `🎉 <b>FBS joy bron qilindi!</b>${num ? ` 🧾 № <b>${escapeHtml(String(num))}</b>` : ""}`,
                "",
                `🚚 <b>Shu joyga olib borasiz:</b>`,
                `📍 ${escapeHtml(p.address)}`,
                `   ${ptType(p)}${p.hours ? ` · ish vaqti: ${p.hours}` : ""}`,
                "",
                `⏰ <b>${slotLabel(env, s)}</b> — soat <b>${until}</b> gacha olib boring!`,
                `📦 ${ids.length} ta buyurtma: ${ids.slice(0, 10).map((x) => `<code>${x}</code>`).join(", ")}${ids.length > 10 ? " …" : ""}`,
              ].join("\n"),
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🗺 Xaritada ochish", url: mapLink(p) } as any],
                    [{ text: "🏷 Yorliqlar (PDF)", callback_data: invId ? `u:flb:${w.acc}:${invId}` : `u:flp:${w.acc}` }, { text: "🧾 Ta'minlashlar", callback_data: `u:fi:${w.acc}:0` }],
                  ],
                },
              },
            ).catch(() => {});
            return found;
          } catch (e) {
            console.log("fbs auto invoice:", (e as Error).message);
          }
        }
      }

      // 🔔 Xabar: topilgan vaqtlar tugma bilan (bosilsa — tasdiqlash ekrani). Shu vaqtlar haqida qayta yozmaymiz.
      const sig = hits.flatMap((h) => h.slots.map((s) => s.uuid)).sort().join(",");
      if (sig === w.sig) continue;
      w.sig = sig;
      await env.STATE.put(k.name, JSON.stringify(w), { expirationTtl: 3 * 86400 });
      const pts = hits.map((h) => h.p);
      await env.STATE.put(ptsKey(w.acc), JSON.stringify(pts), { expirationTtl: 3600 });
      await putSel(env, w.acc, ids);
      const rows: Btn[][] = [];
      const L = [`🎉 <b>FBS: bo'sh vaqt ochildi!</b>${w.auto ? " (avtomatik yaratib bo'lmadi)" : ""}`, `📦 ${ids.length} ta buyurtma`, ""];
      for (let i = 0; i < hits.length && rows.length < 8; i++) {
        const h = hits[i];
        await env.STATE.put(slotKey(w.acc, i), JSON.stringify(h.slots.map((s) => ({ uuid: s.uuid, timeFrom: s.timeFrom, timeTo: s.timeTo, left: s.remainingCapacity }))), { expirationTtl: 3600 });
        L.push(`📍 ${escapeHtml(cut(h.p.address, 80))}`);
        h.slots.slice(0, 2).forEach((s, j) => rows.push([{ text: `✅ ${slotLabel(env, s)} · ${cut(h.p.address.replace(/^[^,]*(shahri|shahar|sh\.)\s*,\s*/i, ""), 22)}`, callback_data: `u:fts:${w.acc}:${i}:${j}` }]));
      }
      L.push("", "Tezroq tanlang 👇 Yangi vaqt ochilsa yana xabar beraman.");
      rows.push([{ text: "⏹ Kuzatuvni to'xtatish", callback_data: `u:fwq:${w.acc}` }]);
      await notify(env, w.chatId, L.join("\n"), { reply_markup: { inline_keyboard: rows } }, "new").catch(() => {});
    } catch (e) {
      console.log("fbs watch:", (e as Error).message);
    }
  }
  return found;
}

/** Bosh menyu uchun: faol avto bron / kuzatuv tugmalari (faqat yoqilgan bo'lsa) */
export async function activeWatchRows(env: Env): Promise<Btn[][]> {
  const rows: Btn[][] = [];
  const fb = await env.STATE.list({ prefix: "fbswatch:" });
  for (const k of fb.keys) {
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    const w: FWatch = JSON.parse(raw);
    if (w.acc.includes("|u")) continue; // mijozlarniki
    rows.push([{ text: `${w.auto ? "⚡ FBS avto bron" : "🔔 FBS kuzatuv"} · ${cut(w.label.replace(/^Toshkent shahri · /, ""), 28)}`, callback_data: `u:fws:${w.acc}`, style: "success" }]);
  }
  const fo0 = await env.STATE.list({ prefix: "uwatch:" });
  const fo = { keys: [] as { name: string }[] };
  for (const k of fo0.keys) if (!(await env.STATE.get(`clshop:${k.name.split(":")[2]}`))) fo.keys.push(k);
  if (fo.keys.length) rows.push([{ text: `🔔 FBO slot kuzatuv (${fo.keys.length})`, callback_data: "u:wl", style: "primary" }]);
  return rows;
}

/* ---------- 🏷 Yorliqlar (PDF) ---------- */

/** what: "inv" — ta'minlash (id), "pck" — barcha yig'ishdagilar, "ord" — bitta buyurtma */
export async function sendFbsLabels(env: Env, chatId: number, acc: string, what: "inv" | "pck" | "ord", id = 0): Promise<string> {
  const ids: number[] = [];
  if (what === "inv") {
    try {
      const pdf = await uzumFbsInvoiceLabels(env, acc, id);
      await sendDocument(env, chatId, pdf, `yorliqlar-${id}.pdf`, "application/pdf", `🏷 Ta'minlash № ${id} — barcha yorliqlar (58×40)`);
      return "✅ Yorliqlar yuborildi.";
    } catch (e) {
      console.log("invoice labels:", (e as Error).message);
      const r = await uzumGet<any>(env, acc, `/seller/fbs/invoice/${id}/orders`).catch(() => null);
      const list: any[] = Array.isArray(r) ? r : r?.orders ?? r?.content ?? [];
      for (const o of list) ids.push(Number(o.id ?? o.orderId));
    }
  } else if (what === "pck") ids.push(...(await packingOrders(env, acc)).map((o) => Number(o.id)));
  else ids.push(id);
  const todo = ids.filter(Boolean).slice(0, 20);
  if (!todo.length) return "⚠️ Yorliq uchun buyurtma topilmadi.";
  let ok = 0;
  for (const oid of todo) {
    try {
      const pdf = await uzumFbsLabel(env, acc, oid);
      await sendDocument(env, chatId, pdf, `yorliq-${oid}.pdf`, "application/pdf", `🏷 № ${oid}`);
      ok++;
    } catch (e) {
      console.log("label:", oid, (e as Error).message);
    }
  }
  return ok ? `✅ ${ok} ta yorliq yuborildi (58×40).` : "⚠️ Yorliqlarni olib bo'lmadi.";
}

/* ---------- 📱 Mini App uchun FBS ta'minlash (ma'lumot, ekransiz) ---------- */

/** Yig'ishdagi buyurtmalar va faol kuzatuv */
export async function fbsWebState(env: Env, acc: string) {
  const { names } = await shopIds(env, acc);
  const orders = await packingOrders(env, acc);
  const raw = await env.STATE.get(fwKey(acc));
  const w: FWatch | null = raw ? JSON.parse(raw) : null;
  return {
    orders: orders.map((o) => ({
      id: Number(o.id),
      shop: names.get(o.shopId) ?? String(o.shopId),
      items: (o.orderItems ?? []).slice(0, 3).map((it: any) => ({ name: skuLine(it), qty: Number(it.amount ?? 1) })),
      deadline: o.deliverUntil ? Number(o.deliverUntil) : null,
    })),
    watch: w ? { label: w.label, when: `${ymdText(w.ymd ?? "")} · ${halfText(w.half, w.hours).replace(/^\S+\s/, "")}`, auto: w.auto, orders: w.orderIds.length, points: w.points.length } : null,
  };
}

async function checkSel(env: Env, acc: string, sel: number[]): Promise<number[]> {
  const ids = new Set((await packingOrders(env, acc)).map((o) => Number(o.id)));
  const ok = [...new Set(sel.map(Number))].filter((x) => ids.has(x));
  if (!ok.length) throw new Error("Yig'ishdagi buyurtma tanlanmagan");
  await putSel(env, acc, ok);
  return ok;
}

/** Topshirish joylari (barcha + mos belgisi) */
export async function fbsWebPoints(env: Env, acc: string, sel: number[]) {
  const ok = await checkSel(env, acc, sel);
  const { slim } = await fetchPoints(env, acc, ok);
  const regs: string[] = JSON.parse((await env.STATE.get(`fbsregs:${acc}`)) ?? "[]");
  const last = await env.STATE.get(`fbslastdop:${acc}`);
  return {
    regions: regs,
    points: slim.map((x, i) => ({
      i,
      address: x.address,
      type: ptType(x),
      hours: x.hours,
      region: isMobile(x) ? MOBILE : x.region,
      district: isMobile(x) ? "" : x.district,
      ok: !!x.ok,
      last: x.uuid === last,
    })),
  };
}

/** Bitta joyning bo'sh vaqtlari */
export async function fbsWebSlots(env: Env, acc: string, p: number) {
  const pt = await getPoint(env, acc, p);
  const sel = await getSel(env, acc);
  if (!pt || !sel.length) throw new Error("Joylar ro'yxati eskirgan — qayta oching");
  const r = await uzumGet<any>(env, acc, `/seller/fbs/invoice/time-slot?${qs({ dopId: pt.uuid, sellerOrderIds: sel.join(",") })}`);
  const slots: any[] = (r?.timeSlots ?? []).filter((s: any) => Number(s.remainingCapacity ?? 1) > 0).sort((a: any, b: any) => Number(a.timeFrom) - Number(b.timeFrom));
  await env.STATE.put(slotKey(acc, p), JSON.stringify(slots.map((s) => ({ uuid: s.uuid, timeFrom: s.timeFrom, timeTo: s.timeTo, left: s.remainingCapacity }))), { expirationTtl: 3600 });
  return { slots: slots.slice(0, 30).map((s, i) => ({ s: i, text: slotLabel(env, s), left: s.remainingCapacity ?? null })) };
}

/** Ta'minlashni yaratish (supplyCreate bilan bir xil) */
export async function fbsWebCreate(env: Env, acc: string, p: number, s: number): Promise<{ ok: boolean; msg: string }> {
  const sc = await supplyCreate(env, acc, p, s);
  const first = sc.text.split("\n\n")[0] === "<b>🧾 FBS ta'minlashlar</b>" ? "" : sc.text.split("\n\n")[0];
  const plain = first.replace(/<[^>]+>/g, "");
  return { ok: plain.startsWith("✅"), msg: plain || "So'rov yuborildi — kabinetda tekshiring" };
}

/** Avtomatik bron / kuzatuv: tanlangan joylar, kunlar va soatlar */
export async function fbsWebWatch(env: Env, chatId: number, acc: string, pts: number[], days: string[], hours: number[], auto: boolean, label: string, split = false, parts = 3, minPart = 2) {
  const sel = await getSel(env, acc);
  if (!sel.length) throw new Error("Buyurtmalar tanlanmagan — qayta oching");
  const all = await loadPts(env, acc);
  const points = [...new Set(pts.map(Number))].map((i) => all[i]).filter(Boolean);
  if (!points.length) throw new Error("Kamida bitta joy tanlang");
  const hs = hours.map(Number).filter((h) => HOURS.includes(h));
  const w: FWatch = {
    acc,
    chatId,
    orderIds: sel,
    points: points.sort((x, y) => Number(!!y.ok) - Number(!!x.ok)).slice(0, MAXW),
    label: label.slice(0, 120) || (points.length === 1 ? points[0].address : `${points.length} ta joy`),
    auto,
    t: Date.now(),
    ymd: days.filter((d) => /^\d{8}$/.test(d)).sort().join("-"),
    half: hs.length ? "h" : "x",
    ...(hs.length ? { hours: hs } : {}),
    ...(split && auto ? { split: true, parts: Math.max(2, Math.min(5, Math.floor(parts) || 3)), minPart: Math.max(1, Math.min(10, Math.floor(minPart) || 2)) } : {}),
  };
  await env.STATE.put(fwKey(acc), JSON.stringify(w), { expirationTtl: 3 * 86400 });
  return { msg: auto ? "Avtomatik bron yoqildi" : "Kuzatuv yoqildi", maxed: points.length > MAXW };
}

/** Avto bron uchun kunlar: 20:00 dan keyin «bugun» — ertangi kun */
export function fbsWebDays() {
  const shift = tz5(Date.now()).getUTCHours() >= 20 ? 1 : 0;
  return [0, 1, 2].map((k) => {
    const ymd = ymdOf(Date.now() + (shift + k) * 86400e3);
    return { ymd, label: ymdOne(ymd), wd: k === 0 ? (shift ? "Ertaga" : "Bugun") : k === 1 && !shift ? "Ertaga" : "" };
  });
}

/* ---------- ✂️ Bo'lib topshirish: bitta joy hammasini qabul qilmasa — yaqin joylarga bo'lib ---------- */

export interface SplitPart {
  km?: number; // 1-punktdan masofa
  p: Pt;
  slot: { uuid: string; timeFrom: number; timeTo: number; cap: number };
  orderIds: number[];
}

const kmBetween = (a: Pt, b: Pt) => {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 9999;
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/**
 * Reja: har bir joyning bo'sh vaqtlari va sig'imi (remainingCapacity) olinadi.
 * Eng ko'p sig'imli joydan boshlab, unga eng yaqin joylarga qolgan buyurtmalar taqsimlanadi.
 * Bitta joy hammasini qabul qila olsa — bitta ta'minlash bo'ladi.
 */
const capCache = new Map<string, { t: number; slots: SplitPart["slot"][] }>();
/** Joyning bo'sh vaqtlari va sig'imi (bitta buyurtma bilan so'raladi — sig'imi kam joylar ham ko'rinsin). Kesh 45 s. */
async function pointSlots(env: Env, acc: string, p: Pt, oneId: number): Promise<SplitPart["slot"][]> {
  const key = `${acc.split("|")[0]}|${p.uuid}`;
  const c = capCache.get(key);
  if (c && Date.now() - c.t < 45_000) return c.slots;
  const r = await uzumGet<any>(env, acc, `/seller/fbs/invoice/time-slot?${qs({ dopId: p.uuid, sellerOrderIds: String(oneId) })}`).catch(() => null);
  if (!r) return c?.slots ?? [];
  const slots = ((r?.timeSlots ?? []) as any[]).map((s) => ({ uuid: String(s.uuid), timeFrom: Number(s.timeFrom), timeTo: Number(s.timeTo), cap: Number(s.remainingCapacity ?? 0) }));
  capCache.set(key, { t: Date.now(), slots });
  if (capCache.size > 2000) capCache.clear();
  return slots;
}
/** Ta'minlash yaratilgach — o'sha joylar keshini tozalash (sig'im o'zgardi) */
const capForget = (acc: string, uuids: string[]) => uuids.forEach((u) => capCache.delete(`${acc.split("|")[0]}|${u}`));

export const SPLIT_MAX_KM = 5; // bo'lib topshirishda punktlar bir-biridan uzog'i bilan shuncha km
export async function fbsSplitPlan(env: Env, acc: string, ids: number[], pts: Pt[], fit: (s: any) => boolean = () => true, maxParts = 3, minPart = 2, maxKm = SPLIT_MAX_KM): Promise<{ parts: SplitPart[]; left: number[] }> {
  maxParts = Math.max(1, Math.min(5, Math.floor(maxParts) || 3));
  // Bitta ta'minlashda kamida shuncha buyurtma (mayda ta'minlashlar ko'paymasin); jami undan kam bo'lsa — jami
  minPart = Math.max(1, Math.min(ids.length, Math.floor(minPart) || 1));
  const cands: { p: Pt; slots: SplitPart["slot"][] }[] = [];
  const list = pts.slice(0, 30);
  // 5 tadan parallel; har joyning vaqtlari 45 s eslab qolinadi (avto bron har 15 s da qayta so'ramasin)
  for (let i = 0; i < list.length; i += 5) {
    const chunk = await Promise.all(list.slice(i, i + 5).map((p) => pointSlots(env, acc, p, ids[0])));
    chunk.forEach((all, j) => {
      const slots = all.filter((s) => s.cap > 0 && fit(s)).sort((a, b) => a.timeFrom - b.timeFrom);
      if (slots.length) cands.push({ p: list[i + j], slots });
    });
  }
  if (!cands.length) return { parts: [], left: ids.slice() };
  const best = (c: (typeof cands)[0], day?: string) => {
    const pool = day ? c.slots.filter((s) => ymdOf(s.timeFrom) === day) : [];
    const list = pool.length ? pool : c.slots;
    // avval hammasini sig'dira oladigan eng erta vaqt, bo'lmasa — eng katta sig'imli
    const full = list.find((s) => s.cap >= ids.length);
    return full ?? [...list].sort((a, b) => b.cap - a.cap || a.timeFrom - b.timeFrom)[0];
  };
  // Bitta joy hammasini qabul qila oladimi? — eng erta shunday vaqt
  const single = cands
    .map((c) => ({ c, s: c.slots.find((s) => s.cap >= ids.length) }))
    .filter((x) => x.s)
    .sort((a, b) => a.s!.timeFrom - b.s!.timeFrom)[0];
  if (single) return { parts: [{ p: single.c.p, slot: single.s!, orderIds: ids.slice() }], left: [] };
  // Langar — eng katta sig'imli joy; qolganlari unga yaqinligi bo'yicha
  const anchor = [...cands].sort((a, b) => best(b).cap - best(a).cap)[0];
  const day = ymdOf(best(anchor).timeFrom);
  // Avval langarga yaqin joylar (maxKm ichida), yetmasa — tumandagi uzoqroqlari ham (yaqinidan boshlab).
  // Koordinatasi noma'lum joylar eng oxirida.
  // Faqat 1-punkt joylashgan tumanning o'zidagi joylar (boshqa tumanga o'tmaydi)
  const sameDistrict = (c: (typeof cands)[0]) => (c.p.district || "") === (anchor.p.district || "") && c.p.region === anchor.p.region;
  const near = cands
    .filter((c) => c !== anchor && sameDistrict(c))
    .map((c) => ({ c, km: kmBetween(anchor.p, c.p) }))
    .sort((a, b) => a.km - b.km);
  void maxKm;
  // Ko'pi bilan maxParts ta joy. Ikki usul solishtiriladi: (A) eng yaqinlari, (B) eng ko'p sig'imlilari —
  // qaysi biri ko'proq buyurtmani joylasa, o'sha (teng bo'lsa — yaqinlari).
  const build = (list: typeof near) => {
    let rest = ids.slice();
    const parts: SplitPart[] = [];
    for (const { c, km } of [{ c: anchor, km: 0 }, ...list]) {
      if (!rest.length || parts.length >= maxParts) break;
      const s = best(c, day);
      const n = Math.min(s.cap, rest.length);
      if (n < minPart) continue; // juda kichik — bu joyni o'tkazib yuboramiz
      parts.push({ p: c.p, slot: s, orderIds: rest.slice(0, n), km: km >= 9999 ? -1 : Math.round(km * 10) / 10 });
      rest = rest.slice(n);
    }
    return { parts, left: rest };
  };
  const a = build(near);
  if (!a.left.length) return a;
  const b = build([...near].sort((x, y) => best(y.c, day).cap - best(x.c, day).cap || x.km - y.km));
  return b.left.length < a.left.length ? b : a;
}

/** Reja bo'yicha ta'minlashlarni ketma-ket yaratish */
export async function fbsSplitCreate(env: Env, acc: string, chatId: number, parts: SplitPart[]): Promise<{ ok: { part: SplitPart; num: string; invId: number }[]; failed: { part: SplitPart; err: string }[] }> {
  const lock = `fbsinvlock:${acc}`;
  if (await env.STATE.get(lock)) throw new Error("Ta'minlash allaqachon yaratilmoqda — biroz kuting");
  await env.STATE.put(lock, "1", { expirationTtl: 120 });
  const ok: { part: SplitPart; num: string; invId: number }[] = [];
  const failed: { part: SplitPart; err: string }[] = [];
  try {
    const sellerId = await uzumSellerId(env, acc);
    for (const part of parts) {
      try {
        const r = await uzumPost<any>(env, acc, "/seller/fbs/invoice", { sellerId, orderIds: part.orderIds, dropOffPointUuid: part.p.uuid, timeSlotUuid: part.slot.uuid, idempotencyKey: crypto.randomUUID() });
        const num = String(r?.number ?? r?.id ?? r?.invoiceNumber ?? (Array.isArray(r) ? r[0]?.number ?? r[0]?.id : "") ?? "");
        const invId = Number(r?.id ?? 0);
        ok.push({ part, num, invId });
        capForget(acc, [part.p.uuid]);
        await env.STATE.put(`fbslastdop:${acc}`, part.p.uuid);
        await scheduleReminder(env, { chatId, at: part.slot.timeFrom, to: part.slot.timeTo, title: `🚚 FBS ta'minlash${num ? ` № ${num}` : ""} · ${part.orderIds.length} ta buyurtma`, place: part.p.address, cb: `u:fi:${acc}:0`, labels: invId ? `u:flb:${acc}:${invId}` : `u:flp:${acc}` });
      } catch (e) {
        failed.push({ part, err: (e as Error).message });
      }
    }
  } finally {
    await env.STATE.delete(lock);
  }
  return { ok, failed };
}

/** Bo'lib yaratilgan ta'minlashlar haqida bitta xabar */
export function splitMessage(env: Env, acc: string, res: Awaited<ReturnType<typeof fbsSplitCreate>>, left: number[], head: string) {
  const L = [head, ""];
  res.ok.forEach((x, i) => {
    const until = fmtTime(env, new Date(x.part.slot.timeTo).toISOString()).split(" ")[1];
    L.push(
      `<b>${i + 1}) ${x.num ? `🧾 № ${escapeHtml(x.num)} · ` : ""}${x.part.orderIds.length} ta buyurtma</b>`,
      `📍 ${escapeHtml(x.part.p.address)}${i ? ` <i>(${x.part.km === -1 ? "masofa noma'lum" : `1-punktdan ${String(x.part.km).replace(".", ",")} km`}${(x.part.km ?? 0) > SPLIT_MAX_KM || x.part.km === -1 ? " — uzoqroq" : ""})</i>` : ""}`,
      `⏰ ${slotLabel(env, { timeFrom: x.part.slot.timeFrom, timeTo: x.part.slot.timeTo })} — soat <b>${until}</b> gacha`,
      `📦 ${x.part.orderIds.map((o) => `<code>${o}</code>`).join(", ")}`,
      "",
    );
  });
  if (res.failed.length) L.push(`⚠️ Yaratilmadi: ${res.failed.map((f) => `${f.part.orderIds.length} ta (${escapeHtml(cut(f.err, 60))})`).join("; ")}`);
  if (left.length) L.push(`⏳ Yana <b>${left.length}</b> ta buyurtmaga joy topilmadi.`);
  const rows: Btn[][] = res.ok.slice(0, 4).map((x) => [{ text: `🗺 ${cut(x.part.p.address.replace(/^[^,]*(shahri|shahar|sh\.)\s*,\s*/i, ""), 30)}`, url: mapLink(x.part.p) } as any]);
  rows.push([{ text: "🏷 Yorliqlar (PDF)", callback_data: `u:flp:${acc}` }, { text: "🧾 Ta'minlashlar", callback_data: `u:fi:${acc}:0` }]);
  return { text: L.join("\n"), rows };
}

/** 📱 Mini App: bo'lib topshirish rejasi (tanlangan joylar bo'yicha) */
export async function fbsWebSplitPlan(env: Env, acc: string, pts: number[], maxParts = 3, minPart = 2) {
  const sel = await getSel(env, acc);
  if (!sel.length) throw new Error("Buyurtmalar tanlanmagan — qayta oching");
  const all = await loadPts(env, acc);
  const chosen = [...new Set(pts.map(Number))].map((i) => all[i]).filter(Boolean);
  if (!chosen.length) throw new Error("Joy tanlanmagan");
  const plan = await fbsSplitPlan(env, acc, sel, chosen, () => true, maxParts, minPart);
  await env.STATE.put(`fbsplan:${acc}`, JSON.stringify(plan), { expirationTtl: 600 });
  return {
    total: sel.length,
    left: plan.left.length,
    maxKm: SPLIT_MAX_KM,
    minPart: Math.min(minPart, sel.length),
    parts: plan.parts.map((x) => ({ address: x.p.address, type: ptType(x.p), slot: slotLabel(env, x.slot), cap: x.slot.cap, n: x.orderIds.length, orderIds: x.orderIds, km: x.km ?? 0 })),
  };
}

export async function fbsWebSplitCreate(env: Env, chatId: number, acc: string) {
  const raw = await env.STATE.get(`fbsplan:${acc}`);
  if (!raw) throw new Error("Reja eskirgan — qayta hisoblang");
  const plan = JSON.parse(raw) as { parts: SplitPart[]; left: number[] };
  await env.STATE.delete(`fbsplan:${acc}`);
  const res = await fbsSplitCreate(env, acc, chatId, plan.parts);
  const done = new Set(res.ok.flatMap((x) => x.part.orderIds));
  const left = plan.parts.flatMap((x) => x.orderIds).filter((x) => !done.has(x)).concat(plan.left);
  // Qolganlari — keyingi avto bron uchun tanlangan holda qoladi
  if (left.length) await putSel(env, acc, left);
  else await env.STATE.delete(selKey(acc));
  if (res.ok.length) {
    const m = splitMessage(env, acc, res, left, `✅ <b>Ta'minlash yaratildi${res.ok.length > 1 ? ` — ${res.ok.length} ta joyga bo'lib` : ""}</b>`);
    await notify(env, chatId, m.text, { reply_markup: { inline_keyboard: m.rows } }, "tasks").catch(() => {});
  }
  return { created: res.ok.length, failed: res.failed.map((f) => cut(f.err, 120)), left: left.length, leftIds: left };
}
