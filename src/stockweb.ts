import type { Env } from "./types";
import { catalog, forgetLast, loadConf, loadItems, loadLog, saveConf, saveItems, score, stockSync, type Listing, type Master } from "./fbsstock";

/** Mini App «🏬 FBS ombor» API (faqat egasi uchun) */

const MPN: Record<string, string> = { uz: "Uzum", oz: "Ozon", wb: "WB" };
const lview = (l: Listing | undefined, k: string) =>
  l ? { k, mp: l.mp, shop: l.shop, code: l.code, title: l.title, qty: l.qty, img: l.img } : { k, mp: k.slice(0, 2), shop: MPN[k.slice(0, 2)] ?? "", code: k.slice(3), title: "(topilmadi)", qty: null };

export async function stockApi(env: Env, sub: string, q: URLSearchParams, body: any): Promise<Record<string, unknown>> {
  const items = await loadItems(env);
  const find = (id: string) => {
    const m = items.find((x) => x.id === id);
    if (!m) throw new Error("Mahsulot topilmadi");
    return m;
  };
  if (sub === "" || sub === "/") {
    const { list, errs } = await catalog(env, q.get("force") === "1");
    const byK = new Map(list.map((l) => [l.k, l]));
    const linked = new Set(items.flatMap((m) => m.links));
    const conf = await loadConf(env);
    return {
      ok: true,
      conf: { on: conf.on, lastRun: conf.lastRun ?? null, lastErr: conf.lastErr ?? [] },
      errs,
      items: items.map((m) => ({ ...m, links: m.links.map((k) => lview(byK.get(k), k)) })),
      free: { uz: list.filter((l) => l.mp === "uz" && !linked.has(l.k)).length, oz: list.filter((l) => l.mp === "oz" && !linked.has(l.k)).length, wb: list.filter((l) => l.mp === "wb" && !linked.has(l.k)).length },
      total: { uz: list.filter((l) => l.mp === "uz").length, oz: list.filter((l) => l.mp === "oz").length, wb: list.filter((l) => l.mp === "wb").length },
      log: (await loadLog(env)).slice(0, 15),
    };
  }
  if (sub === "/cand") {
    const { list } = await catalog(env);
    const linked = new Set(items.flatMap((m) => m.links));
    const m = q.get("id") ? items.find((x) => x.id === q.get("id")) : null;
    const text = String(q.get("q") ?? "").trim().toLowerCase();
    const mp = String(q.get("mp") ?? "");
    let c = list.filter((l) => !linked.has(l.k) && (!mp || l.mp === mp));
    if (text) c = c.filter((l) => (l.title + " " + l.code + " " + l.shop).toLowerCase().includes(text));
    const name = m ? m.name + " " + m.links.map((k) => list.find((l) => l.k === k)?.code ?? "").join(" ") : "";
    const scored = c.map((l) => ({ l, s: name ? score(name, l) : 0 })).sort((a, b) => b.s - a.s || (b.l.qty ?? 0) - (a.l.qty ?? 0));
    return { ok: true, list: scored.slice(0, 60).map((x) => ({ ...lview(x.l, x.l.k), s: Math.round(x.s * 100) })) };
  }
  if (sub !== "/act") throw new Error("Noma'lum so'rov");
  const act = String(body.act ?? "");
  const conf = await loadConf(env);
  const sync = async (ids: string[]) => {
    if (!conf.on) return "";
    const r = await stockSync(env, { only: ids, force: true, manual: true });
    return r.errors.length ? " · ⚠️ " + r.errors[0] : " · marketlarga yozildi";
  };
  switch (act) {
    case "toggle": {
      conf.on = !conf.on;
      await saveConf(env, conf);
      if (conf.on) {
        const r = await stockSync(env, { force: true, manual: true });
        return { ok: true, msg: "✅ Sinxronlash yoqildi" + (r.errors.length ? " · ⚠️ " + r.errors[0] : "") };
      }
      return { ok: true, msg: "⏸ Sinxronlash to'xtatildi" };
    }
    case "sync": {
      const r = await stockSync(env, { force: true, manual: true });
      return { ok: true, msg: r.errors.length ? "⚠️ " + r.errors.slice(0, 2).join(" · ") : "✅ Hammasi marketlarga yozildi" };
    }
    case "create": {
      // Tanlangan kartochkadan yangi mahsulot (qoldiq — shu kartochkadagi FBS qoldiq)
      const { list } = await catalog(env);
      const l = list.find((x) => x.k === String(body.k));
      if (!l) throw new Error("Kartochka topilmadi");
      if (items.some((m) => m.links.includes(l.k))) throw new Error("Bu kartochka allaqachon bog'langan");
      const m: Master = { id: Math.random().toString(36).slice(2, 10), name: l.title.slice(0, 80), qty: Math.max(0, l.qty ?? 0), links: [l.k], on: true, img: l.img };
      items.unshift(m);
      await saveItems(env, items);
      await forgetLast(env, [l.k]);
      return { ok: true, msg: "Mahsulot qo'shildi", id: m.id };
    }
    case "bulk": {
      // Uzum'dagi FBS qoldig'i bor, bog'lanmagan hamma kartochkadan mahsulot yaratish
      const { list } = await catalog(env);
      const linked = new Set(items.flatMap((m) => m.links));
      const add = list.filter((l) => l.mp === "uz" && !linked.has(l.k) && (l.qty ?? 0) > 0);
      for (const l of add) items.push({ id: Math.random().toString(36).slice(2, 10), name: l.title.slice(0, 80), qty: l.qty ?? 0, links: [l.k], on: true, img: l.img });
      await saveItems(env, items);
      await forgetLast(env, add.map((l) => l.k));
      return { ok: true, msg: `${add.length} ta mahsulot qo'shildi` };
    }
    case "link": {
      const m = find(String(body.id));
      const k = String(body.k);
      // Boshqa mahsulotga bog'langan bo'lsa — o'sha yerdan olib, bo'sh qolsa o'sha mahsulotni o'chiramiz
      for (const o of items) if (o !== m && o.links.includes(k)) o.links = o.links.filter((x) => x !== k);
      if (!m.links.includes(k)) m.links.push(k);
      const left = items.filter((o) => o === m || o.links.length);
      await saveItems(env, left);
      await forgetLast(env, [k]);
      return { ok: true, msg: "Bog'landi" + (await sync([m.id])) };
    }
    case "unlink": {
      const m = find(String(body.id));
      m.links = m.links.filter((x) => x !== String(body.k));
      await saveItems(env, items);
      await forgetLast(env, [String(body.k)]);
      return { ok: true, msg: "Uzildi" };
    }
    case "set":
    case "add": {
      const m = find(String(body.id));
      const n = Math.round(Number(body.n));
      if (!Number.isFinite(n)) throw new Error("Son noto'g'ri");
      m.qty = Math.max(0, act === "set" ? n : m.qty + n);
      await saveItems(env, items);
      return { ok: true, msg: `Qoldiq: ${m.qty} ta` + (await sync([m.id])) };
    }
    case "rename": {
      const m = find(String(body.id));
      const n = String(body.name ?? "").trim().slice(0, 80);
      if (n) m.name = n;
      await saveItems(env, items);
      return { ok: true, msg: "Saqlandi" };
    }
    case "onoff": {
      const m = find(String(body.id));
      m.on = !m.on;
      await saveItems(env, items);
      return { ok: true, msg: m.on ? "Sinxronlash yoqildi" : "Bu mahsulot sinxronlanmaydi" };
    }
    case "del": {
      const m = find(String(body.id));
      await saveItems(env, items.filter((x) => x !== m));
      await forgetLast(env, m.links);
      return { ok: true, msg: "O'chirildi" };
    }
  }
  throw new Error("Noma'lum amal");
}
