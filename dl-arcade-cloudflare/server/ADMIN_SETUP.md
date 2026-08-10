# Включить админ-панель Pixel Battle в Cloudflare

Админка остаётся закрытой (`503`), пока Worker не получил полный набор из четырёх секретов.

## 1. Сначала задеплой Worker

Из `dl-arcade-cloudflare`:

```powershell
npx wrangler login
npm run deploy:worker
```

Сохрани URL из вывода, например:

```text
https://dl-arcade-cloudflare.example.workers.dev
```

## 2. Создай GitHub OAuth App

Открой https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**.

- Application name: `DL Arcade Admin`
- Homepage URL: URL Worker без завершающего `/`
- Authorization callback URL: `<URL Worker>/admin/auth/callback`

Если используешь Custom Domain, указывай его и в Homepage, и в callback. Скопируй Client ID и
сгенерированный Client secret.

## 3. Запиши секреты

Каждая команда спросит значение интерактивно и не запишет его в Git:

```powershell
npx wrangler secret put GITHUB_CLIENT_ID --config server/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config server/wrangler.jsonc
npx wrangler secret put ADMIN_GITHUB_ID --config server/wrangler.jsonc
npx wrangler secret put ADMIN_SESSION_SECRET --config server/wrangler.jsonc
```

`ADMIN_GITHUB_ID` — стабильный числовой GitHub id, не логин. Узнать его можно по полю `id` в:

```text
https://api.github.com/users/<твой_логин>
```

Сгенерировать 64-символьный session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Опционально для Mapillary:

```powershell
npx wrangler secret put MG_MAPILLARY_TOKEN --config server/wrangler.jsonc
```

Без Mapillary GeoGuesser продолжит работать на Panoramax-локациях из встроенного пула.

## 4. Проверка

```powershell
curl.exe -I https://<твой-host>/admin
```

Ожидается `302` на GitHub. `503 Admin authentication is not configured` означает, что отсутствует
хотя бы один из четырёх обязательных секретов или `ADMIN_SESSION_SECRET` короче 32 символов.

После OAuth callback допускается только аккаунт с точным числовым `ADMIN_GITHUB_ID`. Сессия живёт
8 часов в `HttpOnly; Secure` cookie. GitHub access token после проверки пользователя не хранится.

## Локальная разработка

Скопируй `server/.dev.vars.example` в `server/.dev.vars`, впиши тестовые значения и запусти:

```powershell
npm run dev:worker
```

`server/.dev.vars` игнорируется Git. Не используй production OAuth secret в общем или
синхронизируемом рабочем каталоге.
