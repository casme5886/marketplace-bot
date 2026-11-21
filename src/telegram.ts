import type { Env } from "./types";

export class TgError extends Error {
  constructor(public method: string, public description: string) {
    super(`${method}: ${description}`);
  }
}

/**
 * Kerakli tugmalarni avtomatik rangli qilish (agar kodda rang berilmagan bo'lsa):
 *  🟢 success — tasdiqlash / bajarish, 🔴 danger — bekor qilish / to'xtatish / o'chirish, 🔵 primary — muhim navigatsiya.
 */
const STYLE_RULES: [RegExp, string][] = [
  [/^(⏹|🗑|🚪|❌ (Bekor|Yo'q|Rad|Buyurtmani)|⛔)/u, "danger"],
  [/^(✅ (Ha|Tasdiq|Ruxsat|Hammasini|\d)|🟢|🚚 Ha|📦 Ha|⚡|🎉|➡️|🔎 Qidirish|🔍 (Shu kun|Qidirishni davom|Boshqa vaqt)|📦 Yig'ish|🚚 Yukni|🧾 Ta'minlashga|🧾 Yig'ishdagilarni|🔑 Parolni saqlash|👁)/u, "success"],
  [/^(📅|🔔 (Faqat|Bron qilmasdan|FBO|FBS)|🔍 Qidiruv holati|🔄 Qayta (urinish|qidirish|yozish)|📋 Barcha|📍 FBS joy|🏷 Barcha|📄 (Nakladnoy|Akt)|🕒 Istalgan|🗺 Xaritada)/u, "primary"],
];
function autoStyle(body: Record<string, unknown>) {
  const kb = (body.reply_markup as any)?.inline_keyboard;
  if (!Array.isArray(kb)) return;
  for (const row of kb)
    for (const b of Array.isArray(row) ? row : []) {
      if (!b || b.style || typeof b.text !== "string") continue;
      const r = STYLE_RULES.find(([re]) => re.test(b.text));
      if (r) b.style = r[1];
    }
}

export async function tg<T = any>(env: Env, method: string, body: Record<string, unknown>): Promise<T> {
  autoStyle(body);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok) throw new TgError(method, json.description ?? "unknown error");
  return json.result as T;
}

export async function sendText(env: Env, chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/** PDF yoki PNG faylni hujjat sifatida yuborish */
export async function sendDocument(
  env: Env,
  chatId: number,
  data: ArrayBuffer | Uint8Array,
  filename: string,
  mime: string,
  caption?: string,
  replyMarkup?: unknown,
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  form.append("document", new Blob([data], { type: mime }), filename);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const json: any = await res.json();
  if (!json.ok) throw new TgError("sendDocument", json.description);
  return json.result;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Hujjatli xabarni boshqa hujjat bilan almashtirish (shu xabarning o'zida) */
export async function editDocument(
  env: Env,
  chatId: number,
  messageId: number,
  doc: { fileId?: string; data?: ArrayBuffer | Uint8Array; filename?: string; mime?: string },
  caption: string,
  replyMarkup: unknown,
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("message_id", String(messageId));
  form.append("reply_markup", JSON.stringify(replyMarkup));
  const media: Record<string, unknown> = { type: "document", caption };
  if (doc.fileId) media.media = doc.fileId;
  else {
    media.media = "attach://file";
    form.append("file", new Blob([doc.data!], { type: doc.mime }), doc.filename);
  }
  form.append("media", JSON.stringify(media));
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageMedia`, { method: "POST", body: form });
  const json: any = await res.json();
  if (!json.ok && !/not modified/i.test(json.description ?? "")) throw new TgError("editMessageMedia", json.description);
  return json.result;
}
