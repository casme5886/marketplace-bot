/**
 * 🌐 Tillar: o'zbek (uz), rus (ru), xitoy (zh).
 * Til `lang:{uid}` da saqlanadi — botda /start da tanlanadi, ilovada ham o'zgartiriladi (bitta joy, ikkalasida amal qiladi).
 * Bildirishnomalar o'zbekcha shablonlardan iboralar bo'yicha tarjima qilinadi.
 */
import type { Env } from "./types";

export type Lang = "uz" | "ru" | "zh";
export const LANGS: Lang[] = ["uz", "ru", "zh"];
export const LANG_NAME: Record<Lang, string> = { uz: "🇺🇿 O'zbekcha", ru: "🇷🇺 Русский", zh: "🇨🇳 中文" };

export async function getLang(env: Env, uid: number): Promise<Lang> {
  const l = await env.STATE.get(`lang:${uid}`);
  return (LANGS as string[]).includes(l ?? "") ? (l as Lang) : "uz";
}
export async function hasLang(env: Env, uid: number): Promise<boolean> {
  return !!(await env.STATE.get(`lang:${uid}`));
}
export async function setLang(env: Env, uid: number, l: string): Promise<Lang> {
  const v = ((LANGS as string[]).includes(l) ? l : "uz") as Lang;
  await env.STATE.put(`lang:${uid}`, v);
  return v;
}

/** Bot matnlari */
const B: Record<string, Record<Lang, string>> = {
  pick: {
    uz: "🌐 <b>Tilni tanlang</b>\nВыберите язык · 选择语言",
    ru: "🌐 <b>Выберите язык</b>",
    zh: "🌐 <b>选择语言</b>",
  },
  askPhone: {
    uz: "📱 <b>Ro'yxatdan o'tish</b>\n\nPastdagi <b>«📱 Raqamni yuborish»</b> tugmasini bosing — telefon raqamingiz bilan ro'yxatdan o'tasiz.",
    ru: "📱 <b>Регистрация</b>\n\nНажмите кнопку <b>«📱 Отправить номер»</b> внизу — вы зарегистрируетесь по номеру телефона.",
    zh: "📱 <b>注册</b>\n\n请点击下方的 <b>«📱 发送手机号»</b> 按钮，使用手机号完成注册。",
  },
  phoneBtn: { uz: "📱 Raqamni yuborish", ru: "📱 Отправить номер", zh: "📱 发送手机号" },
  ownPhone: {
    uz: "❌ Faqat <b>o'zingizning</b> raqamingizni yuboring — pastdagi tugmani bosing.",
    ru: "❌ Отправьте <b>свой</b> номер — нажмите кнопку внизу.",
    zh: "❌ 请发送<b>您本人</b>的手机号——点击下方按钮。",
  },
  regOk: { uz: "✅ Ro'yxatdan o'tdingiz!", ru: "✅ Вы зарегистрированы!", zh: "✅ 注册成功！" },
  langSet: { uz: "✅ Til: O'zbekcha", ru: "✅ Язык: Русский", zh: "✅ 语言：中文" },
  home: {
    uz: "📱 <b>MarketHub</b>\n\nBarcha amallar — <b>ilovada</b>: slot qidirish, FBS ta'minlash, buyurtmalar, yorliqlar, statistika.\n\n🔔 Bu chatga faqat bildirishnomalar keladi.",
    ru: "📱 <b>MarketHub</b>\n\nВсё — <b>в приложении</b>: поиск слотов, поставки FBS, заказы, этикетки, статистика.\n\n🔔 В этот чат приходят только уведомления.",
    zh: "📱 <b>MarketHub</b>\n\n所有操作都在<b>应用</b>中完成：抢仓位、FBS 发货、订单、标签、统计。\n\n🔔 此聊天只接收通知。",
  },
  openApp: { uz: "📱 Ilovani ochish", ru: "📱 Открыть приложение", zh: "📱 打开应用" },
  openIn: { uz: "📱 Ilovada ochish", ru: "📱 Открыть в приложении", zh: "📱 在应用中打开" },
};
export const bt = (l: Lang, k: keyof typeof B | string) => (B[k] ?? {})[l] ?? B[k]?.uz ?? k;

/** Butun shablonlar (avval) — [regex, ru, zh] */
const T: [RegExp, string, string][] = [
  [/Obunangiz <b>([^<]+)<\/b> gacha uzaytirildi\. Rahmat!/g, "Ваша подписка продлена до <b>$1</b>. Спасибо!", "您的订阅已延长至 <b>$1</b>。谢谢！"],
  [/Obunangiz <b>([^<]+)<\/b> da tugaydi\. Slot kuzatuvi to'xtamasligi uchun uzaytiring\./g, "Ваша подписка заканчивается <b>$1</b>. Продлите, чтобы отслеживание слотов не остановилось.", "您的订阅将于 <b>$1</b> 到期。请续订，以免仓位监控中断。"],
  [/Obunangiz tugagani uchun FBS kuzatuvi to'xtatildi\./g, "Подписка закончилась — отслеживание FBS остановлено.", "订阅已到期，FBS 监控已停止。"],
  [/Obunangiz tugagani uchun № ([^\n<]+) kuzatuvi to'xtatildi\./g, "Подписка закончилась — отслеживание № $1 остановлено.", "订阅已到期，№ $1 的监控已停止。"],
  [/soat <b>([^<]+)<\/b> gacha yetkazing/g, "доставьте до <b>$1</b>", "请在 <b>$1</b> 前送达"],
  [/soat <b>([^<]+)<\/b> gacha/g, "до <b>$1</b>", "<b>$1</b> 前"],
  [/Yana <b>(\d+)<\/b> ta buyurtmaga joy topilmadi\./g, "Ещё для <b>$1</b> заказов место не найдено.", "还有 <b>$1</b> 个订单未找到位置。"],
  [/(\d+) ta buyurtma/g, "$1 заказ(ов)", "$1 个订单"],
  [/(\d+) oy/g, "$1 мес.", "$1 个月"],
];

/** Bildirishnoma iboralari: [o'zbekcha, ruscha, xitoycha] — uzunroqlari oldin */
const P: [string, string, string][] = [
  ["Avtomatik band qilindi!", "Слот забронирован автоматически!", "已自动预约成功！"],
  ["Olib borasiz:", "Куда везти:", "送货地点："],
  ["Vaqtdan 1 soat oldin eslataman.", "Напомню за 1 час до времени.", "我会提前 1 小时提醒您。"],
  ["Eslatma: topshirish vaqti yaqinlashdi!", "Напоминание: время сдачи приближается!", "提醒：交货时间快到了！"],
  ["FBS: bo'sh vaqt ochildi!", "FBS: появилось свободное время!", "FBS：出现空闲时段！"],
  ["(avtomatik yaratib bo'lmadi)", "(не удалось создать автоматически)", "（无法自动创建）"],
  ["Tezroq tanlang 👇 Yangi vaqt ochilsa yana xabar beraman.", "Выберите быстрее 👇 Сообщу, если появится новое время.", "请尽快选择 👇 有新时段时我会再通知您。"],
  ["FBS kuzatuvi to'xtadi: belgilangan buyurtmalar endi «Yig'ishdagilar»da emas.", "Отслеживание FBS остановлено: выбранные заказы больше не в «Сборке».", "FBS 监控已停止：所选订单已不在「拣货中」。"],
  ["FBS avtomatik bron muddati tugadi:", "Срок автобронирования FBS истёк:", "FBS 自动预约已到期："],
  ["uchun joy chiqmadi.", "— мест не появилось.", "没有出现空位。"],
  ["Yaratilmadi:", "Не создано:", "未创建："],
  ["masofa noma'lum", "расстояние неизвестно", "距离未知"],
  ["1-punktdan", "от 1-го пункта", "距第 1 个点"],
  [" — uzoqroq", " — дальше", " — 较远"],
  ["To'lov cheki tasdiqlanmadi.", "Чек об оплате не подтверждён.", "付款凭证未通过审核。"],
  ["Savol bo'lsa, admin bilan bog'laning.", "Если есть вопросы — свяжитесь с админом.", "如有疑问，请联系管理员。"],
  ["Yangi FBS buyurtma", "Новый заказ FBS", "新的 FBS 订单"],
  ["Yangi buyurtma", "Новый заказ", "新订单"],
  ["Muddati:", "Срок:", "期限："],
  ["Summa:", "Сумма:", "金额："],
  ["dona", "шт", "件"],
  ["so'm", "сум", "苏姆"],
  ["Dushanba", "Понедельник", "星期一"],
  ["Seshanba", "Вторник", "星期二"],
  ["Chorshanba", "Среда", "星期三"],
  ["Payshanba", "Четверг", "星期四"],
  ["Juma", "Пятница", "星期五"],
  ["Shanba", "Суббота", "星期六"],
  ["Yakshanba", "Воскресенье", "星期日"],
  ["bugun", "сегодня", "今天"],
  ["ertaga", "завтра", "明天"],
];
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SORTED = [...P].sort((a, b) => b[0].length - a[0].length).map((p) => ({ re: new RegExp(`(?<![\\p{L}'])${esc(p[0])}(?![\\p{L}'])`, "gu"), ru: p[1], zh: p[2] }));

/** Bildirishnomani foydalanuvchi tiliga o'girish (HTML teglari saqlanadi) */
export function trText(l: Lang, html: string): string {
  if (l === "uz" || !html) return html;
  let h = html;
  for (const [re, ru, zh] of T) h = h.replace(re, l === "ru" ? ru : zh);
  // Teglar ichiga tegmaslik uchun: faqat matn bo'laklarini almashtiramiz
  return h.replace(/(^|>)([^<]+)/g, (_m, a: string, txt: string) => {
    let t = txt;
    for (const p of SORTED) t = t.replace(p.re, l === "ru" ? p.ru : p.zh);
    return a + t;
  });
}
