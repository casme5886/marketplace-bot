import { bt, getLang, hasLang, LANG_NAME, LANGS, setLang, type Lang } from "./i18n";
import type { Env, Marketplace } from "./types";
import { allowedPhones, decideRequest, disallowPhone, fmtPhone, handleContact, normPhone, sendWelcome, allowPhone } from "./phonelogin";
import { getOwner, handleLoginInput, isAuthorized, isOwner, logout, rememberUser, safeEqual, setOwner, startLogin, userName } from "./auth";
import { escapeHtml, sendText, tg } from "./telegram";
import { wbTodaySupply } from "./wb";
import { REPORT_KEYBOARD, cardAction, bulkHandover, bulkLabels, bulkShip, makeLabel, dailyReport, dashStats, doAction, loadOrder, pendingOrders, pendingSummary, pollAll, sendDailyReport, sendOrderCards } from "./orders";
import { getSelMonths, lostDetail, lostScreen, monthPicker, runLostSearch, toggleMonth } from "./lost";
import { checkStock, checkUzumNewFbs, confirmFromNotice } from "./uzumalerts";
import { bookCenter } from "./bookcenter";
import * as CL from "./clients";
import { isWebPath } from "./webapp";
import { onPaid, onPreCheckout } from "./payments";
import { sendFbsLabels, activeWatchRows, fbsWatchDistrictPick, fbsWatchPointsPick, fbsWatchHalf, supplyRegionsRefresh, fbsWatchDistrictsScreen, fbsWatchAsk, fbsWatchAdd, fbsWatchStatus, fbsWatchStop, fbsWatchToggle, supplyDistrictsScreen, supplyRegionsScreen, supplyConfirmScreen, supplyCreate, supplyPointsScreen, supplySelectScreen, supplySlotsScreen, cancelAskScreen, cancelConfirmScreen, cancelDo, cancelReasonScreen, fbsConfirmAll, fbsConfirmAllAsk, fbsConfirmOne, dbsScreen, fbsAccount, fbsInvoices, fbsOrders, fbsRoot, uzumHome } from "./uzumfbs";
import { threeDayScreen, dayScreen, addDaysWatch, fboPlanScreen, addPlanWatch, toggleWatchAuto, sessionsScreen, securityScreen, revealText, purgeSecretMessages, searchConfirmScreen, searchStatusScreen, stopSearch, profilesScreen, removeConfirmScreen, rootScreen, addWatch, checkWatches, confirmScreen, datesScreen, halfScreen, invoicesScreen, kindScreen, removeWatch, reserve, shopsScreen, timesScreen, watchesScreen } from "./uzumui";
import { uzumRevealCredentials, uzumAccounts, uzumAllAccounts, uzumAddAccount, uzumEnabled, uzumRemoveAccount, type UzKind } from "./uzum";
import { getStats, PERIODS, returnsScreen, soldScreen, statsScreen, todayLines, topScreen, type PeriodKey } from "./stats";
import { BUTTON_COMMANDS, REPLY_KEYBOARD, showLabel, confirmSendScreen, confirmShipScreen, homeScreen, mpChoiceScreen, orderScreen, ordersScreen, showScreen, textScreen } from "./menu";

/** Hamma akkauntlar uchun: bitta tugma — boshlash va qotib qolsa qayta yuklash */
const COMMANDS = [{ command: "start", description: "🔄 Boshlash / qayta ishga tushirish (qotib qolsa)" }];
/** Faqat asosiy admin chatida ko'rinadigan buyruqlar */
const ADMIN_COMMANDS = [
  { command: "start", description: "🏠 Boshlash / bosh menyu" },
  { command: "restart", description: "🔄 Botni qayta ishga tushirish (qotib qolsa)" },
  { command: "security", description: "🛡 Xavfsizlik: Uzum login va parollar" },
];

/** "Menyu" ro'yxati: hammaga start/restart, asosiy adminga + 🛡 Xavfsizlik */
export async function syncCommands(env: Env) {
  await tg(env, "setMyCommands", { commands: COMMANDS }).catch(() => {});
  const owner = await getOwner(env);
  if (owner) await tg(env, "setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: owner } }).catch((e) => console.log("admin commands:", e.message));
}
export { COMMANDS };

export { BotDO } from "./do";

/** Cloudflare: barcha so'rovlar bitta Durable Object'ga ("main") uzatiladi */
const botStub = (env: Env) => env.BOT!.get(env.BOT!.idFromName("main"));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!env.BOT) return new Response("BOT (Durable Object) ulanmagan — wrangler.toml ni tekshiring", { status: 500 });

    // 📱 Mini App sahifasi va API — ma'lumotlar Durable Object'da
    if (isWebPath(url.pathname)) {
      return botStub(env).fetch(
        new Request(`https://bot${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === "POST" ? await req.text() : undefined }),
      );
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      return botStub(env).fetch(new Request("https://bot/webhook", { method: "POST", body: await req.text() }));
    }
    // Bir martalik sozlash va ma'lumot ko'chirish: ?key=SETUP_KEY
    if (url.pathname === "/setup" || url.pathname === "/import") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) return new Response("Forbidden", { status: 403 });
      return botStub(env).fetch(
        new Request(`https://bot${url.pathname}`, { method: req.method, headers: { "x-origin": url.origin }, body: req.method === "POST" ? await req.text() : undefined }),
      );
    }
    return botStub(env).fetch(new Request("https://bot/"));
  },

  // Har daqiqada: Durable Object uyg'oqligini tekshiradi (asosiy ish uning 10 soniyalik alarm'ida)
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (env.BOT) ctx.waitUntil(botStub(env).fetch(new Request("https://bot/tick")).then(() => undefined));
  },
};

export async function handleUpdate(env: Env, u: any) {
  // 💳 Telegram Payments (Click/Payme)
  if (u.pre_checkout_query) return onPreCheckout(env, u.pre_checkout_query);
  if (u.message?.successful_payment) return onPaid(env, u.message);
  if (u.message) return handleMessage(env, u.message);
  if (u.callback_query) return handleCallback(env, u.callback_query);
  if (u.widget_query) return handleWidgetQuery(env, u.widget_query);
}

/**
 * 📱 Ilova rejimi (Mini App manzili o'rnatilgan): bot menyulari o'rniga bitta xabar — «Ilovani ochish».
 * Bot faqat bildirishnomalar yuboradi. Zaxira: /menu — eski bot menyusi (xodimlar uchun).
 */
async function appHome(env: Env, chatId: number): Promise<boolean> {
  const url = await env.STATE.get("app:url");
  if (!url) return false;
  const prev = Number(await env.STATE.get(`apph:${chatId}`));
  if (prev) await tg(env, "deleteMessage", { chat_id: chatId, message_id: prev }).catch(() => {});
  const lang = await getLang(env, chatId);
  const r = await sendText(env, chatId, bt(lang, "home"), { reply_markup: { inline_keyboard: [[{ text: bt(lang, "openApp"), web_app: { url } } as any]] } });
  await env.STATE.put(`apph:${chatId}`, String(r.message_id));
  return true;
}

/* ---------- 🌐 /start: til → raqam → ilova ---------- */
const phoneKb = (lang: Lang) => ({ keyboard: [[{ text: bt(lang, "phoneBtn"), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
async function askLang(env: Env, chatId: number) {
  return sendText(env, chatId, bt("uz", "pick"), {
    reply_markup: { inline_keyboard: [LANGS.map((l) => ({ text: LANG_NAME[l], callback_data: `lang:${l}` }))] },
  });
}
async function needPhone(env: Env, uid: number) {
  if (await isAuthorized(env, uid)) return false;
  return !(await env.STATE.get(`phone:${uid}`));
}
async function askPhone(env: Env, chatId: number, uid: number) {
  const lang = await getLang(env, uid);
  await env.STATE.put(`regphone:${uid}`, "1", { expirationTtl: 86400 });
  return sendText(env, chatId, bt(lang, "askPhone"), { reply_markup: phoneKb(lang) });
}
/** /start asosiy oqimi (til va raqam tayyor bo'lgach) */
async function startFlow(env: Env, chatId: number, userId: number) {
  if (await isAuthorized(env, userId)) {
    for (const k of [`uzlogin:${chatId}`, `secpw:${chatId}`, `phadd:${chatId}`, `fbscx:${chatId}`]) await env.STATE.delete(k);
    if (await appHome(env, chatId)) return;
    return showMenu(env, chatId);
  }
  await env.STATE.delete(`clwait:${chatId}`);
  await sendText(env, chatId, "👋", { reply_markup: { remove_keyboard: true } })
    .then((r) => tg(env, "deleteMessage", { chat_id: chatId, message_id: r.message_id }).catch(() => {}))
    .catch(() => {});
  // Ilova rejimida — hamma (yangi mijoz ham) ilovaga: do'kon ulash qo'llanmaning o'zida
  if (await appHome(env, chatId)) return;
  return showScreen(env, chatId, null, await CL.clientHome(env, userId));
}
async function onLangPick(env: Env, q: any) {
  const uid: number = q.from.id;
  const chatId: number = q.message.chat.id;
  const first = !(await hasLang(env, uid));
  const lang = await setLang(env, uid, String(q.data).split(":")[1]);
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: bt(lang, "langSet") }).catch(() => {});
  await tg(env, "deleteMessage", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
  if (!first) return appHome(env, chatId);
  if (await needPhone(env, uid)) return askPhone(env, chatId, uid);
  return startFlow(env, chatId, uid);
}

async function showMenu(env: Env, chatId: number, messageId: number | null = null) {
  // Oldin yuborilgan pastki klaviaturani bir marta olib tashlaymiz
  if (!(await env.STATE.get(`kbrm:${chatId}`))) {
    await env.STATE.put(`kbrm:${chatId}`, "1");
    await sendText(env, chatId, "⌨️", { reply_markup: { remove_keyboard: true } })
      .then((r) => tg(env, "deleteMessage", { chat_id: chatId, message_id: r.message_id }).catch(() => {}))
      .catch(() => {});
  }
  const [d, today] = await Promise.all([
    dashStats(env),
    getStats(env, "td").then(todayLines).catch((e) => {
      console.log("today stats:", (e as Error).message);
      return [] as string[];
    }),
  ]);
  const sc = homeScreen(env, d, today);
  // Faol FBS avto bron / FBO kuzatuv bo'lsa — «Uzum Market» tugmasi ustida ko'rinadi
  const extra = await activeWatchRows(env).catch(() => []);
  if (extra.length) {
    const kb = sc.reply_markup.inline_keyboard as any[];
    const ui = kb.findIndex((r) => r.some((b: any) => b.callback_data === "u:sh"));
    kb.splice(ui < 0 ? kb.length - 1 : ui, 0, ...extra);
  }
  await showScreen(env, chatId, messageId, sc);
}

/** Uzum loginini solishtirish uchun bir xil ko'rinishga keltirish */
const acc_login = (s: string) => {
  const t = s.trim();
  if (/[a-z@]/i.test(t)) return t;
  const d = t.replace(/[^\d]/g, "");
  return d.length === 9 ? "998" + d : d;
};

/** Uzum FBO ekranlari */
async function showUzum(env: Env, chatId: number, messageId: number | null, p: string[]) {
  const act = p[1];
  if (act === "lg") {
    // Profil qo'shish yoki parolini yangilash: 1) login 2) parol — chatga yoziladi
    const existing = p[2] ? (await uzumAllAccounts(env)).find((a) => a.id === p[2]) : undefined;
    await env.STATE.delete(`secpw:${chatId}`);
    const pid = messageId ?? (await showScreen(env, chatId, null, textScreen("⏳")));
    if (existing) {
      await env.STATE.put(`uzlogin:${chatId}`, JSON.stringify({ step: "pass", login: existing.login, acc: existing.id, pid }), { expirationTtl: 600 });
      return showScreen(env, chatId, pid, {
        text: `🔑 <b>${escapeHtml(existing.label)}</b> profili uchun <b>parol</b>ni yozing.\n<i>Xabaringiz darhol o'chiriladi.</i>`,
        reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "u:lgx" }]] },
      });
    }
    await env.STATE.put(`uzlogin:${chatId}`, JSON.stringify({ step: "login", pid }), { expirationTtl: 600 });
    return showScreen(env, chatId, pid, {
      text: "🔐 <b>Uzum profilini qo'shish</b>\n\n1️⃣ Uzum Seller kabinetiga kiradigan <b>telefon raqam</b> (998901234567) yoki <b>email</b>ni yozing:",
      reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "u:lgx" }]] },
    });
  }
  if (act === "am" || act === "lo") return showScreen(env, chatId, messageId, await profilesScreen(env, chatId));
  if (act === "sec") {
    // Faqat asosiy admin; boshqalarga bu bo'lim umuman ko'rinmaydi
    if (!(await isOwner(env, chatId))) return showUzum(env, chatId, messageId, ["u", "sh"]);
    return showScreen(env, chatId, messageId, await securityScreen(env, chatId));
  }
  const ownerOnly = async () => {
    if (await isOwner(env, chatId)) return false;
    const o = await getOwner(env);
    await showScreen(env, chatId, messageId, {
      text: o ? "🚫 Bu amal sizning akkauntingizda mavjud emas." : "🚫 Asosiy admin hali belgilanmagan.",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menyu", callback_data: "m:home" }]] },
    });
    return true;
  };
  if (act === "own") {
    if (await getOwner(env)) return showScreen(env, chatId, messageId, await securityScreen(env, chatId));
    await env.STATE.delete(`uzlogin:${chatId}`);
    await env.STATE.put(`secpw:${chatId}`, JSON.stringify({ pid: messageId, purpose: "own" }), { expirationTtl: 120 });
    return showScreen(env, chatId, messageId, {
      text: "👑 Bu akkauntni <b>asosiy admin</b> qilish uchun <b>bot parolingizni</b> yozing.\n<i>Shundan keyin Uzum login va parollari faqat shu akkauntda ko'rinadi. Xabaringiz darhol o'chiriladi.</i>",
      reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "u:secx" }]] },
    });
  }
  if (act === "ph" || act === "phx" || act === "pha") {
    if (await ownerOnly()) return;
    if (act === "phx") await disallowPhone(env, p[2]);
    if (act === "pha") {
      await env.STATE.put(`phadd:${chatId}`, String(messageId ?? 0), { expirationTtl: 300 });
      return showScreen(env, chatId, messageId, {
        text: "📞 Ruxsat beriladigan <b>telefon raqam</b>ni yozing (masalan 901234567).",
        reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "u:ph" }]] },
      });
    }
    await env.STATE.delete(`phadd:${chatId}`);
    const list = await allowedPhones(env);
    const rows = list.map((ph) => [{ text: `🗑 ${fmtPhone(ph)}`, callback_data: `u:phx:${ph}` }]);
    rows.push([{ text: "➕ Raqam qo'shish", callback_data: "u:pha" }]);
    rows.push([{ text: "⬅️ Orqaga", callback_data: "u:sec" }, { text: "🏠", callback_data: "m:home" }]);
    return showScreen(env, chatId, messageId, {
      text:
        "<b>📞 Telefon orqali kirish</b>\n\nBu raqamlar <b>📱 Telefon raqamni ulashish</b> tugmasi bilan botga darhol kiradi. Ro'yxatda yo'q raqam ulashilsa — sizga ruxsat so'rovi keladi.\n\n" +
        (list.length ? list.map((x) => `✅ ${fmtPhone(x)}`).join("\n") : "Ro'yxat bo'sh.") +
        "\n\n<i>🗑 — raqamni o'chirish (shu raqam bilan kirganlar ham chiqariladi)</i>",
      reply_markup: { inline_keyboard: rows },
    });
  }
  if (act === "ses") {
    if (await ownerOnly()) return;
    return showScreen(env, chatId, messageId, await sessionsScreen(env, chatId));
  }
  if (act === "sx") {
    if (await ownerOnly()) return;
    const uid = Number(p[2]);
    if (uid && uid !== chatId) await revokeStaff(env, uid);
    return showScreen(env, chatId, messageId, await sessionsScreen(env, chatId));
  }
  if (act === "secv") {
    if (await ownerOnly()) return;
    const lock = Number((await env.STATE.get(`seclock:${chatId}`)) ?? 0);
    if (lock > Date.now()) {
      return showScreen(env, chatId, messageId, textScreen(`⛔ Ko'p marta noto'g'ri parol. ${Math.ceil((lock - Date.now()) / 60000)} daqiqadan keyin urinib ko'ring.`));
    }
    await env.STATE.delete(`uzlogin:${chatId}`);
    await env.STATE.put(`secpw:${chatId}`, JSON.stringify({ pid: messageId, purpose: "reveal" }), { expirationTtl: 120 });
    return showScreen(env, chatId, messageId, {
      text: "🔒 Tasdiqlash uchun <b>bot parolingizni</b> yozing (botga kirishda ishlatadigan parol).\n<i>Xabaringiz darhol o'chiriladi.</i>",
      reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "u:secx" }]] },
    });
  }
  if (act === "secdel") {
    // Maxfiy xabar o'rnida bosh menyu ochiladi
    const page = await env.STATE.list({ prefix: `autodel:${chatId}:${messageId}:` });
    for (const k of page.keys) await env.STATE.delete(k.name);
    return showMenu(env, chatId, messageId);
  }
  if (act === "secx") {
    await env.STATE.delete(`secpw:${chatId}`);
    return showScreen(env, chatId, messageId, await securityScreen(env, chatId));
  }
  if ((act === "ar" || act === "ary") && (await ownerOnly())) return;
  if (act === "ar") return showScreen(env, chatId, messageId, await removeConfirmScreen(env, p[2]));
  if (act === "ary") {
    await uzumRemoveAccount(env, p[2]);
    const wl = await env.STATE.list({ prefix: "uwatch:" });
    for (const k of wl.keys) {
      const w = JSON.parse((await env.STATE.get(k.name)) ?? "{}");
      if (w.acc === p[2]) await env.STATE.delete(k.name);
    }
    return showScreen(env, chatId, messageId, await profilesScreen(env, chatId));
  }
  if (act === "lgx") {
    await env.STATE.delete(`uzlogin:${chatId}`);
    return showUzum(env, chatId, messageId, ["u", "sh"]);
  }
  if (!(await uzumEnabled(env))) {
    return showScreen(env, chatId, messageId, {
      text: "📦 <b>Uzum ulanmagan</b>\n\nNakladnoylarni ko'rish va vaqt tanlash uchun Uzum Seller profilingizni qo'shing. Login va parolni shu chatga yozasiz — parol xabari darhol o'chiriladi, parol esa shifrlangan holda eslab qolinadi. Bir nechta profil qo'shish mumkin.",
      reply_markup: { inline_keyboard: [[{ text: "➕ Uzum profilini qo'shish", callback_data: "u:lg" }], [{ text: "🏠 Menyu", callback_data: "m:home" }]] },
    });
  }
  // u:s:{shop} | u:k:{k}:{shop} | u:{i|d|h|t|ty|w}:{k}:{shop}:{inv}:{c}:{d}
  const kind = (["f", "r", "s"].includes(p[2]) ? p[2] : "f") as UzKind;
  const shop = Number(p[3]), inv = Number(p[4]), c = p[5], d = p[6];
  let sc;
  try {
    switch (act) {
      case "s": sc = await kindScreen(env, Number(p[2])); break;
      case "fbo": sc = await rootScreen(env, chatId); break;
      case "fbs": sc = await fbsRoot(env); break;
      case "fa": sc = await fbsAccount(env, p[2]); break;
      case "fs": sc = await fbsOrders(env, p[2], p[3], Number(p[4]) || 0); break;
      case "fi": sc = await fbsInvoices(env, p[2], Number(p[3]) || 0); break;
      case "dbs": sc = dbsScreen(); break;
      case "lost": sc = await monthPicker(env, chatId); break;
      case "lostr": sc = (await lostScreen(env, await getSelMonths(env, chatId))) ?? (await monthPicker(env, chatId)); break;
      case "lm":
        await toggleMonth(env, chatId, p[2]);
        sc = await monthPicker(env, chatId);
        break;
      case "lostf": {
        const months = await getSelMonths(env, chatId);
        if (!months.length) {
          sc = await monthPicker(env, chatId);
          break;
        }
        // Fon rejimida qidiruv — xabar jonli yangilanadi (🔍/🔎 qimirlaydi)
        const mid = messageId ?? (await showScreen(env, chatId, null, textScreen("🔍")));
        runLostSearch(env, chatId, mid, months).catch((e) => console.log("lost search:", (e as Error).message));
        return;
      }
      case "lsd": sc = await lostDetail(env, p[2], Number(p[3]), Number(p[4]), p[5] === "ru" ? "ru" : p[5] === "uz" ? "uz" : "v"); break;
      case "fc": sc = await fbsConfirmOne(env, p[2], Number(p[3])); break;
      case "fx":
        await env.STATE.delete(`uzlogin:${chatId}`);
        await env.STATE.delete(`secpw:${chatId}`);
        await env.STATE.put(`fbscx:${chatId}`, JSON.stringify({ acc: p[2], pid: messageId }), { expirationTtl: 600 });
        sc = await cancelAskScreen(env, p[2]);
        break;
      case "fxo":
        await env.STATE.delete(`fbscx:${chatId}`);
        sc = await cancelReasonScreen(env, p[2], p[3]);
        break;
      case "fxr": sc = cancelConfirmScreen(p[2], Number(p[3]), p[4]); break;
      case "fxy": sc = await cancelDo(env, p[2], Number(p[3]), p[4]); break;
      case "ft": sc = await supplySelectScreen(env, p[2], "init"); break;
      case "ftk": sc = await supplySelectScreen(env, p[2], "keep"); break;
      case "ftt": sc = await supplySelectScreen(env, p[2], Number(p[3])); break;
      case "fta": sc = await supplySelectScreen(env, p[2], p[3] === "1" ? "all" : "none"); break;
      case "ftp": sc = await supplyRegionsRefresh(env, p[2]); break;
      case "fwR": sc = await supplyRegionsScreen(env, p[2], true); break;
      case "ftg": sc = await supplyRegionsScreen(env, p[2]); break;
      case "ftG": sc = await supplyRegionsRefresh(env, p[2]); break;
      case "ftr": sc = await supplyDistrictsScreen(env, p[2], Number(p[3]) || 0); break;
      case "ftq": sc = await supplyPointsScreen(env, p[2], Number(p[3]) || 0, Number(p[4]) || 0, Number(p[5]) || 0); break;
      case "ftd": sc = await supplySlotsScreen(env, p[2], Number(p[3]) || 0); break;
      case "fts": sc = await supplyConfirmScreen(env, p[2], Number(p[3]), Number(p[4])); break;
      case "fty": sc = await supplyCreate(env, p[2], Number(p[3]), Number(p[4])); break;
      case "fwa": sc = await fbsWatchAsk(env, p[2], (["m", "s"].includes(p[5]) ? p[5] : "d") as "d", Number(p[3]) || 0, Number(p[4]) || 0); break;
      case "fwn": sc = await fbsWatchDistrictPick(env, p[2], Number(p[3]) || 0); break;
      case "fwo": sc = await fbsWatchPointsPick(env, p[2], Number(p[3]) || 0, Number(p[4]) || 0, p[5] ?? "x"); break;
      case "fwm": sc = await fbsWatchDistrictsScreen(env, p[2], Number(p[3]) || 0, p[4] ?? "x"); break;
      case "fwp": sc = await fbsWatchAsk(env, p[2], "p", Number(p[3]) || 0, 0); break;
      case "fwa2": sc = await fbsWatchAsk(env, p[2], (["p", "m", "s"].includes(p[3]) ? p[3] : "d") as "d", Number(p[4]) || 0, Number(p[5]) || 0); break;
      case "fwd": sc = await fbsWatchHalf(env, p[2], (["p", "m", "s"].includes(p[3]) ? p[3] : "d") as "d", Number(p[4]) || 0, Number(p[5]) || 0, p[6] === "0" ? "" : p[6]); break;
      case "fwh": sc = await fbsWatchHalf(env, p[2], (["p", "m", "s"].includes(p[3]) ? p[3] : "d") as "d", Number(p[4]) || 0, Number(p[5]) || 0, p[6] === "0" ? "" : p[6], p[7] ?? "x"); break;
      case "fwy": sc = await fbsWatchAdd(env, chatId, p[2], (["p", "m", "s"].includes(p[3]) ? p[3] : "d") as "d", Number(p[4]) || 0, Number(p[5]) || 0, p[8] === "1", p[6] === "0" ? "" : p[6], p[7] || "x"); break;
      case "fws": sc = await fbsWatchStatus(env, p[2]); break;
      case "fwt": sc = await fbsWatchToggle(env, p[2]); break;
      case "fwq": sc = await fbsWatchStop(env, p[2]); break;
      case "bm": sc = await bookCenter(env); break;
      case "fcn": sc = await confirmFromNotice(env, p[2], Number(p[3])); break;
      case "flb":
      case "flp":
      case "flo": {
        const note = await sendFbsLabels(env, chatId, p[2], act === "flb" ? "inv" : act === "flp" ? "pck" : "ord", Number(p[3]) || 0);
        await sendText(env, chatId, note).catch(() => {});
        return;
      }
      case "fbp": sc = await fboPlanScreen(env, kind, shop, inv, p[5] ?? "x"); break;
      case "fbz": sc = await addPlanWatch(env, chatId, kind, shop, inv, p[5] === "1"); break;
      case "wt": sc = await toggleWatchAuto(env, kind, shop, inv); break;
      case "fca": sc = await fbsConfirmAllAsk(env, p[2]); break;
      case "fcy": sc = await fbsConfirmAll(env, p[2]); break;
      case "ac": sc = await shopsScreen(env, p[2], true, chatId); break;
      case "k": sc = await invoicesScreen(env, kind, shop); break;
      case "i": sc = await datesScreen(env, kind, shop, inv, Number(c) || 0); break;
      case "d": sc = await dayScreen(env, kind, shop, inv, c); break;
      case "wd": sc = await addDaysWatch(env, chatId, kind, shop, inv, String(c).split("-").filter(Boolean), [], d === "1"); break;
      case "w3": sc = await threeDayScreen(env, kind, shop, inv); break;
      case "h": sc = await timesScreen(env, kind, shop, inv, c, d === "a" ? "a" : "p"); break;
      case "t": sc = await confirmScreen(env, kind, shop, inv, Number(c), Number(d)); break;
      case "ty": sc = await reserve(env, kind, shop, inv, Number(c), Number(d)); break;
      case "w": sc = await addWatch(env, chatId, kind, shop, inv, c, d === "a" ? "a" : "p", p[7] === "1"); break;
      case "wc": sc = await searchConfirmScreen(env, kind, shop, inv, c, d === "a" ? "a" : "p"); break;
      case "ws": sc = await searchStatusScreen(env, kind, shop, inv); break;
      case "wq": sc = await stopSearch(env, kind, shop, inv); break;
      case "wl": sc = await watchesScreen(env); break;
      case "wx": sc = await removeWatch(env, p.slice(2).join(":")); break;
      default: sc = await uzumHome(env);
    }
  } catch (e) {
    sc = textScreen(`⚠️ Uzum: ${escapeHtml((e as Error).message.slice(0, 300))}`);
    sc.reply_markup.inline_keyboard.unshift([{ text: "🔄 Qayta urinish", callback_data: p.join(":") }]);
    if (/sessiya|profil|401/i.test((e as Error).message)) sc.reply_markup.inline_keyboard.unshift([{ text: "⚙️ Profillar", callback_data: "u:am" }]);
  }
  await showScreen(env, chatId, messageId, sc);
}

const asPeriod = (x?: string): PeriodKey => (PERIODS.includes(x as PeriodKey) ? (x as PeriodKey) : "td");

/** Statistika ekranlari: s (umumiy), so (buyurtmalar), sr (qaytarishlar), st (top mahsulot), sc (shaharlar) */
async function showStats(env: Env, chatId: number, messageId: number | null, kind: string, p: PeriodKey, page = 0, force = false) {
  const s = await getStats(env, p, force);
  const sc =
    kind === "so" ? soldScreen(env, p, page, s)
    : kind === "sr" ? returnsScreen(env, p, page, s)
    : kind === "st" || kind === "sc" ? topScreen(env, p, kind, s)
    : statsScreen(env, p, s);
  await showScreen(env, chatId, messageId, sc);
}

/** Buyurtmalar: avval marketpleysni tanlash */
async function showOrders(env: Env, chatId: number, messageId: number | null = null) {
  const { all, errs } = await pendingOrders(env);
  await showScreen(env, chatId, messageId, mpChoiceScreen(env, all, errs));
}

/** Yorliq ko'ruvchi: shu xabarni hujjatga aylantirib, buyurtmalar bo'yicha varaqlash */
async function openLabels(env: Env, chatId: number, messageId: number, isDoc: boolean, mp: Marketplace, i: number) {
  let ids: string[] | null = null;
  if (isDoc) {
    const raw = await env.STATE.get(`lv:${chatId}:${messageId}`);
    ids = raw ? JSON.parse(raw) : null;
  }
  const { all } = await pendingOrders(env);
  const list = all.filter((o) => o.mp === mp);
  if (!ids) ids = list.map((o) => o.id);
  if (!ids.length) return showScreen(env, chatId, isDoc ? null : messageId, textScreen("Yorliq uchun buyurtma yo'q."));
  const byId = new Map(list.map((o) => [o.id, o]));
  const idx = ((i % ids.length) + ids.length) % ids.length;
  await showLabel(env, chatId, messageId, isDoc, mp, ids, idx, async (id) => {
    const o = byId.get(id) ?? (await loadOrder(env, mp, id))?.order;
    if (!o) throw new Error("Buyurtma topilmadi: " + id);
    return makeLabel(env, o);
  });
}

/** Tanlangan marketpleys buyurtmalari */
async function showMpOrders(env: Env, chatId: number, messageId: number | null, mp: Marketplace, note = "") {
  const { all, errs } = await pendingOrders(env);
  const sc = ordersScreen(env, mp, all, errs, mp === "wb" ? Boolean(await wbTodaySupply(env)) : false);
  if (note) sc.text += `\n\n<i>${escapeHtml(note)}</i>`;
  await showScreen(env, chatId, messageId, sc);
}

async function showOrder(env: Env, chatId: number, messageId: number | null, mp: Marketplace, id: string, note = "") {
  const { all } = await pendingOrders(env);
  const o = all.find((x) => x.mp === mp && x.id === id) ?? (await loadOrder(env, mp, id))?.order;
  if (!o) return showScreen(env, chatId, messageId, textScreen("⚠️ Buyurtma topilmadi yoki allaqachon topshirilgan."));
  await showScreen(env, chatId, messageId, orderScreen(env, o, note));
}

async function runCommand(env: Env, chatId: number, userId: number, cmd: string) {
  switch (cmd) {
    case "/start":
      if (await appHome(env, chatId)) return;
      return showMenu(env, chatId);
    case "/menu":
      return showMenu(env, chatId);
    case "/security": {
      if (!(await isOwner(env, chatId))) return showMenu(env, chatId);
      return showScreen(env, chatId, null, await securityScreen(env, chatId));
    }
    case "/restart": {
      // Osilib qolgan jarayonlarni tozalash: Uzum login, keshlar
      await env.STATE.delete(`uzlogin:${chatId}`);
      const caches = await env.STATE.list({ prefix: "uzum:shops:" });
      for (const k of caches.keys) await env.STATE.delete(k.name);
      for (const k of (await env.STATE.list({ prefix: "stat:" })).keys) await env.STATE.delete(k.name);
      const note = await sendText(env, chatId, env.RESTART ? "🔄 Bot qayta ishga tushirilmoqda... 5–10 soniyadan keyin menyu chiqadi." : "🔄 Bot tozalandi va qayta yuklandi.");
      if (env.RESTART) {
        // Qayta ishga tushgach bu xabar o'chiriladi
        await env.STATE.put("restart:chat", JSON.stringify({ chat: chatId, msg: note.message_id }), { expirationTtl: 300 });
        await env.RESTART();
        return;
      }
      await showMenu(env, chatId);
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: note.message_id }).catch(() => {});
      return;
    }
    case "/orders":
      return showOrders(env, chatId);
    case "/uzum":
      return showUzum(env, chatId, null, ["u", "sh"]);
    case "/stats":
      return showStats(env, chatId, null, "s", "td");
    case "/sales":
      return showStats(env, chatId, null, "so", "td");
    case "/returns":
      return showStats(env, chatId, null, "sr", "7d");
    case "/widget": {
      // Vidjet sinovi: ishlasa — kartochka chiqadi, ishlamasa — xato sababi yoziladi
      try {
        await tg(env, "sendWidget", {
          chat_id: chatId,
          html: '<!doctype html><html><body style="font:16px system-ui;padding:16px;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)"><b>✅ Vidjet ishlayapti!</b><p>Bu xabar ichidagi interaktiv vidjet (Bot API 10.4).</p></body></html>',
          caption: "🧪 Vidjet sinovi",
        });
        return sendText(env, chatId, "✅ Telegram vidjetni qabul qildi. Yuqorida kartochka ko'rinyaptimi?");
      } catch (e) {
        return sendText(env, chatId, `❌ Vidjet yuborilmadi.\nSabab: <code>${escapeHtml((e as Error).message)}</code>`);
      }
    }
    case "/cards":
      return sendOrderCards(env, chatId);
    case "/list":
      return sendText(env, chatId, await pendingSummary(env));
    case "/report":
      return sendText(env, chatId, await dailyReport(env), { reply_markup: REPORT_KEYBOARD });
    case "/check": {
      const r = await pollAll(env);
      return sendText(
        env,
        chatId,
        `🔄 Tekshirildi. Yangi buyurtmalar: <b>${r.newCount}</b>` + (r.errors.length ? `\n⚠️ ${r.errors.join("\n⚠️ ")}` : ""),
      );
    }
    case "/logout":
      await logout(env, userId);
      return sendText(env, chatId, "👋 Chiqdingiz. Qayta kirish: /login", { reply_markup: { remove_keyboard: true } }).then((r) => trackTmp(env, chatId, r?.message_id));
    default:
      return showMenu(env, chatId);
  }
}

async function handleMessage(env: Env, m: any) {
  const chatId: number = m.chat.id;
  const userId: number = m.from?.id;
  const text: string = (m.text ?? "").trim();
  if (m.chat.type !== "private" || !userId) return; // faqat shaxsiy chat

  // 📱 Telefon raqam ulashildi
  if (m.contact) {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});
    // 📝 Ro'yxatdan o'tish (/start → til → raqam)
    if (await env.STATE.get(`regphone:${userId}`)) {
      const lang = await getLang(env, userId);
      if (Number(m.contact.user_id) !== userId) return sendText(env, chatId, bt(lang, "ownPhone"), { reply_markup: phoneKb(lang) });
      await env.STATE.delete(`regphone:${userId}`);
      await env.STATE.put(`phone:${userId}`, normPhone(m.contact.phone_number ?? ""));
      await rememberUser(env, m.from).catch(() => {});
      await sendText(env, chatId, bt(lang, "regOk"), { reply_markup: { remove_keyboard: true } }).catch(() => {});
      return startFlow(env, chatId, userId);
    }
    // 📱 Ilova (Profil) so'ragan raqam — faqat saqlaymiz, xodim so'rovi yuborilmaydi
    if (await env.STATE.get(`appphone:${userId}`)) {
      await env.STATE.delete(`appphone:${userId}`);
      if (Number(m.contact.user_id) === userId) await env.STATE.put(`phone:${userId}`, normPhone(m.contact.phone_number ?? ""));
      return;
    }
    if (await isAuthorized(env, userId)) return showMenu(env, chatId);
    const r = await handleContact(env, m);
    if (r === "ok") {
      await sendText(env, chatId, "✅ Xush kelibsiz! Raqamingiz tasdiqlandi.", { reply_markup: REPLY_KEYBOARD });
      return showMenu(env, chatId);
    }
    return;
  }

  if (text === "/login" || text === "/start") {
    // /start va /login xabari hamda eski vaqtinchalik xabarlar (masalan «Chiqdingiz») chatdan o'chiriladi
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});
    await purgeTmp(env, chatId);
    if (text === "/start") {
      if (!(await hasLang(env, userId))) return askLang(env, chatId);
      if (await needPhone(env, userId)) return askPhone(env, chatId, userId);
      return startFlow(env, chatId, userId);
    }
    if (await isAuthorized(env, userId)) {
      // Qotib qolgan holatlarni tozalaymiz (yarim qolgan kiritishlar) va yangi menyu
      for (const k of [`uzlogin:${chatId}`, `secpw:${chatId}`, `phadd:${chatId}`, `fbscx:${chatId}`]) await env.STATE.delete(k);
      await sendText(env, chatId, "🔄 Bot yangilandi.", { reply_markup: REPLY_KEYBOARD }).then((r) => tg(env, "deleteMessage", { chat_id: chatId, message_id: r.message_id }).catch(() => {})).catch(() => {});
      return showMenu(env, chatId);
    }
    return sendText(env, chatId, await startLogin(env, userId), { reply_markup: { remove_keyboard: true } }).then((r) => trackTmp(env, chatId, r?.message_id));
  }

  // Login jarayoni (login -> parol)
  const step = await handleLoginInput(env, userId, text);
  if (step) {
    if (step.deleteMessage) {
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});
    }
    if (step.success) {
      await sendText(env, chatId, "✅ Muvaffaqiyatli kirdingiz! Yangi buyurtmalar shu yerga keladi.", {
        reply_markup: REPLY_KEYBOARD,
      });
      return showMenu(env, chatId);
    }
    return sendText(env, chatId, step.reply);
  }

  if (!(await isAuthorized(env, userId))) {
    // 🛎 Slot xizmati mijozi
    await rememberUser(env, m.from).catch(() => {});
    // 🔗 Ozon/WB kaliti yuborildi
    if (text && !text.startsWith("/")) {
      const mi = await CL.mpInput(env, userId, chatId, text);
      if (mi) {
        await tg(env, "deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});
        return showScreen(env, chatId, mi.pid, mi.sc);
      }
    }
    const wait = await env.STATE.get(`clwait:${chatId}`);
    if (wait !== null && text) {
      const pid = Number(wait) || null;
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});
      return showScreen(env, chatId, pid, await CL.linkShop(env, m.from, text));
    }
    return showScreen(env, chatId, null, await CL.clientHome(env, userId));
  }
  await rememberUser(env, m.from);

  const isCmd = text.startsWith("/") || Boolean(BUTTON_COMMANDS[text]);
  const secRaw = await env.STATE.get(`secpw:${chatId}`);
  const uzRaw = await env.STATE.get(`uzlogin:${chatId}`);
  // Har qanday matnli xabarimizni chatdan olib tashlaymiz (chat toza turadi, parollar ochiq qolmaydi)
  await tg(env, "deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});

  // 🛎 Slot xizmati sozlamasi (admin)
  const svcRaw = await env.STATE.get(`svcset:${chatId}`);
  if (svcRaw && text && !isCmd) {
    await env.STATE.delete(`svcset:${chatId}`);
    const st = JSON.parse(svcRaw) as { field: string; pid?: number };
    return showScreen(env, chatId, st.pid ?? null, await CL.saveSetting(env, st.field, text));
  }

  // ❌ FBS bekor qilish: buyurtma raqami yozildi
  const fxRaw = await env.STATE.get(`fbscx:${chatId}`);
  if (fxRaw && text && !isCmd) {
    await env.STATE.delete(`fbscx:${chatId}`);
    const st = JSON.parse(fxRaw) as { acc: string; pid?: number };
    let sc;
    try {
      sc = await cancelReasonScreen(env, st.acc, text);
    } catch (e) {
      sc = textScreen(`⚠️ Uzum: ${escapeHtml((e as Error).message.slice(0, 200))}`);
    }
    return showScreen(env, chatId, st.pid ?? null, sc);
  }
  if (fxRaw && isCmd) await env.STATE.delete(`fbscx:${chatId}`);

  // 📞 Admin raqam qo'shmoqda
  const phRaw = await env.STATE.get(`phadd:${chatId}`);
  if (phRaw && text && !isCmd) {
    await env.STATE.delete(`phadd:${chatId}`);
    if ((await isOwner(env, chatId)) && normPhone(text).length >= 9) await allowPhone(env, text);
    return showUzum(env, chatId, Number(phRaw) || null, ["u", "ph"]);
  }

  // 🛡 Xavfsizlik: bot parolini tasdiqlash -> login/parollarni ko'rsatish (shu panelning o'zida)
  if (secRaw && text && !isCmd) {
    await env.STATE.delete(`secpw:${chatId}`);
    let sp: { pid?: number | null; purpose?: string } = {};
    try {
      sp = JSON.parse(secRaw);
    } catch {}
    const pid = (typeof sp === "object" && sp?.pid) || null;
    if (!(await safeEqual(text, env.ADMIN_PASSWORD))) {
      const n = Number((await env.STATE.get(`secfail:${chatId}`)) ?? 0) + 1;
      if (n >= 3) {
        await env.STATE.put(`seclock:${chatId}`, String(Date.now() + 15 * 60e3), { expirationTtl: 900 });
        await env.STATE.delete(`secfail:${chatId}`);
        return showScreen(env, chatId, pid, textScreen("⛔ 3 marta noto'g'ri parol. Xavfsizlik bo'limi 15 daqiqaga yopildi."));
      }
      await env.STATE.put(`secfail:${chatId}`, String(n), { expirationTtl: 900 });
      return showScreen(env, chatId, pid, {
        text: `❌ Bot paroli noto'g'ri. Qolgan urinish: ${3 - n}.`,
        reply_markup: { inline_keyboard: [[{ text: "🔄 Qayta urinish", callback_data: "u:secv" }], [{ text: "🏠 Menyu", callback_data: "m:home" }]] },
      });
    }
    await env.STATE.delete(`secfail:${chatId}`);
    if (sp.purpose === "own") {
      if (!(await getOwner(env))) {
        await setOwner(env, chatId);
        await syncCommands(env);
      }
      return showScreen(env, chatId, pid, await securityScreen(env, chatId));
    }
    if (!(await isOwner(env, chatId))) return showScreen(env, chatId, pid, await securityScreen(env, chatId));
    const creds = await uzumRevealCredentials(env);
    const kb = creds.filter((c) => !c.password && c.id !== "env").map((c) => [{ text: `🔑 Parolni saqlash — ${c.label.slice(0, 24)}`, callback_data: `u:lg:${c.id}` }]);
    kb.push([{ text: "🗑 Yashirish va bosh menyu", callback_data: "u:secdel" }]);
    const mid = await showScreen(env, chatId, pid, { text: revealText(creds), reply_markup: { inline_keyboard: kb } });
    await env.STATE.put(`autodel:${chatId}:${mid}:${Date.now() + 60e3}`, "1", { expirationTtl: 3600 });
    setTimeout(() => purgeSecretMessages(env).catch(() => {}), 61e3);
    return;
  }
  if (secRaw && isCmd) await env.STATE.delete(`secpw:${chatId}`);

  // Uzum profilini qo'shish / parolini saqlash (login -> parol), hammasi bitta panelda
  if (uzRaw && text && !isCmd) {
    const st = JSON.parse(uzRaw) as { step: string; login?: string; acc?: string; pid?: number };
    const pid = st.pid ?? null;
    if (st.step === "login") {
      await env.STATE.put(`uzlogin:${chatId}`, JSON.stringify({ ...st, step: "pass", login: text }), { expirationTtl: 600 });
      return showScreen(env, chatId, pid, {
        text: `🔐 <b>Uzum profilini qo'shish</b>\n\n👤 Login: ${(await isOwner(env, chatId)) ? `<code>${escapeHtml(text)}</code>` : "qabul qilindi ✅"}\n\n2️⃣ Endi <b>parol</b>ni yozing.\n<i>Xabaringiz chatdan darhol o'chiriladi, parol shifrlangan holda saqlanadi.</i>`,
        reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "u:lgx" }]] },
      });
    }
    await env.STATE.delete(`uzlogin:${chatId}`);
    const panel = await showScreen(env, chatId, pid, textScreen("⏳ Uzum'ga ulanmoqda..."));
    try {
      const before = (await uzumAllAccounts(env)).some((x) => x.login === acc_login(st.login ?? ""));
      const acc = await uzumAddAccount(env, st.login ?? "", text, true);
      const owner = await isOwner(env, chatId);
      // Boshqa akkauntdan kiritilgan bo'lsa — asosiy adminga xabar
      const ownerId = await getOwner(env);
      if (ownerId && ownerId !== chatId) {
        await sendText(
          env,
          ownerId,
          `🔔 <b>${escapeHtml(await userName(env, chatId))}</b> Uzum profilini ${before ? "yangiladi (yangi parol)" : "qo'shdi"}:\n` +
            `👤 ${escapeHtml(acc.label)}\n📧 Login: <code>${escapeHtml(acc.login)}</code>\n\n<i>Parolni ko'rish uchun pastdagi tugmani bosing (bot paroli so'raladi).</i>`,
          { reply_markup: { inline_keyboard: [[{ text: "👁 Login va parolni ko'rish", callback_data: "u:secv" }]] } },
        ).catch(() => {});
      }
      await showScreen(env, chatId, panel, {
        text:
          `✅ <b>Uzum profili ulandi:</b> ${escapeHtml(acc.label)}\n\n` +
          (owner ? `👤 Login: <code>${escapeHtml(acc.login)}</code>\n` : "") +
          (owner ? `🔑 Parol: <tg-spoiler><code>${escapeHtml(text)}</code></tg-spoiler>\n\n` : `🔑 Login va parol saqlandi <i>(faqat asosiy admin ko'ra oladi)</i>\n\n`) +
          `<i>Parol shifrlangan holda saqlandi — sessiya tugasa bot o'zi qayta kiradi. Bu ma'lumot 60 soniyadan keyin yashiriladi.</i>`,
        reply_markup: {
          inline_keyboard: [
            [{ text: "📦 Do'konlarni ochish", callback_data: `u:ac:${acc.id}` }],
            [{ text: "🗑 Yashirish va bosh menyu", callback_data: "u:secdel" }],
          ],
        },
      });
      await env.STATE.put(`autodel:${chatId}:${panel}:${Date.now() + 60e3}`, "1", { expirationTtl: 3600 });
      setTimeout(() => purgeSecretMessages(env).catch(() => {}), 61e3);
      return;
    } catch (e) {
      return showScreen(env, chatId, panel, {
        text: `❌ Ulanib bo'lmadi: ${escapeHtml((e as Error).message.slice(0, 200))}`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔄 Qayta urinish", callback_data: st.acc ? `u:lg:${st.acc}` : "u:lg" }], [{ text: "🏠 Menyu", callback_data: "m:home" }]],
        },
      });
    }
  }
  if (uzRaw && isCmd) await env.STATE.delete(`uzlogin:${chatId}`);

  const cmd = BUTTON_COMMANDS[text] ?? text.split(/[\s@]/)[0];
  return runCommand(env, chatId, userId, cmd);
}

/** Menyu tugmalari — hammasi shu xabarning o'zida ochiladi */
async function menuAction(env: Env, chatId: number, userId: number, messageId: number, action: string) {
  switch (action) {
    case "orders":
      return showOrders(env, chatId, messageId);
    case "report":
      return showScreen(env, chatId, messageId, textScreen(await dailyReport(env)));
    case "logout":
      return runCommand(env, chatId, userId, "/logout");
    case "refresh":
      await pollAll(env).catch(() => undefined);
      return showMenu(env, chatId, messageId);
    case "home":
    default:
      return showMenu(env, chatId, messageId);
  }
}

/** Oddiy (zaxira) tugmalar: a:ship:ozon:12345 yoki m:orders */
async function handleCallback(env: Env, q: any): Promise<any> {
  const userId: number = q.from.id;
  const chatId: number = q.message.chat.id;
  if (String(q.data ?? "").startsWith("lang:")) return onLangPick(env, q);
  const staff = await isAuthorized(env, userId);
  if (!staff || String(q.data ?? "").startsWith("c:")) return clientCallback(env, q, staff);
  await rememberUser(env, q.from);
  const parts = String(q.data ?? "").split(":");
  const messageId: number = q.message.message_id;
  if (parts[0] === "rv") {
    // Tasdiqlangan xodim ruxsatini bekor qilish (faqat asosiy admin)
    if (!(await isOwner(env, userId))) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "🚫 Faqat asosiy admin", show_alert: true });
    const uid = Number(parts[1]);
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "🚫 Ruxsat bekor qilindi" }).catch(() => {});
    if (uid && uid !== userId) await revokeStaff(env, uid);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: `🚫 Ruxsat bekor qilindi: ${escapeHtml(await userName(env, uid))}`, parse_mode: "HTML" }).catch(() => {});
    return;
  }
  if (parts[0] === "ap" || parts[0] === "rj") {
    if (!(await isOwner(env, userId))) {
      return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "🚫 Faqat asosiy admin", show_alert: true });
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    const uid = Number(parts[1]);
    const note = await decideRequest(env, uid, parts[0] === "ap");
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: note,
      parse_mode: "HTML",
      ...(parts[0] === "ap" ? { reply_markup: { inline_keyboard: [[{ text: "🚫 Ruxsatni bekor qilish", callback_data: `rv:${uid}`, style: "danger" }]] } } : {}),
    }).catch(() => {});
    if (parts[0] === "ap") {
      await sendText(env, uid, "✅ Admin ruxsat berdi. Xush kelibsiz!", { reply_markup: REPLY_KEYBOARD }).catch(() => {});
      await showMenu(env, uid).catch(() => {});
    }
    return;
  }
  const answer = (text = "") => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  try {
    if (parts[0] === "m") {
      await answer();
      return await menuAction(env, chatId, userId, messageId, parts[1]);
    }
    if (parts[0] === "u") {
      const act = parts[1];
      await answer(act === "lostf" ? "🔎 Qidiruv boshlandi (2–5 daqiqa)" : act === "fxy" ? "⏳ Bekor qilinmoqda..." : act === "fc" || act === "fcy" ? "⏳ Yig'ishga o'tkazilmoqda..." : act === "ty" ? "⏳ Band qilinmoqda..." : act === "w" ? "🔍 Qidiruv boshlandi" : act === "wq" ? "⏹ To'xtatildi" : "");
      return await showUzum(env, chatId, messageId, parts);
    }
    if (parts[0] === "k") {
      // Buyurtma kartochkasi: k:<amal>:<mp>:<id>[:qo'shimcha]
      const [, act, mp, id, extra] = parts;
      const slow = ["acc", "lbl", "cy", "handy", "act", "qr"].includes(act);
      if (slow) await answer(act === "lbl" ? "🏷 Yorliq tayyorlanmoqda..." : "⏳ Bajarilmoqda...");
      const r = await cardAction(env, chatId, messageId, act, mp as Marketplace, id, extra);
      if (!slow) await answer(r);
      else if (r.startsWith("⚠️") || /topilmadi|bo'lmaydi|allaqachon/.test(r)) await sendText(env, chatId, r);
      return;
    }
    if (["s", "so", "sr", "st", "sc"].includes(parts[0])) {
      const force = parts[0] === "s" && parts[2] === "f";
      await answer(force ? "🔄 Yangilanmoqda..." : "");
      return await showStats(env, chatId, messageId, parts[0], asPeriod(parts[1]), force ? 0 : Number(parts[2] ?? 0) || 0, force);
    }
    if (parts[0] === "lv") {
      await answer("🏷 ...");
      return await openLabels(env, chatId, messageId, true, parts[1] as Marketplace, Number(parts[2]));
    }
    if (parts[0] === "lvb" || parts[0] === "lvh") {
      await answer();
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
      return parts[0] === "lvb" ? await showMpOrders(env, chatId, null, parts[1] as Marketplace) : await showMenu(env, chatId);
    }
    if (parts[0] === "l") {
      await answer();
      return await showMpOrders(env, chatId, messageId, parts[1] as Marketplace);
    }
    if (parts[0] === "b") {
      const mp = parts[2] as Marketplace;
      if (parts[1] === "ship") {
        await answer();
        const { all } = await pendingOrders(env);
        const n = all.filter((o) => o.mp === mp && o.canShip).length;
        return await showScreen(env, chatId, messageId, confirmShipScreen(mp, n));
      }
      if (parts[1] === "send") {
        await answer();
        const { all } = await pendingOrders(env);
        const n = all.filter((o) => o.mp === mp && o.readyToHandover).length;
        return await showScreen(env, chatId, messageId, confirmSendScreen(mp, n));
      }
      // Yorliqlar shu xabarning o'zida ochiladi: ◀️ 1/N ▶️ bilan varaqlanadi
      await answer("🏷 Yorliq tayyorlanmoqda...");
      return await openLabels(env, chatId, messageId, false, mp, 0);
    }
    if (parts[0] === "bc" && parts[1] === "send") {
      const mp = parts[2] as Marketplace;
      await answer("⏳ Jo'natma tayyorlanmoqda...");
      const note = await bulkHandover(env, chatId, mp);
      return await showMpOrders(env, chatId, messageId, mp, note);
    }
    if (parts[0] === "bc") {
      const mp = parts[2] as Marketplace;
      await answer("⏳ Yig'ishga olinmoqda...");
      const r = await bulkShip(env, chatId, mp);
      return await showMpOrders(env, chatId, messageId, mp, `✅ ${r.ok} ta yig'ishga olindi.` + (r.fail.length ? ` ⚠️ Xato: ${r.fail.join("; ")}` : ""));
    }
    if (parts[0] === "o") {
      await answer();
      return await showOrder(env, chatId, messageId, parts[1] as Marketplace, parts.slice(2).join(":"));
    }
    const [, action, mp, ...rest] = parts;
    const id = rest.join(":");
    await answer(action === "label" ? "🏷 Yorliq tayyorlanmoqda..." : "⏳ Bajarilmoqda...");
    if (action === "label") {
      // Yorliq shu xabarning o'zida ochiladi
      const m = mp as Marketplace;
      await env.STATE.put(`lv:${chatId}:${messageId}`, JSON.stringify([id]), { expirationTtl: 86400 });
      return await showLabel(env, chatId, messageId, false, m, [id], 0, async (oid) => {
        const { all } = await pendingOrders(env);
        const o = all.find((x) => x.mp === m && x.id === oid) ?? (await loadOrder(env, m, oid))?.order;
        if (!o) throw new Error("Buyurtma topilmadi: " + oid);
        return makeLabel(env, o);
      });
    }
    const msg = await doAction(env, chatId, mp as Marketplace, id, action);
    if (action === "ship") await showOrder(env, chatId, messageId, mp as Marketplace, id, msg + ". Endi yorliqni chop eting, keyin ro'yxatda \"🚚 Yukni jo'natish\" ni bosing.");
  } catch (e) {
    await sendText(env, chatId, `⚠️ Xatolik: ${escapeHtml((e as Error).message)}`);
  }
}

/** Vidjet ichidagi tugmalar (Bot API 10.4 widget_query) */
async function handleWidgetQuery(env: Env, q: any) {
  const userId: number = q.from?.id;
  const chatId: number | undefined = q.chat?.id;
  const ok = await isAuthorized(env, userId);
  // 15 soniya ichida javob berish shart — avval javob, keyin ish
  await tg(env, "answerWidgetQuery", { widget_query_id: q.id, data: ok ? "ok" : "denied" }).catch((e) =>
    console.log("answerWidgetQuery", e.message),
  );
  if (!ok || !chatId) return;

  const ref = await env.STATE.get(`msg:${chatId}:${q.message_id}`);
  const data = String(q.data ?? "");
  try {
    if (ref === "menu" || data.startsWith("m:")) {
      // Vidjetdan bosilsa — yangi navigatsiya xabarini ochamiz
      return await menuAction(env, chatId, userId, 0, data.replace(/^m:/, ""));
    }
    if (!ref) return sendText(env, chatId, "⚠️ Buyurtma topilmadi (eskirgan bo'lishi mumkin). /orders");
    const [mp, ...rest] = ref.split(":");
    const id = rest.join(":");
    const msg = await doAction(env, chatId, mp as Marketplace, id, data);
    if (data !== "label") await sendText(env, chatId, `${msg} — № <code>${id}</code>`);
  } catch (e) {
    await sendText(env, chatId, `⚠️ Xatolik: ${(e as Error).message}`);
  }
}

/** 🛎 Slot xizmati: mijoz tugmalari (va admin boshqaruvi c:adm ...) */
async function clientCallback(env: Env, q: any, staff: boolean): Promise<any> {
  const userId: number = q.from.id;
  const chatId: number = q.message.chat.id;
  const messageId: number = q.message.message_id;
  const p = String(q.data ?? "").split(":");
  const answer = (text = "", alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert }).catch(() => {});
  const show = async (sc: any) => {
    await answer();
    return showScreen(env, chatId, messageId, sc);
  };
  try {
    if (p[0] === "c") {
      const act = p[1];
      // 👑 Admin amallari
      const adminActs = ["adm", "svl", "svs", "set", "cl", "ext", "stop", "del"];
      if (adminActs.includes(act)) {
        if (!staff || !(await isOwner(env, userId))) return answer("🚫 Faqat asosiy admin", true);
        if (act === "adm") return show(await CL.adminScreen(env));
        if (act === "svl") return show(await CL.svcPickScreen(env));
        if (act === "svs") return show(await CL.setSvcAcc(env, p[2]));
        if (act === "set") return show(await CL.askSetting(env, chatId, p[2], messageId));
        if (act === "cl") return show(await CL.clientAdminScreen(env, Number(p[2])));
        if (act === "ext") return show(await CL.extendSub(env, Number(p[2]), Number(p[3]) || 30));
        if (act === "stop") return show(await CL.stopSub(env, Number(p[2])));
        if (act === "del") return show(await CL.deleteClient(env, Number(p[2])));
      }
      if (act === "staff") {
        await answer();
        return sendWelcome(env, chatId);
      }
      if (act === "con") return show(await CL.connectScreen(env, chatId, messageId));
      if (act === "mp") {
        await env.STATE.delete(`clmpw:${chatId}`);
        return show(await CL.mpScreen(env, userId));
      }
      if (act === "mpo" || act === "mpw") return show(await CL.mpAsk(env, chatId, act === "mpo" ? "o" : "w", messageId));
      if (act === "mpx") return show(await CL.mpRemove(env, userId, p[2]));
      if (act === "sh") return show(await CL.clientShopsScreen(env, userId));
      if (act === "uz") return show(await CL.clientUzumScreen(env, userId));
      if (act === "fbs") return show(await CL.clientFbsScreen(env, userId, p[2] ?? "NEW"));
      if (act === "wl") return show(await CL.clientWatchesScreen(env, userId));
      if (act === "sub") return show(await CL.subScreen(env, userId));
      if (act === "paid") return show(await CL.paidNotice(env, userId));
      await env.STATE.delete(`clwait:${chatId}`);
      return show(await CL.clientHome(env, userId));
    }
    // 🔗 Ozon/WB buyurtmalari va statistika — mijozning o'z muhitida (o'z tokenlari, o'z xotirasi)
    const TEN = new Set(["k", "s", "so", "sr", "st", "sc", "lv", "lvb", "l", "b", "bc", "o", "a"]);
    if (TEN.has(p[0]) || (p[0] === "m" && ["orders", "report"].includes(p[1]))) {
      const c = await CL.getClient(env, userId);
      const mp = await CL.mpCreds(env, userId);
      if (!mp.oz && !mp.wb) return show(await CL.mpScreen(env, userId));
      if (!CL.subActive(c)) return show(await CL.subScreen(env, userId, "⛔ Obunangiz tugagan — uzaytiring."));
      return handleCallback(await CL.tenantEnv(env, userId, mp), q);
    }
    if (p[0] === "u") {
      const g = await CL.clientGuard(env, userId, p);
      if (g === "home") return show(await CL.clientHome(env, userId));
      if (g === "watches") return show(await CL.clientWatchesScreen(env, userId));
      if (g === "shops") return show(await CL.clientShopsScreen(env, userId));
      if (g === "sub") return show(await CL.subScreen(env, userId, "⛔ Obunangiz tugagan — slot olish uchun obunani uzaytiring."));
      const act = p[1];
      await answer(act === "ty" ? "⏳ Band qilinmoqda..." : act === "w" ? "🔍 Qidiruv boshlandi" : act === "wq" ? "⏹ To'xtatildi" : "");
      return await showUzum(env, chatId, messageId, p);
    }
    return show(await CL.clientHome(env, userId));
  } catch (e) {
    console.log("client cb:", (e as Error).message);
    await answer("⚠️ Xatolik, qayta urinib ko'ring", true);
  }
}

/** Xodim ruxsatini to'liq bekor qilish: sessiya + telefon ruxsati. Keyin u oddiy mijoz sahifasini ko'radi. */
async function revokeStaff(env: Env, uid: number) {
  await logout(env, uid);
  const ph = await env.STATE.get(`phone:${uid}`);
  if (ph) await disallowPhone(env, ph);
  await env.STATE.delete(`pending:${uid}`);
  await sendText(env, uid, "🚪 Xodim sifatidagi ruxsatingiz bekor qilindi.", { reply_markup: { remove_keyboard: true } }).catch(() => {});
  await showScreen(env, uid, null, await CL.clientHome(env, uid)).catch(() => {});
}

/** Vaqtinchalik xabarlar (keyingi /start da o'chiriladi) */
async function trackTmp(env: Env, chatId: number, id?: number) {
  if (!id) return;
  const list: number[] = JSON.parse((await env.STATE.get(`tmp:${chatId}`)) ?? "[]");
  list.push(id);
  await env.STATE.put(`tmp:${chatId}`, JSON.stringify(list.slice(-20)), { expirationTtl: 2 * 86400 });
}
async function purgeTmp(env: Env, chatId: number) {
  const raw = await env.STATE.get(`tmp:${chatId}`);
  if (!raw) return;
  await env.STATE.delete(`tmp:${chatId}`);
  for (const id of JSON.parse(raw) as number[]) await tg(env, "deleteMessage", { chat_id: chatId, message_id: id }).catch(() => {});
}
