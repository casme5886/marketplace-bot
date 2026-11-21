/**
 * 📱 Telefon raqam orqali kirish.
 *  - Foydalanuvchi "📱 Telefon raqamni ulashish" tugmasini bosadi (faqat o'z raqami qabul qilinadi).
 *  - Raqam ruxsat etilganlar ro'yxatida bo'lsa — darhol kiradi.
 *  - Bo'lmasa — asosiy adminga "✅ Ruxsat berish / ❌ Rad etish" so'rovi boradi.
 */
import type { Env } from "./types";
import { escapeHtml, sendText } from "./telegram";
import { getOwner, rememberUser, userName } from "./auth";

const ALLOW_KEY = "phones:allow";

export const normPhone = (s: string) => {
  const d = String(s).replace(/[^\d]/g, "");
  return d.length === 9 ? "998" + d : d;
};
export const fmtPhone = (p: string) => (p.length === 12 ? `+${p.slice(0, 3)} ${p.slice(3, 5)} ${p.slice(5, 8)}-${p.slice(8, 10)}-${p.slice(10)}` : `+${p}`);

export async function allowedPhones(env: Env): Promise<string[]> {
  return JSON.parse((await env.STATE.get(ALLOW_KEY)) ?? "[]");
}
export async function allowPhone(env: Env, phone: string) {
  const list = await allowedPhones(env);
  const p = normPhone(phone);
  if (p && !list.includes(p)) list.push(p);
  await env.STATE.put(ALLOW_KEY, JSON.stringify(list));
}
export async function disallowPhone(env: Env, phone: string) {
  const list = (await allowedPhones(env)).filter((x) => x !== normPhone(phone));
  await env.STATE.put(ALLOW_KEY, JSON.stringify(list));
  // Shu raqam bilan kirgan akkauntlarni chiqaramiz
  const page = await env.STATE.list({ prefix: "phone:" });
  for (const k of page.keys) {
    if ((await env.STATE.get(k.name)) === normPhone(phone)) {
      const uid = Number(k.name.slice(6));
      await env.STATE.delete(`auth:${uid}`);
      await sendText(env, uid, "🚪 Raqamingiz uchun ruxsat bekor qilindi. Qayta kirish: /start", { reply_markup: { remove_keyboard: true } }).catch(() => {});
    }
  }
}

/** Kirmagan foydalanuvchiga ko'rsatiladigan tugma */
export const SHARE_KEYBOARD = {
  keyboard: [[{ text: "📱 Telefon raqamni ulashish", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

export async function sendWelcome(env: Env, chatId: number) {
  await sendText(
    env,
    chatId,
    "🔐 <b>Xodimlar kirishi</b>\n\nBu bo'lim faqat MarketHub <b>xodimlari</b> uchun (admin tasdiqlaydi).\n<b>Slot xizmati mijozi bo'lsangiz — telefon kerak emas</b>, /start bosing.\n\nXodim bo'lsangiz — pastdagi <b>📱 Telefon raqamni ulashish</b> tugmasini bosing.\n<i>Admin login/paroli bilan kirish: /login</i>",
    { reply_markup: SHARE_KEYBOARD },
  );
}

/**
 * Kontakt kelganda. Qaytaradi: "ok" — kirdi, "pending" — adminga so'rov ketdi, "denied" — rad.
 */
export async function handleContact(env: Env, m: any): Promise<"ok" | "pending" | "denied"> {
  const chatId: number = m.chat.id;
  const uid: number = m.from.id;
  const c = m.contact ?? {};
  if (Number(c.user_id) !== uid) {
    await sendText(env, chatId, "❌ Faqat <b>o'zingizning</b> raqamingizni ulashing — pastdagi tugmani bosing.", { reply_markup: SHARE_KEYBOARD });
    return "denied";
  }
  const phone = normPhone(c.phone_number ?? "");
  await rememberUser(env, m.from);
  await env.STATE.put(`phone:${uid}`, phone);

  if ((await allowedPhones(env)).includes(phone)) {
    await env.STATE.put(`auth:${uid}`, new Date().toISOString());
    return "ok";
  }

  const owner = await getOwner(env);
  if (!owner) {
    await sendText(env, chatId, "⏳ Asosiy admin hali belgilanmagan. Hozircha /login orqali kiring.", { reply_markup: { remove_keyboard: true } });
    return "denied";
  }
  if (await env.STATE.get(`pending:${uid}`)) {
    await sendText(env, chatId, "⏳ So'rovingiz adminga yuborilgan, javobni kuting.", { reply_markup: { remove_keyboard: true } });
    return "pending";
  }
  await env.STATE.put(`pending:${uid}`, phone, { expirationTtl: 86400 });
  await sendText(
    env,
    owner,
    `📱 <b>Xodim sifatida kirish so'rovi</b>\n\n👤 ${escapeHtml(await userName(env, uid))}\n📞 ${fmtPhone(phone)}\n🆔 <code>${uid}</code>\n\n⚠️ Ruxsat bersangiz — u <b>sizning barcha do'kon, buyurtma va statistikangizni</b> ko'radi. Slot xizmati mijozlariga ruxsat bermang (ular uchun kerak emas).\n\nRuxsat beraymi?`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Ruxsat berish", callback_data: `ap:${uid}` }, { text: "❌ Rad etish", callback_data: `rj:${uid}` }]],
      },
    },
  );
  await sendText(env, chatId, "✅ Raqamingiz qabul qilindi. So'rov <b>adminga yuborildi</b> — ruxsat berilishi bilan xabar keladi.", {
    reply_markup: { remove_keyboard: true },
  });
  return "pending";
}

/** Admin javobi: ap (ruxsat) yoki rj (rad) */
export async function decideRequest(env: Env, uid: number, approve: boolean): Promise<string> {
  const phone = await env.STATE.get(`pending:${uid}`);
  await env.STATE.delete(`pending:${uid}`);
  const who = await userName(env, uid);
  if (!approve) {
    await sendText(env, uid, "❌ Admin kirishga ruxsat bermadi.", { reply_markup: { remove_keyboard: true } }).catch(() => {});
    return `❌ Rad etildi: ${escapeHtml(who)}`;
  }
  const p = phone ?? (await env.STATE.get(`phone:${uid}`)) ?? "";
  if (p) await allowPhone(env, p);
  await env.STATE.put(`auth:${uid}`, new Date().toISOString());
  return `✅ Ruxsat berildi: ${escapeHtml(who)}${p ? ` · ${fmtPhone(p)}` : ""}`;
}
