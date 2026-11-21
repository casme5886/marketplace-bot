import type { Env } from "./types";

/**
 * Login/parol himoyasi.
 * - Foydalanuvchi /login bosadi -> login so'raladi -> parol so'raladi.
 * - Parol xabari darhol o'chiriladi (chatda qolmasligi uchun).
 * - 5 marta xato -> 30 daqiqaga bloklanadi.
 * - Muvaffaqiyatli kirgan chat ID lari KV da saqlanadi va faqat ularga xabar boradi.
 */

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 30 * 60;

type LoginStep = { step: "login" } | { step: "password"; login: string };

async function sha256(text: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/** Vaqt bo'yicha teng solishtirish (timing attack'dan himoya) */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

export async function isAuthorized(env: Env, userId: number): Promise<boolean> {
  return (await env.STATE.get(`auth:${userId}`)) !== null;
}

export async function listAuthorizedChats(env: Env): Promise<number[]> {
  const out: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ prefix: "auth:", cursor });
    for (const k of page.keys) out.push(Number(k.name.slice(5)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function logout(env: Env, userId: number) {
  await env.STATE.delete(`auth:${userId}`);
  await env.STATE.delete(`loginstep:${userId}`);
}

export async function startLogin(env: Env, userId: number): Promise<string> {
  const locked = await env.STATE.get(`lock:${userId}`);
  if (locked) return "⛔ Juda ko'p noto'g'ri urinish. 30 daqiqadan keyin qayta urinib ko'ring.";
  await env.STATE.put(`loginstep:${userId}`, JSON.stringify({ step: "login" } satisfies LoginStep), {
    expirationTtl: 300,
  });
  return "🔐 Loginni kiriting:";
}

/**
 * Login jarayonidagi matnli xabarni qayta ishlaydi.
 * null qaytarsa — foydalanuvchi login jarayonida emas.
 */
export async function handleLoginInput(
  env: Env,
  userId: number,
  text: string,
): Promise<{ reply: string; deleteMessage: boolean; success?: boolean } | null> {
  const raw = await env.STATE.get(`loginstep:${userId}`);
  if (!raw) return null;
  const st = JSON.parse(raw) as LoginStep;

  if (st.step === "login") {
    await env.STATE.put(`loginstep:${userId}`, JSON.stringify({ step: "password", login: text.trim() }), {
      expirationTtl: 300,
    });
    return { reply: "🔑 Parolni kiriting (xabar darhol o'chiriladi):", deleteMessage: false };
  }

  await env.STATE.delete(`loginstep:${userId}`);
  const ok = (await safeEqual(st.login, env.ADMIN_LOGIN)) && (await safeEqual(text, env.ADMIN_PASSWORD));
  if (ok) {
    await env.STATE.put(`auth:${userId}`, new Date().toISOString());
    await env.STATE.delete(`attempts:${userId}`);
    return {
      reply: "✅ Muvaffaqiyatli kirdingiz! Endi yangi buyurtmalar shu yerga keladi.\n\n/orders — kutilayotgan buyurtmalar\n/report — bugungi hisobot\n/logout — chiqish",
      deleteMessage: true,
      success: true,
    };
  }

  const attempts = Number((await env.STATE.get(`attempts:${userId}`)) ?? "0") + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await env.STATE.put(`lock:${userId}`, "1", { expirationTtl: LOCK_SECONDS });
    await env.STATE.delete(`attempts:${userId}`);
    return { reply: "⛔ Login yoki parol noto'g'ri. 30 daqiqaga bloklandingiz.", deleteMessage: true };
  }
  await env.STATE.put(`attempts:${userId}`, String(attempts), { expirationTtl: LOCK_SECONDS });
  return {
    reply: `❌ Login yoki parol noto'g'ri. Qolgan urinishlar: ${MAX_ATTEMPTS - attempts}.\nQayta urinish: /login`,
    deleteMessage: true,
  };
}

/* ===================== 👑 Asosiy admin (parollarni faqat u ko'radi) ===================== */

/** Asosiy admin Telegram ID: .dev.vars dagi ADMIN_TELEGRAM_ID (ustun) yoki bot ichida belgilangan */
export async function getOwner(env: Env): Promise<number | null> {
  const fromEnv = Number(env.ADMIN_TELEGRAM_ID ?? 0);
  if (fromEnv) return fromEnv;
  return Number((await env.STATE.get("owner:id")) ?? 0) || null;
}

export async function isOwner(env: Env, userId: number): Promise<boolean> {
  return (await getOwner(env)) === userId;
}

export async function setOwner(env: Env, userId: number | null) {
  if (userId) await env.STATE.put("owner:id", String(userId));
  else await env.STATE.delete("owner:id");
}

/** Telegram akkaunt nomini eslab qolish (sessiyalar ro'yxati uchun) */
export async function rememberUser(env: Env, from: any) {
  if (!from?.id) return;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") + (from.username ? ` (@${from.username})` : "");
  const key = `uname:${from.id}`;
  if ((await env.STATE.get(key)) !== name) await env.STATE.put(key, name);
}

export async function userName(env: Env, userId: number): Promise<string> {
  return (await env.STATE.get(`uname:${userId}`)) ?? `ID ${userId}`;
}
