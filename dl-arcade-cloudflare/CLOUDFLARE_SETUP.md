# Перенос DL Arcade на Cloudflare Workers Free — пошагово

Ниже путь от чистого клона до работающего Worker и VPK. Все команды выполняются из
`D:\GitHub2\Deadlock-UI-Mods\dl-arcade-cloudflare`, если не сказано иначе.

## 0. Что уже подготовлено

- Worker: `server/worker.js` (генерируется из общих правил и `worker.core.js`).
- Один SQLite-backed Durable Object `Hub` — лобби, Pixel Battle, баны и аудит.
- Современный declarative `exports` в `server/wrangler.jsonc`; старый `migrations` не нужен.
- VPS-адаптер, Nginx, systemd, certbot и локальная SQLite из этой копии удалены.
- Polling возвращён к более экономному режиму для лимита Free.

## 1. Установить зависимости

Нужен Node.js 20+ и npm.

```powershell
npm install
npx wrangler --version
```

Затем локальные проверки:

```powershell
npm run lint
npm test
npm run deploy:worker:dry
```

Dry-run собирает настоящий Cloudflare bundle, но ничего не публикует и не требует домена.

## 2. Войти в Cloudflare

```powershell
npx wrangler login
npx wrangler whoami
```

Браузер откроет OAuth Cloudflare. Выбери нужный аккаунт. Для этих команд API token вручную не
нужен. Не коммить файлы из `.wrangler` или `.dev.vars`.

## 3. Первый deploy

```powershell
npm run deploy:worker
```

При первом deploy Cloudflare:

1. создаст Worker `dl-arcade-cloudflare`;
2. создаст SQLite namespace для класса `Hub`;
3. привяжет `HUB`;
4. выдаст адрес `https://dl-arcade-cloudflare.<твой-subdomain>.workers.dev`.

Проверь endpoint:

```powershell
curl.exe -I https://dl-arcade-cloudflare.<твой-subdomain>.workers.dev/api/ping.png
```

Нужен `HTTP 200` и `content-type: image/png`.

## 4. Прописать адрес в моде

Открой `panorama/scripts/mg_net.js` и замени:

```js
const BASE_URL = "";
```

на адрес без завершающего `/`:

```js
const BASE_URL = "https://dl-arcade-cloudflare.<твой-subdomain>.workers.dev";
```

После этого снова:

```powershell
npm run lint
npm test
```

Без этого шага UI специально пишет `Server not configured` и не шлёт запросы в несуществующий
placeholder.

## 5. Секреты и админка

Сначала создай GitHub OAuth App по `server/ADMIN_SETUP.md`, затем добавь четыре обязательных
секрета:

```powershell
npx wrangler secret put GITHUB_CLIENT_ID --config server/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config server/wrangler.jsonc
npx wrangler secret put ADMIN_GITHUB_ID --config server/wrangler.jsonc
npx wrangler secret put ADMIN_SESSION_SECRET --config server/wrangler.jsonc
```

Mapillary опционален:

```powershell
npx wrangler secret put MG_MAPILLARY_TOKEN --config server/wrangler.jsonc
```

Важно: `wrangler secret put` создаёт и сразу деплоит новую версию Worker. Значения после сохранения
не показываются обратно. Не добавляй их в `wrangler.jsonc`.

Проверка:

```powershell
curl.exe -I https://<твой-host>/admin
```

`302` — конфигурация есть; `503` — не хватает обязательного секрета.

## 6. Локально проверить Worker

Для маршрутов без OAuth достаточно:

```powershell
npm run dev:worker
```

В другом окне:

```powershell
curl.exe -I http://127.0.0.1:8787/api/ping.png
```

Для локальной админки скопируй `server/.dev.vars.example` в `server/.dev.vars` и впиши тестовые
значения. Этот файл уже игнорируется Git.

## 7. Собрать VPK

Из корня `D:\GitHub2\Deadlock-UI-Mods`:

```powershell
.\tools\build_mod_strip_comments.ps1 dl-arcade-cloudflare
```

Нужен Reduced CSDK 12, настроенный для существующего build tool. Готовый VPK появится в
`tools/builds` или в выбранной в build tool директории. В игре обязательно проверить:

- Create/Join с двумя клиентами;
- Quick Match и rematch;
- один ход в шахматах/шашках и обновление часов;
- Pixel Battle: view, один pixel, ручной UPLOAD, повторное открытие;
- GeoGuesser: картинка, guess, reveal, next round;
- `/admin` через GitHub.

## 8. Custom Domain (рекомендуется для production)

Нужен домен, зона которого уже добавлена в Cloudflare. В Dashboard:

`Workers & Pages` → `dl-arcade-cloudflare` → `Settings` → `Domains & Routes` → `Add` →
`Custom Domain`.

Например: `arcade.example.com`. Cloudflare сам создаст DNS-запись и сертификат. Затем:

1. замени `BASE_URL` на `https://arcade.example.com`;
2. поменяй Homepage/Callback URL в GitHub OAuth App;
3. пересобери VPK.

Не создавай одновременно CNAME с тем же hostname: Custom Domain должен владеть hostname.
`workers.dev` можно оставить для диагностики или отключить после проверки custom domain.

## 9. Логи, метрики и квоты

Живой лог:

```powershell
npm run tail:worker
```

Метрики: Cloudflare Dashboard → Workers & Pages → `dl-arcade-cloudflare` → Metrics.

Free-план имеет жёсткие лимиты:

- Worker: 100,000 входящих запросов/сутки, сброс в 00:00 UTC;
- Durable Objects: отдельные 100,000 запросов/сутки;
- Worker CPU: 10 ms на внешний invocation;
- DO SQLite: 5 млн прочитанных и 100,000 записанных строк/сутки, до 5 GB на аккаунт Free.

Почти каждый игровой API request считается один раз для Worker и один раз для DO, поэтому первым
закончится обычно одинаковый 100k/day лимит. После лимита Cloudflare отдаёт ошибку, а не списывает
деньги с Free-аккаунта. Если ежедневная аудитория вырастет, нормальный следующий шаг — Workers Paid,
а не ещё сильнее портить polling.

## 10. Деплой обновления и откат

Обычное обновление:

```powershell
npm run lint
npm test
npm run deploy:worker:dry
npm run deploy:worker
```

`deploy:worker` всегда пересобирает `server/worker.js`, поэтому shared rules и authority не
расходятся.

Версии/rollback делаются в Dashboard: Worker → Deployments. Не удаляй `Hub` из `exports` и не
меняй его storage type ради отката: это lifecycle state Durable Object, а не обычная настройка.
Rollback кода не должен пересекать изменение lifecycle Durable Object.

## 11. Что будет со старыми данными VPS

Этот проект создаёт свежий Durable Object. Активные лобби переносить бессмысленно. Pixel Battle
canvas, audit, banks и bans из VPS SQLite автоматически не совместимы с DO storage и не импортируются.
Перед отключением VPS реши отдельно, нужен ли экспорт этих данных. До отдельной проверенной утилиты
миграции не удаляй VPS database/backups.
