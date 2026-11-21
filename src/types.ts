export interface Env {
  STATE: KVNamespace;
  /** Cloudflare: botning asosiy Durable Object'i (ma'lumotlar SQLite'da) */
  BOT?: DurableObjectNamespace;
  // Secrets (wrangler secret put ...)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_LOGIN: string;
  ADMIN_PASSWORD: string;
  SETUP_KEY: string;
  OZON_CLIENT_ID?: string;
  OZON_API_KEY?: string;
  WB_API_TOKEN?: string;
  // Vars (wrangler.toml)
  TIMEZONE_OFFSET_HOURS?: string; // Toshkent = 5
  REMIND_BEFORE_HOURS?: string; // muddatdan necha soat oldin eslatish
  UZUM_LOGIN?: string; // Uzum kabinetiga kirish (telefon)
  UZUM_PASSWORD?: string;
  UZUM_REFRESH_TOKEN?: string; // ixtiyoriy, login/parol o'rniga
  UZUM_SHOPS?: string; // ko'rsatiladigan do'konlar ID lari, vergul bilan
  WB_STATS_CURRENCY?: string;
  PAYMENT_PROVIDER_TOKEN?: string; // Telegram Payments (Click/Payme) — BotFather'dan
  ADMIN_TELEGRAM_ID?: string; // ixtiyoriy: asosiy admin Telegram ID (bot ichidagi sozlamadan ustun)
  RESTART?: () => Promise<void>; // faqat lokal rejimda: jarayonni qayta ishga tushirish // WB statistikasidagi narx valyutasi (standart: RUB)
}

export type Marketplace = "ozon" | "wb";

export interface OrderItem {
  name: string;
  article: string;
  qty: number;
}

/** Ikkala marketpleys uchun yagona buyurtma ko'rinishi */
export interface Order {
  mp: Marketplace;
  id: string; // Ozon: posting_number, WB: order id
  status: string; // marketpleysdagi asl holat
  items: OrderItem[];
  price: number; // so'mda (yoki currency)
  currency: string;
  city: string; // qayerga ketmoqda
  createdAt: string; // ISO
  deadline?: string; // ISO, topshirish muddati (Ozon shipment_date)
  canShip: boolean; // "Yig'ish" tugmasi mumkinmi
  readyToHandover?: boolean; // yig'ilgan, topshirishga tayyor
  deliveryMethodId?: number; // Ozon: yetkazib berish usuli (jo'natma yaratish uchun)
}

export interface StoredOrder {
  order: Order;
  chatMessages: { chatId: number; messageId: number; widget: boolean }[];
  reminded?: boolean;
  overdueNotified?: boolean;
  shipped?: boolean;
  supply?: string; // WB: qaysi postavkaga qo'shilgan
  handed?: string; // Ozon: jo'natma (carriage) raqami, WB: topshirilgan postavka raqami
  cancelled?: boolean;
}
