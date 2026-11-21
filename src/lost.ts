/**
 * 🔎 Yo'qolgan tovarlarni professional qidirish (Uzum Market). Bir nechta manba solishtiriladi:
 *  1) 🏭 Uzum omborida yo'qolgan — Uzum o'zi «yo'qolgan» deb belgilagan qoldiq (SKU kartochkasi: quantityMissing)
 *  2) 💔 Omborda nuqsonli — Uzum «brak» deb belgilagan qoldiq (quantityDefected)
 *  3) 📦 FBO qabulida farq — ta'minlashda yuborilgan (reja) > qabul qilingan (haqiqatda), SKU bo'yicha, sababi bilan
 *  4) 🚚 FBS topshirishda farq — ta'minlashdagi buyurtmalar > Uzum qabul qilgan buyurtmalar
 *  5) ↩️ Qaytarishlar Uzum omborida kutmoqda — olib ketilmagan qaytarishlar (pullik saqlash xavfi)
 * Qidiruv fon rejimida ishlaydi va xabarni jonli yangilab turadi (🔍/🔎 qimirlaydi).
 */
import type { Env } from "./types";
import { escapeHtml, tg } from "./telegram";
import { uzumAccounts, uzumGet, uzumSellerId, uzumShops } from "./uzum";

type Btn = { text: string; callback_data: string; style?: string };
export interface LScreen {
  text: string;
  reply_markup: { inline_keyboard: Btn[][] };
}

interface FboLoss {
  accId: string;
  shopId: number;
  invId: number;
  problems: string[];
  title?: string;
  acc: string;
  shop: string;
  invoice: string;
  date: string;
  sku: string;
  sent: number;
  got: number;
  price: number;
}
interface FbsLoss {
  acc: string;
  invoice: string;
  date: string;
  orders: number;
  accepted: number;
  sum: number;
}
interface StockLoss {
  shop: string;
  sku: string;
  title: string;
  qty: number;
  price: number;
}
interface ReturnWait {
  shop: string;
  id: string;
  type: string;
  days: number | null; // bepul saqlashgacha qolgan kun (manfiy — pullik boshlangan)
  slot: boolean;
}
interface Report {
  t: number;
  months: string[];
  fbo: FboLoss[];
  fbs: FbsLoss[];
  missing: StockLoss[];
  defected: StockLoss[];
  returns: ReturnWait[];
  checked: { shops: number; skus: number; invoices: number; fbsInvoices: number; returns: number };
  errs: string[];
}

const KEYP = "lost:report:v5";
const keyOf = (months: string[]) => `${KEYP}:${[...months].sort().join(",")}`;

/* ---------- Oylar ---------- */
const MONTHS_UZ = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];
const TZ = 5 * 3600e3;
/** Oxirgi N oy (joriy oy birinchi), "YYYYMM" ko'rinishida — kelmagan oylar yo'q */
export function lastMonths(n = 6): string[] {
  const d = new Date(Date.now() + TZ);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m + 1).padStart(2, "0")}`);
    m--;
    if (m < 0) {
      m = 11;
      y--;
    }
  }
  return out;
}
export const monthLabel = (ym: string) => `${MONTHS_UZ[Number(ym.slice(4)) - 1]} ${ym.slice(0, 4)}`;
/** Sana (ms) tanlangan oylardan biriga tushadimi */
const inMonths = (ms: number | null, months: Set<string>) => {
  if (!ms) return true; // sanasi noma'lum — tashlab ketmaymiz
  const d = new Date(ms + TZ);
  return months.has(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
};
/** "25.09.2026" -> ms */
const parseDmy = (s: string): number | null => {
  const m = String(s ?? "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) - TZ + 12 * 3600e3 : null;
};
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ")} so'm`;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const qs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const day = (ms: number) => {
  const d = new Date(ms + 5 * 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

const STEPS = ["📦 FBO ta'minlashlar (reja ↔ qabul)", "🏭 Ombordagi qoldiqlar (yo'qolgan / nuqsonli)", "🚚 FBS ta'minlashlar (topshirildi ↔ qabul)", "↩️ Qaytarishlar (olib ketilmagan)"];

async function scan(env: Env, monthsArr: string[], progress: (step: number, note: string) => void): Promise<Report> {
  const months = new Set(monthsArr);
  const oldest = Math.min(...monthsArr.map((ym) => Date.UTC(+ym.slice(0, 4), +ym.slice(4) - 1, 1) - TZ));
  const rep: Report = { t: Date.now(), months: monthsArr, fbo: [], fbs: [], missing: [], defected: [], returns: [], checked: { shops: 0, skus: 0, invoices: 0, fbsInvoices: 0, returns: 0 }, errs: [] };
  const accs = await uzumAccounts(env);
  const all: { acc: (typeof accs)[number]; shops: { id: number; name: string }[] }[] = [];
  for (const a of accs) {
    try {
      all.push({ acc: a, shops: await uzumShops(env, a.id) });
    } catch (e) {
      rep.errs.push(`${a.label}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  rep.checked.shops = all.reduce((s, x) => s + x.shops.length, 0);

  // 1) FBO ta'minlashlar
  for (const { acc: a, shops } of all) {
    for (const s of shops) {
      progress(0, s.name);
      try {
        for (let page = 0; page < 6; page++) {
          const list = await uzumGet<any[]>(env, a.id, `/seller/shop/${s.id}/invoice?${qs({ page, size: 30 })}`);
          const arr = Array.isArray(list) ? list : [];
          rep.checked.invoices += arr.length;
          for (const inv of arr) {
            const sent = Number(inv.totalToStock ?? 0), got = Number(inv.totalAccepted ?? 0);
            const when = inv.dateAccepted ? Number(inv.dateAccepted) : parseDmy(inv.dateCreated);
            if (!inMonths(when, months)) continue;
            if (inv.invoiceStatus?.value !== "ACCEPTED" || got >= sent) continue;
            const num = String(inv.invoiceNumber ?? inv.id);
            const prods = await uzumGet<any[]>(env, a.id, `/seller/shop/${s.id}/invoice/getInvoiceProducts?${qs({ invoiceId: inv.id })}`).catch(() => []);
            for (const p of Array.isArray(prods) ? prods : []) {
              const skus: any[] = p.skuForInvoiceDtoList?.length ? p.skuForInvoiceDtoList : [p];
              for (const k of skus) {
                const q = Number(k.quantityToStock ?? 0), ac = Number(k.quantityAccepted ?? 0);
                if (ac >= q) continue;
                rep.fbo.push({
                  accId: a.id,
                  shopId: s.id,
                  invId: Number(inv.id),
                  problems: (k.issue?.problemTypes ?? []).map(String),
                  title: String(p.productTitle ?? ""),
                  acc: a.label,
                  shop: s.name,
                  invoice: num.length === 13 ? num.slice(0, 12) : num,
                  date: inv.dateAccepted ? day(Number(inv.dateAccepted)) : String(inv.dateCreated ?? ""),
                  sku: String(k.skuTitle ?? p.skuTitle ?? "SKU").trim(),
                  sent: q,
                  got: ac,
                  price: Number(k.purchasePrice ?? p.purchasePrice ?? 0),
                });
              }
            }
          }
          if (arr.length < 30) break;
          // Ro'yxat yangidan eskiga — tanlangan davrdan eski sahifalarga o'tmaymiz
          const last = arr[arr.length - 1];
          const lw = last?.dateAccepted ? Number(last.dateAccepted) : parseDmy(last?.dateCreated);
          if (lw && lw < oldest - 31 * 864e5) break;
        }
      } catch (e) {
        rep.errs.push(`FBO ${s.name}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }

  // 2) Ombordagi qoldiqlar: Uzum belgilagan yo'qolgan / nuqsonli
  for (const { acc: a, shops } of all) {
    for (const s of shops) {
      progress(1, s.name);
      try {
        for (let page = 0; page < 20; page++) {
          const r = await uzumGet<any>(env, a.id, `/seller/shop/${s.id}/product/getProducts?${qs({ page, size: 100, filter: "ALL" })}`);
          const list: any[] = r?.productList ?? [];
          for (const p of list) {
            for (const k of p.skuList ?? []) {
              rep.checked.skus++;
              const row = { shop: s.name, sku: String(k.skuFullTitle ?? k.skuTitle ?? ""), title: String(k.productTitle ?? p.title ?? ""), price: Number(k.purchasePrice ?? k.price ?? 0) };
              if (Number(k.quantityMissing ?? 0) > 0) rep.missing.push({ ...row, qty: Number(k.quantityMissing) });
              if (Number(k.quantityDefected ?? 0) > 0) rep.defected.push({ ...row, qty: Number(k.quantityDefected) });
            }
          }
          if (list.length < 100) break;
        }
      } catch (e) {
        rep.errs.push(`Qoldiq ${s.name}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }

  // 3) FBS ta'minlashlar
  for (const { acc: a } of all) {
    progress(2, a.label);
    try {
      const sellerId = await uzumSellerId(env, a.id);
      for (let page = 0; page < 10; page++) {
        const list = await uzumGet<any[]>(env, a.id, `/seller/fbs/invoice?${qs({ sellerId, statuses: "ACCEPTED", page, size: 20 })}`);
        const arr = Array.isArray(list) ? list : [];
        rep.checked.fbsInvoices += arr.length;
        for (const x of arr) {
          const n = Number(x.numberOrders ?? 0), ok = Number(x.numberAcceptedOrders ?? 0);
          if (ok >= n) continue;
          if (!inMonths(x.acceptedDate ? Number(x.acceptedDate) : x.dateCreated ? Number(x.dateCreated) : null, months)) continue;
          rep.fbs.push({
            acc: a.label,
            invoice: String(x.number ?? x.id),
            date: x.acceptedDate ? day(Number(x.acceptedDate)) : "",
            orders: n,
            accepted: ok,
            sum: Number(x.fullPrice ?? 0) - Number(x.acceptedPrice ?? x.fullPrice ?? 0),
          });
        }
        if (arr.length < 20) break;
      }
    } catch (e) {
      rep.errs.push(`FBS ${a.label}: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  // 4) Qaytarishlar: omborda kutayotganlar
  for (const { acc: a, shops } of all) {
    for (const s of shops) {
      progress(3, s.name);
      try {
        const r = await uzumGet<any[]>(env, a.id, `/seller/shop/${s.id}/return?${qs({ page: 0, size: 30 })}`);
        const arr = Array.isArray(r) ? r : [];
        rep.checked.returns += arr.length;
        for (const x of arr) {
          if (/COMPLETE|CANCEL|ISSUED|DONE/i.test(String(x.status ?? ""))) continue;
          if (!inMonths(x.dateCreated ? Number(x.dateCreated) : null, months)) continue;
          const start = x.paidStorage?.startDate ? Number(x.paidStorage.startDate) : null;
          rep.returns.push({
            shop: s.name,
            id: String(x.id),
            type: x.type === "FBS" ? "FBS qaytarish" : /DEFECT/i.test(String(x.type)) ? "Yaroqsiz" : String(x.type ?? ""),
            days: start ? Math.ceil((start - Date.now()) / 864e5) : null,
            slot: Boolean(x.timeSlotReservation?.timeFrom),
          });
        }
      } catch (e) {
        rep.errs.push(`Qaytarish ${s.name}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }
  return rep;
}

/* ---------- Natija ekrani ---------- */

export async function cachedLost(env: Env, months: string[]): Promise<Report | null> {
  const raw = await env.STATE.get(keyOf(months));
  if (!raw) return null;
  const r = JSON.parse(raw) as Report;
  return Date.now() - r.t < 15 * 60e3 ? r : null;
}

export function renderLost(r: Report): LScreen {
  const multi = new Set(r.fbo.map((x) => x.acc)).size > 1;
  const fboQty = r.fbo.reduce((s, x) => s + (x.sent - x.got), 0);
  const fboSum = r.fbo.reduce((s, x) => s + (x.sent - x.got) * x.price, 0);
  const fbsQty = r.fbs.reduce((s, x) => s + (x.orders - x.accepted), 0);
  const missQty = r.missing.reduce((s, x) => s + x.qty, 0);
  const defQty = r.defected.reduce((s, x) => s + x.qty, 0);
  const paidRet = r.returns.filter((x) => x.days !== null && x.days <= 0).length;

  const L = ["<b>🔎 Yo'qolgan tovarlar — natija</b>", `📅 ${(r.months ?? []).map(monthLabel).join(", ")}`, "<i>🏭 Ombor qoldig'i (yo'qolgan/nuqsonli) — joriy holat</i>", ""];
  // Xulosa
  L.push("<b>📋 Xulosa:</b>");
  L.push(`${missQty ? "🔴" : "✅"} Uzum omborida yo'qolgan: <b>${missQty ? `${missQty} dona` : "yo'q"}</b>`);
  L.push(`${fbsQty ? "🔴" : "✅"} FBS'da yo'qolgan (topshirildi, qabul qilinmadi): <b>${fbsQty ? `${fbsQty} ta buyurtma` : "yo'q"}</b>`);
  L.push(`${fboQty ? "🟡" : "✅"} FBO qabulida farq: <b>${fboQty ? `${fboQty} dona` : "yo'q"}</b>`);
  L.push(`${defQty ? "🟠" : "✅"} Omborda nuqsonli: <b>${defQty ? `${defQty} dona` : "yo'q"}</b>`);
  L.push(`${r.returns.length ? (paidRet ? "🔴" : "🟡") : "✅"} Olib ketilmagan qaytarishlar: <b>${r.returns.length ? `${r.returns.length} ta${paidRet ? ` (${paidRet} tasida pullik saqlash)` : ""}` : "yo'q"}</b>`);

  if (r.missing.length) {
    L.push("", "🏭 <b>Uzum omborida yo'qolgan</b> (Uzum o'zi belgilagan — kompensatsiya qilinishi kerak):");
    for (const x of r.missing.slice(0, 10)) L.push(`   🔴 <b>${escapeHtml(cut(x.sku, 40))}</b> · 🛍 <b>${escapeHtml(x.shop)}</b>`, `      📦 ${x.qty} dona · 💰 ${money(x.price)} × ${x.qty} = <b>${money(x.price * x.qty)}</b>`);
  }
  if (r.fbs.length) {
    L.push("", "🚚 <b>FBS: topshirilgan, lekin Uzum qabul qilmagan buyurtmalar</b>:");
    for (const x of r.fbs.slice(0, 8)) L.push(`   🔴 🧾 № ${escapeHtml(x.invoice)} · ${escapeHtml(x.date)}: ${x.orders} → ${x.accepted} · <b>−${x.orders - x.accepted}</b>${x.sum > 0 ? ` (${money(x.sum)})` : ""}`);
  }
  if (r.fbo.length) {
    L.push("", `📦 <b>FBO qabulida farq</b>: ${fboQty} dona · ≈ ${money(fboSum)}`, "<i>⚠️ Kam olib borilgan bo'lishi ham mumkin — batafsilda tekshiring.</i>");
    const byInv = new Map<string, FboLoss[]>();
    for (const x of r.fbo) byInv.set(x.invoice, [...(byInv.get(x.invoice) ?? []), x]);
    for (const [inv, items] of [...byInv.entries()].slice(0, 6)) {
      L.push(`📄 <b>№ ${inv}</b> · 🛍 <b>${escapeHtml(items[0].shop)}</b>${multi ? ` · 👤 ${escapeHtml(items[0].acc)}` : ""} · ${escapeHtml(items[0].date)}`);
      for (const x of items.slice(0, 4)) {
        const miss = x.sent - x.got;
        L.push(`   ${isLost(x.problems) ? "🟡" : "🟠"} <b>${escapeHtml(cut(x.sku, 36))}</b> · ${miss} dona · ${money(x.price)} × ${miss} = <b>${money(x.price * miss)}</b>`);
      }
    }
  }
  if (r.defected.length) {
    L.push("", "💔 <b>Omborda nuqsonli</b> (sotuvga chiqmaydi — qaytarib oling yoki Uzum aybi bo'lsa murojaat qiling):");
    for (const x of r.defected.slice(0, 8)) L.push(`   🟠 <b>${escapeHtml(cut(x.sku, 40))}</b> · 🛍 <b>${escapeHtml(x.shop)}</b> · ${x.qty} dona · ${money(x.price * x.qty)}`);
  }
  if (r.returns.length) {
    L.push("", "↩️ <b>Olib ketilmagan qaytarishlar</b> (Uzum omborida turibdi):");
    for (const x of r.returns.slice(0, 8)) {
      const st = x.days === null ? "" : x.days > 0 ? ` · 🆓 yana ${x.days} kun bepul` : " · 💸 pullik saqlash boshlangan";
      L.push(`   ${x.days !== null && x.days <= 0 ? "🔴" : "🟡"} № ${escapeHtml(x.id)} · ${escapeHtml(x.type)} · 🛍 <b>${escapeHtml(x.shop)}</b>${st}${x.slot ? " · 🕒 vaqt band" : " · ⏳ vaqt tanlanmagan"}`);
    }
  }
  const c = r.checked;
  L.push("", `<i>🔍 Tekshirildi: ${c.shops} do'kon · ${c.skus} SKU · ${c.invoices} FBO ta'minlash · ${c.fbsInvoices} FBS ta'minlash · ${c.returns} qaytarish</i>`);
  if (r.errs.length) L.push("⚠️ " + r.errs.slice(0, 3).map(escapeHtml).join("\n⚠️ "));
  const ago = Math.round((Date.now() - r.t) / 60000);
  L.push(`<i>🕒 ${ago ? `${ago} daqiqa oldin` : "hozirgina"}</i>`);
  return {
    text: L.join("\n").slice(0, 4000),
    reply_markup: {
      inline_keyboard: [
        ...[...new Map(r.fbo.map((x) => [x.invId, x])).values()].slice(0, 6).map((x) => [
          { text: `📄 FBO № ${x.invoice} — batafsil`, callback_data: `u:lsd:${x.accId}:${x.shopId}:${x.invId}:v` },
        ]),
        ...(r.returns.length ? [[{ text: "↩️ Qaytarishlarga vaqt tanlash", callback_data: "u:fbo" }]] : []),
        [{ text: "📅 Oylarni o'zgartirish", callback_data: "u:lost" }, { text: "🔄 Qayta qidirish", callback_data: "u:lostf" }],
        [{ text: "⬅️ Orqaga", callback_data: "u:home" }],
      ],
    },
  };
}

/* ---------- 📅 Oy tanlash ekrani ---------- */

export async function getSelMonths(env: Env, chatId: number): Promise<string[]> {
  const all = lastMonths(6);
  const raw = await env.STATE.get(`lostsel:${chatId}`);
  const sel: string[] = raw ? JSON.parse(raw) : all.slice(0, 3); // standart: oxirgi 3 oy
  return sel.filter((x) => all.includes(x));
}

export async function toggleMonth(env: Env, chatId: number, ym: string): Promise<void> {
  const all = lastMonths(6);
  let sel = await getSelMonths(env, chatId);
  if (ym === "all") sel = sel.length === all.length ? [] : [...all];
  else sel = sel.includes(ym) ? sel.filter((x) => x !== ym) : [...sel, ym];
  await env.STATE.put(`lostsel:${chatId}`, JSON.stringify(sel), { expirationTtl: 90 * 86400 });
}

export async function monthPicker(env: Env, chatId: number): Promise<LScreen> {
  const all = lastMonths(6);
  const sel = await getSelMonths(env, chatId);
  const btns: Btn[] = all.map((ym) => ({
    text: `${sel.includes(ym) ? "✓ " : ""}${monthLabel(ym)}`,
    callback_data: `u:lm:${ym}`,
    ...(sel.includes(ym) ? { style: "primary" } : {}),
  }));
  const rows: Btn[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([{ text: sel.length === all.length ? "♻️ Hammasini olib tashlash" : "✅ Hammasini tanlash (6 oy)", callback_data: "u:lm:all" }]);
  if (sel.length) rows.push([{ text: `🔎 Qidirish (${sel.length} oy)`, callback_data: "u:lostf", style: "success" }]);
  rows.push([{ text: "⬅️ Orqaga", callback_data: "u:home" }]);
  return {
    text:
      "<b>🔎 Yo'qolgan tovarlarni topish</b>\n\n📅 Qaysi oylarni tekshiramiz? Oylarni bosib tanlang — tanlanganlari <b>ko'k</b> bo'ladi.\n\n" +
      (sel.length ? `Tanlandi: <b>${[...sel].sort().map(monthLabel).join(", ")}</b>` : "<i>Hech bir oy tanlanmagan.</i>") +
      "\n\n<i>💡 Oxirgi 6 oy ko'rsatiladi — eski nakladnoylar bo'yicha Uzum odatda da'voni qabul qilmaydi.</i>",
    reply_markup: { inline_keyboard: rows },
  };
}

/** Kesh bor bo'lsa — darhol; bo'lmasa null (qidiruv kerak) */
export async function lostScreen(env: Env, months: string[]): Promise<LScreen | null> {
  const r = await cachedLost(env, months);
  return r ? renderLost(r) : null;
}

/**
 * Fon rejimida qidiruv: xabarni jonli yangilab turadi (🔍↔🔎 qimirlaydi, bosqichlar ✅/⏳),
 * oxirida natijani shu xabarning o'zida chiqaradi.
 */
export async function runLostSearch(env: Env, chatId: number, messageId: number, months: string[]): Promise<void> {
  const lockKey = `lost:job`;
  if (await env.STATE.get(lockKey)) return; // allaqachon qidirilmoqda
  await env.STATE.put(lockKey, "1", { expirationTtl: 600 });
  let step = 0, note = "", frame = 0, done = false;
  const started = Date.now();
  const draw = async () => {
    const icon = frame++ % 2 ? "🔎" : "🔍";
    const dots = ".".repeat((frame % 3) + 1);
    const sec = Math.round((Date.now() - started) / 1000);
    const L = [`<b>${icon} Yo'qolgan tovarlar qidirilmoqda${dots}</b>`, `📅 ${months.map(monthLabel).join(", ")}`, "", "⏱ Qidiruv <b>2–5 daqiqa</b> davom etishi mumkin — hisobotlar solishtirilmoqda.", ""];
    STEPS.forEach((s, i) => L.push(`${i < step ? "✅" : i === step ? icon : "⏳"} ${s}${i === step && note ? ` — <i>${escapeHtml(cut(note, 30))}</i>` : ""}`));
    L.push("", `<i>⏳ ${sec} soniya</i>`);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: L.join("\n"), parse_mode: "HTML" }).catch(() => {});
  };
  await draw();
  const timer = setInterval(() => {
    if (!done) draw();
  }, 2500);
  try {
    const rep = await scan(env, months, (s, n) => {
      step = s;
      note = n;
    });
    await env.STATE.put(keyOf(months), JSON.stringify(rep), { expirationTtl: 86400 });
    done = true;
    clearInterval(timer);
    const sc = renderLost(rep);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: sc.text, parse_mode: "HTML", reply_markup: sc.reply_markup }).catch(async () => {
      await tg(env, "sendMessage", { chat_id: chatId, text: sc.text, parse_mode: "HTML", reply_markup: sc.reply_markup }).catch(() => {});
    });
  } catch (e) {
    done = true;
    clearInterval(timer);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `⚠️ Qidiruvda xato: ${escapeHtml((e as Error).message.slice(0, 200))}`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🔄 Qayta urinish", callback_data: "u:lostf" }, { text: "⬅️ Orqaga", callback_data: "u:home" }]] },
    }).catch(() => {});
  } finally {
    await env.STATE.delete(lockKey);
  }
}

/* ---------- Muammo turlari ---------- */

const PROBLEM_UZ: Record<string, string> = {
  "Недостача": "kam qabul qilingan (yetishmovchilik)",
  "Брак": "nuqsonli (brak)",
  "Пересорт": "boshqa tovar kelgan (peresort)",
  "Излишек": "ortiqcha",
  "Нет маркировки": "markirovka yo'q",
  "Нет штрихкода": "shtrix-kod yo'q",
  "Не соответствует": "tavsifga mos emas",
};
const isLost = (p: string[]) => !p.length || p.some((x) => /Недостач|shortage|missing/i.test(x));
const problemUz = (p: string[]) => (p.length ? p.map((x) => PROBLEM_UZ[x] ?? x).join(", ") : "yetishmovchilik");
export type LostMode = "v" | "uz" | "ru";

/** Nakladnoy tafsiloti + Uzum supportiga murojaat matni (uz / ru) */
export async function lostDetail(env: Env, accId: string, shopId: number, invId: number, mode: LostMode): Promise<LScreen> {
  const lang: "uz" | "ru" = mode === "ru" ? "ru" : "uz";
  const inv = await uzumGet<any>(env, accId, `/seller/shop/${shopId}/invoice/${invId}`);
  const prods = await uzumGet<any[]>(env, accId, `/seller/shop/${shopId}/invoice/getInvoiceProducts?${qs({ invoiceId: invId })}`);
  const shops = await uzumShops(env, accId);
  const shop = shops.find((x) => x.id === shopId)?.name ?? String(shopId);
  const numRaw = String(inv.invoiceNumber ?? invId);
  const num = numRaw.length === 13 ? numRaw.slice(0, 12) : numRaw;
  const sentAt = inv.timeSlotReservation?.timeFrom ? day(Number(inv.timeSlotReservation.timeFrom)) : String(inv.dateCreated ?? "");
  const accAt = inv.dateAccepted ? day(Number(inv.dateAccepted)) : "—";
  const stock = String(inv.stock?.title ?? "Fulfilment markazi");

  const rows: { title: string; sku: string; skuId: number; sent: number; got: number; price: number; problems: string[] }[] = [];
  for (const p of Array.isArray(prods) ? prods : []) {
    const skus: any[] = p.skuForInvoiceDtoList?.length ? p.skuForInvoiceDtoList : [p];
    for (const k of skus) {
      const q = Number(k.quantityToStock ?? 0), a = Number(k.quantityAccepted ?? 0);
      if (a >= q) continue;
      rows.push({
        title: String(p.productTitle ?? ""),
        sku: String(k.skuTitle ?? p.skuTitle ?? "").trim(),
        skuId: Number(k.id ?? 0),
        sent: q,
        got: a,
        price: Number(k.purchasePrice ?? p.purchasePrice ?? 0),
        problems: (k.issue?.problemTypes ?? []).map(String),
      });
    }
  }
  const lost = rows.filter((x) => isLost(x.problems));
  const rejected = rows.filter((x) => !isLost(x.problems));
  const lostQty = lost.reduce((s, x) => s + x.sent - x.got, 0);
  const lostSum = lost.reduce((s, x) => s + (x.sent - x.got) * x.price, 0);

  const L = [`<b>📄 FBO ta'minlash № ${num}</b>`, `🛍 <b>${escapeHtml(shop)}</b> · 🏭 ${escapeHtml(stock)}`, `🕒 Slot: ${sentAt} · ✅ Qabul qilingan: ${accAt}`, ""];
  if (lost.length) {
    L.push(`🟡 <b>Kam qabul qilingan</b> (yetishmovchilik): <b>${lostQty} dona · ${money(lostSum)}</b>`);
    for (const x of lost) {
      const miss = x.sent - x.got;
      L.push(
        "",
        `   🏷 <b>${escapeHtml(x.sku)}</b> (SKU ID ${x.skuId})`,
        `   📝 ${escapeHtml(cut(x.title, 70))}`,
        `   📦 Soni: <b>${miss} dona</b> kam (yuborildi ${x.sent}, qabul qilindi ${x.got})`,
        `   💰 Narxi: ${money(x.price)} × ${miss} dona = <b>${money(x.price * miss)}</b>`,
      );
    }
    L.push("");
  }
  if (rejected.length) {
    L.push("🟠 <b>Nuqson va h.k. sababli qabul qilinmagan</b> (tovar omborda, qoldiqqa qo'shilmagan):");
    for (const x of rejected) {
      const miss = x.sent - x.got;
      L.push(
        "",
        `   🏷 <b>${escapeHtml(x.sku)}</b> (SKU ID ${x.skuId}) · ${escapeHtml(problemUz(x.problems))}`,
        `   📝 ${escapeHtml(cut(x.title, 70))}`,
        `   📦 Soni: <b>${miss} dona</b> · 💰 ${money(x.price)} × ${miss} = <b>${money(x.price * miss)}</b>`,
      );
    }
    L.push("");
  }
  if (!rows.length) L.push("✅ Bu nakladnoyda farq yo'q.");

  // Murojaat matni
  const T: string[] = [];
  if (lang === "uz") {
    T.push("Assalomu alaykum!", "", `Do'kon: ${shop} (ID ${shopId})`, `FBO ta'minlash № ${num}`, `Ta'minlash sloti: ${sentAt}, qabul qilingan: ${accAt} (${stock})`, "");
    if (lost.length) {
      T.push("Qabul qilishda quyidagi tovarlar «yetishmovchilik» deb belgilangan:");
      lost.forEach((x, i) => T.push(`${i + 1}) ${x.sku} (SKU ID ${x.skuId}) — ${x.title}: yuborilgan ${x.sent} dona, qabul qilingan ${x.got} dona, yetishmaydi ${x.sent - x.got} dona. Narxi: ${money(x.price)} × ${x.sent - x.got} = ${money(x.price * (x.sent - x.got))}.`));
      T.push("", "Biz barcha tovarlarni yuborish dalolatnomasidagi miqdorda to'liq topshirganmiz.", "Iltimos:", "1) Omborda qayta qidirib, topilgan tovarlarni qoldiqqa qo'shing;", `2) Topilmasa, yetishmagan ${lostQty} dona uchun tannarx bo'yicha ${money(lostSum)} kompensatsiya to'lab bering.`);
    }
    if (rejected.length) {
      T.push("", "Quyidagi tovarlar qabul qilinmagan:");
      rejected.forEach((x, i) => T.push(`${i + 1}) ${x.sku} (SKU ID ${x.skuId}) — ${x.sent - x.got} dona, sabab: ${problemUz(x.problems)}.`));
      T.push("Iltimos, sababini fotosuratlar bilan tasdiqlang va tovarlarni qaytarish (qaytarish talabnomasi) uchun tayyorlang.");
    }
    T.push("", "Farq dalolatnomasi va yuborish dalolatnomasini ilova qilaman. Rahmat!");
  } else {
    T.push("Здравствуйте!", "", `Магазин: ${shop} (ID ${shopId})`, `Поставка FBO № ${num}`, `Слот поставки: ${sentAt}, принята: ${accAt} (${stock})`, "");
    if (lost.length) {
      T.push("При приёмке по следующим товарам зафиксирована недостача:");
      lost.forEach((x, i) => T.push(`${i + 1}) ${x.sku} (SKU ID ${x.skuId}) — ${x.title}: отправлено ${x.sent} шт., принято ${x.got} шт., недостача ${x.sent - x.got} шт. Себестоимость: ${money(x.price).replace("so'm", "сум")} × ${x.sent - x.got} = ${money(x.price * (x.sent - x.got)).replace("so'm", "сум")}.`));
      T.push("", "Все товары были переданы в полном объёме согласно акту отправки.", "Прошу:", "1) Провести повторный поиск на складе и оприходовать найденные товары;", `2) В случае ненахождения — выплатить компенсацию за ${lostQty} шт. по себестоимости: ${money(lostSum).replace("so'm", "сум")}.`);
    }
    if (rejected.length) {
      T.push("", "Следующие товары не приняты:");
      rejected.forEach((x, i) => T.push(`${i + 1}) ${x.sku} (SKU ID ${x.skuId}) — ${x.sent - x.got} шт., причина: ${x.problems.join(", ") || "не указана"}.`));
      T.push("Прошу подтвердить причину фотографиями и подготовить товары к возврату.");
    }
    T.push("", "Акт расхождений и акт отправки прилагаю. Спасибо!");
  }
  if (rows.length && mode === "v") {
    L.push(
      "❓ <b>Avval tekshiring:</b> shu tovarlarni haqiqatan to'liq olib borganmisiz? Yuborish dalolatnomasi va qadoqlash paytidagi hisob bilan solishtiring.",
      "",
      "• Kam olib borgan bo'lsangiz — murojaat qilmang, farq sizniki.",
      "• To'liq topshirgan bo'lsangiz — pastdagi tugmani bosing, Uzum supportiga murojaat matni chiqadi.",
    );
  }
  if (rows.length && mode !== "v") {
    L.push(`<b>✉️ Uzum supportiga murojaat (${lang === "uz" ? "o'zbekcha" : "ruscha"})</b> — matn ustiga bosing, nusxa olinadi:`);
    L.push(`<pre>${escapeHtml(T.join("\n"))}</pre>`);
    L.push("<i>📎 Kabinetdagi shu nakladnoydan «Farq dalolatnomasi» va «Yuborish dalolatnomasi»ni yuklab, murojaatga ilova qiling. Murojaat: Uzum Seller → Yordam xizmati (chat).</i>");
  }
  return {
    text: L.join("\n").slice(0, 4090),
    reply_markup: {
      inline_keyboard:
        rows.length && mode === "v"
          ? [
              [{ text: "✅ To'liq topshirganman — murojaat matni", callback_data: `u:lsd:${accId}:${shopId}:${invId}:uz`, style: "success" }],
              [{ text: "⬅️ Orqaga", callback_data: "u:lostr" }],
            ]
          : [
              [
                { text: lang === "uz" ? "• 🇺🇿 O'zbekcha •" : "🇺🇿 O'zbekcha", callback_data: `u:lsd:${accId}:${shopId}:${invId}:uz` },
                { text: lang === "ru" ? "• 🇷🇺 Ruscha •" : "🇷🇺 Ruscha", callback_data: `u:lsd:${accId}:${shopId}:${invId}:ru` },
              ],
              [{ text: "⬅️ Orqaga", callback_data: `u:lsd:${accId}:${shopId}:${invId}:v` }],
            ],
    },
  };
}
