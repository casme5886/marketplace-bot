/**
 * ☁️ Cloudflare rejimi: butun bot bitta Durable Object ichida ishlaydi.
 *  - Ma'lumotlar DO'ning SQLite xotirasida (bepul tarifda KV yozish limiti 1000/kun — bizga kam).
 *  - Alarm har 10 soniyada: FBO/qaytarish va FBS avto bron tekshiruvlari.
 *  - Har daqiqada: Ozon/WB buyurtmalari, Uzum FBS yangi buyurtmalar, eslatmalar; 30 daqiqada — qoldiq; 09:00 — hisobot.
 */
import type { Env } from "./types";
import { handleUpdate, syncCommands } from "./index";
import { tg } from "./telegram";
import { pollAll, sendDailyReport } from "./orders";
import { checkWatches } from "./uzumui";
import { checkStock, checkUzumNewFbs } from "./uzumalerts";
import { checkReminders } from "./reminders";
import { pollClients, subReminders } from "./clients";
import { uzumEnabled } from "./uzum";
import { handleWeb, isWebPath, setMiniAppUrl } from "./webapp";

/** KVNamespace bilan bir xil interfeys — SQLite ustida */
class SqlKV {
  constructor(private sql: any) {
    sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, m TEXT, e INTEGER)");
  }
  async get(k: string): Promise<string | null> {
    const r: any = this.sql.exec("SELECT v, e FROM kv WHERE k = ?", k).toArray()[0];
    if (!r) return null;
    if (r.e && r.e < Date.now()) {
      this.sql.exec("DELETE FROM kv WHERE k = ?", k);
      return null;
    }
    return r.v as string;
  }
  async put(k: string, v: string, o: { expirationTtl?: number; metadata?: unknown } = {}) {
    this.sql.exec(
      "INSERT OR REPLACE INTO kv (k, v, m, e) VALUES (?, ?, ?, ?)",
      k,
      String(v),
      o.metadata === undefined ? null : JSON.stringify(o.metadata),
      o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null,
    );
  }
  async delete(k: string) {
    this.sql.exec("DELETE FROM kv WHERE k = ?", k);
  }
  async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const prefix = o.prefix ?? "";
    const rows: any[] = this.sql.exec("SELECT k, m FROM kv WHERE substr(k, 1, ?) = ? AND (e IS NULL OR e > ?) ORDER BY k", prefix.length, prefix, Date.now()).toArray();
    return { keys: rows.map((r) => ({ name: r.k as string, metadata: r.m ? JSON.parse(r.m) : undefined })), list_complete: true, cursor: "" };
  }
  cleanup() {
    this.sql.exec("DELETE FROM kv WHERE e IS NOT NULL AND e < ?", Date.now());
  }
}

const TICK = 10_000;
const log = (what: string) => (e: unknown) => console.log(what, (e as Error)?.message ?? e);

export class BotDO {
  private env: Env;
  private kv: SqlKV;
  private busy = false;
  private lastMin = 0;

  constructor(private ctx: any, env: Env) {
    this.kv = new SqlKV(ctx.storage.sql);
    this.env = { ...env, STATE: this.kv as unknown as KVNamespace };
  }

  private async ensureAlarm() {
    const a = await this.ctx.storage.getAlarm();
    if (!a || a < Date.now() - 60_000) await this.ctx.storage.setAlarm(Date.now() + TICK);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.ensureAlarm();
    if (isWebPath(url.pathname)) return handleWeb(this.env, req);
    if (url.pathname === "/webhook") {
      const u: any = await req.json();
      this.ctx.waitUntil(handleUpdate(this.env, u).catch(log("update xato:")));
      return new Response("ok");
    }
    if (url.pathname === "/setup") {
      const origin = req.headers.get("x-origin") ?? url.origin;
      await tg(this.env, "setWebhook", {
        url: `${origin}/webhook`,
        secret_token: this.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "widget_query", "pre_checkout_query"],
        drop_pending_updates: false,
      });
      await syncCommands(this.env).catch(log("commands:"));
      await setMiniAppUrl(this.env, `${origin}/app`).catch(log("mini app:"));
      return new Response("✅ Webhook o'rnatildi. Bot Cloudflare'da ishlayapti. 📱 Ilova: " + origin + "/app");
    }
    if (url.pathname === "/import" && req.method === "POST") {
      // Kompyuterdagi .local-kv.json dan ko'chirish: { key: {v, e?, m?} }
      const data: Record<string, { v: string; e?: number; m?: unknown }> = await req.json();
      let n = 0;
      for (const [k, x] of Object.entries(data)) {
        if (x.e && x.e < Date.now()) continue;
        await this.kv.put(k, x.v, { metadata: x.m, expirationTtl: x.e ? Math.max(60, Math.round((x.e - Date.now()) / 1000)) : undefined });
        n++;
      }
      return new Response(`✅ ${n} ta yozuv ko'chirildi`);
    }
    if (url.pathname === "/tick") return new Response("ok");
    return new Response("MarketHub bot ishlayapti ✅ (Cloudflare)");
  }

  async alarm() {
    try {
      await this.tick();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TICK);
    }
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    const env = this.env;
    try {
      const on = await uzumEnabled(env).catch(() => false);
      // Har 10 s: FBO/qaytarish + FBS avto bron
      if (on) await checkWatches(env).catch(log("slot xato:"));
      // Har daqiqada
      if (Date.now() - this.lastMin >= 60_000) {
        this.lastMin = Date.now();
        await Promise.allSettled([pollAll(env), on ? checkUzumNewFbs(env) : 0, checkReminders(env), subReminders(env), pollClients(env)]);
        this.kv.cleanup();
        // 30 daqiqada bir — qoldiq
        const ls = Number((await this.kv.get("stock:last")) ?? 0);
        if (on && Date.now() - ls >= 30 * 60_000) {
          await this.kv.put("stock:last", String(Date.now()));
          await checkStock(env).catch(log("qoldiq xato:"));
        }
        // 09:00 (Toshkent) — kunlik hisobot
        const t = new Date(Date.now() + 5 * 3600e3);
        const day = t.toISOString().slice(0, 10);
        if (t.getUTCHours() === 9 && (await this.kv.get("report:day")) !== day) {
          await this.kv.put("report:day", day);
          await sendDailyReport(env).catch(log("hisobot xato:"));
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
