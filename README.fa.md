# فیت‌فلو

یک MVP فول‌استک برای مدیریت ارتباط مربی و شاگرد، کاملاً راست‌چین و قابل نصب به‌صورت PWA.

## امکانات

- دو نقش مربی و شاگرد با Better Auth
- مدیریت شاگردان و رابطه مربی/شاگرد
- کتابخانه حرکات با آپلود تصویر یا ویدیو در S3/MinIO
- برنامه‌ساز تمرینی با روز هفته، ست، تکرار، وزن و استراحت
- اجرای روزانه برنامه به‌صورت Todo و ثبت عملکرد واقعی
- صف IndexedDB برای همگام‌سازی Todo در حالت آفلاین
- دانلود کنترل‌شدهٔ تصویر و ویدیوی تمرین برای مشاهده آفلاین
- ثبت تاریخچه وضعیت جسمانی و نمودارهای پیشرفت
- PostgreSQL، Drizzle ORM، migration و seed آماده

## اجرای سریع

پیش‌نیاز: Node.js 22.12 یا جدیدتر و Docker.

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:push
# ابتدا ADMIN_NAME و ADMIN_EMAIL و ADMIN_PASSWORD را در فایل .env مقداردهی کنید.
npm run db:seed
npm run dev
```

Compose سرور MinIO و ابزار `mc` را از نسخه‌های مشخص سورس رسمی می‌سازد، چون ایمیج‌های آمادهٔ قبلی
دیگر به‌صورت عمومی در دسترس نیستند. اجرای اول برای دانلود وابستگی‌های Go و کامپایل زمان می‌برد؛
اجراهای بعدی از ایمیج‌های محلی استفاده می‌کنند. بعد از تغییر Dockerfile فرمان
`docker compose up -d --build` را اجرا کنید. ساخت bucket پس از آماده‌شدن MinIO انجام می‌شود.

سپس این آدرس‌ها در دسترس هستند:

- وب: `http://localhost:5173`
- API: `http://localhost:3000`
- پنل MinIO: `http://localhost:9001`

## اجرای production

دامنهٔ production را در `.env` تنظیم کنید؛ از جمله `NODE_ENV=production`، `WEB_ORIGIN` و
`BETTER_AUTH_URL`. مقدار `VITE_API_URL=` را خالی بگذارید تا وب و API از یک دامنه سرو شوند. سپس اجرا
کنید:

```bash
npm run start
```

این فرمان فرانت‌اند را build می‌کند، خروجی را جایگزین `apps/api/public` می‌کند، API را build و سپس
اجرا می‌کند. migrationهای دیتابیس و سرویس‌های Docker عمداً جداگانه مدیریت می‌شوند.

## ساخت حساب مربی اصلی

مقادیر `ADMIN_NAME`، `ADMIN_EMAIL` و `ADMIN_PASSWORD` را در فایل `.env` تنظیم و سپس
`npm run db:seed` را اجرا کنید. این فرمان فقط همان حساب را با نقش `coach` ایجاد یا به‌روزرسانی
می‌کند و هیچ شاگرد، حرکت، برنامه تمرینی یا گزارش نمونه‌ای نمی‌سازد. رمز عبور نیز در خروجی چاپ
نمی‌شود.

## فرمان‌ها

در صفحهٔ «حرکات»، دکمهٔ «آرشیو حرکات» فهرست حرکت‌های آرشیوشده را باز می‌کند. هر حرکت را می‌توان به
فهرست فعال بازگرداند یا همراه فایل‌های رسانه برای همیشه حذف کرد. حذف دائمی برای حرکتی که در برنامهٔ
تمرینی استفاده شده مسدود است تا سابقهٔ برنامه و تمرین حفظ شود.

app مستقل [دریافت داده‌ی اولیه](apps/initial-data/README.md) برای دریافت و import بانک حرکات مسترجیم
همراه ویدیو و SVG عضلات است. ابتدا تنظیمات مستقل آن را مقداردهی کنید:

```bash
npx playwright install chromium
cp apps/initial-data/.env.example apps/initial-data/.env
vp run initial-data:sync
```

راهنمای دریافت مستقل، import یک‌فرمانی، انتخاب مربی و ادامهٔ دانلود در
[راهنمای بانک حرکات](apps/initial-data/README.md) آمده است.

```bash
npm run dev
npm run build
npm run typecheck
npm run db:generate
npm run db:push
npm run db:migrate
npm run db:seed
npm run verify:structure
```

تست API آرشیو و حذف دائمی با `vp run @akiraminafit/api#test` اجرا می‌شود. ابتدا
`EXERCISE_TEST_DATABASE_URL` را به یک دیتابیس موقت با نام منتهی به `_test` و جداول آمادهٔ پروژه
تنظیم کنید؛ بدون این متغیر، تست دیتابیس اجرا نمی‌شود.

## نکات production

- bucket رسانه را private کنید و signed read URL برگردانید.
- برای قابلیت دانلود آفلاین رسانه، `MINIO_API_CORS_ALLOW_ORIGIN` را روی origin وب‌سایت (مثلاً
  `https://akiraminafit.ir`) بگذارید و اجازهٔ `GET` و `HEAD` را در CORS bucket حفظ کنید.
- برای ویدیوها اسکن بدافزار، transcoding و thumbnail generation اضافه کنید.
- HTTPS، secret قوی، rate limiting و backup مدیریت‌شده PostgreSQL فعال شود.
- دسترسی عمومی MinIO در `docker-compose.yml` فقط برای توسعه محلی است.
