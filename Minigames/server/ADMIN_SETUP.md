# Включить админ-панель Pixel Battle (пошагово)

Гайд для мейнтейнера. Делается один раз, занимает ~5 минут.

Что получится в конце: `https://178.236.246.13/admin` открывается, просит войти через GitHub,
пускает **только** твой аккаунт и даёт искать по Steam32, красить без списания банка игрока,
откатывать чужие правки и банить.

## Сначала: почему `npx wrangler` больше не при делах

Раньше секреты жили в Cloudflare (`npx wrangler secret put ...`). Мод с Cloudflare **уехал** —
теперь всё крутится на своём VPS как обычный systemd-сервис. Поэтому:

| было (Cloudflare) | стало (VPS) |
|---|---|
| `npx wrangler secret put NAME` | строка `NAME=значение` в `/etc/deadlock-minigames.env` |
| `npx wrangler deploy` | `scp server/worker.js` + `systemctl restart deadlock-minigames` |
| секреты в дашборде CF | обычный файл на диске, права `600` |

`wrangler.jsonc` в репо остался только как история/путь к откату. Продакшен его не читает.

## Шаг 1. Создать OAuth App на GitHub

Браузер → https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**.

Заполнить:

- **Application name** — любое, например `Deadlock Minigames Admin`
- **Homepage URL** — `https://178.236.246.13`
- **Authorization callback URL** — **строго** это, символ в символ:

```
https://178.236.246.13/admin/auth/callback
```

Нажать **Register application**. На следующей странице:

- **Client ID** — виден сразу, скопировать.
- **Client secret** — нажать **Generate a new client secret**, скопировать.
  ⚠ Он показывается **один раз**. Закроешь страницу — придётся генерировать заново.

## Шаг 2. Сгенерировать `ADMIN_SESSION_SECRET`

Это не пароль, который надо помнить, а ключ для подписи cookie сессии. Требование в коде:
**минимум 32 символа** (`adminConfig()` в `worker.core.js` — короче 32 не примет и админка
останется закрытой). Просто сгенерировать случайный и вставить.

Локально в Git Bash (48 символов, с запасом):

```bash
openssl rand -base64 60 | tr -d '/+=\n' | cut -c1-48
```

> Почему 60 байт, а не 36: `tr -d '/+='` выкидывает часть символов, и с 36 байт результат
> иногда выходил 45 вместо 48. Порога 32 хватало и так, но пусть длина будет предсказуемой.

Если `openssl` нет — вот вариант на PowerShell (проверен, даёт ровно 48):

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

Или прямо на сервере, одной командой (сразу впишет в файл — см. шаг 3).

## Шаг 3. Вписать четыре переменные на сервере

Зайти на VPS:

```bash
ssh -i ~/.ssh/codex_deadlock_vps_ed25519 root@178.236.246.13
```

Файл `/etc/deadlock-minigames.env` уже существует и в нём уже лежит `MG_MAPILLARY_TOKEN`
(его **не трогать**, иначе отвалятся панорамы Mapillary в GeoGuesser). Дописать в конец:

```bash
cat >> /etc/deadlock-minigames.env <<'EOF'
GITHUB_CLIENT_ID=сюда_client_id
GITHUB_CLIENT_SECRET=сюда_client_secret
ADMIN_GITHUB_ID=122024464
ADMIN_SESSION_SECRET=сюда_случайные_48_символов
EOF
```

Про значения:

- `ADMIN_GITHUB_ID` — **это уже твой id**, `122024464` (проверено через
  `https://api.github.com/users/Predi-i`). Именно числовой id, а не логин: логин можно
  переименовать и угнать, число — нельзя.
- Кавычки не нужны. systemd читает `EnvironmentFile` буквально, кавычки попадут внутрь значения
  и сломают секрет.
- Пробелов вокруг `=` быть не должно.

Если хочешь сгенерировать секрет прямо здесь, вместо последней строки:

```bash
echo "ADMIN_SESSION_SECRET=$(openssl rand -base64 60 | tr -d '/+=\n' | cut -c1-48)" \
  >> /etc/deadlock-minigames.env
```

Закрепить права и перезапустить:

```bash
chmod 0640 /etc/deadlock-minigames.env
chown root:minigames /etc/deadlock-minigames.env
systemctl restart deadlock-minigames
```

## Шаг 4. Проверить

```bash
# 1. Сервис поднялся
systemctl is-active deadlock-minigames        # ждём: active

# 2. Все четыре переменные реально попали в процесс (а не только в файл)
PID=$(systemctl show -p MainPID --value deadlock-minigames)
for v in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET ADMIN_GITHUB_ID ADMIN_SESSION_SECRET; do
  tr '\0' '\n' < /proc/$PID/environ | grep -q "^$v=" && echo "$v: ok" || echo "$v: НЕТ"
done

# 3. Админка больше не fail-closed
curl -s -o /dev/null -w '%{http_code}\n' -k https://127.0.0.1/admin   # ждём: 302 (редирект на GitHub)
```

`503` + текст `Admin authentication is not configured` означает, что хотя бы одна переменная не
доехала: чаще всего опечатка в имени, пробел вокруг `=`, кавычки или секрет короче 32 символов.

Потом в браузере открыть `https://178.236.246.13/admin` и войти через GitHub.

## Почему может ругаться браузер

Сертификат выписан **на голый IP** через Let's Encrypt профиль `shortlived` — живёт около 6 дней
и продлевается таймером дважды в сутки. Для игры это неважно (Panorama просто грузит картинки), а
браузер к админке пожалуется, если продление сорвалось. Проверить:

```bash
systemctl status deadlock-minigames-certbot.timer
openssl x509 -in /etc/letsencrypt/live/178.236.246.13/cert.pem -noout -enddate
```

Прогнать продление вживую, ничего не ломая:

```bash
/opt/certbot/bin/certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
```

## Если надо отключить админку

Убрать любую из четырёх строк и перезапустить — код **fail-closed**, без полного набора
`/admin*` не пускает никого. Это штатный способ, а не аварийный.

## Что нельзя делать

- Не коммитить эти значения в репо. В git уходит только имя переменной, никогда значение.
- Не менять `MG_MAPILLARY_TOKEN` — на нём держатся Mapillary-панорамы в GeoGuesser.
- Не ставить `ADMIN_GITHUB_ID` = логин или `0`: код требует именно непустое число.
