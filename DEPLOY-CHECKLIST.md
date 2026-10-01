# Jaipur Online — چک‌لیست دیپلوی بدون خطا (Cloudflare Workers + GitHub)

> ترتیب این مراحل مهم است. اگر دقیقاً همین‌طور بروی، هیچ‌کدام از خطاهای قبلی
> (`binding DB of type d1 must have a valid database_id`، `missing secrets` و …) دیگر پیش نمی‌آید.

## ۰) چیزهایی که باید از قبل درست باشند

| مورد | مقدار درست |
|---|---|
| نام Worker در داشبورد Cloudflare | دقیقاً `jaipur-online` (هم‌نام `name` در `wrangler.jsonc`) |
| دیتابیس D1 | یک دیتابیس به نام `jaipur-db` که قبلاً ساخته‌ای. `database_id` آن باید با `wrangler.jsonc` یکی باشد |
| Build command (در Settings → Build) | `npm run build` (اگر خالی هم باشد مشکلی نیست، چون خود `wrangler.jsonc` بیلد را اجرا می‌کند) |
| Deploy command | `npx wrangler deploy` |

شناسه دیتابیس را از اینجا ببین: **Cloudflare → Storage & Databases → D1 → jaipur-db → Database ID**.
باید با این مقدار در `wrangler.jsonc` برابر باشد (و در پروژه ربات هم همین مقدار):

```
f509869b-2118-4f98-900d-4fa838260cfe
```

اگر دیتابیس تو شناسه دیگری دارد، فقط همین یک خط را در **هر دو** پروژه عوض کن.

## ۱) آپلود در GitHub
تمام محتوای همین پوشه (به‌جز `node_modules`, `dist`, `.wrangler`) را در مخزن `jaipur_Online` جایگزین کن
(فایل `package-lock.json` را هم حتماً آپلود کن).

## ۲) دیپلوی
Push که انجام شد، Cloudflare خودش Build و Deploy می‌کند.
**نیازی نیست جدول‌ها را دستی بسازی؛** Worker در اولین درخواست همه جدول‌های لازم را خودش می‌سازد
(`worker/schema.ts`). این کار بی‌خطر است و چندبار اجرا شدنش مشکلی ایجاد نمی‌کند.

## ۳) تعریف Secret (بعد از اولین دیپلوی موفق)
**Worker → Settings → Variables and Secrets → Add → نوع Secret**

| نام | مقدار |
|---|---|
| `ADMIN_API_TOKEN` | یک رشته تصادفی طولانی (مثلاً ۳۲+ کاراکتر). همین مقدار را بعداً در ربات هم می‌گذاری |

(اختیاری) متغیر معمولی `TURN_SECONDS` = مدت هر نوبت به ثانیه (۱۰ تا ۳۰۰، پیش‌فرض ۶۰).

> چرا `secrets.required` را از `wrangler.jsonc` برداشتیم؟ چون وقتی Secret هنوز تعریف نشده،
> همان دیپلوی اول شکست می‌خورد (مشکل «مرغ و تخم‌مرغ»). حالا اول دیپلوی می‌شود، بعد Secret می‌گذاری.

## ۴) تست سلامت
مرورگر را باز کن:

```
https://jaipur-online.<ساب‌دامین-تو>.workers.dev/api/health?deep=1
```

باید چیزی شبیه این ببینی: `{"ok":true,...,"db":true,"users":0,"adminTokenSet":true}`

- `db:false` → `database_id` اشتباه است یا D1 به این Worker وصل نیست.
- `adminTokenSet:false` → Secret مرحله ۳ را هنوز نگذاشته‌ای (بازی کار می‌کند، فقط آمار آنلاین در ربات صفر می‌ماند).

## ۵) تست کامل
1. صفحه بازی را باز کن و کاربر A بساز.
2. در پنجره ناشناس کاربر B بساز.
3. A اتاق می‌سازد، B با کد وارد می‌شود.
4. تایمر نوبت (حلقه کنار «Your turn») باید شروع به شمارش کند. اگر نوبتت را رها کنی، بعد از پایان تایمر نوبت به حریف می‌رسد.
5. بعد از اتمام بازی در ربات `/admin` → آمار و بازی‌های اخیر را ببین.

## ۶) رفع خطاهای رایج

| پیام | علت و راه‌حل |
|---|---|
| `binding DB of type d1 must have a valid database_id` | `database_id` در `wrangler.jsonc` placeholder است. شناسه واقعی D1 را بگذار |
| `Worker name mismatch / name differs` | نام Worker در داشبورد باید `jaipur-online` باشد |
| `The directory specified by the "assets.directory" field ... does not exist` | Build اجرا نشده. این نسخه خودش `npm run build` را اجرا می‌کند؛ مطمئن شو `package.json` و `vite.config.ts` آپلود شده‌اند |
| `npm ci` خطای sync می‌دهد | `package-lock.json` را همراه `package.json` آپلود کن |
| `Authentication required` در بازی | کوکی پاک شده؛ دوباره وارد شو |
| WebSocket وصل نمی‌شود | از `workers.dev` یا دامنه HTTPS باز کن؛ VPN/افزونه‌های مسدودکننده را بررسی کن |
