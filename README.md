# VK COIN Exchange

Стеклянный мобильный интерфейс обмена VK COIN и заготовка защищённого серверного API на Supabase.

## Файлы
- `index.html` — интерфейс пользователя и калькулятор.
- `admin.html` — закрытая панель просмотра заявок и смены статусов.
- `supabase/schema.sql` — таблица заявок с выключенным прямым доступом из браузера.
- `supabase/functions/submit-request/index.ts` — создание заявки после проверки Telegram Web App initData.
- `supabase/functions/admin-api/index.ts` — API панели администратора.

## Настройка backend
1. Создайте проект Supabase.
2. Откройте SQL Editor и выполните весь файл `supabase/schema.sql`.
3. Установите Supabase CLI и выполните вход: `supabase login`.
4. Свяжите папку проекта с Supabase: `supabase link --project-ref YOUR_PROJECT_REF`.
5. Задайте серверные секреты, не публикуя их в GitHub:
   `supabase secrets set TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN ADMIN_PASSWORD=YOUR_LONG_ADMIN_PASSWORD`
   Supabase Edge Functions используют серверные `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY`; service-role key нельзя вставлять в HTML.
6. Разверните функции:
   `supabase functions deploy submit-request`
   `supabase functions deploy admin-api`
7. В `index.html` и `admin.html` замените `https://YOUR_PROJECT_REF.supabase.co` на URL проекта и `YOUR_SUPABASE_ANON_KEY` на публичный anon/publishable key. Это единственные ключи Supabase, допустимые в браузере.
8. Настройте Telegram Mini App URL на опубликованный HTTPS-адрес сайта. Для проверки Telegram пользователя приложение должно открываться внутри Telegram Web App.
9. Опубликуйте статические файлы через GitHub Pages (Settings → Pages → Deploy from a branch → `main` → `/(root)`) или другой статический хостинг.

## Как работает доступ
- Публичный браузер не имеет прямого доступа к таблице заявок.
- Серверная функция проверяет подпись Telegram Web App initData перед созданием заявки.
- Админ API требует пароль из серверного секрета `ADMIN_PASSWORD`; вводится в `admin.html`.
- Никогда не помещайте Telegram bot token или Supabase service-role key в `index.html`, `admin.html` или другие публичные файлы.

## Важно перед реальным запуском
- Серверная часть пока является исходным кодом: её нужно развернуть в своём Supabase проекте и указать URL/anon key в двух HTML-файлах.
- Подтверждение оплаты и проверка перевода монет пока выполняются оператором вручную. Автоматические выплаты не подключены.
- Проверьте правовые требования, финансовые риски, спорные операции и защиту персональных/банковских данных до приёма реальных пользователей.
- Текущая версия рассчитывает сумму по указанным фиксированным курсам: продажа 10.76 ₽ и скупка 4.65 ₽ за 11 600.000 VK COIN.
