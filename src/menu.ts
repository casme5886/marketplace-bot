/**
 * Asosiy menyu — xabar ichidagi vidjet (Bot API 10.4) ko'rinishidagi boshqaruv paneli.
 * Vidjet ishlamasa — oddiy xabar + inline tugmalar.
 */
import type { Env } from "./types";
import { sendText, tg, TgError } from "./telegram";
import { fmtTime } from "./format";

export const MENU_WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{font:14px system-ui,sans-serif;color:var(--tg-theme-text-color,#111);background:var(--tg-theme-bg-color,#fff);padding:12px}
.t{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.t b{font-size:17px}.u{font-size:12px;color:var(--tg-theme-hint-color,#888)}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.c{border-radius:12px;padding:10px;color:#fff}
.c i{font-style:normal;font-size:12px;opacity:.9}.c b{display:block;font-size:24px;margin-top:2px}
.oz{background:linear-gradient(135deg,#005bff,#3d8bff)}.wb{background:linear-gradient(135deg,#cb11ab,#8e1ad9)}
.w{margin-top:8px;padding:8px 10px;border-radius:10px;font-size:13px;background:rgba(128,128,128,.12)}
.w.r{background:rgba(255,59,48,.15);font-weight:600}
.e{margin-top:6px;font-size:12px;color:#e53935}
.b{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
button{border:0;border-radius:10px;padding:11px 6px;font-size:14px;font-weight:600;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff)}
button.s{background:var(--tg-theme-secondary-bg-color,#eee);color:var(--tg-theme-text-color,#111)}
button:disabled{opacity:.5}
</style></head><body><div id="a"></div><script>
var W=window.TelegramWidget,busy=0;
function e(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function g(){try{return JSON.parse(W.chatData||'{}')}catch(_){return{}}}
function q(c){if(busy)return;busy=1;r(1);var p=W.request(c);if(p&&p.then){p.then(function(){busy=0;r()},function(){busy=0;r()})}else{busy=0}}
function r(w){var d=g(),h='',x=w?' disabled':'';
h+='<div class="t"><b>🛒 MarketHub</b><span class="u">'+(d.u?'🔄 '+e(d.u):'')+'</span></div>';
h+='<div class="g"><div class="c oz"><i>Ozon · kutilmoqda</i><b>'+e(d.oz==null?'—':d.oz)+'</b></div><div class="c wb"><i>Wildberries · yangi</i><b>'+e(d.wb==null?'—':d.wb)+'</b></div></div>';
if(d.od)h+='<div class="w r">🚨 Muddati o\\'tgan: '+e(d.od)+' ta</div>';
if(d.nd)h+='<div class="w">⏰ Eng yaqin muddat: '+e(d.nd)+'</div>';
if(d.e)h+='<div class="e">⚠️ '+e(d.e)+'</div>';
h+='<div class="b"><button id="o"'+x+'>📋 Buyurtmalar</button><button id="f"'+x+'>🔄 Yangilash</button><button class="s" id="p"'+x+'>📊 Hisobot</button><button class="s" id="l"'+x+'>🚪 Chiqish</button></div>';
document.getElementById('a').innerHTML=h;
document.getElementById('o').onclick=function(){q('m:orders')};
document.getElementById('f').onclick=function(){q('m:refresh')};
document.getElementById('p').onclick=function(){q('m:report')};
document.getElementById('l').onclick=function(){q('m:logout')};}
if(W){W.onEvent('chatDataChanged',function(){r()});r();W.ready&&W.ready()}
</script></body></html>`;

/** Pastki doimiy tugmalar (har qanday Telegram versiyasida ishlaydi) */
/** Pastki (reply) klaviatura ishlatilmaydi — hamma tugmalar xabar ichida. Eski klaviaturani olib tashlaydi. */
export const REPLY_KEYBOARD = { remove_keyboard: true } as const;

/** Tugma matnini buyruqqa aylantirish (eski tugmalar ham ishlayveradi) */
export const BUTTON_COMMANDS: Record<string, string> = {
  "📋 Buyurtmalar": "/orders",
  "📈 Statistika": "/stats",
  "🛍 Bugungi sotuv": "/sales",
  "↩️ Qaytarishlar": "/returns",
  "🔄 Tekshirish": "/check",
  "📊 Hisobot": "/report",
  "🏠 Menyu": "/menu",
  "📦 Uzum FBO": "/uzum",
  "🟪 Uzum Market": "/uzum",
  "🚪 Chiqish": "/logout",
};

export interface DashStats {
  oz: number | null;
  wb: number | null;
  od: number;
  nd: string;
  e: string;
}

export function menuData(env: Env, s: DashStats): string {
  const t = fmtTime(env, new Date().toISOString()).split(" ")[1];
  return JSON.stringify({ ...s, e: s.e.slice(0, 120), u: t });
}

function menuFallbackKeyboard(s?: DashStats) {
  const n = (s?.oz ?? 0) + (s?.wb ?? 0);
  return {
    inline_keyboard: [
      [
        { text: `📋 Buyurtmalar${n ? ` (${n})` : ""}${s?.od ? " 🚨" : ""}`, callback_data: "m:orders" },
        { text: "📈 Statistika", callback_data: "s:td" },
      ],
      [
        { text: "🛍 Bugungi sotuv", callback_data: "so:td:0" },
        { text: "↩️ Qaytarishlar", callback_data: "sr:7d:0" },
      ],
      [
        { text: "🏆 Top mahsulotlar", callback_data: "st:7d" },
        { text: "🗺 Shaharlar", callback_data: "sc:7d" },
      ],
      [{ text: "🟪 Uzum Market", callback_data: "u:sh", style: "primary" }, { text: "🎯 Bron markazi", callback_data: "u:bm", style: "success" }],
      [
        { text: "🔄 Yangilash", callback_data: "m:refresh" },
        { text: "🚪 Chiqish", callback_data: "m:logout" },
      ],
    ],
  };
}

function menuText(env: Env, s: DashStats, today: string[] = []): string {
  const now = fmtTime(env, new Date().toISOString());
  const lines = [`<b>🛒 MarketHub</b> · <i>${now}</i>`];
  if (today.length) lines.push("", ...today);
  lines.push("", "<b>📦 Ish navbatida</b>");
  lines.push(`🔵 Ozon: <b>${s.oz ?? "—"}</b> ta  ·  🟣 WB: <b>${s.wb ?? "—"}</b> ta`);
  if (s.od) lines.push(`🚨 Muddati o'tgan: <b>${s.od}</b> ta`);
  if (s.nd) lines.push(`⏰ Eng yaqin muddat: <b>${s.nd}</b>`);
  if (!s.od && !s.nd && !(s.oz || s.wb)) lines.push("✅ Hammasi jo'natilgan");
  if (s.e) lines.push("", `⚠️ ${escapeHtml(s.e)}`);
  return lines.join("\n");
}

export async function sendMenu(env: Env, chatId: number, s: DashStats) {
  try {
    const m = await tg<{ message_id: number }>(env, "sendWidget", {
      chat_id: chatId,
      html: MENU_WIDGET_HTML,
      chat_data: menuData(env, s),
      allow_queries: true,
    });
    await env.STATE.put(`msg:${chatId}:${m.message_id}`, "menu", { expirationTtl: 30 * 86400 });
  } catch (e) {
    console.log("menu widget failed, fallback:", (e as Error).message);
    await sendText(env, chatId, menuText(env, s), { reply_markup: menuFallbackKeyboard() });
  }
}

/** Menyu vidjeti yoki xabarini yangilash */
export async function updateMenu(env: Env, chatId: number, messageId: number, widget: boolean, s: DashStats) {
  try {
    if (widget) {
      await tg(env, "editMessageWidgetData", { chat_id: chatId, message_id: messageId, chat_data: menuData(env, s) });
    } else {
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: menuText(env, s),
        parse_mode: "HTML",
        reply_markup: menuFallbackKeyboard(),
      });
    }
  } catch (e) {
    if (!(e instanceof TgError && /not modified/i.test(e.description))) throw e;
  }
}

/* ===================== Bitta xabar ichida navigatsiya ===================== */
import { escapeHtml } from "./telegram";
import type { Marketplace, Order } from "./types";
import { fmtMoney, MP_ICON, MP_NAME, orderText } from "./format";

export interface Screen {
  text: string;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
}

const back = (to: string, text = "⬅️ Orqaga") => ({ text, callback_data: to });

export function homeScreen(env: Env, s: DashStats, today: string[] = []): Screen {
  return { text: menuText(env, s, today), reply_markup: menuFallbackKeyboard(s) };
}

/** 1-qadam: marketpleysni tanlash */
export function mpChoiceScreen(env: Env, all: Order[], errs: string[]): Screen {
  const now = Date.now();
  const stat = (mp: Marketplace) => {
    const l = all.filter((o) => o.mp === mp);
    const late = l.filter((o) => o.deadline && new Date(o.deadline).getTime() < now).length;
    return { n: l.length, late, ship: l.filter((o) => o.canShip).length };
  };
  const oz = stat("ozon"), wb = stat("wb");
  const line = (icon: string, name: string, s: { n: number; late: number; ship: number }) =>
    `${icon} <b>${name}</b>: ${s.n} ta` + (s.ship ? ` · yig'ishga ${s.ship}` : "") + (s.late ? ` · 🚨 kechikkan ${s.late}` : "");
  const text = [
    "<b>📋 Buyurtmalar</b>",
    "",
    line("🔵", "Ozon", oz),
    line("🟣", "Wildberries", wb),
    "",
    "Marketpleysni tanlang 👇",
  ];
  if (errs.length) text.push("\n⚠️ " + errs.map(escapeHtml).join("\n⚠️ "));
  return {
    text: text.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: `🔵 Ozon (${oz.n})${oz.late ? " 🚨" : ""}`, callback_data: "l:ozon" },
          { text: `🟣 Wildberries (${wb.n})${wb.late ? " 🚨" : ""}`, callback_data: "l:wb" },
        ],
        [{ text: "🔄 Yangilash", callback_data: "m:orders" }, back("m:home", "🏠 Menyu")],
      ],
    },
  };
}

/** 2-qadam: tanlangan marketpleys buyurtmalari + umumiy amallar */
export function ordersScreen(env: Env, mp: Marketplace, all: Order[], errs: string[], wbSupply = false): Screen {
  const now = Date.now();
  const list = all.filter((o) => o.mp === mp);
  const lines = [`<b>${MP_ICON[mp]} ${MP_NAME[mp]} — buyurtmalar (${list.length})</b>`];
  if (!list.length) lines.push("\n✅ Hozircha kutilayotgan buyurtma yo'q.");
  else {
    const late = list.filter((o) => o.deadline && new Date(o.deadline).getTime() < now).length;
    const ship = list.filter((o) => o.canShip).length;
    lines.push("");
    if (ship) lines.push(`📦 Yig'ishni kutmoqda: <b>${ship}</b>`);
    if (list.length - ship) lines.push(`🚚 Topshirishni kutmoqda: <b>${list.length - ship}</b>`);
    if (late) lines.push(`🚨 Kechikkan: <b>${late}</b>`);
    lines.push("");
    for (const o of list.slice(0, 12)) {
      const nm = o.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(", ");
      lines.push(`${o.canShip ? "📦" : "🚚"} ${escapeHtml(nm.length > 48 ? nm.slice(0, 47) + "…" : nm)}\n     📍 ${escapeHtml(o.city.split(",")[0])} · ${fmtMoney(o.price, o.currency)}`);
    }
    if (list.length > 12) lines.push(`… yana ${list.length - 12} ta`);
    lines.push("\nBuyurtmani tanlang 👇");
  }
  const mpErr = errs.filter((e) => e.toLowerCase().startsWith(mp === "ozon" ? "ozon" : "wb"));
  if (mpErr.length) lines.push("\n⚠️ " + mpErr.map(escapeHtml).join("\n⚠️ "));
  const rows = list.slice(0, 20).map((o) => {
    const late = o.deadline && new Date(o.deadline).getTime() < now;
    const dl = o.deadline ? ` · ${late ? "🚨" : "⏰"} ${fmtTime(env, o.deadline)}` : "";
    const name = o.items[0]?.name ?? "";
    const short = name.length > 22 ? name.slice(0, 21) + "…" : name;
    return [{ text: `${o.canShip ? "📦" : "🚚"} ${short}${dl}`, callback_data: `o:${o.mp}:${o.id}` }];
  });
  const shipN = list.filter((o) => o.canShip).length;
  const readyN = mp === "ozon" ? list.filter((o) => o.readyToHandover).length : 0;
  const act: { text: string; callback_data: string }[] = [];
  if (shipN) act.push({ text: `📦 Yig'ish (${shipN})`, callback_data: `b:ship:${mp}` });
  if (readyN || (mp === "wb" && wbSupply)) act.push({ text: `🚚 Yukni jo'natish${readyN ? ` (${readyN})` : ""}`, callback_data: `b:send:${mp}` });
  if (act.length) rows.push(act);
  if (list.length) rows.push([{ text: `🏷 Barcha yorliqlar (${list.length})`, callback_data: `b:label:${mp}` }]);
  rows.push([back("m:orders", "⬅️ Orqaga"), { text: "🔄 Yangilash", callback_data: `l:${mp}` }, back("m:home", "🏠")]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** "Yukni jo'natish" dan oldin tasdiqlash */
export function confirmSendScreen(mp: Marketplace, n: number): Screen {
  const what = mp === "ozon" ? `${n} ta tayyor buyurtma uchun jo'natma (otgruzka) yaratib, tasdiqlayman` : "bugungi postavkani yopib, yetkazishga topshiraman";
  return {
    text: `❓ <b>${MP_NAME[mp]}</b>: ${what}.\n\nShundan keyin yukni topshirish punktiga olib borasiz. Davom etaymi?`,
    reply_markup: {
      inline_keyboard: [[{ text: "🚚 Ha, jo'natish", callback_data: `bc:send:${mp}` }, back(`l:${mp}`, "❌ Bekor qilish")]],
    },
  };
}

/** Ommaviy yig'ishdan oldin tasdiqlash */
export function confirmShipScreen(mp: Marketplace, n: number): Screen {
  return {
    text: `❓ <b>${MP_NAME[mp]}</b>: ${n} ta buyurtmani "yig'ildi" deb belgilaymi?\n\nBu marketpleysda buyurtma holatini o'zgartiradi. Faqat hammasini haqiqatan qadoqlagan bo'lsangiz tasdiqlang.`,
    reply_markup: {
      inline_keyboard: [[{ text: "📦 Ha, yig'ildi", callback_data: `bc:ship:${mp}` }, back(`l:${mp}`, "❌ Bekor qilish")]],
    },
  };
}

export function orderScreen(env: Env, o: Order, note = ""): Screen {
  const row: { text: string; callback_data: string }[] = [];
  if (o.canShip) row.push({ text: "📦 Yig'ish", callback_data: `a:ship:${o.mp}:${o.id}` });
  row.push({ text: "🏷 Yorliq", callback_data: `a:label:${o.mp}:${o.id}` });
  return {
    text: orderText(env, o, "📦 Buyurtma") + (note ? `\n\n<i>${escapeHtml(note)}</i>` : ""),
    reply_markup: { inline_keyboard: [row, [back(`l:${o.mp}`, "⬅️ Ro'yxat"), back("m:home", "🏠 Menyu")]] },
  };
}

export function textScreen(text: string): Screen {
  return { text, reply_markup: { inline_keyboard: [[back("m:home", "⬅️ Menyu")]] } };
}

/** Ekranni chiqarish: messageId bo'lsa — o'sha xabarni tahrirlaydi, bo'lmasa — yangi xabar */
export async function showScreen(env: Env, chatId: number, messageId: number | null, sc: Screen): Promise<number> {
  if (messageId) {
    try {
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: sc.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: sc.reply_markup,
      });
      await env.STATE.put(`panel:${chatId}`, String(messageId), { expirationTtl: 2 * 86400 });
      return messageId;
    } catch (e) {
      if (e instanceof TgError && /not modified/i.test(e.description)) return messageId;
      console.log("edit failed, sending new:", (e as Error).message);
    }
  }
  // Yangi panel chiqadi — eskisini o'chiramiz (chatda bitta menyu turadi)
  const m = await sendText(env, chatId, sc.text, { reply_markup: sc.reply_markup });
  const old = Number((await env.STATE.get(`panel:${chatId}`)) ?? 0);
  if (old && old !== m.message_id) await tg(env, "deleteMessage", { chat_id: chatId, message_id: old }).catch(() => {});
  await env.STATE.put(`panel:${chatId}`, String(m.message_id), { expirationTtl: 2 * 86400 });
  return m.message_id;
}

export const mpName = (mp: Marketplace) => MP_NAME[mp];

/* ===================== Yorliqlarni ko'rish (shu xabarning o'zida) ===================== */
import { editDocument, sendDocument } from "./telegram";

/** Yorliq ko'ruvchi tugmalari: ◀️ 1/3 ▶️ va Orqaga */
export function labelViewerKeyboard(mp: Marketplace, i: number, n: number) {
  const nav: { text: string; callback_data: string }[] = [];
  if (n > 1) {
    nav.push({ text: "◀️", callback_data: `lv:${mp}:${(i - 1 + n) % n}` });
    nav.push({ text: `${i + 1} / ${n}`, callback_data: `lv:${mp}:${i}` });
    nav.push({ text: "▶️", callback_data: `lv:${mp}:${(i + 1) % n}` });
  }
  const rows = nav.length ? [nav] : [];
  rows.push([
    { text: "⬅️ Orqaga", callback_data: `lvb:${mp}` },
    { text: "🏠", callback_data: "lvh" },
  ]);
  return { inline_keyboard: rows };
}

/**
 * Yorliqni ko'rsatish. messageId hujjatli xabar bo'lsa — o'sha xabarda almashtiradi,
 * matnli xabar bo'lsa — uni o'chirib, o'rniga hujjatli xabar chiqaradi.
 */
export async function showLabel(
  env: Env,
  chatId: number,
  messageId: number,
  isDocMessage: boolean,
  mp: Marketplace,
  ids: string[],
  i: number,
  make: (id: string) => Promise<{ data: ArrayBuffer | Uint8Array; filename: string; mime: string; caption: string }>,
) {
  const id = ids[i];
  const cacheKey = `lfile:${mp}:${id}`;
  const cached = await env.STATE.get(cacheKey);
  const kb = labelViewerKeyboard(mp, i, ids.length);
  if (isDocMessage) {
    if (cached) {
      const c = JSON.parse(cached);
      await editDocument(env, chatId, messageId, { fileId: c.fileId }, c.caption, kb);
    } else {
      const f = await make(id);
      const r = await editDocument(env, chatId, messageId, f, f.caption, kb);
      const fileId = r?.document?.file_id ?? r?.photo?.at?.(-1)?.file_id;
      if (fileId) await env.STATE.put(cacheKey, JSON.stringify({ fileId, caption: f.caption }), { expirationTtl: 86400 });
    }
    await env.STATE.put(`lv:${chatId}:${messageId}`, JSON.stringify(ids), { expirationTtl: 86400 });
    return;
  }
  // Matnli menyu -> hujjatli xabar
  const f = cached ? null : await make(id);
  await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
  let m: any;
  if (cached) {
    const c = JSON.parse(cached);
    m = await tg(env, "sendDocument", { chat_id: chatId, document: c.fileId, caption: c.caption, reply_markup: kb });
  } else {
    m = await sendDocument(env, chatId, f!.data, f!.filename, f!.mime, f!.caption, kb);
    const fileId = m?.document?.file_id;
    if (fileId) await env.STATE.put(cacheKey, JSON.stringify({ fileId, caption: f!.caption }), { expirationTtl: 86400 });
  }
  await env.STATE.put(`lv:${chatId}:${m.message_id}`, JSON.stringify(ids), { expirationTtl: 86400 });
}
