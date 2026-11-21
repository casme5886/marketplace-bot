/**
 * 🛎 Uzum Slot xizmati — mijozlar uchun (innaslot kabi).
 *  - Mijoz xizmat raqamimizni kabinetiga «Менеджер» qilib qo'shadi va do'kon ID sini yuboradi.
 *  - Bot xizmat hisobi orqali uning FBO nakladnoylarini ko'radi va bo'sh slotni avtomatik band qiladi.
 *  - Oylik obuna: admin qo'lda uzaytiradi (+30 kun). Birinchi ulanishda 3 kun sinov.
 *
 * KV: svc:acc | svc:phone | svc:price | svc:contact
 *     cl:{uid} → Client · clshop:{shopId} → uid · clwait:{chat} → kutilayotgan do'kon ID
 */
import { notify } from "./notify";
import type { Env } from "./types";
import { escapeHtml, sendText } from "./telegram";
import { getOwner, userName } from "./auth";
import { decrypt, encrypt, uzumGet, uzumAllAccounts, uzumBindShop, uzumCanSeeShop, uzumShopsFresh } from "./uzum";
import { ozonUnfulfilled } from "./ozon";
import { wbNew } from "./wb";
import { pollAll } from "./orders";
import { skuLine } from "./uzumfbs";

type Btn = { text: string; callback_data: string; style?: string };
export type CScreen = { text: string; reply_markup: { inline_keyboard: Btn[][] } };

export interface Client {
  uid: number;
  name: string;
  shops: { id: number; name: string }[];
  sub: number; // obuna tugash vaqti (ms)
  trial: boolean; // sinov berilganmi
  trialEnd?: number; // bepul sinov tugash vaqti
  t: number;
}

const TRIAL_DAYS = 7; // har bir yangi mijozga bepul sinov
const DAY = 86400e3;
const fmtDate = (ms: number) => {
  const d = new Date(ms + 5 * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/* ---------- Sozlamalar ---------- */

export async function svcSettings(env: Env) {
  const [acc, phone, price, contact] = await Promise.all(["svc:acc", "svc:phone", "svc:price", "svc:contact"].map((k) => env.STATE.get(k)));
  return { acc: acc ?? "", phone: phone ?? "", price: price ?? "", contact: contact ?? "" };
}

/* ---------- Mijozlar ---------- */

export async function getClient(env: Env, uid: number): Promise<Client | null> {
  const raw = await env.STATE.get(`cl:${uid}`);
  if (!raw) return null;
  const c: Client = JSON.parse(raw);
  // Sinov hali berilmagan (eski «bepul davr» mijozlari ham) — 7 kunlik bepul sinov shu paytdan
  if (!c.trial) {
    grantTrial(c);
    await env.STATE.put(`cl:${uid}`, JSON.stringify(c));
  }
  return c;
}
function grantTrial(c: Client) {
  c.trial = true;
  c.trialEnd = Math.max(c.sub, Date.now()) + TRIAL_DAYS * DAY;
  c.sub = c.trialEnd;
}
export const inTrial = (c: Client | null) => !!c?.trialEnd && c.sub <= c.trialEnd && c.sub > Date.now();
const saveClient = (env: Env, c: Client) => env.STATE.put(`cl:${c.uid}`, JSON.stringify(c));
/** Umumiy bepul davr o'chirildi — endi har bir mijozga 7 kunlik sinov, keyin pullik */
export const FREE_UNTIL = 0;
export const freeNow = () => false;
export const subActive = (c: Client | null) => !!c && c.sub > Date.now();

/** Do'kon mijozniki bo'lsa — mijoz (aks holda null) */
export async function clientOfShop(env: Env, shopId: number): Promise<Client | null> {
  const uid = await env.STATE.get(`clshop:${shopId}`);
  return uid ? getClient(env, Number(uid)) : null;
}

export const listClientsAll = (env: Env) => listClients(env);
async function listClients(env: Env): Promise<Client[]> {
  const page = await env.STATE.list({ prefix: "cl:" });
  const out: Client[] = [];
  for (const k of page.keys) {
    const raw = await env.STATE.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  return out.sort((a, b) => b.t - a.t);
}

const subLine = (c: Client | null) =>
  inTrial(c)
    ? `🎁 Bepul sinov: <b>${fmtDate(c!.sub)}</b> gacha`
    : !c || !c.sub ? "⚪ Obuna yo'q" : c.sub > Date.now() ? `✅ Obuna: <b>${fmtDate(c.sub)}</b> gacha` : `⛔ Obuna tugagan (${fmtDate(c.sub)})`;

/** Mijoz kuzatuvlari (FBO) */
async function clientWatches(env: Env, c: Client) {
  const ids = new Set(c.shops.map((s) => s.id));
  const page = await env.STATE.list({ prefix: "uwatch:" });
  const out: { key: string; w: any }[] = [];
  for (const k of page.keys) {
    const shop = Number(k.name.split(":")[2]);
    if (!ids.has(shop)) continue;
    const raw = await env.STATE.get(k.name);
    if (raw) out.push({ key: k.name, w: JSON.parse(raw) });
  }
  return out;
}

/* ---------- Mijoz ekranlari ---------- */

export async function clientHome(env: Env, uid: number, note = ""): Promise<CScreen> {
  const c = await getClient(env, uid);
  const L = [
    "🛎 <b>Uzum Slot</b> — xush kelibsiz!",
    "",
    "Bot Uzum fulfillment markazida yetkazib berish uchun <b>bo'sh slotni avtomatik topib band qiladi</b>. Kimdir slotni bekor qilsa, bot uni bir necha soniyada olib qo'yadi.",
    "",
    "<b>Qanday ishlaydi:</b>",
    "1. Bizning raqamni kabinetingizga xodim qilib qo'shasiz",
    "2. Do'kon ID va slot kerak bo'lgan nakladnoyni tanlaysiz",
    "3. Bot 24/7 kuzatadi va bo'sh slot chiqishi bilan band qiladi",
    "",
    `🎁 Birinchi <b>${TRIAL_DAYS} kun — bepul</b>, keyin oylik obuna.`,
  ];
  if (note) L.unshift(note, "");
  const rows: Btn[][] = [];
  const mp0 = await mpCreds(env, uid);
  if (c?.shops.length || mp0.oz || mp0.wb) {
    const ws = c ? await clientWatches(env, c) : [];
    L.push("", c?.shops.length ? `🛍 Uzum do'konlar: <b>${c.shops.map((s) => escapeHtml(s.name)).join(", ")}</b>` : "🛍 Uzum do'koni ulanmagan", subLine(c));
    if (ws.length) L.push(`🔍 Faol kuzatuvlar: <b>${ws.length}</b>`);
    if (c?.shops.length) rows.push([{ text: "🟪 Uzum Market", callback_data: "c:uz", style: "success" }]);
    if (ws.length) rows.push([{ text: `🔔 Kuzatuvlarim (${ws.length})`, callback_data: "c:wl", style: "primary" }]);
    const mp = await mpCreds(env, uid);
    if (mp.oz || mp.wb) {
      L.push(`🔗 Ulangan: ${[mp.oz ? "🟦 Ozon" : "", mp.wb ? "🟪 WB" : ""].filter(Boolean).join(" · ")} — yangi FBS buyurtmalar shu yerga keladi`);
      rows.push([{ text: "📋 Ozon/WB buyurtmalar", callback_data: "m:orders" }, { text: "📈 Statistika", callback_data: "s:td" }]);
    }
    rows.push([{ text: `🔗 Ozon / WB ${mp.oz || mp.wb ? "sozlash" : "ulash"}`, callback_data: "c:mp" }]);
    if (!c?.shops.length) rows.push([{ text: "🔌 Uzum do'konini ulash", callback_data: "c:con" }]);
    rows.push([{ text: "💳 Obuna", callback_data: "c:sub" }]);
  } else {
    L.push("", "Boshlash uchun «🔌 Do'konni ulash» tugmasini bosing.", "<i>Ozon / Wildberries FBS buyurtmalarini ham ulash mumkin — 🔗 tugmasi.</i>");
    rows.push([{ text: "🔌 Do'konni ulash (Uzum)", callback_data: "c:con", style: "success" }]);
    rows.push([{ text: "🔗 Ozon / WB ulash", callback_data: "c:mp" }]);
  }
  const appUrl = await env.STATE.get("app:url");
  if (appUrl) rows.unshift([{ text: "📱 Ilovani ochish", web_app: { url: appUrl } } as unknown as Btn]);
  rows.push([{ text: "🔐 Faqat MarketHub xodimlari uchun", callback_data: "c:staff" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function connectScreen(env: Env, chat: number, pid: number | null): Promise<CScreen> {
  const s = await svcSettings(env);
  if (!s.acc || !s.phone) {
    return {
      text: "⏳ Xizmat hozircha sozlanmoqda. Birozdan keyin urinib ko'ring.",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Bosh sahifa", callback_data: "c:home" }]] },
    };
  }
  await env.STATE.put(`clwait:${chat}`, String(pid ?? 0), { expirationTtl: 1800 });
  return {
    text: [
      "🔌 <b>Do'koningizni ulash</b>",
      "",
      "Bot nakladnoylaringizni ko'rishi va slot band qilishi uchun uni kabinetingizga <b>xodim</b> sifatida qo'shing — parol kerak emas:",
      "",
      "1️⃣ seller.uzum.uz → <b>Сотрудники</b>",
      "2️⃣ <b>Добавить сотрудника</b> ni bosing",
      `3️⃣ Raqam: <code>${escapeHtml(s.phone)}</code>`,
      "4️⃣ Rol: <b>Менеджер</b>",
      "5️⃣ Do'koningizni belgilab, saqlang",
      "",
      "✅ Bajarib bo'lgach, <b>Do'kon ID</b> raqamini shu chatga yuboring:",
      "seller.uzum.uz/seller/<b>12345</b>/products — URL dagi raqam (yoki butun havolani yuboring)",
    ].join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "c:home" }]] },
  };
}

/** Mijoz do'kon ID yubordi */
export async function linkShop(env: Env, from: any, text: string): Promise<CScreen> {
  const uid = Number(from.id);
  const m = text.match(/seller\/(\d{3,9})/) ?? text.match(/^\s*(\d{3,9})\s*$/);
  const again = (msg: string): CScreen => ({
    text: msg,
    reply_markup: { inline_keyboard: [[{ text: "🔌 Ko'rsatmani qayta ko'rish", callback_data: "c:con" }], [{ text: "🏠 Bosh sahifa", callback_data: "c:home" }]] },
  });
  if (!m) return again("❓ Do'kon ID topilmadi. Faqat raqamni (masalan <code>12345</code>) yoki kabinetdagi havolani yuboring.");
  const shopId = Number(m[1]);
  const s = await svcSettings(env);
  if (!s.acc) return again("⏳ Xizmat hozircha sozlanmoqda.");
  const busy = await env.STATE.get(`clshop:${shopId}`);
  if (busy && Number(busy) !== uid) return again("🚫 Bu do'kon boshqa akkauntga ulangan. Muammo bo'lsa, admin bilan bog'laning.");
  // Do'kon xizmat hisobida ko'rinadimi
  let name = "";
  try {
    const shops = await uzumShopsFresh(env, s.acc);
    name = shops.find((x) => x.id === shopId)?.name ?? "";
  } catch (e) {
    console.log("svc shops:", (e as Error).message);
  }
  if (!name && (await uzumCanSeeShop(env, s.acc, shopId))) name = `Do'kon ${shopId}`;
  if (!name) {
    return again(
      `❌ <b>${shopId}</b> do'koniga kirish huquqi hali yo'q.\n\nTekshiring:\n• raqam <code>${escapeHtml(s.phone)}</code> <b>Сотрудники</b>ga qo'shilganmi\n• rol <b>Менеджер</b>, do'kon belgilangan va saqlanganmi\n\nQo'shgandan 1–2 daqiqa o'tib ID ni qayta yuboring.`,
    );
  }
  await uzumBindShop(env, shopId, s.acc);
  let c = await getClient(env, uid);
  const isNew = !c;
  if (!c) c = { uid, name: [from.first_name, from.last_name].filter(Boolean).join(" ") + (from.username ? ` @${from.username}` : ""), shops: [], sub: 0, trial: false, t: Date.now() };
  if (!c.shops.some((x) => x.id === shopId)) c.shops.push({ id: shopId, name });
  let note = `✅ <b>${escapeHtml(name)}</b> ulandi!`;
  if (!c.trial) grantTrial(c);
  if (isNew) note += `\n🎁 ${TRIAL_DAYS} kunlik bepul sinov: <b>${fmtDate(c.sub)}</b> gacha. Keyin — oylik obuna.`;
  await saveClient(env, c);
  await env.STATE.put(`clshop:${shopId}`, String(uid));
  await env.STATE.delete(`clwait:${uid}`);
  const owner = await getOwner(env);
  if (owner) {
    await sendText(env, owner, `🛎 <b>${isNew ? "Yangi mijoz" : "Mijoz do'kon qo'shdi"}</b>\n👤 ${escapeHtml(c.name)} · <code>${uid}</code>\n🛍 <b>${escapeHtml(name)}</b> (${shopId})`, {
      reply_markup: { inline_keyboard: [[{ text: "👤 Mijozni ochish", callback_data: `c:cl:${uid}` }]] },
    }).catch(() => {});
  }
  return clientHome(env, uid, note);
}

export async function clientShopsScreen(env: Env, uid: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c?.shops.length) return clientHome(env, uid);
  if (!subActive(c)) return subScreen(env, uid, "⛔ Obunangiz tugagan — slot olish uchun obunani uzaytiring.");
  const rows: Btn[][] = c.shops.map((s) => [{ text: `🛍 ${s.name}`, callback_data: `u:k:f:${s.id}` }]);
  rows.push([{ text: "⬅️ Uzum Market", callback_data: "c:uz" }, { text: "🏠", callback_data: "c:home" }]);
  return { text: "📦 <b>Qaysi do'kon nakladnoylari?</b>\n\nNakladnoyni tanlang → sana/vaqt yoki <b>⚡ Avto bron</b> (kunlar + soatlar).", reply_markup: { inline_keyboard: rows } };
}

/** 🟪 Uzum Market: FBO va FBS tugmalari */
export async function clientUzumScreen(env: Env, uid: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c?.shops.length) return clientHome(env, uid);
  const ws = await clientWatches(env, c);
  const L = ["🟪 <b>Uzum Market</b>", "", `🛍 <b>${c.shops.map((s) => escapeHtml(s.name)).join(", ")}</b>`, subLine(c)];
  if (ws.length) L.push(`🔍 Faol slot kuzatuvlari: <b>${ws.length}</b>`);
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📦 FBO — slot olish", callback_data: "c:sh", style: "primary" },
          { text: "🚚 FBS — buyurtmalar", callback_data: "c:fbs:NEW", style: "success" },
        ],
        ...(ws.length ? [[{ text: `🔔 Kuzatuvlarim (${ws.length})`, callback_data: "c:wl" } as Btn]] : []),
        [{ text: "➕ Uzum do'kon qo'shish", callback_data: "c:con" }],
        [{ text: "🏠 Bosh sahifa", callback_data: "c:home" }],
      ],
    },
  };
}

const FBS_ST: { s: string; k: string; t: string; i: string }[] = [
  { s: "CREATED", k: "NEW", t: "Yangilar", i: "🆕" },
  { s: "PACKING", k: "PCK", t: "Yig'ishda", i: "📦" },
  { s: "PENDING_DELIVERY", k: "PND", t: "Ta'minlashda", i: "🚚" },
  { s: "DELIVERING", k: "DLV", t: "Yo'lda", i: "🛣" },
  { s: "CANCELED", k: "CNL", t: "Bekor", i: "❌" },
];

/** 🚚 Mijozning Uzum FBS buyurtmalari (faqat o'z do'konlari, ko'rish rejimi) */
export async function clientFbsScreen(env: Env, uid: number, k = "NEW"): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c?.shops.length) return clientHome(env, uid);
  if (!subActive(c)) return subScreen(env, uid, "⛔ Obunangiz tugagan — uzaytiring.");
  const s = await svcSettings(env);
  const st = FBS_ST.find((x) => x.k === k) ?? FBS_ST[0];
  const ids = c.shops.map((x) => x.id).join(",");
  const names = new Map(c.shops.map((x) => [x.id, x.name]));
  const qs = (o: Record<string, string | number>) => Object.entries(o).map(([a, b]) => `${a}=${encodeURIComponent(String(b))}`).join("&");
  const L = [`🚚 <b>Uzum FBS · ${st.t}</b>`, ""];
  const rows: Btn[][] = [];
  try {
    const cnt = await uzumGet<any>(env, s.acc, `/seller/fbs/orders/count?${qs({ scheme: "FBS", statuses: FBS_ST.map((x) => x.s).join(","), shopIds: ids, places: "STOCK,DROP_OFF" })}`);
    const num = (x: string) => Number((cnt?.ordersCount ?? []).find((y: any) => y.status === x)?.counter ?? 0);
    const r = await uzumGet<any>(env, s.acc, `/seller/fbs/v2/orders?${qs({ page: 0, size: 20, sortBy: "CREATED_DATE", sortOrder: "DESC", scheme: "FBS", statuses: st.s, shopIds: ids, places: "STOCK,DROP_OFF" })}`);
    const list: any[] = r?.orders ?? [];
    if (!list.length) L.push("Bu bo'limda buyurtma yo'q ✅");
    for (const o of list) {
      L.push(`№ <code>${o.id}</code> · 🛍 <b>${escapeHtml(names.get(o.shopId) ?? String(o.shopId))}</b>`);
      for (const it of (o.orderItems ?? []).slice(0, 3)) L.push(`   🏷 ${escapeHtml(skuLine(it))} × ${it.amount ?? 1}`);
    }
    const btns: Btn[] = FBS_ST.map((x) => ({ text: `${x.i} ${x.t} (${num(x.s)})`, callback_data: `c:fbs:${x.k}`, ...(x.k === st.k ? { style: "primary" } : {}) }));
    rows.push(btns.slice(0, 3), btns.slice(3));
  } catch (e) {
    L.push(`⚠️ FBS ma'lumotini olib bo'lmadi: ${escapeHtml(String((e as Error).message).slice(0, 120))}`);
  }
  L.push("", "<i>Yig'ishga o'tkazish va ta'minlash — hozircha Uzum kabinetida.</i>");
  rows.push([{ text: "🔄 Yangilash", callback_data: `c:fbs:${st.k}` }, { text: "⬅️ Uzum Market", callback_data: "c:uz" }]);
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

export async function clientWatchesScreen(env: Env, uid: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c) return clientHome(env, uid);
  const ws = await clientWatches(env, c);
  const L = ["🔔 <b>Kuzatuvlarim</b>", ""];
  if (!ws.length) L.push("Hozir hech narsa kuzatilmayapti.");
  const rows: Btn[][] = [];
  for (const { w } of ws) {
    L.push(`📄 № ${escapeHtml(String(w.invNo))}${w.auto ? " · ⚡ avto bron" : " · 🔔 xabar"}`);
    rows.push([{ text: `📄 №…${String(w.invNo).slice(-4)}${w.auto ? " ⚡" : ""} — holat`, callback_data: `u:ws:f:${w.shopId}:${w.invId}`, style: "primary" }]);
  }
  rows.push([{ text: "🏠 Bosh sahifa", callback_data: "c:home" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function subScreen(env: Env, uid: number, note = ""): Promise<CScreen> {
  const c = await getClient(env, uid);
  const s = await svcSettings(env);
  const L = ["💳 <b>Obuna</b>", ""];
  if (note) L.push(note, "");
  L.push(subLine(c));
  if (s.price) L.push(`💰 Narx: <b>${escapeHtml(s.price)}</b>`);
  L.push("", `To'lov uchun admin bilan bog'laning${s.contact ? `: ${escapeHtml(s.contact)}` : ""}.`, "To'lagach «✅ To'lov qildim» tugmasini bosing — admin tasdiqlashi bilan obuna uzayadi.");
  return {
    text: L.join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "✅ To'lov qildim", callback_data: "c:paid", style: "success" }], [{ text: "🏠 Bosh sahifa", callback_data: "c:home" }]] },
  };
}

export async function paidNotice(env: Env, uid: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  const owner = await getOwner(env);
  if (owner && c) {
    await sendText(env, owner, `💳 <b>To'lov so'rovi</b>\n👤 ${escapeHtml(c.name)} · <code>${uid}</code>\n🛍 <b>${c.shops.map((s) => escapeHtml(s.name)).join(", ")}</b>\n${subLine(c)}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ +30 kun", callback_data: `c:ext:${uid}:30`, style: "success" }, { text: "+7 kun", callback_data: `c:ext:${uid}:7` }],
          [{ text: "👤 Mijozni ochish", callback_data: `c:cl:${uid}` }],
        ],
      },
    }).catch(() => {});
  }
  return subScreen(env, uid, "📨 So'rovingiz adminga yuborildi. Tasdiqlangach xabar keladi.");
}

/** Mijoz qaysi tugmalarni bosa oladi (FBO nakladnoylari, faqat o'z do'konlari) */
const FREE_ACTS = new Set(["k", "i", "d", "h", "t", "ws", "wq", "fbp", "w3"]);
const PAID_ACTS = new Set(["ty", "w", "wt", "fbz", "wd"]);
export async function clientGuard(env: Env, uid: number, p: string[]): Promise<"ok" | "home" | "sub" | "watches" | "shops"> {
  const act = p[1];
  if (act === "wl") return "watches";
  if (act === "s" || act === "fbo") return "shops"; // «⬅️ Orqaga» nakladnoylardan — do'konlar ro'yxatiga
  if (!FREE_ACTS.has(act) && !PAID_ACTS.has(act)) return "home";
  if (p[2] !== "f") return "home";
  const c = await getClient(env, uid);
  if (!c || !c.shops.some((s) => s.id === Number(p[3]))) return "home";
  if (!subActive(c) && (PAID_ACTS.has(act) || act === "k")) return "sub";
  return "ok";
}

/* ---------- 👑 Admin: xizmat sozlamalari va mijozlar ---------- */

export async function adminScreen(env: Env, note = ""): Promise<CScreen> {
  const s = await svcSettings(env);
  const acc = (await uzumAllAccounts(env)).find((a) => a.id === s.acc);
  const cls = await listClients(env);
  const active = cls.filter((c) => subActive(c)).length;
  const L = ["🛎 <b>Slot xizmati — boshqaruv</b>", ""];
  if (note) L.push(note, "");
  L.push(
    `🛎 Xizmat hisobi: <b>${acc ? escapeHtml(acc.label) : "tanlanmagan"}</b>`,
    `📞 Mijozlarga raqam: <b>${s.phone ? escapeHtml(s.phone) : "—"}</b>`,
    `💰 Narx: <b>${s.price ? escapeHtml(s.price) : "—"}</b>`,
    `👤 To'lov uchun kontakt: <b>${s.contact ? escapeHtml(s.contact) : "—"}</b>`,
    "",
    `👥 Mijozlar: <b>${cls.length}</b> · faol obuna: <b>${active}</b>`,
  );
  if (!acc) L.push("", "⚠️ <b>Sozlash:</b> 1) xizmat raqami bilan Uzum profilini qo'shing → 2) uni xizmat hisobi qilib tanlang. Shundan keyin mijozlar raqamni ko'radi.");
  const rows: Btn[][] = [
    ...(acc ? [] : [[{ text: "➕ 1) Xizmat raqami profilini qo'shish", callback_data: "u:lg", style: "success" } as Btn]]),
    [{ text: acc ? "🛎 Xizmat hisobini almashtirish" : "🛎 2) Xizmat hisobini tanlash", callback_data: "c:svl", ...(acc ? {} : { style: "primary" }) }],
    [{ text: "📞 Raqam", callback_data: "c:set:phone" }, { text: "💰 Narx", callback_data: "c:set:price" }, { text: "👤 Kontakt", callback_data: "c:set:contact" }],
  ];
  if (cls.length) L.push("", "👇 Mijozlar ro'yxati (bosib — obuna, do'konlar):");
  else L.push("", "<i>Mijozlar ro'yxati shu yerda chiqadi — birinchi mijoz do'konini ulagach.</i>");
  for (const c of cls.slice(0, 30)) {
    rows.push([{ text: `${subActive(c) ? "✅" : "⛔"} ${c.name.slice(0, 22)} · ${c.shops.length} do'kon`, callback_data: `c:cl:${c.uid}` }]);
  }
  rows.push([{ text: "⚙️ Profillar", callback_data: "u:am" }, { text: "🏠 Menyu", callback_data: "m:home" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function svcPickScreen(env: Env): Promise<CScreen> {
  const s = await svcSettings(env);
  const rows: Btn[][] = (await uzumAllAccounts(env))
    .filter((a) => a.id !== "env")
    .map((a) => [{ text: `${a.id === s.acc ? "✅ " : ""}${a.label}`, callback_data: `c:svs:${a.id}` }]);
  rows.push([{ text: "⬅️ Orqaga", callback_data: "c:adm" }]);
  return {
    text: "🛎 <b>Xizmat hisobi</b>\n\nMijozlar kabinetiga qo'shadigan raqam bilan kirgan profilni tanlang.\n⚠️ Shu profil do'konlari endi sizning xodim menyularingizda ko'rinmaydi (faqat mijozlarniki).",
    reply_markup: { inline_keyboard: rows },
  };
}

export async function setSvcAcc(env: Env, id: string): Promise<CScreen> {
  await env.STATE.put("svc:acc", id);
  await env.STATE.delete(`uzum:shops:${id}`);
  return adminScreen(env, "✅ Xizmat hisobi tanlandi.");
}

export async function askSetting(env: Env, chat: number, field: string, pid: number): Promise<CScreen> {
  await env.STATE.put(`svcset:${chat}`, JSON.stringify({ field, pid }), { expirationTtl: 600 });
  const what: Record<string, string> = {
    phone: "📞 Mijozlar kabinetiga qo'shadigan <b>xizmat raqami</b>ni yozing (masalan +998 90 123-45-67):",
    price: "💰 Oylik obuna <b>narxi</b>ni yozing (masalan 150 000 so'm / oy):",
    contact: "👤 To'lov uchun <b>kontakt</b> (masalan @username yoki telefon):",
  };
  return { text: what[field] ?? "Qiymatni yozing:", reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "c:adm" }]] } };
}

/** Admin sozlama qiymatini yozdi */
export async function saveSetting(env: Env, field: string, value: string): Promise<CScreen> {
  if (["phone", "price", "contact"].includes(field)) await env.STATE.put(`svc:${field}`, value.trim().slice(0, 80));
  return adminScreen(env, "✅ Saqlandi.");
}

export async function clientAdminScreen(env: Env, uid: number, note = ""): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c) return adminScreen(env, "Mijoz topilmadi.");
  const ws = await clientWatches(env, c);
  const L = [`👤 <b>${escapeHtml(c.name)}</b> · <code>${uid}</code>`, ""];
  if (note) L.unshift(note, "");
  L.push(subLine(c), `🛍 ${c.shops.map((s) => `<b>${escapeHtml(s.name)}</b> (${s.id})`).join(", ") || "—"}`, `🔍 Kuzatuvlar: ${ws.length}`, `🔗 Ozon/WB: ${await mpCreds(env, uid).then((m) => [m.oz ? "🟦 Ozon" : "", m.wb ? "🟪 WB" : ""].filter(Boolean).join(" · ") || "—")}`, `📅 Ulangan: ${fmtDate(c.t)}`);
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ +30 kun", callback_data: `c:ext:${uid}:30`, style: "success" }, { text: "+7 kun", callback_data: `c:ext:${uid}:7` }, { text: "+1 kun", callback_data: `c:ext:${uid}:1` }],
        [{ text: "⛔ Obunani to'xtatish", callback_data: `c:stop:${uid}`, style: "danger" }],
        [{ text: "🗑 Mijozni o'chirish", callback_data: `c:del:${uid}`, style: "danger" }],
        [{ text: "⬅️ Mijozlar", callback_data: "c:adm" }],
      ],
    },
  };
}

export async function extendSub(env: Env, uid: number, days: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c) return adminScreen(env, "Mijoz topilmadi.");
  // Bepul davr ichida qo'shilgan kunlar bepul davr tugagach boshlanadi
  c.sub = Math.max(c.sub, Date.now(), freeNow() ? FREE_UNTIL : 0) + days * DAY;
  await saveClient(env, c);
  await notify(env, uid, `✅ Obunangiz <b>${fmtDate(c.sub)}</b> gacha uzaytirildi. Rahmat!`, {
    reply_markup: { inline_keyboard: [[{ text: "📦 Nakladnoylar", callback_data: "c:sh" }]] },
  }).catch(() => {});
  return clientAdminScreen(env, uid, `✅ +${days} kun qo'shildi.`);
}

async function dropWatches(env: Env, c: Client) {
  for (const { key } of await clientWatches(env, c)) await env.STATE.delete(key);
}

export async function stopSub(env: Env, uid: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (!c) return adminScreen(env);
  c.sub = Date.now() - 1000;
  await saveClient(env, c);
  await dropWatches(env, c);
  return clientAdminScreen(env, uid, "⛔ Obuna to'xtatildi, kuzatuvlari o'chirildi.");
}

export async function deleteClient(env: Env, uid: number): Promise<CScreen> {
  const c = await getClient(env, uid);
  if (c) {
    await dropWatches(env, c);
    for (const s of c.shops) await env.STATE.delete(`clshop:${s.id}`);
    await env.STATE.delete(`cl:${uid}`);
  }
  return adminScreen(env, `🗑 ${c ? escapeHtml(c.name) : "Mijoz"} o'chirildi.`);
}

/** Mijoz o'z Uzum do'konini uzadi: ro'yxatdan chiqariladi, shu do'kon kuzatuvlari o'chiriladi */
export async function unlinkShop(env: Env, uid: number, shopId: number): Promise<string> {
  const c = await getClient(env, uid);
  const s = c?.shops.find((x) => x.id === shopId);
  if (!c || !s) throw new Error("Do'kon topilmadi");
  const page = await env.STATE.list({ prefix: "uwatch:" });
  for (const k of page.keys) if (Number(k.name.split(":")[2]) === shopId) await env.STATE.delete(k.name);
  c.shops = c.shops.filter((x) => x.id !== shopId);
  await saveClient(env, c);
  if ((await env.STATE.get(`clshop:${shopId}`)) === String(uid)) await env.STATE.delete(`clshop:${shopId}`);
  const owner = await getOwner(env);
  if (owner) await sendText(env, owner, `🔌 <b>Mijoz do'konni uzdi</b>\n👤 ${escapeHtml(c.name)} · <code>${uid}</code>\n🛍 ${escapeHtml(s.name)} (${shopId})`).catch(() => {});
  return s.name;
}

/** Har kuni: obunasi 1 kunda tugaydiganlarga eslatma (fon tekshiruvidan chaqiriladi) */
export async function subReminders(env: Env) {
  for (const c of await listClients(env)) {
    const end = freeNow() ? Math.max(c.sub, FREE_UNTIL) : c.sub;
    const left = end - Date.now();
    const key = `clrem:${c.uid}:${Math.floor(end / DAY)}`;
    if (left > 0 && left < DAY && !(await env.STATE.get(key))) {
      await env.STATE.put(key, "1", { expirationTtl: 3 * 86400 });
      await notify(env, c.uid, `⏰ Obunangiz <b>${fmtDate(end)}</b> da tugaydi. Slot kuzatuvi to'xtamasligi uchun uzaytiring.`, {
        reply_markup: { inline_keyboard: [[{ text: "💳 Obuna", callback_data: "c:sub" }]] },
      }).catch(() => {});
    }
  }
}

export { userName };

/* ---------- 🔗 Mijozning Ozon / Wildberries FBS buyurtmalari ---------- */
// Har mijozga alohida "ijarachi" muhit: o'z tokenlari + o'z KV bo'limi (t:{uid}:...) — buyurtma kartochkalari, statistika
// MarketHub'dagi kod o'zgarishsiz ishlaydi, faqat mijozning tokenlari va xotirasi bilan.

interface MpCreds {
  oz?: { id: string; key: string };
  wb?: string;
}

export async function mpCreds(env: Env, uid: number): Promise<MpCreds> {
  const raw = await env.STATE.get(`clmp:${uid}`);
  if (!raw) return {};
  try {
    return JSON.parse(await decrypt(env, raw));
  } catch {
    return {};
  }
}
async function saveMp(env: Env, uid: number, m: MpCreds) {
  if (!m.oz && !m.wb) return env.STATE.delete(`clmp:${uid}`);
  await env.STATE.put(`clmp:${uid}`, await encrypt(env, JSON.stringify(m)));
}

/** KV ning mijozga ajratilgan bo'limi */
function prefixedKV(kv: KVNamespace, pre: string): KVNamespace {
  return {
    get: (k: string, ...a: any[]) => (kv.get as any)(pre + k, ...a),
    put: (k: string, v: any, o?: any) => kv.put(pre + k, v, o),
    delete: (k: string) => kv.delete(pre + k),
    list: async (o: any = {}) => {
      const r: any = await kv.list({ ...o, prefix: pre + (o.prefix ?? "") });
      return { ...r, keys: r.keys.map((x: any) => ({ ...x, name: x.name.slice(pre.length) })) };
    },
  } as unknown as KVNamespace;
}

/** Mijoz uchun muhit: Ozon/WB tokenlari va alohida xotira. Xabarlar faqat shu mijozga boradi. */
export async function tenantEnv(env: Env, uid: number, m?: MpCreds): Promise<Env> {
  const c = m ?? (await mpCreds(env, uid));
  const STATE = prefixedKV(env.STATE, `t:${uid}:`);
  if (!(await STATE.get(`auth:${uid}`))) await STATE.put(`auth:${uid}`, new Date().toISOString());
  return {
    ...env,
    STATE,
    OZON_CLIENT_ID: c.oz?.id ?? "",
    OZON_API_KEY: c.oz?.key ?? "",
    WB_API_TOKEN: c.wb ?? "",
    ADMIN_TELEGRAM_ID: String(uid),
    RESTART: undefined,
  } as Env;
}

export async function mpScreen(env: Env, uid: number, note = ""): Promise<CScreen> {
  const m = await mpCreds(env, uid);
  const L = ["🔗 <b>Ozon va Wildberries</b>", ""];
  if (note) L.push(note, "");
  L.push(
    "Yangi <b>FBS buyurtmalar</b> darhol shu chatga keladi: qabul qilish, yorliq, topshirish va bekor qilish tugmalari bilan. Statistika ham ko'rinadi.",
    "",
    `🟦 Ozon: ${m.oz ? `✅ ulangan (Client-Id ${escapeHtml(m.oz.id)})` : "— ulanmagan"}`,
    `🟪 Wildberries: ${m.wb ? "✅ ulangan" : "— ulanmagan"}`,
  );
  const rows: Btn[][] = [
    [
      { text: m.oz ? "🟦 Ozon — yangilash" : "🟦 Ozon ulash", callback_data: "c:mpo", ...(m.oz ? {} : { style: "primary" }) },
      { text: m.wb ? "🟪 WB — yangilash" : "🟪 WB ulash", callback_data: "c:mpw", ...(m.wb ? {} : { style: "primary" }) },
    ],
  ];
  const del: Btn[] = [];
  if (m.oz) del.push({ text: "🗑 Ozon'ni uzish", callback_data: "c:mpx:o", style: "danger" });
  if (m.wb) del.push({ text: "🗑 WB'ni uzish", callback_data: "c:mpx:w", style: "danger" });
  if (del.length) rows.push(del);
  rows.push([{ text: "🏠 Bosh sahifa", callback_data: "c:home" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function mpAsk(env: Env, chat: number, which: "o" | "w", pid: number): Promise<CScreen> {
  await env.STATE.delete(`clwait:${chat}`);
  await env.STATE.put(`clmpw:${chat}`, JSON.stringify({ step: which === "o" ? "oz_id" : "wb", pid }), { expirationTtl: 900 });
  const text =
    which === "o"
      ? "🟦 <b>Ozon ulash</b>\n\nOzon Seller → <b>Настройки → Seller API</b> → «Сгенерировать ключ» (rol: <b>Admin</b> yoki FBS huquqli).\n\n1️⃣ Avval <b>Client-Id</b> raqamini yuboring:"
      : "🟪 <b>Wildberries ulash</b>\n\nWB Partners → <b>Настройки → Доступ к API</b> → token yarating (bo'limlar: <b>Маркетплейс</b>, <b>Статистика</b>).\n\nTokenni shu chatga yuboring:";
  return { text: text + "\n\n<i>🔒 Xabaringiz darhol o'chiriladi, kalit shifrlangan holda saqlanadi.</i>", reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "c:mp" }]] } };
}

/** Mijoz token/kalit yubordi. Qaytaradi: ekran (yoki null — kutilmagan) */
export async function mpInput(env: Env, uid: number, chat: number, text: string): Promise<{ sc: CScreen; pid: number | null } | null> {
  const raw = await env.STATE.get(`clmpw:${chat}`);
  if (!raw) return null;
  const st = JSON.parse(raw) as { step: string; pid: number; id?: string };
  const t = text.trim();
  const m = await mpCreds(env, uid);
  if (st.step === "oz_id") {
    if (!/^\d{3,12}$/.test(t)) return { sc: { ...(await mpAsk(env, chat, "o", st.pid)), text: "❓ Client-Id faqat raqamlardan iborat. Qayta yuboring:" }, pid: st.pid };
    await env.STATE.put(`clmpw:${chat}`, JSON.stringify({ step: "oz_key", pid: st.pid, id: t }), { expirationTtl: 900 });
    return { sc: { text: `🟦 Client-Id: <b>${escapeHtml(t)}</b>\n\n2️⃣ Endi <b>API kalit</b>ni (Api-Key) yuboring:`, reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "c:mp" }]] } }, pid: st.pid };
  }
  await env.STATE.delete(`clmpw:${chat}`);
  const next: MpCreds = { ...m };
  if (st.step === "oz_key") next.oz = { id: st.id ?? "", key: t };
  else next.wb = t;
  // Tekshiramiz
  const tenv = await tenantEnv(env, uid, next);
  try {
    if (st.step === "oz_key") await ozonUnfulfilled(tenv);
    else await wbNew(tenv);
  } catch (e) {
    return { sc: await mpScreen(env, uid, `❌ Ulanmadi: ${escapeHtml(String((e as Error).message).slice(0, 160))}\nKalitni tekshirib qayta urinib ko'ring.`), pid: st.pid };
  }
  await saveMp(env, uid, next);
  // Mijoz yozuvi (faqat Ozon/WB ulagan bo'lsa ham) + bir martalik sinov
  let c = await getClient(env, uid);
  let trialNote = "";
  const isNewCl = !c;
  if (!c) c = { uid, name: await userName(env, uid).catch(() => String(uid)), shops: [], sub: 0, trial: false, t: Date.now() };
  if (isNewCl) {
    const owner = await getOwner(env);
    if (owner) await sendText(env, owner, `🛎 <b>Yangi mijoz (Ozon/WB)</b>\n👤 ${escapeHtml(c.name)} · <code>${uid}</code>`, { reply_markup: { inline_keyboard: [[{ text: "👤 Mijozni ochish", callback_data: `c:cl:${uid}` }]] } }).catch(() => {});
  }
  if (!c.trial) {
    grantTrial(c);
    trialNote = `\n🎁 ${TRIAL_DAYS} kunlik bepul sinov: ${fmtDate(c.sub)} gacha.`;
  }
  await saveClient(env, c);
  // Hozir turgan buyurtmalar haqida eski xabar yubormaslik uchun — birinchi tekshiruvni "jim" o'tkazamiz
  await env.STATE.put(`clmpseed:${uid}`, "1");
  return { sc: await mpScreen(env, uid, `✅ ${st.step === "oz_key" ? "Ozon" : "Wildberries"} ulandi! Yangi FBS buyurtmalar shu chatga keladi.${trialNote}`), pid: st.pid };
}

export async function mpRemove(env: Env, uid: number, which: string): Promise<CScreen> {
  const m = await mpCreds(env, uid);
  if (which === "o") delete m.oz;
  else delete m.wb;
  await saveMp(env, uid, m);
  return mpScreen(env, uid, "🗑 Uzildi.");
}

/** Har daqiqada: obunasi faol mijozlarning Ozon/WB buyurtmalarini tekshirish */
export async function pollClients(env: Env): Promise<number> {
  let n = 0;
  for (const c of await listClientsAll(env)) {
    if (!subActive(c)) continue;
    const m = await mpCreds(env, c.uid);
    if (!m.oz && !m.wb) continue;
    try {
      const tenv = await tenantEnv(env, c.uid, m);
      if (await env.STATE.get(`clmpseed:${c.uid}`)) {
        // Birinchi marta: mavjud buyurtmalarni "ko'rilgan" deb belgilaymiz (xabarsiz)
        const chats = tenv.STATE;
        await chats.delete(`auth:${c.uid}`);
        await pollAll(tenv);
        await chats.put(`auth:${c.uid}`, new Date().toISOString());
        await env.STATE.delete(`clmpseed:${c.uid}`);
        continue;
      }
      n += (await pollAll(tenv)).newCount;
    } catch (e) {
      console.log("client poll", c.uid, (e as Error).message);
    }
  }
  return n;
}

