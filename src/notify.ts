/**
 * 🔔 Bildirishnomalar: botga yuboriladi va ilovadagi «Xabarlar» tarixiga yoziladi.
 * Ilova rejimida (Mini App manzili o'rnatilgan bo'lsa) bot tugmalari o'rniga bitta «📱 Ilovada ochish» tugmasi qo'yiladi
 * (xarita kabi tashqi havolalar saqlanadi) — hamma amal ilovada bajariladi.
 */
import type { Env } from "./types";
import { sendText } from "./telegram";
import { bt, getLang, trText, type Lang } from "./i18n";

export interface Ntf {
  t: number;
  text: string;
  tab?: string;
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();

export async function logNtf(env: Env, chatId: number, text: string, tab = "") {
  if (!chatId || chatId < 0) return;
  try {
    const key = `ntf:${chatId}`;
    const list: Ntf[] = JSON.parse((await env.STATE.get(key)) ?? "[]");
    list.unshift({ t: Date.now(), text: plain(text).slice(0, 700), ...(tab ? { tab } : {}) });
    const cut = Date.now() - 14 * 86400e3;
    await env.STATE.put(key, JSON.stringify(list.filter((x) => x.t > cut).slice(0, 60)));
  } catch (e) {
    console.log("ntf log:", (e as Error).message);
  }
}

export async function notifications(env: Env, chatId: number): Promise<Ntf[]> {
  return JSON.parse((await env.STATE.get(`ntf:${chatId}`)) ?? "[]");
}

/** Ilova rejimi: manzil bo'lsa — tugmalar ilovaga yo'naltiriladi */
export async function appMarkup(env: Env, markup: any, tab = "", lang: Lang = "uz"): Promise<any> {
  const url = await env.STATE.get("app:url");
  if (!url) return markup;
  const keep: any[][] = [];
  for (const row of markup?.inline_keyboard ?? []) {
    const ext = (row as any[]).filter((b) => b.url && !b.callback_data);
    if (ext.length) keep.push(ext);
  }
  return { inline_keyboard: [[{ text: bt(lang, "openIn"), web_app: { url: tab ? `${url}#${tab}` : url } }], ...keep.slice(0, 3)] };
}

/** Bildirishnoma: botga + tarixga */
export async function notify(env: Env, chatId: number, text: string, opts: Record<string, unknown> = {}, tab = "") {
  const lang = await getLang(env, chatId);
  text = trText(lang, text);
  await logNtf(env, chatId, text, tab);
  const o = { ...opts };
  o.reply_markup = await appMarkup(env, o.reply_markup, tab, lang);
  if (!(o.reply_markup as any)?.inline_keyboard?.length) delete o.reply_markup;
  return sendText(env, chatId, text, o);
}
