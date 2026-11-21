# Marketpleys buyurtmalar boti (Ozon + Wildberries → Telegram)

Ozon va Wildberries'dan kelgan **FBS buyurtmalar** haqida Telegram'ga xabar beradi va ularni boshqarishga imkon beradi. Bot **Cloudflare Workers**'da **tekin** ishlaydi, server yoki VPS kerak emas.

## Nima qiladi

- 🔔 **Yangi buyurtma** kelsa, xabar ichida interaktiv kartochka yuboradi (Telegram Bot API 10.4 "widget"). Kartochkada: tovar, soni, narx, **qaysi shaharga ketyapti**, topshirish muddati.
  - Agar Telegram ilovangiz vidjetni hali qo'llab-quvvatlamasa, oddiy xabar va tugmalar keladi.
- ✅ **"Yig'ishga olish"** tugmasi:
  - Ozon: buyurtma yig'ildi deb belgilanadi (*awaiting_packaging → awaiting_deliver*).
  - WB: buyurtma bugungi postavkaga qo'shiladi (*new → confirm*).
- 🏷 **"Yorliq"** tugmasi: Ozon yorlig'i (PDF) yoki WB stikeri (PNG) to'g'ridan-to'g'ri chatga keladi.
- ⏰ **Eslatmalar:** muddatga 3 soat qolganda va muddat o'tib ketganda ogohlantiradi.
- 📊 **Kunlik hisobot:** har kuni soat 09:00 da (Toshkent vaqti).
- 🔐 **Login va parol:** bot faqat login qilgan foydalanuvchilarga ishlaydi.
  - Parol yozilgan xabar darhol o'chiriladi.
  - 5 marta xato kiritilsa, 30 daqiqaga bloklanadi.

Buyruqlar: `/login`, `/orders`, `/report`, `/check`, `/logout`

---

## Tezkor sinov — o'z kompyuteringizda (Cloudflare'siz)

1. `.dev.vars.example` faylidan nusxa oling va nomini `.dev.vars` qiling:
   ```powershell
   copy .dev.vars.example .dev.vars
   notepad .dev.vars
   ```
2. Faylni to'ldiring: kamida `TELEGRAM_BOT_TOKEN`, `ADMIN_LOGIN`, `ADMIN_PASSWORD`. Ozon/WB kalitlari bo'lsa, ularni ham yozing.
3. Ishga tushiring:
   ```powershell
   npm run local
   ```
4. Telegram'da botga `/login` yozing.

> Bu rejimda bot faqat terminal ochiq turganda ishlaydi. Doimiy ishlashi uchun pastdagi Cloudflare o'rnatishini bajaring. `.dev.vars` faylida maxfiy kalitlar bor: uni hech kimga yubormang.

## O'rnatish (bir marta, ~20 daqiqa)

### 0. Kerakli dasturlar
Kompyuteringizda **Node.js 18+** bo'lishi kerak. Tekshirish: `node -v`.

```powershell
cd E:\project\marketplace-bot
npm install
```

### 1. Telegram bot
1. Telegram'da **@BotFather** → `/newbot`.
2. Botga nom bering va **tokenni** saqlab qo'ying.

### 2. Ozon API kaliti
1. seller.ozon.ru → **Sozlamalar → API kalitlar → Yangi kalit**.
2. Ruxsat sifatida **"Admin read only"** emas, FBS buyurtmalar bilan ishlash (Posting FBS) huquqini bering.
3. **Client-Id** va **API key**'ni saqlab qo'ying.

### 3. Wildberries API tokeni
1. seller.wildberries.ru → **Profil → Sozlamalar → API'ga kirish → Token yaratish**.
2. Toifa sifatida **"Marketplace"**ni tanlang.
3. Tokenni saqlab qo'ying.

### 4. Cloudflare (tekin)
1. https://dash.cloudflare.com da ro'yxatdan o'ting. Karta kerak emas.
2. Terminalda:

```powershell
npx wrangler login
npx wrangler kv namespace create STATE
```

3. Chiqqan `id = "..."` qiymatini `wrangler.toml` faylidagi `BU_YERGA_KV_ID_NI_QOYING` o'rniga qo'ying.

### 5. Maxfiy kalitlarni kiritish
Har bir buyruqdan keyin terminal qiymat so'raydi. Kalitlarni **o'zingiz** kiritasiz: ular Cloudflare'da shifrlangan holda saqlanadi va hech qayerda ko'rinmaydi.

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_LOGIN
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SETUP_KEY
npx wrangler secret put OZON_CLIENT_ID
npx wrangler secret put OZON_API_KEY
npx wrangler secret put WB_API_TOKEN
```

| Kalit | Qayerdan olinadi | Izoh |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather | |
| `TELEGRAM_WEBHOOK_SECRET` | o'zingiz o'ylab topasiz | 20+ belgi; faqat harf, raqam, `_` va `-` |
| `ADMIN_LOGIN` | o'zingiz o'ylab topasiz | Botga kirish logini |
| `ADMIN_PASSWORD` | o'zingiz o'ylab topasiz | Kuchli parol: kamida 12 belgi |
| `SETUP_KEY` | o'zingiz o'ylab topasiz | Faqat 6-qadamda bir marta kerak |
| `OZON_CLIENT_ID` | 2-qadam | |
| `OZON_API_KEY` | 2-qadam | |
| `WB_API_TOKEN` | 3-qadam | |

> Agar faqat bitta marketpleysni ulasangiz, ikkinchisining kalitini kiritmang. Bot uni o'tkazib yuboradi.

### 6. Ishga tushirish

```powershell
npm run deploy
```

Terminal `https://marketplace-orders-bot.<sizning-nomingiz>.workers.dev` manzilini beradi. Brauzerda bir marta oching:

```
https://marketplace-orders-bot.<...>.workers.dev/setup?key=SETUP_KEY_qiymati
```

Sahifada "✅ Webhook va buyruqlar o'rnatildi" chiqadi.

### 7. Botga kirish
Telegram'da botingizni oching → `/login` → login → parol.
Shundan keyin yangi buyurtmalar har 3 daqiqada tekshiriladi va shu chatga keladi.

---

## Sozlamalar (`wrangler.toml`)

- `crons`: tekshirish oralig'i (standart har 3 daqiqa) va hisobot vaqti (`0 4 * * *` = 09:00 Toshkent).
- `REMIND_BEFORE_HOURS`: muddatdan necha soat oldin eslatish (standart 3).
- `WB_STATS_CURRENCY`: WB statistikasi narxlari valyutasi (standart `RUB`). Kabinetdagi summalar bilan mos kelmasa — `UZS` qiling.

## 📈 Statistika
- **Bosh menyu**: bugungi buyurtmalar soni va summasi, qaytarishlar, bekorlar + jo'natish kerak bo'lgan buyurtmalar.
- **📈 Statistika**: Bugun / Kecha / 7 kun / 30 kun — har marketpleys bo'yicha buyurtma, summa, sotib olindi, qaytarish, bekor, o'rtacha chek, top mahsulot va shaharlar.
- **🛍 Buyurtmalar ro'yxati**: qaysi tovar, qaysi shaharga, qancha, qachon va holati.
- **↩️ Qaytarishlar**, **🏆 Top mahsulotlar**, **🗺 Shaharlar**.
- Har kuni 09:00 da kechagi natijalar hisoboti keladi.
- WB statistikasi uchun tokenda **"Statistika"** toifasi belgilangan bo'lishi kerak. Ozon qaytarishlari uchun API kalitida qaytarishlarni o'qish huquqi kerak.

O'zgartirgach: `npm run deploy`.

## Loglarni ko'rish

```powershell
npx wrangler tail
```

## Keyingi bosqich
- Uzum Market FBS: yangi buyurtmalar, avtomatik tasdiqlash, kuniga 2 marta nakladnoy.
- Qoldiq tugayotganda ogohlantirish.
- Yagona marketpleys platformasiga (Next.js + Supabase) ulash.

## Tuzilma

```
src/
  index.ts     — webhook, cron, buyruqlar
  auth.ts      — login/parol, bloklash
  orders.ts    — tekshirish, eslatmalar, tugmalar, hisobot
  ozon.ts      — Ozon Seller API
  wb.ts        — Wildberries Marketplace API
  widget.ts    — xabar ichidagi vidjet (HTML)
  format.ts    — matn va vaqt formatlari
  telegram.ts  — Telegram Bot API
```

## 📦 Uzum FBO — slot olish
1. `.dev.vars` fayliga qo'shing (o'zingiz yozasiz):
   ```
   UZUM_LOGIN=998901234567
   UZUM_PASSWORD=kabinet_parolingiz
   ```
2. Botni qayta ishga tushiring → **📦 Uzum FBO** tugmasi.
3. Do'kon → nakladnoy → sana → 🌅 ertalab / 🌇 tushdan keyin → vaqt → ✅ band qilish.
4. Bo'sh slot bo'lmasa — **🔔 Bo'shashini kuzatish**: bot har 3 daqiqada tekshiradi va slot ochilganda xabar beradi.
- Ko'rinadigan do'konlar: `UZUM_SHOPS` (wrangler.toml / .dev.vars), standart: Rivo shop, Ucare, ONEURI, CASME, Tommy shop.
- Uzum rasmiy API'sida slot yo'q — bot kabinet so'rovlaridan foydalanadi. Uzum kabinetni o'zgartirsa, tuzatish kerak bo'lishi mumkin.

## ▶️ Botni bitta bosishda ishga tushirish (Windows)
- **start-bot.bat** — ikki marta bosing. Bot ishga tushadi; kod yangilansa yoki `.dev.vars` o'zgarsa — o'zi qayta yuklanadi; xato bilan to'xtasa — o'zi qayta yonadi.
- **autostart-yoqish.bat** — bir marta bosing: kompyuter yonganda bot o'zi ishga tushadi + ish stolida yorliq paydo bo'ladi.
- **autostart-ochirish.bat** — avtomatik ishga tushishni o'chiradi.
- To'xtatish: bot oynasini yoping.
