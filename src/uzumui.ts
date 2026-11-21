/**
 * Uzum FBO: do'kon → nakladnoy → sana → kun yarmi → vaqt → band qilish.
 * Bo'sh slot bo'lmasa — kuzatish: slot ochilishi bilan xabar beradi.
 * Callback'lar (u:...):
 *   u:sh                              do'konlar
 *   u:s:{shop}                        nakladnoy turi (FBO / qaytarish / FBS)
 *   u:k:{k}:{shop}                    nakladnoylar ({k}: f — FBO, r — qaytarish, s — FBS)
 *   u:i:{k}:{shop}:{inv}:{page}       sanalar (14 kunlik sahifa)
 *   u:d:{k}:{shop}:{inv}:{ymd}        kun yarmi
 *   u:h:{k}:{shop}:{inv}:{ymd}:{a|p}  vaqtlar
 *   u:t:{k}:{shop}:{inv}:{from}:{to}  tasdiqlash
 *   u:ty:{k}:{shop}:{inv}:{from}:{to} band qilish
 *   u:w:{k}:{shop}:{inv}:{ymd}:{a|p}  kuzatishni yoqish
 *   u:wl / u:wx:{key}            kuzatuvlar ro'yxati / o'chirish
 */
import { notify } from "./notify";
import { checkFbsWatches, fbsWatchList } from "./uzumfbs";
import { scheduleReminder } from "./reminders";
import { logBooking } from "./booklog";
import type { Env } from "./types";
import { escapeHtml, sendText, tg } from "./telegram";
import { getOwner, listAuthorizedChats, userName } from "./auth";
import { tzOffset } from "./format";
import { ensureNames, KIND_NAME, maskLogin, shopName, uzumAccounts, uzumAllAccounts, uzumInvoice, uzumInvoices, uzumReserve, uzumShops, uzumSlots, type UzInvoice, type UzKind, type UzSlot } from "./uzum";

type Btn = { text: string; callback_data: string; style?: string };
export interface UScreen {
  text: string;
  reply_markup: { inline_keyboard: Btn[][] };
}

const DAY = 864e5;
const WD = ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"];
const HALF_NAME = { a: "🌅 Ertalab (12:00 gacha)", p: "🌇 Tushdan keyin (12:00 dan kechgacha)" } as const;
type Half = "a" | "p";

/** Toshkent vaqtidagi qismlar */
function local(env: Env, ms: number) {
  const d = new Date(ms + tzOffset(env) * 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    ymd: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    dm: `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`,
    hm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    h: d.getUTCHours(),
    wd: WD[d.getUTCDay()],
  };
}
/** YYYYMMDD → shu kun boshlanishi (ms, Toshkent) */
function ymdStart(env: Env, ymd: string): number {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
  return Date.UTC(y, m, d) - tzOffset(env) * 3600e3;
}
const ymdLabel = (env: Env, ymd: string) => {
  const l = local(env, ymdStart(env, ymd) + 3600e3);
  return `${l.wd} ${l.dm}`;
};
const halfOf = (env: Env, ms: number): Half => (local(env, ms).h < 12 ? "a" : "p");
const slotText = (env: Env, s: UzSlot) => `${local(env, s.from).hm}–${local(env, s.to).hm}`;
const fullSlot = (env: Env, s: { from: number; to: number }) => `${local(env, s.from).wd} ${local(env, s.from).dm} · ${slotText(env, s)}`;
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ")} so'm`;
const back = (to: string, text = "⬅️ Orqaga"): Btn => ({ text, callback_data: to });

/* ---------- Ekranlar ---------- */

/** Bosh ekran: bitta profil bo'lsa — do'konlar, ko'p bo'lsa — profillar */
export async function rootScreen(env: Env, viewerId = 0): Promise<UScreen> {
  await ensureNames(env).catch(() => {});
  const accs = await uzumAccounts(env);
  if (accs.length === 1) return shopsScreen(env, accs[0].id, false, viewerId);
  const isAdm = viewerId > 0 && (await getOwner(env)) === viewerId;
  const rows: Btn[][] = accs.map((a) => [{ text: `👤 ${a.label}`, callback_data: `u:ac:${a.id}` }]);
  rows.push([{ text: "⚙️ Profillar", callback_data: "u:am" }, { text: "🔔 Kuzatuvlar", callback_data: "u:wl" }]);
  void isAdm;
  rows.push([back("u:home"), back("m:home", "🏠")]);
  return {
    text: `<b>📦 Uzum FBO</b>\n\nTa'minlash va qaytarishlarga vaqt tanlash.\nProfilni tanlang 👇 (${accs.length} ta)`,
    reply_markup: { inline_keyboard: rows },
  };
}

export async function shopsScreen(env: Env, accId: string, multi = true, viewerId = 0): Promise<UScreen> {
  const viewerIsOwner = viewerId > 0 && (await getOwner(env)) === viewerId;
  const acc = (await uzumAccounts(env)).find((a) => a.id === accId);
  const shops = await uzumShops(env, accId);
  const counts = await Promise.all(
    shops.map((s) =>
      Promise.all([uzumInvoices(env, "f", s.id), uzumInvoices(env, "r", s.id)])
        .then(([a, b]) => a.length + b.length)
        .catch(() => -1),
    ),
  );
  const rows: Btn[][] = [];
  for (let i = 0; i < shops.length; i += 2) {
    rows.push(
      shops.slice(i, i + 2).map((s, j) => {
        const n = counts[i + j];
        return { text: `🛍 ${s.name}${n > 0 ? ` (${n})` : n < 0 ? " ⚠️" : ""}`, callback_data: `u:s:${s.id}` };
      }),
    );
  }
  const r2: Btn[] = [{ text: "⚙️ Profillar", callback_data: "u:am" }, { text: "🔔 Kuzatuvlar", callback_data: "u:wl" }];
  rows.push(r2);
  rows.push(multi ? [back("u:fbo"), back("m:home", "🏠")] : [back("u:home"), back("m:home", "🏠")]);
  return {
    text:
      `<b>📦 Uzum FBO</b>${acc ? `\n👤 ${escapeHtml(acc.label)}${viewerIsOwner ? ` · <code>${escapeHtml(maskLogin(acc.login))}</code>` : ""}` : ""}` +
      "\n\nFBO ta'minlash va qaytarishlarga vaqt tanlash.\nDo'konni tanlang 👇\n<i>Qavsda — faol nakladnoylar soni</i>",
    reply_markup: { inline_keyboard: rows },
  };
}

function invLine(env: Env, i: UzInvoice): string {
  return i.slot ? `✅ ${fullSlot(env, i.slot)}` : "⏳ vaqt tanlanmagan";
}

/** Do'kon: nakladnoy turini tanlash */
export async function kindScreen(env: Env, shopId: number): Promise<UScreen> {
  const shop = await shopName(env, shopId);
  const [f, r] = await Promise.all([
    uzumInvoices(env, "f", shopId).catch(() => null),
    uzumInvoices(env, "r", shopId).catch(() => null),
  ]);
  const cnt = (l: UzInvoice[] | null) => (l == null ? " ⚠️" : l.length ? ` (${l.length})` : "");
  const noSlot = (l: UzInvoice[] | null) => (l ?? []).filter((x) => !x.slot).length;
  const L = [`<b>🛍 ${escapeHtml(shop)}</b>`, "", "Qaysi nakladnoyga vaqt tanlaymiz?", ""];
  L.push(`📦 FBO ta'minlash (omborga olib borish): <b>${f?.length ?? "—"}</b>` + (noSlot(f) ? ` · ⏳ vaqtsiz ${noSlot(f)}` : ""));
  L.push(`↩️ Qaytarish (ombordan olish): <b>${r?.length ?? "—"}</b>` + (noSlot(r) ? ` · ⏳ vaqtsiz ${noSlot(r)}` : ""));
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: `📦 FBO${cnt(f)}`, callback_data: `u:k:f:${shopId}` }, { text: `↩️ Qaytarish${cnt(r)}`, callback_data: `u:k:r:${shopId}` }],
        [back("u:fbo"), back("m:home", "🏠")],
      ],
    },
  };
}

export async function invoicesScreen(env: Env, kind: UzKind, shopId: number): Promise<UScreen> {
  if (kind === "s") {
    return {
      text: "🚚 <b>FBS nakladnoylari</b>\n\nBu qism hali ulanmagan — Uzum kabinetidagi FBS topshirish vaqtini tekshirib, keyingi yangilanishda qo'shaman.",
      reply_markup: { inline_keyboard: [[back(`u:s:${shopId}`), back("m:home", "🏠")]] },
    };
  }
  const [shop, list] = await Promise.all([shopName(env, shopId), uzumInvoices(env, kind, shopId)]);
  const L = [`<b>🛍 ${escapeHtml(shop)} · ${KIND_NAME[kind]}</b>`, ""];
  if (!list.length) L.push(kind === "f" ? "Faol nakladnoy yo'q. Kabinetda yarating, keyin 🔄 bosing." : "Olinishi kerak bo'lgan qaytarish yo'q ✅");
  for (const i of list.slice(0, 10)) {
    const head = kind === "f" ? `📄 <b>№ ${i.number}</b> · ${i.qty} dona · ${money(i.price)}` : `↩️ <b>№ ${i.number}</b> · ${escapeHtml(i.type ?? "")}`;
    L.push(head, `     ${invLine(env, i)} · ${escapeHtml(i.statusText)}`);
    if (i.freeUntil) {
      const days = Math.ceil((i.freeUntil - Date.now()) / DAY);
      L.push(`     ${days > 0 ? `🆓 Bepul saqlash: yana ${days} kun` : "💸 Pullik saqlash boshlangan"}`);
    }
  }
  const watches = await Promise.all(list.slice(0, 10).map((i) => activeWatch(env, kind, shopId, i.id)));
  watches.forEach((a, n) => {
    if (a) L.push(`🔍 № ${list[n].number}: qidirilmoqda ${watchWhen(env, a.w)}${a.w.auto ? " · ⚡avto" : ""}`);
  });
  const rows: Btn[][] = list.slice(0, 10).map((i, n) => [
    {
      text: `${kind === "f" ? "📄" : "↩️"} № ${i.number} · ${i.slot ? "✅ " + local(env, i.slot.from).dm + " " + local(env, i.slot.from).hm : "⏳ vaqt yo'q"}${watches[n] ? " · 🔍" : ""}`,
      callback_data: `u:i:${kind}:${shopId}:${i.id}:0`,
    },
  ]);
  rows.push([back(`u:s:${shopId}`), { text: "🔄 Yangilash", callback_data: `u:k:${kind}:${shopId}` }, back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

async function loadInv(env: Env, kind: UzKind, shopId: number, invId: number) {
  const inv = await uzumInvoice(env, kind, shopId, invId);
  if (!inv) throw new Error("Nakladnoy topilmadi");
  return inv;
}

function invHeader(env: Env, inv: UzInvoice): string[] {
  const L =
    inv.kind === "f"
      ? [`<b>📄 FBO nakladnoy № ${inv.number}</b>`, `📦 ${inv.qty} dona · ${money(inv.price)} · 🏭 ${escapeHtml(inv.stock)}`]
      : [`<b>↩️ Qaytarish № ${inv.number}</b>`, `${escapeHtml(inv.type ?? "")} · 🏭 ${escapeHtml(inv.stock)} · ${escapeHtml(inv.statusText)}`];
  L.push(inv.slot ? `🕒 Hozirgi vaqt: <b>${fullSlot(env, inv.slot)}</b>` : "🕒 Vaqt hali tanlanmagan");
  if (inv.slot && inv.updatesLeft != null) L.push(`🔁 O'zgartirish imkoni: <b>${inv.updatesLeft}</b> marta`);
  return L;
}

/** Sanalar: 14 kunlik sahifa, bo'sh slotli kunlar ✅ bilan */
export async function datesScreen(env: Env, kind: UzKind, shopId: number, invId: number, page = 0): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const slots = await uzumSlots(env, shopId, inv);
  const byDay = new Map<string, number>();
  for (const s of slots) byDay.set(local(env, s.from).ymd, (byDay.get(local(env, s.from).ymd) ?? 0) + 1);
  const L = invHeader(env, inv);
  const first = slots[0];
  const aw = await activeWatch(env, kind, shopId, invId);
  if (aw) L.push("", watchLine(env, aw.w));
  L.push("", first ? `🟢 Eng yaqin bo'sh slot: <b>${fullSlot(env, first)}</b>` : "🔴 Hozircha bo'sh slot yo'q");
  L.push("", `📅 ${aw ? "Yangi sanani" : "Sanani"} tanlang 👇\n<i>✅ — bo'sh vaqt bor (soni). Bo'sh bo'lmagan kunni tanlasangiz — o'sha kun uchun qidiraman.</i>`);

  const today = local(env, Date.now()).ymd;
  // Yaqin 7 kun (bugundan boshlab)
  const start = ymdStart(env, today);
  const days = 7;
  const btns: Btn[] = [];
  for (let k = 0; k < days; k++) {
    const ymd = local(env, start + k * DAY + 3600e3).ymd;
    const n = byDay.get(ymd) ?? 0;
    const name = k === 0 ? `Bugun · ${ymdLabel(env, ymd)}` : k === 1 ? `Ertaga · ${ymdLabel(env, ymd)}` : ymdLabel(env, ymd);
    btns.push({ text: `${n ? "✅ " : ""}${name}${n ? ` (${n})` : ""}`, callback_data: `u:d:${kind}:${shopId}:${invId}:${ymd}`, ...(n ? { style: "success" } : {}) });
  }
  const rows: Btn[][] = [btns.slice(0, 2), btns.slice(2, 5), btns.slice(5, 7)];
  // Eng yaqin bo'sh kunlarga tezkor o'tish
  if (first && local(env, first.from).ymd > local(env, start + (days - 1) * DAY).ymd) {
    rows.push([{ text: `⚡ Eng yaqin bo'sh kun: ${ymdLabel(env, local(env, first.from).ymd)}`, callback_data: `u:d:${kind}:${shopId}:${invId}:${local(env, first.from).ymd}` }]);
  }
  rows.unshift([{ text: "⚡ Avto bron: yaqin 3 kun", callback_data: `u:w3:${kind}:${shopId}:${invId}`, style: "success" }]);
  if (aw) rows.push([{ text: "🔍 Qidiruv holati", callback_data: `u:ws:${kind}:${shopId}:${invId}` }, { text: "⏹ To'xtatish", callback_data: `u:wq:${kind}:${shopId}:${invId}` }]);
  rows.push([back(`u:k:${kind}:${shopId}`), { text: "🔄", callback_data: `u:i:${kind}:${shopId}:${invId}:${page}` }, back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

async function daySlots(env: Env, shopId: number, inv: UzInvoice, ymd: string) {
  const slots = await uzumSlots(env, shopId, inv);
  return slots.filter((s) => local(env, s.from).ymd === ymd);
}

/** Kun yarmini tanlash */
export async function halfScreen(env: Env, kind: UzKind, shopId: number, invId: number, ymd: string): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const ds = await daySlots(env, shopId, inv, ymd);
  const a = ds.filter((s) => halfOf(env, s.from) === "a").length;
  const p = ds.length - a;
  const L = [...invHeader(env, inv), "", `📅 <b>${ymdLabel(env, ymd)}</b> — kunning qaysi qismi?`];
  if (!ds.length) L.push("<i>Bu kunda hozir bo'sh vaqt yo'q — kun qismini tanlasangiz, shu kun uchun qidiraman.</i>");
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: `${HALF_NAME.a}${a ? ` · ${a}` : ""}`, callback_data: `u:h:${kind}:${shopId}:${invId}:${ymd}:a` }],
        [{ text: `${HALF_NAME.p}${p ? ` · ${p}` : ""}`, callback_data: `u:h:${kind}:${shopId}:${invId}:${ymd}:p` }],
        [back(`u:i:${kind}:${shopId}:${invId}:0`, "⬅️ Sanalar"), back("m:home", "🏠")],
      ],
    },
  };
}

/** Vaqtlar (bo'sh slotlar) yoki kuzatish taklifi */
export async function timesScreen(env: Env, kind: UzKind, shopId: number, invId: number, ymd: string, half: Half): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const list = (await daySlots(env, shopId, inv, ymd)).filter((s) => halfOf(env, s.from) === half);
  const L = [...invHeader(env, inv), "", `📅 <b>${ymdLabel(env, ymd)}</b> · ${HALF_NAME[half]}`];
  const rows: Btn[][] = [];
  if (list.length) {
    L.push("", "Bo'sh vaqtni tanlang 👇");
    const btns = list.map((s) => ({ text: `🕒 ${slotText(env, s)}`, callback_data: `u:t:${kind}:${shopId}:${invId}:${s.from}:${s.to}` }));
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  } else {
    // Bo'sh vaqt yo'q — shu sana uchun qidiruvni tasdiqlash
    const sc = await searchConfirmScreen(env, kind, shopId, invId, ymd, half);
    sc.text = sc.text.replace("❓", "🔴 Hozircha bo'sh vaqt yo'q.\n\n❓");
    return sc;
  }
  rows.push([{ text: "🔍 Boshqa vaqt chiqishini kutish", callback_data: `u:wc:${kind}:${shopId}:${invId}:${ymd}:${half}` }]);
  rows.push([back(`u:d:${kind}:${shopId}:${invId}:${ymd}`), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function confirmScreen(env: Env, kind: UzKind, shopId: number, invId: number, from: number, to: number): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const L = [...invHeader(env, inv), "", `❓ <b>${fullSlot(env, { from, to })}</b> slotini band qilaymi?`];
  if (inv.slot) {
    L.push(`⚠️ Hozirgi slot (${fullSlot(env, inv.slot)}) bekor bo'ladi va o'zgartirish imkoni 1 taga kamayadi.`);
    if (inv.updatesLeft === 0) L.push("⛔ O'zgartirish imkoni qolmagan — Uzum rad etishi mumkin.");
  }
  return {
    text: L.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ha, band qilish", callback_data: `u:ty:${kind}:${shopId}:${invId}:${from}:${to}` }],
        [back(`u:i:${kind}:${shopId}:${invId}:0`, "❌ Yo'q")],
      ],
    },
  };
}

export async function reserve(env: Env, kind: UzKind, shopId: number, invId: number, from: number, to: number): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  // Slot hali bo'shmi — tekshiramiz
  const free = (await uzumSlots(env, shopId, inv)).some((s) => s.from === from && s.to === to);
  if (!free) {
    return {
      text: `😔 <b>${fullSlot(env, { from, to })}</b> slotini boshqa sotuvchi olib ulgurdi.\nBoshqa vaqtni tanlang yoki kuzatishga qo'ying.`,
      reply_markup: {
        inline_keyboard: [
          [back(`u:h:${kind}:${shopId}:${invId}:${local(env, from).ymd}:${halfOf(env, from)}`, "🕒 Boshqa vaqt")],
          [{ text: "🔍 Shu kun uchun qidirish", callback_data: `u:wc:${kind}:${shopId}:${invId}:${local(env, from).ymd}:${halfOf(env, from)}` }],
        ],
      },
    };
  }
  await uzumReserve(env, kind, shopId, invId, from, to);
  const after = await uzumInvoice(env, kind, shopId, invId).catch(() => null);
  const ok = after?.slot?.from === from;
  if (ok) await logBooking(env, { shopId, kind, invId, invNo: inv.number, from, to, stock: inv.stock, auto: false });
  if (ok) await scheduleReminder(env, { chatId: 0, shopId, at: from, to, title: `${inv.kind === "f" ? "📄 FBO nakladnoy" : "↩️ Qaytarish"} № ${inv.number}`, place: inv.stock, cb: `u:i:${kind}:${shopId}:${invId}:0` });
  // Shu nakladnoy bo'yicha kuzatuvlarni o'chiramiz
  const page = await env.STATE.list({ prefix: `uwatch:${kind}:${shopId}:${invId}:` });
  for (const k of page.keys) await env.STATE.delete(k.name);
  return {
    text: ok
      ? `🎉 <b>Band qilindi!</b>\n${inv.kind === "f" ? "📄 FBO nakladnoy" : "↩️ Qaytarish"} № ${inv.number}\n🕒 <b>${fullSlot(env, { from, to })}</b>\n🏭 ${escapeHtml(inv.stock)}`
      : `✅ Uzum so'rovni qabul qildi.\n📄 № ${inv.number} · 🕒 ${fullSlot(env, { from, to })}\n<i>Kabinetda tekshirib qo'ying.</i>`,
    reply_markup: { inline_keyboard: [[back(`u:k:${kind}:${shopId}`, "📄 Nakladnoylar"), back("m:home", "🏠 Menyu")]] },
  };
}

/* ---------- Kuzatish (qidiruv) ---------- */

/** Nakladnoy uchun faol qidiruv (bitta nakladnoyga bitta qidiruv) */
async function activeWatch(env: Env, kind: UzKind, shopId: number, invId: number): Promise<{ key: string; w: Watch } | null> {
  const page = await env.STATE.list({ prefix: `uwatch:${kind}:${shopId}:${invId}:` });
  for (const k of page.keys) {
    const raw = await env.STATE.get(k.name);
    if (raw) return { key: k.name, w: JSON.parse(raw) };
  }
  return null;
}
const halfShort = (h: Half | "m") => (h === "a" ? "🌅 ertalab" : "🌇 tushdan keyin");
const watchLine = (env: Env, w: Watch) => `🔍 <b>Qidirilmoqda:</b> ${watchWhen(env, w)} · ${w.auto ? "⚡ topilsa avtomatik band qilinadi" : "🔔 topilsa xabar beriladi"}`;

/** Sana va kun yarmi tanlangach — qidiruvni tasdiqlash */
export async function searchConfirmScreen(env: Env, kind: UzKind, shopId: number, invId: number, ymd: string, half: Half): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const L = [...invHeader(env, inv), "", `❓ <b>${ymdLabel(env, ymd)} · ${HALF_NAME[half]}</b> uchun bo'sh vaqt qidirilsinmi?`, "", "Bo'sh vaqt topilganda nima qilay?"];
  const k = `${kind}:${shopId}:${invId}:${ymd}:${half}`;
  const rows: Btn[][] = [];
  const blocked = inv.slot && inv.updatesLeft === 0;
  if (blocked) L.push("", "⛔ Bu nakladnoyda vaqtni o'zgartirish imkoni qolmagan — faqat xabar bera olaman.");
  else {
    rows.push([{ text: "⚡ Avtomatik band qilinsin", callback_data: `u:w:${k}:1` }]);
    if (inv.slot) L.push("", `<i>⚡ tanlansa: hozirgi vaqt (${fullSlot(env, inv.slot)}) yangisiga almashadi va o'zgartirish imkoni 1 taga kamayadi.</i>`);
  }
  rows.push([{ text: "🔔 Faqat xabar berilsin", callback_data: `u:w:${k}:0` }]);
  rows.push([{ text: "📅 Boshqa sana tanlash", callback_data: `u:i:${kind}:${shopId}:${invId}:0` }, back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Qidiruv holati */
export async function searchStatusScreen(env: Env, kind: UzKind, shopId: number, invId: number, note = ""): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const a = await activeWatch(env, kind, shopId, invId);
  const L = [...invHeader(env, inv), ""];
  if (note) L.push(note, "");
  const rows: Btn[][] = [];
  if (a) {
    L.push(watchLine(env, a.w), "", "⏱ Har 10 soniyada tekshiraman. Topilishi bilan xabar beraman.", "<i>Bosh menyuga chiqsangiz ham qidiruv davom etadi.</i>");
    rows.push([{ text: "📅 Kunni o'zgartirish", callback_data: `u:fbp:${kind}:${shopId}:${invId}:x` }]);
    rows.push([
      { text: a.w.auto ? "🔔 Faqat xabar berishga o'tish" : "⚡ Avtomatik band qilishga o'tish", callback_data: `u:wt:${kind}:${shopId}:${invId}` },
    ]);
    rows.push([{ text: "⏹ Qidiruvni to'xtatish", callback_data: `u:wq:${kind}:${shopId}:${invId}` }]);
  } else {
    L.push("⏹ Faol qidiruv yo'q.");
    rows.push([{ text: "📅 Sana tanlash", callback_data: `u:i:${kind}:${shopId}:${invId}:0` }]);
  }
  rows.push([back("u:wl", "🔔 Kuzatuvlar"), back(`u:k:${kind}:${shopId}`, "📄 Nakladnoylar"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function stopSearch(env: Env, kind: UzKind, shopId: number, invId: number): Promise<UScreen> {
  const page = await env.STATE.list({ prefix: `uwatch:${kind}:${shopId}:${invId}:` });
  for (const k of page.keys) await env.STATE.delete(k.name);
  return searchStatusScreen(env, kind, shopId, invId, "⏹ Qidiruv to'xtatildi.");
}

interface Watch {
  kind?: UzKind;
  auto?: boolean; // topilsa avtomatik band qilish
  chatId: number;
  shopId: number;
  invId: number;
  invNo: string;
  ymd: string; // oddiy rejimda — kun; "m" rejimida — oxirgi kun (muddat)
  half: Half | "m"; // "m" — bir nechta kun + soatlar
  days?: string[]; // "m": tanlangan kunlar (YYYYMMDD)
  hours?: number[]; // "m": tanlangan soatlar (8 → 08:00–09:00); bo'sh — istalgan vaqt
  t: number;
}

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const hoursText = (hs: number[]) => (hs.length ? hs.slice().sort((a, b) => a - b).map((h) => `${hh(h)}–${hh(h + 1)}`).join(", ") : "istalgan vaqt");
/** Slot kuzatuv shartiga mosmi */
function watchFits(env: Env, w: Watch, s: UzSlot): boolean {
  const l = local(env, s.from);
  if (w.half !== "m") return l.ymd === w.ymd && halfOf(env, s.from) === w.half;
  if (!(w.days ?? []).includes(l.ymd)) return false;
  if (!w.hours?.length) return true;
  const e = local(env, s.to);
  const from = l.h + Number(l.hm.slice(3)) / 60;
  const to = e.h + Number(e.hm.slice(3)) / 60 || 24;
  return w.hours.some((x) => from < x + 1 && to > x);
}
const watchWhen = (env: Env, w: Watch) =>
  w.half === "m" ? `${(w.days ?? []).map((d) => ymdLabel(env, d)).join(", ")}${w.hours?.length ? ` · 🕒 ${hoursText(w.hours)}` : ""}` : `${ymdLabel(env, w.ymd)} · ${halfShort(w.half)}`;

/** ⚡ Avto bron rejasi: bir nechta kun + soatlar. t: x | d{ymd} | h{n} | ha */
export async function fboPlanScreen(env: Env, kind: UzKind, shopId: number, invId: number, t = "x"): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const key = `fbowp:${kind}:${shopId}:${invId}`;
  let raw = await env.STATE.get(key);
  if (!raw) {
    // Faol reja bo'lsa — o'shani ko'rsatamiz
    const aw = await activeWatch(env, kind, shopId, invId);
    if (aw?.w.half === "m") raw = JSON.stringify({ days: aw.w.days ?? [], hours: aw.w.hours ?? [] });
  }
  const st: { days: string[]; hours: number[] } = JSON.parse(raw ?? '{"days":[],"hours":[]}');
  const today0 = local(env, Date.now()).ymd;
  st.days = st.days.filter((d) => d >= today0);
  if (t.startsWith("d")) {
    const d = t.slice(1);
    st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : [...st.days, d].sort();
  } else if (t === "ha") st.hours = st.hours.length === HOURS.length ? [] : [...HOURS];
  else if (t.startsWith("h")) {
    const h = Number(t.slice(1));
    st.hours = st.hours.includes(h) ? st.hours.filter((x) => x !== h) : [...st.hours, h];
  }
  await env.STATE.put(key, JSON.stringify(st), { expirationTtl: 3600 });
  const slots = await uzumSlots(env, shopId, inv).catch(() => [] as UzSlot[]);
  const byDay = new Map<string, number>();
  for (const x of slots) byDay.set(local(env, x.from).ymd, (byDay.get(local(env, x.from).ymd) ?? 0) + 1);
  st.hours = []; // Uzum'da vaqt muhim emas — kun yetarli
  const L = [...invHeader(env, inv), "", "⚡ <b>Avtomatik bron</b>", "", "📅 Qaysi kunlarga topshira olasiz? Bir nechtasini belgilang 👇", "<i>O'sha kunlarning istalgan vaqtida bo'sh joy chiqsa — band qilaman.</i>"];
  if (st.days.length) L.push("", `📅 Tanlandi: <b>${st.days.map((d) => ymdLabel(env, d)).join(", ")}</b>`);
  L.push("", "<i>🟢 — hozir bo'sh vaqt bor (soni)</i>");
  const base = `u:fbp:${kind}:${shopId}:${invId}`;
  const today = local(env, Date.now()).ymd;
  const start = ymdStart(env, today);
  const dayBtns: Btn[] = [];
  for (let k = 0; k < 9; k++) {
    const ymd = local(env, start + k * DAY + 3600e3).ymd;
    const n = byDay.get(ymd) ?? 0;
    const on = st.days.includes(ymd);
    dayBtns.push({ text: `${on ? "✅" : n ? "🟢" : "⬜"} ${k === 0 ? "Bugun" : k === 1 ? "Ertaga" : ymdLabel(env, ymd)}${n ? ` (${n})` : ""}`, callback_data: `${base}:d${ymd}`, ...(on ? { style: "primary" } : {}) });
  }
  const rows: Btn[][] = [];
  for (let i = 0; i < dayBtns.length; i += 3) rows.push(dayBtns.slice(i, i + 3));
  const blocked = !!(inv.slot && inv.updatesLeft === 0);
  if (st.days.length) {
    if (!blocked) rows.push([{ text: `⚡ Avtomatik band qilish (${st.days.length} kun)`, callback_data: `u:fbz:${kind}:${shopId}:${invId}:1`, style: "success" }]);
    rows.push([{ text: "🔔 Faqat xabar berilsin", callback_data: `u:fbz:${kind}:${shopId}:${invId}:0` }]);
  }
  if (blocked) L.push("", "⛔ Bu nakladnoyda vaqtni o'zgartirish imkoni qolmagan — faqat xabar bera olaman.");
  rows.push([back(`u:i:${kind}:${shopId}:${invId}:0`, "⬅️ Sanalar"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function addPlanWatch(env: Env, chatId: number, kind: UzKind, shopId: number, invId: number, auto: boolean): Promise<UScreen> {
  const st: { days: string[]; hours: number[] } = JSON.parse((await env.STATE.get(`fbowp:${kind}:${shopId}:${invId}`)) ?? '{"days":[],"hours":[]}');
  if (!st.days.length) return fboPlanScreen(env, kind, shopId, invId);
  return addDaysWatch(env, chatId, kind, shopId, invId, st.days, [], auto);
}

/** 📅 Bitta kun tanlandi: bo'sh vaqt bo'lsa — darhol band qilishni taklif qiladi (vaqt so'ralmaydi); bo'lmasa — shu kunga qidiruv */
export async function dayScreen(env: Env, kind: UzKind, shopId: number, invId: number, ymd: string): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const slots = (await uzumSlots(env, shopId, inv)).filter((x) => local(env, x.from).ymd === ymd);
  const L = [...invHeader(env, inv), ""];
  const rows: Btn[][] = [];
  const blocked = !!(inv.slot && inv.updatesLeft === 0);
  if (slots.length) {
    const s0 = slots[0];
    L.push(`🟢 <b>${ymdLabel(env, ymd)}</b> — bo'sh joy bor.`, "", `❓ Shu kunga band qilaymi?`);
    if (inv.slot) L.push(`⚠️ Hozirgi vaqt (${fullSlot(env, inv.slot)}) bekor bo'ladi, o'zgartirish imkoni 1 taga kamayadi.`);
    if (blocked) L.push("⛔ O'zgartirish imkoni qolmagan — Uzum rad etishi mumkin.");
    rows.push([{ text: `✅ Ha, ${ymdLabel(env, ymd)} ga band qilish`, callback_data: `u:ty:${kind}:${shopId}:${invId}:${s0.from}:${s0.to}`, style: "success" }]);
  } else {
    L.push(`🔴 <b>${ymdLabel(env, ymd)}</b> uchun hozircha bo'sh joy yo'q.`, "", "Shu kunga joy chiqishini kutaymi? (har 10 soniyada tekshiraman)");
    if (blocked) L.push("", "⛔ Bu nakladnoyda o'zgartirish imkoni qolmagan — faqat xabar bera olaman.");
    else rows.push([{ text: "⚡ Joy chiqsa — avtomatik band qilinsin", callback_data: `u:wd:${kind}:${shopId}:${invId}:${ymd}:1`, style: "success" }]);
    rows.push([{ text: "🔔 Faqat xabar berilsin", callback_data: `u:wd:${kind}:${shopId}:${invId}:${ymd}:0` }]);
  }
  rows.push([back(`u:i:${kind}:${shopId}:${invId}:0`, "📅 Boshqa kun"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Yaqin 3 kun (soat 20:00 dan keyin — ertadan boshlab) */
export function next3Days(env: Env): string[] {
  const t = local(env, Date.now());
  const start = ymdStart(env, t.ymd) + (t.h >= 20 ? DAY : 0);
  return [0, 1, 2].map((k) => local(env, start + k * DAY + 3600e3).ymd);
}

/** ⚡ Yaqin 3 kun uchun avto bron — tasdiq */
export async function threeDayScreen(env: Env, kind: UzKind, shopId: number, invId: number): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const days = next3Days(env);
  const slots = (await uzumSlots(env, shopId, inv)).filter((x) => days.includes(local(env, x.from).ymd));
  const L = [...invHeader(env, inv), "", `⚡ <b>Yaqin 3 kun:</b> ${days.map((d) => ymdLabel(env, d)).join(", ")}`, ""];
  const rows: Btn[][] = [];
  const blocked = !!(inv.slot && inv.updatesLeft === 0);
  const tail = days.join("-");
  if (slots.length) {
    L.push(`🟢 Hozir bo'sh joy bor: <b>${ymdLabel(env, local(env, slots[0].from).ymd)}</b>`);
    rows.push([{ text: `✅ Darhol band qilish — ${ymdLabel(env, local(env, slots[0].from).ymd)}`, callback_data: `u:ty:${kind}:${shopId}:${invId}:${slots[0].from}:${slots[0].to}`, style: "success" }]);
  } else L.push("🔴 Bu 3 kunda hozircha bo'sh joy yo'q. Joy chiqishini kutaymi? (har 10 soniyada tekshiraman)");
  if (inv.slot) L.push("", `<i>Band qilinsa hozirgi vaqt (${fullSlot(env, inv.slot)}) almashadi, o'zgartirish imkoni 1 taga kamayadi.</i>`);
  if (blocked) L.push("", "⛔ O'zgartirish imkoni qolmagan — faqat xabar bera olaman.");
  else rows.push([{ text: "⚡ 3 kunda joy chiqsa — avtomatik band", callback_data: `u:wd:${kind}:${shopId}:${invId}:${tail}:1`, ...(slots.length ? {} : { style: "success" }) }]);
  rows.push([{ text: "🔔 Faqat xabar berilsin", callback_data: `u:wd:${kind}:${shopId}:${invId}:${tail}:0` }]);
  rows.push([{ text: "📅 Kunlarni o'zim belgilayman", callback_data: `u:fbp:${kind}:${shopId}:${invId}:x` }]);
  rows.push([back(`u:i:${kind}:${shopId}:${invId}:0`), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Kunlar bo'yicha kuzatuv (soat — istalgan) */
export async function addDaysWatch(env: Env, chatId: number, kind: UzKind, shopId: number, invId: number, days: string[], hours: number[], auto: boolean): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  const st = { days, hours };
  const old = await env.STATE.list({ prefix: `uwatch:${kind}:${shopId}:${invId}:` });
  for (const k of old.keys) await env.STATE.delete(k.name);
  const last = st.days.slice().sort().at(-1)!;
  const w: Watch = { kind, auto: auto && !(inv.slot && inv.updatesLeft === 0), chatId, shopId, invId, invNo: inv.number, ymd: last, half: "m", days: st.days, hours: st.hours, t: Date.now() };
  const ttl = Math.max(3600, Math.round((ymdStart(env, last) + DAY - Date.now()) / 1000));
  await env.STATE.put(`uwatch:${kind}:${shopId}:${invId}:${last}:m`, JSON.stringify(w), { expirationTtl: ttl });
  return searchStatusScreen(env, kind, shopId, invId, auto ? "✅ Avtomatik bron yoqildi." : "✅ Kuzatuv yoqildi.");
}

/** Qidiruv rejimini almashtirish (⚡ ↔ 🔔) — kun/soatlar saqlanadi */
export async function toggleWatchAuto(env: Env, kind: UzKind, shopId: number, invId: number): Promise<UScreen> {
  const a = await activeWatch(env, kind, shopId, invId);
  if (a) {
    a.w.auto = !a.w.auto;
    const ttl = Math.max(3600, Math.round((ymdStart(env, a.w.ymd) + DAY - Date.now()) / 1000));
    await env.STATE.put(a.key, JSON.stringify(a.w), { expirationTtl: ttl });
  }
  return searchStatusScreen(env, kind, shopId, invId, "✅ O'zgartirildi.");
}

export async function addWatch(env: Env, chatId: number, kind: UzKind, shopId: number, invId: number, ymd: string, half: Half, auto = false): Promise<UScreen> {
  const inv = await loadInv(env, kind, shopId, invId);
  // Bitta nakladnoyga bitta qidiruv: eskisini almashtiramiz
  const old = await env.STATE.list({ prefix: `uwatch:${kind}:${shopId}:${invId}:` });
  for (const k of old.keys) await env.STATE.delete(k.name);
  const w: Watch = { kind, auto: auto && !(inv.slot && inv.updatesLeft === 0), chatId, shopId, invId, invNo: inv.number, ymd, half, t: Date.now() };
  const ttl = Math.max(3600, Math.round((ymdStart(env, ymd) + DAY - Date.now()) / 1000));
  await env.STATE.put(`uwatch:${kind}:${shopId}:${invId}:${ymd}:${half}`, JSON.stringify(w), { expirationTtl: ttl });
  return searchStatusScreen(env, kind, shopId, invId, "✅ Tasdiqlandi.");
}

export async function watchesScreen(env: Env): Promise<UScreen> {
  const page = await env.STATE.list({ prefix: "uwatch:" });
  const list: { key: string; w: Watch }[] = [];
  let clientCnt = 0;
  for (const k of page.keys) {
    // Slot xizmati mijozlarining kuzatuvlari — bu ro'yxatda emas
    if (await env.STATE.get(`clshop:${k.name.split(":")[2]}`)) {
      clientCnt++;
      continue;
    }
    const raw = await env.STATE.get(k.name);
    if (raw) list.push({ key: k.name, w: JSON.parse(raw) });
  }
  const L = ["<b>🔔 Slot kuzatuvlari</b>", ""];
  if (clientCnt) L.push(`<i>🛎 Mijozlar kuzatuvlari: ${clientCnt} ta (Slot xizmati bo'limida)</i>`, "");
  const fbs = await fbsWatchList(env);
  if (!list.length && !fbs.length) L.push("Hozir hech narsa kuzatilmayapti.");
  const rows: Btn[][] = [];
  for (const f of fbs) {
    L.push(f.text);
    rows.push([f.btn as Btn]);
  }
  for (const { key, w } of list.slice(0, 15)) {
    L.push(`${w.kind === "r" ? "↩️" : "📄"} № ${w.invNo} · ${watchWhen(env, w)}${w.auto ? " ⚡" : ""}`);
    // Bosilganda — qidiruv holati ochiladi (to'xtatish o'sha yerda, tasodifan o'chib qolmasin)
    rows.push([
      {
        text: `${w.kind === "r" ? "↩️" : "📄"} №…${w.invNo.slice(-4)} · ${w.half === "m" ? `${(w.days ?? []).length} kun` : `${ymdLabel(env, w.ymd)} ${w.half === "a" ? "🌅" : "🌇"}`}${w.auto ? " ⚡" : ""}`,
        callback_data: `u:ws:${w.kind ?? "f"}:${w.shopId}:${w.invId}`,
        style: "primary",
      },
    ]);
  }
  rows.push([back("u:sh"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function removeWatch(env: Env, keyTail: string): Promise<UScreen> {
  await env.STATE.delete(`uwatch:${keyTail}`);
  return watchesScreen(env);
}

/** Cron: kuzatuvlarni tekshirish. Mos slot topilsa — xabar va kuzatuv o'chiriladi */
const invCache = new Map<string, { inv: UzInvoice | null; t: number }>();
let lastPurge = 0;
export async function checkWatches(env: Env): Promise<number> {
  if (Date.now() - lastPurge > 30_000) {
    lastPurge = Date.now();
    await purgeSecretMessages(env).catch(() => {});
  }
  await checkFbsWatches(env).catch((e) => console.log("fbs watch:", (e as Error).message));
  const page = await env.STATE.list({ prefix: "uwatch:" });
  if (!page.keys.length) return 0;
  const watches: { key: string; w: Watch }[] = [];
  for (const k of page.keys) {
    const raw = await env.STATE.get(k.name);
    if (raw) watches.push({ key: k.name, w: JSON.parse(raw) });
  }
  // Har nakladnoy uchun bitta so'rov
  const byInv = new Map<string, { key: string; w: Watch }[]>();
  for (const x of watches) {
    const id = `${x.w.kind ?? "f"}:${x.w.shopId}:${x.w.invId}`;
    byInv.set(id, [...(byInv.get(id) ?? []), x]);
  }
  let found = 0;
  const today = local(env, Date.now()).ymd;
  for (const group of byInv.values()) {
    const { shopId, invId } = group[0].w;
    const kind: UzKind = group[0].w.kind ?? "f";
    // 🛎 Mijoz do'koni: obuna tugagan bo'lsa — kuzatuv to'xtaydi
    const cu = await env.STATE.get(`clshop:${shopId}`);
    if (cu) {
      const cl = JSON.parse((await env.STATE.get(`cl:${cu}`)) ?? "null");
      if (!cl || !(cl.sub > Date.now())) {
        for (const x of group) await env.STATE.delete(x.key);
        await notify(env, Number(cu), `⛔ Obunangiz tugagani uchun № ${escapeHtml(group[0].w.invNo)} kuzatuvi to'xtatildi.`, {
          reply_markup: { inline_keyboard: [[{ text: "💳 Obuna", callback_data: "c:sub" }]] },
        }).catch(() => {});
        continue;
      }
    }
    let slots: UzSlot[];
    let inv: UzInvoice | null;
    try {
      // Nakladnoy ma'lumoti 2 daqiqada bir yangilanadi (slotlar esa har safar)
      const ck = `${kind}:${shopId}:${invId}`;
      const c = invCache.get(ck);
      if (c && Date.now() - c.t < 120_000) inv = c.inv;
      else {
        inv = await uzumInvoice(env, kind, shopId, invId);
        invCache.set(ck, { inv, t: Date.now() });
      }
      if (!inv) {
        for (const x of group) await env.STATE.delete(x.key);
        continue;
      }
      slots = await uzumSlots(env, shopId, inv);
    } catch (e) {
      console.log("uzum watch:", (e as Error).message);
      if (/tegishli emas|profili topilmadi/.test((e as Error).message)) for (const x of group) await env.STATE.delete(x.key);
      continue;
    }
    for (const { key, w } of group) {
      if (w.ymd < today) {
        await env.STATE.delete(key);
        continue;
      }
      const hit = slots.filter((s) => watchFits(env, w, s));
      if (!hit.length) continue;
      found++;
      const title = `${kind === "r" ? "↩️ Qaytarish" : "📄 FBO nakladnoy"} № ${w.invNo}`;
      // ⚡ Avtomatik band qilish
      let booked = false;
      if (w.auto && inv && !(inv.slot && inv.updatesLeft === 0)) {
        // Eng yaqin mos vaqtdan boshlab (3 tagacha) urinib ko'ramiz
        for (const s0 of hit.slice(0, 3)) {
          try {
            await uzumReserve(env, kind, shopId, invId, s0.from, s0.to);
            invCache.delete(`${kind}:${shopId}:${invId}`);
            const after = await uzumInvoice(env, kind, shopId, invId).catch(() => null);
            if (!after || after.slot?.from === s0.from) {
              await env.STATE.delete(key);
              await logBooking(env, { shopId, kind, invId, invNo: w.invNo, from: s0.from, to: s0.to, stock: inv.stock, auto: true });
              await scheduleReminder(env, { chatId: w.chatId, at: s0.from, to: s0.to, title, place: inv.stock, cb: `u:i:${kind}:${shopId}:${invId}:0` });
              await notify(
                env,
                w.chatId,
                [
                  `🎉 <b>Avtomatik band qilindi!</b>`,
                  title,
                  "",
                  `🏭 <b>Olib borasiz:</b> ${escapeHtml(inv.stock)}`,
                  `⏰ <b>${fullSlot(env, s0)}</b> — soat <b>${local(env, s0.to).hm}</b> gacha`,
                  inv.kind === "f" ? `📦 ${inv.qty} dona · ${money(inv.price)}` : "",
                  "",
                  "<i>⏰ Vaqtdan 1 soat oldin eslataman.</i>",
                ]
                  .filter((x) => x !== undefined)
                  .join("\n"),
                { reply_markup: { inline_keyboard: [[{ text: "📄 Nakladnoy", callback_data: `u:i:${kind}:${shopId}:${invId}:0` }]] } },
              ).catch(() => {});
              booked = true;
              break;
            }
          } catch (e) {
            console.log("auto reserve:", (e as Error).message);
          }
        }
      }
      if (booked) continue;
      // Ko'p kunli rejada — bir xil vaqtlar haqida qayta yozmaymiz, kuzatuv davom etadi
      const sig = hit.map((x) => x.from).join(",");
      if (w.half === "m") {
        if ((w as any).sig === sig) continue;
        (w as any).sig = sig;
        await env.STATE.put(key, JSON.stringify(w), { expirationTtl: Math.max(3600, Math.round((ymdStart(env, w.ymd) + DAY - Date.now()) / 1000)) });
      }
      const btns = hit.slice(0, 8).map((s) => ({ text: `✅ ${w.half === "m" ? fullSlot(env, s) : slotText(env, s)}`, callback_data: `u:t:${kind}:${shopId}:${invId}:${s.from}:${s.to}` }));
      const rows: Btn[][] = [];
      for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
      if (w.half !== "m") rows.push([{ text: "🔍 Qidirishni davom ettirish", callback_data: `u:w:${kind}:${shopId}:${invId}:${w.ymd}:${w.half}:0` }]);
      else rows.push([{ text: "⏹ Kuzatuvni to'xtatish", callback_data: `u:wq:${kind}:${shopId}:${invId}` }]);
      await notify(
        env,
        w.chatId,
        `🎉 <b>Bo'sh vaqt ochildi!</b>${w.auto ? " (avtomatik band qilib bo'lmadi)" : ""}\n${title}\n📅 ${w.half === "m" ? watchWhen(env, w) : `${ymdLabel(env, w.ymd)} · ${HALF_NAME[w.half]}`}\n\nTezroq band qiling — boshqalar ham kutyapti 👇`,
        { reply_markup: { inline_keyboard: rows } },
      ).catch((e) => console.log("watch notify:", (e as Error).message));
      if (w.half !== "m") await env.STATE.delete(key);
    }
  }
  return found;
}

/* ---------- Profillar ---------- */

export async function profilesScreen(env: Env, viewerId = 0): Promise<UScreen> {
  await ensureNames(env).catch(() => {});
  const viewerIsOwner = viewerId > 0 && (await getOwner(env)) === viewerId;
  const accs = await uzumAllAccounts(env);
  const L = ["<b>⚙️ Uzum profillari</b>", ""];
  if (!accs.length) L.push("Hali profil yo'q.");
  const rows: Btn[][] = [];
  const svc = (await env.STATE.get("svc:acc")) ?? "";
  for (const a of accs) {
    const saved = a.id === "env" || Boolean(a.enc);
    L.push(`${a.id === svc ? "🛎" : "👤"} <b>${escapeHtml(a.label)}</b>${a.id === svc ? " · <i>mijozlar xizmat hisobi</i>" : ""}${viewerIsOwner ? ` · <code>${escapeHtml(maskLogin(a.login))}</code>` : ""}`, `     ${saved ? "🔑 parol eslab qolingan — sessiya tugasa o'zi kiradi" : "⚠️ parol saqlanmagan"}`);
    if (a.id !== "env") {
      const r: Btn[] = [{ text: `🔑 ${a.label.slice(0, 18)}`, callback_data: `u:lg:${a.id}` }];
      if (viewerIsOwner) r.push({ text: "🗑 O'chirish", callback_data: `u:ar:${a.id}` });
      rows.push(r);
    }
  }
  L.push("", viewerIsOwner ? "<i>🔑 — parolni qayta kiritish, 🗑 — profilni botdan o'chirish</i>" : "<i>🔑 — parolni qayta kiritish</i>");
  rows.push([{ text: "➕ Profil qo'shish", callback_data: "u:lg" }]);
  if (viewerIsOwner) rows.push([{ text: "🛎 Slot xizmati — mijozlar", callback_data: "c:adm", style: "primary" }]);
  rows.push([back("u:sh"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export async function removeConfirmScreen(env: Env, accId: string): Promise<UScreen> {
  const a = (await uzumAllAccounts(env)).find((x) => x.id === accId);
  return {
    text: `❓ <b>${escapeHtml(a?.label ?? accId)}</b> profilini botdan o'chiraymi?\nSaqlangan parol va kuzatuvlar o'chiriladi. Uzum kabinetingizga ta'sir qilmaydi.`,
    reply_markup: {
      inline_keyboard: [[{ text: "🗑 Ha, o'chirish", callback_data: `u:ary:${accId}` }], [back("u:am", "❌ Yo'q")]],
    },
  };
}

/* ---------- 🛡 Xavfsizlik ---------- */

export async function securityScreen(env: Env, viewerId: number): Promise<UScreen> {
  const accs = await uzumAllAccounts(env);
  const owner = await getOwner(env);
  const me = owner === viewerId;
  const L = ["<b>🛡 Xavfsizlik</b>", ""];
  L.push(owner ? `👑 Asosiy admin: <b>${escapeHtml(await userName(env, owner))}</b>${me ? " — <i>bu siz</i>" : ""}` : "👑 Asosiy admin: <b>belgilanmagan</b>");
  L.push("", `👤 Uzum profillari: <b>${accs.length}</b> ta`);
  for (const a of accs) L.push(`   • ${escapeHtml(a.label)}${me ? ` · <code>${escapeHtml(maskLogin(a.login))}</code>` : ""} · ${a.id === "env" || a.enc ? "🔑 parol saqlangan" : "⚠️ parolsiz"}`);
  L.push("", "🔒 Parollar shifrlangan (AES-256) holda saqlanadi.");
  const rows: Btn[][] = [];
  if (me) {
    L.push("👁 Login va parollar <b>faqat shu akkauntda</b> ko'rinadi. Ko'rishda bot paroli so'raladi, 60 soniyadan keyin yashiriladi.");
    rows.push([{ text: "👁 Login va parollarni ko'rsatish", callback_data: "u:secv" }]);
    rows.push([{ text: "📱 Botga kirgan akkauntlar", callback_data: "u:ses" }, { text: "📞 Telefon orqali kirish", callback_data: "u:ph" }]);
  } else if (owner) {
    L.push("", "🚫 Login va parollar faqat <b>asosiy admin</b> akkauntida ko'rinadi. Bu akkauntdan ko'rib bo'lmaydi.");
  } else {
    L.push("", "Login va parollarni ko'rish uchun avval <b>asosiy admin</b> akkauntni belgilang. Buni faqat telefoningizdagi (doim yoningizdagi) akkauntdan qiling.");
    rows.push([{ text: "👑 Shu akkauntni asosiy admin qilish", callback_data: "u:own" }]);
  }
  rows.push([back("u:am", "⚙️ Profillar"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** 📱 Botga kirgan Telegram akkauntlar (faqat asosiy admin uchun) */
export async function sessionsScreen(env: Env, viewerId: number): Promise<UScreen> {
  const ids = await listAuthorizedChats(env);
  const owner = await getOwner(env);
  const L = ["<b>📱 Botga kirgan akkauntlar</b>", ""];
  const rows: Btn[][] = [];
  for (const id of ids) {
    const ph = await env.STATE.get(`phone:${id}`);
    const n = (await userName(env, id)) + (ph ? ` · +${ph}` : "");
    L.push(`${id === owner ? "👑" : "📱"} ${escapeHtml(n)}${id === viewerId ? " — <i>siz</i>" : ""}`);
    if (id !== viewerId) rows.push([{ text: `🚪 Chiqarish: ${n.slice(0, 28)}`, callback_data: `u:sx:${id}` }]);
  }
  L.push("", "<i>Chiqarilgan akkaunt botdan foydalanish uchun qayta /login qilishi kerak bo'ladi.</i>");
  rows.push([back("u:sec"), back("m:home", "🏠")]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Parollarni ko'rsatadigan xabar matni (spoiler bilan) */
export function revealText(list: { id?: string; label: string; login: string; password: string | null }[]): string {
  const L = ["<b>🛡 Uzum login va parollari</b>", "<i>Parol ustiga bosing — ochiladi. 60 soniyadan keyin yashiriladi.</i>", ""];
  if (!list.length) L.push("Saqlangan profil yo'q.");
  for (const x of list) {
    L.push(
      `👤 <b>${escapeHtml(x.label)}</b>`,
      `   Login: <code>${escapeHtml(x.login)}</code>`,
      `   Parol: ${x.password ? `<tg-spoiler><code>${escapeHtml(x.password)}</code></tg-spoiler>` : "⚠️ saqlanmagan — pastdagi 🔑 tugmasini bosib, bir marta kiriting"}`,
      "",
    );
  }
  return L.join("\n");
}

/** Muddati o'tgan maxfiy xabarlarni o'chirish (cron va lokal taymer) */
export async function purgeSecretMessages(env: Env): Promise<void> {
  const page = await env.STATE.list({ prefix: "autodel:" });
  for (const k of page.keys) {
    const [, chat, msg, at] = k.name.split(":");
    if (Number(at) > Date.now()) continue;
    await tg(env, "editMessageText", {
      chat_id: Number(chat),
      message_id: Number(msg),
      text: "🔒 Maxfiy ma'lumot yashirildi.",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Bosh menyu", callback_data: "m:home" }]] },
    }).catch(() => {});
    await env.STATE.delete(k.name);
  }
}
