import type { Env, Marketplace, Order, StoredOrder } from "./types";
import { appMarkup, logNtf } from "./notify";
import { listAuthorizedChats } from "./auth";
import { escapeHtml, sendDocument, sendText, tg, TgError } from "./telegram";
import { fmtTime, itemsLine, MP_ICON, MP_NAME, orderText, statusUz, widgetData } from "./format";
import { ORDER_WIDGET_HTML } from "./widget";
import { getStats, yesterdayReport } from "./stats";
import { ozonActPdf, ozonCancel, ozonEnabled, ozonGet, ozonHandover, ozonLabel, ozonShip, ozonUnfulfilled } from "./ozon";
import { wbCancel, wbEnabled, wbLabel, wbLabels, wbNew, wbShip, wbSupplyQr, wbTodaySupply, wbHandover } from "./wb";
import { cancelConfirmKeyboard, cancelReasonKeyboard, cardKeyboard, cardText, handConfirmKeyboard, stageOf } from "./card";

const ORDER_TTL = 30 * 86400;
const key = (mp: Marketplace, id: string) => `order:${mp}:${id}`;

export async function loadOrder(env: Env, mp: Marketplace, id: string): Promise<StoredOrder | null> {
  const raw = await env.STATE.get(key(mp, id));
  return raw ? (JSON.parse(raw) as StoredOrder) : null;
}

export async function saveOrder(env: Env, so: StoredOrder) {
  await env.STATE.put(key(so.order.mp, so.order.id), JSON.stringify(so), {
    expirationTtl: ORDER_TTL,
    metadata: { c: so.order.createdAt, d: so.order.deadline ?? null },
  });
}

function fallbackKeyboard(o: Order) {
  const row: { text: string; callback_data: string }[] = [];
  if (o.canShip) row.push({ text: "✅ Yig'ishga olish", callback_data: `a:ship:${o.mp}:${o.id}` });
  row.push({ text: "🏷 Yorliq", callback_data: `a:label:${o.mp}:${o.id}` });
  return { inline_keyboard: [row] };
}

/** Bitta chatga buyurtma kartochkasini yuborish: avval vidjet (agar Telegram ruxsat bersa), bo'lmasa xabar + tugmalar */
export async function sendOrderCard(env: Env, chatId: number, o: Order) {
  const so: StoredOrder = { order: o, chatMessages: [] };
  const appMode = !!(await env.STATE.get("app:url"));
  if (!appMode && !(await env.STATE.get("widgets:off"))) {
    try {
      const m = await tg<{ message_id: number }>(env, "sendWidget", {
        chat_id: chatId,
        html: ORDER_WIDGET_HTML,
        chat_data: widgetData(env, o),
        allow_queries: true,
        caption: `${MP_ICON[o.mp]} ${MP_NAME[o.mp]}: yangi buyurtma № ${o.id}`,
      });
      await env.STATE.put(`msg:${chatId}:${m.message_id}`, `${o.mp}:${o.id}`, { expirationTtl: ORDER_TTL });
      return { chatId, messageId: m.message_id, widget: true };
    } catch (e) {
      // Vidjet hali yoqilmagan — 6 soat qayta urinmaymiz
      if (/WIDGET_NOT_ALLOWED|not found|unknown method/i.test((e as Error).message)) {
        await env.STATE.put("widgets:off", "1", { expirationTtl: 6 * 3600 });
      }
      console.log("sendWidget failed, fallback:", (e as Error).message);
    }
  }
  await logNtf(env, chatId, `🆕 Yangi buyurtma\n${cardText(env, so)}`, "orders");
  const m = await sendText(env, chatId, cardText(env, so), { reply_markup: appMode ? await appMarkup(env, null, "orders") : cardKeyboard(so) });
  await env.STATE.put(`msg:${chatId}:${m.message_id}`, `${o.mp}:${o.id}`, { expirationTtl: ORDER_TTL });
  return { chatId, messageId: m.message_id, widget: false };
}

async function broadcast(env: Env, text: string, extra: Record<string, unknown> = {}) {
  for (const chatId of await listAuthorizedChats(env)) {
    try {
      await sendText(env, chatId, text, extra);
    } catch (e) {
      console.log("broadcast error", chatId, (e as Error).message);
    }
  }
}

/** Saqlangan kartochkalarni (vidjet yoki xabar) yangilash */
export async function refreshCards(env: Env, so: StoredOrder, note = "") {
  for (const cm of so.chatMessages) {
    try {
      if (cm.widget) {
        await tg(env, "editMessageWidgetData", {
          chat_id: cm.chatId,
          message_id: cm.messageId,
          chat_data: widgetData(env, so.order, note),
        });
      } else {
        await tg(env, "editMessageText", {
          chat_id: cm.chatId,
          message_id: cm.messageId,
          text: cardText(env, so, false, note),
          parse_mode: "HTML",
          reply_markup: (await env.STATE.get("app:url")) ? await appMarkup(env, null, "orders") : cardKeyboard(so),
        });
      }
    } catch (e) {
      if (!(e instanceof TgError && /not modified/i.test(e.description))) {
        console.log("refresh error", (e as Error).message);
      }
    }
  }
}

/** Har bir cron ishga tushganda: yangi buyurtmalarni topish, holatlarni va muddatlarni tekshirish */
export async function pollAll(env: Env): Promise<{ newCount: number; errors: string[] }> {
  const errors: string[] = [];
  const orders: Order[] = [];
  if (ozonEnabled(env)) {
    try {
      orders.push(...(await ozonUnfulfilled(env)));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (wbEnabled(env)) {
    try {
      orders.push(...(await wbNew(env)));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  const chats = await listAuthorizedChats(env);
  const now = Date.now();
  const remindMs = Number(env.REMIND_BEFORE_HOURS ?? "3") * 3600e3;
  let newCount = 0;

  for (const o of orders) {
    let so = await loadOrder(env, o.mp, o.id);
    if (!so) {
      so = { order: o, chatMessages: [] };
      for (const chatId of chats) {
        try {
          so.chatMessages.push(await sendOrderCard(env, chatId, o));
        } catch (e) {
          errors.push(`send ${chatId}: ${(e as Error).message}`);
        }
      }
      newCount++;
      await saveOrder(env, so);
      continue;
    }

    let changed = false;
    // Muddat o'zgarsa — eslatmalarni qaytadan hisoblaymiz
    if (so.order.deadline !== o.deadline) {
      so.order.deadline = o.deadline;
      so.reminded = false;
      so.overdueNotified = false;
      changed = true;
    }
    if (so.order.status !== o.status || so.order.canShip !== o.canShip) {
      so.order = { ...so.order, ...o };
      changed = true;
      await refreshCards(env, so);
    }

    // Muddat eslatmalari (Ozon'da shipment_date bor)
    if (o.deadline) {
      const dl = new Date(o.deadline).getTime();
      const label = `${MP_ICON[o.mp]} ${MP_NAME[o.mp]} № <code>${escapeHtml(o.id)}</code>\n📦 ${escapeHtml(itemsLine(o))}\n📍 ${escapeHtml(o.city)}`;
      if (now > dl && !so.overdueNotified) {
        await broadcast(env, `🚨 <b>Muddat o'tib ketdi!</b>\n${label}\n⏰ Muddat: ${fmtTime(env, o.deadline)}\nImkon qadar tezroq topshiring — jarima oshib boradi.`);
        so.overdueNotified = true;
        so.reminded = true;
        changed = true;
      } else if (now > dl - remindMs && now <= dl && !so.reminded) {
        const left = Math.max(0, Math.round((dl - now) / 60000));
        const h = Math.floor(left / 60), m = left % 60;
        await broadcast(env, `⏰ <b>Topshirishga ${h} soat ${m} daqiqa qoldi</b>\n${label}\nMuddat: ${fmtTime(env, o.deadline)}`);
        so.reminded = true;
        changed = true;
      }
    }
    if (changed) await saveOrder(env, so);
  }

  if (errors.length) console.log("poll errors", errors);
  return { newCount, errors };
}

/** Tugma bosilganda: "ship" yoki "label" */
export async function doAction(env: Env, chatId: number, mp: Marketplace, id: string, action: string): Promise<string> {
  const so = (await loadOrder(env, mp, id)) ?? null;
  if (action === "ship") {
    let supply = "";
    if (mp === "ozon") await ozonShip(env, id);
    else supply = await wbShip(env, id);
    if (so) {
      if (mp === "ozon") {
        try {
          so.order = (await ozonGet(env, id)).order;
        } catch {
          so.order.canShip = false;
        }
      } else {
        so.order.status = "confirm";
        so.order.canShip = false;
        so.supply = supply;
      }
      so.shipped = true;
      await saveOrder(env, so);
      await refreshCards(env, so);
    }
    return "✅ Yig'ishga olindi";
  }
  if (action === "label") {
    const o = so?.order ?? ({ mp, id, items: [], status: "", price: 0, currency: "", city: "", createdAt: "", canShip: false } as Order);
    await sendOneLabel(env, chatId, o);
    return "🏷 Yorliq yuborildi";
  }
  return "Noma'lum amal";
}

/** Hozir kutilayotgan buyurtmalar (ikkala marketpleys) */
export async function pendingOrders(env: Env): Promise<{ all: Order[]; errs: string[]; oz: number | null; wb: number | null }> {
  const errs: string[] = [];
  const all: Order[] = [];
  let oz: number | null = null, wb: number | null = null;
  if (ozonEnabled(env)) {
    try {
      const o = await ozonUnfulfilled(env);
      // Jo'natmaga (otgruzka) qo'shilganlarini belgilaymiz — qayta jo'natma yaratilmasin
      for (const x of o) {
        if (x.readyToHandover && (await env.STATE.get(`handed:ozon:${x.id}`))) {
          x.readyToHandover = false;
          x.status = "handed";
        }
      }
      oz = o.length;
      all.push(...o);
    } catch (e) {
      errs.push("Ozon: " + (e as Error).message);
    }
  }
  if (wbEnabled(env)) {
    try {
      const w = await wbNew(env);
      wb = w.length;
      all.push(...w);
    } catch (e) {
      errs.push("WB: " + (e as Error).message);
    }
  }
  all.sort((a, b) => (a.deadline ?? a.createdAt).localeCompare(b.deadline ?? b.createdAt));
  return { all, errs, oz, wb };
}

/** Bosh menyu uchun statistika */
export async function dashStats(env: Env) {
  const { all, errs, oz, wb } = await pendingOrders(env);
  const now = Date.now();
  const withDl = all.filter((o) => o.deadline);
  const od = withDl.filter((o) => new Date(o.deadline!).getTime() < now).length;
  const next = withDl.find((o) => new Date(o.deadline!).getTime() >= now);
  return { oz, wb, od, nd: next ? fmtTime(env, next.deadline) : "", e: errs.join("; ") };
}

/** Har bir kutilayotgan buyurtmani alohida kartochka (vidjet) qilib yuborish */
export async function sendOrderCards(env: Env, chatId: number, limit = 15): Promise<number> {
  const { all, errs } = await pendingOrders(env);
  if (!all.length) {
    await sendText(env, chatId, "✅ Kutilayotgan buyurtma yo'q." + (errs.length ? "\n\n⚠️ " + errs.map(escapeHtml).join("\n⚠️ ") : ""));
    return 0;
  }
  for (const o of all.slice(0, limit)) {
    const so = (await loadOrder(env, o.mp, o.id)) ?? { order: o, chatMessages: [] };
    so.order = { ...so.order, ...o };
    so.chatMessages.push(await sendOrderCard(env, chatId, o));
    await saveOrder(env, so);
  }
  if (all.length > limit) await sendText(env, chatId, `… yana ${all.length - limit} ta. To'liq ro'yxat: /list`);
  if (errs.length) await sendText(env, chatId, "⚠️ " + errs.map(escapeHtml).join("\n⚠️ "));
  return all.length;
}

/** /list — qisqa matnli ro'yxat */
export async function pendingSummary(env: Env): Promise<string> {
  const lines: string[] = [];
  const { all, errs } = await pendingOrders(env);
  if (!all.length) lines.push("✅ Kutilayotgan buyurtma yo'q.");
  for (const o of all) {
    lines.push(
      `${MP_ICON[o.mp]} <code>${escapeHtml(o.id)}</code> — ${escapeHtml(itemsLine(o))}\n` +
        `   📍 ${escapeHtml(o.city)} · ${statusUz(o)}` +
        (o.deadline ? ` · ⏰ ${fmtTime(env, o.deadline)}` : ""),
    );
  }
  if (errs.length) lines.push("\n⚠️ " + errs.map(escapeHtml).join("\n⚠️ "));
  return `<b>📋 Kutilayotgan buyurtmalar (${all.length})</b>\n\n` + lines.join("\n");
}

/** Kunlik hisobot: kechagi natijalar + hozir kutilayotgan ishlar */
export async function dailyReport(env: Env): Promise<string> {
  const [st, pend] = await Promise.all([getStats(env, "yd"), pendingOrders(env)]);
  const lines = [yesterdayReport(env, st)];
  const now = Date.now();
  const all = pend.all;
  const late = all.filter((o) => o.deadline && new Date(o.deadline).getTime() < now).length;
  const next = all.find((o) => o.deadline && new Date(o.deadline).getTime() >= now);
  lines.push("", `<b>📦 Bugun jo'natish kerak:</b> ${all.length} ta` + (late ? ` · 🚨 kechikkan: <b>${late}</b>` : ""));
  if (next) lines.push(`⏰ Eng yaqin muddat: ${fmtTime(env, next.deadline)}`);
  return lines.join("\n");
}

/** Hisobot ostidagi tugmalar */
export const REPORT_KEYBOARD = {
  inline_keyboard: [
    [{ text: "📋 Buyurtmalar", callback_data: "m:orders" }, { text: "📈 Batafsil", callback_data: "s:yd" }],
    [{ text: "🏠 Menyu", callback_data: "m:home" }],
  ],
};

export async function sendDailyReport(env: Env) {
  await broadcast(env, await dailyReport(env), { reply_markup: REPORT_KEYBOARD });
}

/** Ommaviy: tanlangan marketpleysdagi barcha "yig'ishni kutayotgan" buyurtmalarni yig'ishga olish */
export async function bulkShip(env: Env, chatId: number, mp: Marketplace): Promise<{ ok: number; fail: string[] }> {
  const { all } = await pendingOrders(env);
  const list = all.filter((o) => o.mp === mp && o.canShip);
  let ok = 0;
  const fail: string[] = [];
  for (const o of list) {
    try {
      await doAction(env, chatId, mp, o.id, "ship");
      ok++;
    } catch (e) {
      fail.push(`${o.id}: ${(e as Error).message}`);
    }
  }
  return { ok, fail };
}

/** Fayl nomi uchun xavfsiz matn */
const fileSafe = (t: string) => t.replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/** Yorliq faylini tayyorlash (yuborishsiz) */
export async function makeLabel(env: Env, o: Order): Promise<{ data: ArrayBuffer | Uint8Array; filename: string; mime: string; caption: string }> {
  const name = o.items.map((i) => i.name).join(", ") || o.id;
  const caption = `🏷 ${name}\n№ ${o.id}${o.items.length ? ` · ${o.items.reduce((s, i) => s + i.qty, 0)} dona` : ""}`.slice(0, 900);
  if (o.mp === "ozon") {
    return { data: await ozonLabel(env, o.id), filename: `${fileSafe(name)} — ${o.id}.pdf`, mime: "application/pdf", caption };
  }
  return { data: await wbLabel(env, o.id), filename: `${fileSafe(name)} — ${o.id}.png`, mime: "image/png", caption };
}

/** Bitta buyurtma yorlig'i: fayl nomi va izohda mahsulot nomi */
async function sendOneLabel(env: Env, chatId: number, o: Order) {
  const name = o.items.map((i) => i.name).join(", ") || o.id;
  const caption = `🏷 ${name}\n№ ${o.id}${o.items.length ? ` · ${o.items.reduce((s, i) => s + i.qty, 0)} dona` : ""}`.slice(0, 1000);
  if (o.mp === "ozon") {
    const pdf = await ozonLabel(env, o.id);
    await sendDocument(env, chatId, pdf, `${fileSafe(name)} — ${o.id}.pdf`, "application/pdf", caption);
  } else {
    const png = await wbLabel(env, o.id);
    await sendDocument(env, chatId, png, `${fileSafe(name)} — ${o.id}.png`, "image/png", caption);
  }
}

/** Ommaviy: barcha yorliqlar — har bir buyurtma alohida fayl, nomi bilan */
export async function bulkLabels(env: Env, chatId: number, mp: Marketplace): Promise<{ ok: number; fail: string[] }> {
  const { all } = await pendingOrders(env);
  const list = all.filter((o) => o.mp === mp);
  let ok = 0;
  const fail: string[] = [];
  for (const o of list) {
    try {
      await sendOneLabel(env, chatId, o);
      ok++;
    } catch (e) {
      fail.push(`${o.id}: ${(e as Error).message}`);
    }
  }
  return { ok, fail };
}

/** Topshirilgan buyurtmalar kartochkalarini 3-bosqichga o'tkazish */
async function markHanded(env: Env, mp: Marketplace, ids: string[], ref: string) {
  for (const id of ids) {
    const so = await loadOrder(env, mp, id);
    if (!so) continue;
    so.handed = ref;
    if (mp === "ozon") so.order.readyToHandover = false;
    await saveOrder(env, so);
    await refreshCards(env, so);
  }
}

/** Ommaviy: "Yukni jo'natish" — Ozon: tayyor buyurtmalar uchun jo'natma + akt; WB: bugungi postavkani topshirish + QR */
export async function bulkHandover(env: Env, chatId: number, mp: Marketplace): Promise<string> {
  if (mp === "ozon") {
    const { all } = await pendingOrders(env);
    const ready = all.filter((o) => o.mp === "ozon" && o.readyToHandover);
    if (!ready.length) return "Topshirishga tayyor buyurtma yo'q. Avval \"📦 Yig'ish\" ni bosing.";
    const byDm = new Map<number, Order[]>();
    for (const o of ready) {
      if (!o.deliveryMethodId) continue;
      byDm.set(o.deliveryMethodId, [...(byDm.get(o.deliveryMethodId) ?? []), o]);
    }
    const out: string[] = [];
    for (const [dm, list] of byDm) {
      const r = await ozonHandover(env, dm);
      for (const o of list) await env.STATE.put(`handed:ozon:${o.id}`, String(r.carriageId), { expirationTtl: 7 * 86400 });
      await markHanded(env, "ozon", list.map((o) => o.id), String(r.carriageId));
      out.push(`🚚 Jo'natma № ${r.carriageId}: ${list.length} ta buyurtma`);
      if (r.act) await sendDocument(env, chatId, r.act, `ozon-akt-${r.carriageId}.pdf`, "application/pdf", `📄 Ozon topshirish akti № ${r.carriageId}`);
    }
    return out.join("\n") + "\nAkt va buyurtmalarni topshirish punktiga olib boring.";
  }
  const supply = await wbTodaySupply(env);
  if (!supply) return "Bugun yig'ilgan WB buyurtma yo'q. Avval \"📦 Yig'ish\" ni bosing.";
  const r = await wbHandover(env, supply);
  // Shu postavkadagi buyurtmalar
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ prefix: "order:wb:", cursor });
    for (const k of page.keys) {
      const raw = await env.STATE.get(k.name);
      if (raw && (JSON.parse(raw) as StoredOrder).supply === supply) ids.push(k.name.slice("order:wb:".length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await markHanded(env, "wb", ids, supply);
  if (r.qr) await sendDocument(env, chatId, r.qr, `wb-postavka-${supply}.png`, "image/png", `📦 WB postavka QR-kodi № ${supply}`);
  return `🚚 WB postavka № ${supply} (${ids.length} ta) yetkazishga topshirildi. QR-kodni qutiga yopishtirib, punktga olib boring.`;
}

/* ===================== Kartochka tugmalari (k:...) ===================== */

/** Kartochkadagi xabarni tahrirlash */
async function editCard(env: Env, chatId: number, messageId: number, text: string, kb: unknown) {
  try {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: kb });
  } catch (e) {
    if (!(e instanceof TgError && /not modified/i.test(e.description))) throw e;
  }
}

/**
 * Kartochka tugmasi bosilganda. Qaytaradi: foydalanuvchiga qisqa javob (answerCallbackQuery uchun).
 * action: acc | lbl | cx | cr | cy | back | hand | handy | act | qr | det | min
 */
export async function cardAction(
  env: Env,
  chatId: number,
  messageId: number,
  action: string,
  mp: Marketplace,
  id: string,
  extra = "",
): Promise<string> {
  let so = await loadOrder(env, mp, id);
  if (!so) {
    const { all } = await pendingOrders(env);
    const o = all.find((x) => x.mp === mp && x.id === id);
    if (!o) return "⚠️ Buyurtma topilmadi (eskirgan bo'lishi mumkin)";
    so = { order: o, chatMessages: [] };
  }
  // Bosilgan xabar ham kartochkalar ro'yxatida bo'lsin (keyingi yangilanishlar uchun)
  if (!so.chatMessages.some((c) => c.chatId === chatId && c.messageId === messageId)) {
    so.chatMessages.push({ chatId, messageId, widget: false });
    await saveOrder(env, so);
  }
  const show = (note = "", detail = false) => editCard(env, chatId, messageId, cardText(env, so!, detail, note), cardKeyboard(so!, detail));
  const st = stageOf(so);

  switch (action) {
    case "det":
      await show("", true);
      return "";
    case "min":
    case "back":
      await show();
      return "";

    case "acc": {
      if (st !== "new") {
        await show();
        return "Bu buyurtma allaqachon qabul qilingan";
      }
      try {
        await doAction(env, chatId, mp, id, "ship");
      } catch (e) {
        // Ehtimol mijoz bekor qilgan — holatni yangilaymiz
        if (mp === "ozon") {
          try {
            so.order = (await ozonGet(env, id)).order;
            await saveOrder(env, so);
          } catch {}
        }
        await show("⚠️ " + (e as Error).message.slice(0, 200));
        return "⚠️ Qabul qilib bo'lmadi";
      }
      so = (await loadOrder(env, mp, id)) ?? so;
      await show();
      try {
        await sendOneLabel(env, chatId, so.order);
      } catch (e) {
        await sendText(env, chatId, `🏷 Yorliq hali tayyor emas: ${escapeHtml((e as Error).message.slice(0, 150))}\nBirozdan keyin kartochkadagi «🏷» tugmasini bosing.`);
      }
      return "✅ Qabul qilindi";
    }

    case "lbl":
      await sendOneLabel(env, chatId, so.order);
      return "🏷 Yorliq yuborildi";

    case "cx":
      await editCard(
        env,
        chatId,
        messageId,
        cardText(env, so) + `\n\n<b>❓ Bekor qilasizmi?</b>` + (mp === "ozon" ? " Sababini tanlang:" : "") + `\n<i>Bekor qilish reytingga ta'sir qiladi va jarima bo'lishi mumkin.</i>`,
        cancelReasonKeyboard(so),
      );
      return "";
    case "cr":
      await editCard(env, chatId, messageId, cardText(env, so) + `\n\n<b>❗ Rostdan ham bekor qilaymi?</b> Buni qaytarib bo'lmaydi.`, cancelConfirmKeyboard(so, extra));
      return "";
    case "cy": {
      if (st !== "new" && st !== "packed") {
        await show();
        return "Bu buyurtmani endi bekor qilib bo'lmaydi";
      }
      if (mp === "ozon") await ozonCancel(env, id, Number(extra) || 352);
      else await wbCancel(env, id);
      so.cancelled = true;
      so.order.canShip = false;
      await saveOrder(env, so);
      await refreshCards(env, so);
      return "❌ Bekor qilindi";
    }

    case "hand": {
      let n = 1;
      if (mp === "ozon") {
        const { all } = await pendingOrders(env);
        n = all.filter((o) => o.mp === "ozon" && o.readyToHandover && o.deliveryMethodId === so!.order.deliveryMethodId).length || 1;
      }
      const what =
        mp === "ozon"
          ? `Ozon'da jo'natma yarataman: shu yetkazish usulidagi ${n} ta tayyor buyurtma birga qo'shiladi va akt chiqadi.`
          : `Bugungi WB postavkasini yopib, yetkazishga topshiraman. Shundan keyin unga yangi buyurtma qo'shib bo'lmaydi.`;
      await editCard(env, chatId, messageId, cardText(env, so) + `\n\n<b>❓ ${what}</b>\nDavom etaymi?`, handConfirmKeyboard(so));
      return "";
    }
    case "handy": {
      const note = await bulkHandover(env, chatId, mp);
      so = (await loadOrder(env, mp, id)) ?? so;
      await show(note);
      return "🚚 Tayyor";
    }

    case "act": {
      const ref = so.handed ?? (await env.STATE.get(`handed:ozon:${id}`));
      if (!ref) return "Jo'natma topilmadi";
      const pdf = await ozonActPdf(env, Number(ref));
      await sendDocument(env, chatId, pdf, `ozon-akt-${ref}.pdf`, "application/pdf", `📄 Ozon topshirish akti № ${ref}`);
      return "📄 Akt yuborildi";
    }
    case "qr": {
      const ref = so.handed ?? so.supply;
      if (!ref) return "Postavka topilmadi";
      const png = await wbSupplyQr(env, ref);
      await sendDocument(env, chatId, png, `wb-postavka-${ref}.png`, "image/png", `📦 WB postavka QR-kodi № ${ref}`);
      return "📦 QR yuborildi";
    }
  }
  return "Noma'lum amal";
}
