# Текущие планы (рабочий трекер агента)

> Живой чеклист для продолжения работы. Обновлять по ходу. Читать вместе с
> `DEVELOPMENT_PLAN.md` (части A–F), `fable.md` (security-волны), `trust_refactor_plan.md`
> и `ARCHITECTURE.md`. Автор коммитов = **Predi-i**
> (`Predi-i@users.noreply.github.com`), трейлер `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
> **Не пушить** без явного запроса мейнтейнера. Коммитить по ходу — можно.

## Порядок задач (от мейнтейнера, приоритет сверху вниз)

1. **Quickmatch «Select Multiple»** — галочки, чтобы искать сразу несколько игр (Part E).
2. **Починить дропдаун UI-scale** — жмёшь «100%», а меню не появляется.
3. **Качество рендера UI-scale** — пикселизация («как 480p»); идея: рендерить в 200% и скейлить вниз.
4. **Внедрить fable.md** — security-правки (частично сделано, см. ниже).
5. Разбивать на мелкие коммиты по ходу.
6. Свериться с текущими планами — что недовыполнено (этот файл).

---

## Чеклист верификации (гонять перед каждым коммитом)

```
node tools/build_worker.js
node --check panorama/scripts/rules/checkers.js
node --check panorama/scripts/rules/ttt.js
node --check panorama/scripts/rules/chess.js
node --check panorama/scripts/rules/connectfour.js
node --check panorama/scripts/rules/durak.js
node --check panorama/scripts/mg_games.js
node --check panorama/scripts/mg_connectfour.js
node --check panorama/scripts/mg_durak.js
node --check panorama/scripts/mg_ui.js
node --check panorama/scripts/mg_net.js
node --check server/worker.js
node tools/mg_rules_test.js
node tools/mg_chess_test.js
node tools/mg_connectfour_test.js
node tools/mg_durak_test.js
node tools/mg_server_test.js
node tools/mg_parity_test.js
```
⚠ Оболочка — PowerShell: разделять команды `;`, НЕ `&&`.
В отчётах честно делить **verified** (Node: синтаксис/правила/протокол/токены) и
**reasoned** (рендер/анимация/drag/hover/онлайн-синк — только репак VPK мейнтейнером).

---

## СДЕЛАНО

- ✅ **Wave 1 — security hardening** (коммит `093b8f6`, 78 server-check зелёные).
  Из `fable.md` P0/P1: token-gated `/api/cancel` (+ проброс `tok` в `mg_net`/`mg_ui`),
  запрет смены типа игры в `/api/reset`, reject unsupported game id (6..9)→`(9,6)`,
  `validateMove` reject без движка, `validTok()` (пустой/битый токен → `(9,3)`),
  терминалка TTT/Connect Four, `move` при `players<2`→`(9,1)`, collision-safe
  `freshCode()`, durak-seed через `crypto.getRandomValues`, keep-alive `lobby.t` на move.

---

## TODO

### A. UI-scale dropdown — ПОЧИНИТЬ (задача 2) — маленькая, делать первой

Файлы: `panorama/styles/mg.css` (класс `.mg-header`, `.mg-scale-menu`), при необходимости
`panorama/scripts/mg_ui.js` (`buildScaleControl`).

**Диагноз (reasoned):** попап `.mg-scale-menu` — потомок `.mg-scale` (flow-children:none)
внутри `.mg-header` (`flow-children:right`, БЕЗ `overflow:noclip`). Меню уходит вниз за
пределы шапки на ~33+150px и **клипается границами header** → «дропдауна нет». Плюс
z-index попапа не поднимает его над `.mg-body` (сосед header в модалке).

**План:**
- `.mg-header { overflow: noclip; z-index: 10; }` — чтобы попап не резался и рисовался над телом.
- Убедиться, что `.mg-scale` уже `overflow: noclip` (да), при необходимости добавить `z-index`.
- `.mg-scale-menu` уже имеет фон/бордер/тень — проверить, что не прозрачный.
- Если после этого всё равно капризит in-game (reasoned) → **fallback: кнопка-циклер**
  (клик = следующий шаг 100→125→…→200→100), как предлагает `DEVELOPMENT_PLAN §B1`.
  Это устраняет все проблемы клиппинга/стекинга разом.
- Коммит: `fix(ui): make the UI-scale dropdown escape the header clip (overflow/z-index)`.

### B. UI-scale качество рендера (задача 3)

**Диагноз:** `pre-transform-scale2d` на `.mg-modal` — это растровый апскейл уже
отрисованной панели. Апскейл ВВЕРХ мылит битмапы (арт `.vtex` доски/карт) → «480p».
SDF-шрифты (radiance/oracle) масштабируются чётко; мылят именно картинки.

**Варианты (все reasoned, требуют репак VPK):**
- **B1 (supersample, идея мейнтейнера):** сделать базовый layout модалки крупнее и
  скейлить ВНИЗ (downscale чёткий). На практике — задать «100%» как `scale2d=0.5` от
  вдвое большего базового размера. Дорого: надо удвоить всю px-геометрию (900→1800,
  доски, карты, шрифты) — большой риск. **Отложить, обсудить с мейнтейнером.**
- **B2 (дёшево):** ограничить апскейл — верхний предел качества = нативные картинки;
  при увеличении неизбежно мыло, пока арт не будет в большем разрешении (задача
  мейнтейнера — перекомпилить `.vtex` в 2×).
- **Рекомендация:** сначала починить дропдаун (A), затем спросить мейнтейнера, готов ли
  он на supersample-рефактор (B1) или достаточно 2× арта (B2). Не пилить B1 вслепую.

### C. Quickmatch «Select Multiple» (задача 1 = `DEVELOPMENT_PLAN` Part E)

Самая крупная. Делать после A. Разбить:

- **E1 — worker: мульти-матчер** (`server/worker.core.js` + rebuild + `mg_server_test.js`).
  - Новый роут `/api/mquick?games=1,2,5&tok=T` (или расширить `quick`; решить — предпочтительно
    отдельный роут, чтобы не ломать существующий 2-int `quick`).
  - Джоинер с набором S ищет любого ждущего хоста, чья игра ∈ S; при матче — join в то лобби.
  - Хост без матча регистрируется в очередях ВСЕХ выбранных игр (`pubq:g` для каждого g).
    При матче/cancel чистить все свои `pubq:g`.
  - Ответ должен вернуть ВЫБРАННУЮ игру джоинеру (сейчас `quick` её не отдаёт). Заложить в 2 int:
    напр. host `(CODE_HI+100, CODE_LO+1)`, joiner `(CODE_HI, CODE_LO+1)` + отдельный
    `/api/status`/`join`-подобный ответ с game, ЛИБО кодировать game во второй ответ. Финализировать протокол здесь.
  - Тесты: пересечение наборов, несовместимые наборы не пейрятся, cancel чистит все очереди.
- **E2 — mg_net.js:** обёртка `mquick(games[], tok, cb, err)` + декод роли/кода/игры.
- **E3 — mg_ui.js + mg.css:** тумблер «Select Multiple» в правой панели; при вкл. — список
  чекбоксов по ВКЛЮЧЁННЫМ играм + одна кнопка Quick Match на набор. CSS чекбоксов в
  фирменной палитре (`#161f2b` fill, `#2a3849` hairline).
- Коммиты: E1 `feat(quickmatch): worker matcher over game-set intersection` ·
  E2 `feat(quickmatch): mg_net wrapper` · E3 `feat(quickmatch): multi-select UI`.

### D. Остаток fable.md (security, опционально/позже)

- **P2 §7 — TTL keep-alive для durak:** добавить `lobby.t = nowSeq()` в `dact`/`start`
  (в 2-int играх уже сделано на `move`). Мелко.
- **P2 §8 — brute-force `/api/join`/hijack приватного лобби:** решается **WAF
  rate-limit на Cloudflare** (правило на `/api/join` и `/api/*` по IP). Инфраструктурное,
  не файловое — записать в `server/README.md` как обязательный шаг перед публичным релизом.
- **fable Wave 2 — `over/winner/rv` + Play Again через `/api/reset` (голосование обоих):**
  крупнее; даёт баннер победы/поражения + рематч по согласию. Отдельной волной ПОСЛЕ E,
  если мейнтейнер захочет. Патчи расписаны в `fable.md` (разделы 2.1–2.7). Требует UI-части
  в `mg_ui.js` (поймать `(91, winner+1)` в poll → баннер + кнопка).

### E. Документация (вплетать по ходу)

- `ARCHITECTURE.md §5`: дописать коды `(9,6)` unsupported-game и правила cancel/reset/validTok
  (сейчас в §5.1 их нет). У мейнтейнера ARCHITECTURE.md уже с локальными правками — не затирать.
- `server/README.md`: добавить `(9,6)` в таблицу move/create и заметку про WAF rate-limit.
- `README.md`: устарел (пишет, что играбельны только шашки) — обновить статус игр.

---

## Статус DEVELOPMENT_PLAN (части A–F)

- **A** (фикс козыря дурака) — ✅ сделано (коммит `fdcb8b7`).
- **B** (UI-scale) — ⚠ дропдаун реализован (`7467928`), но **НЕ работает** (клиппинг) → см. TODO A/B.
- **C** (Connect Four) — ✅ сделано (`d31e25c`…`5e2baa0`).
- **D** (Durak online 2–4) — ✅ 2-player онлайн сделан (`4851328`…`0b4cf1c`); 3–4 seat отложены.
- **E** (Quickmatch multi-select) — ❌ НЕ начато → TODO C.
- **F** (доки) — ⚠ частично; см. TODO E.

## Незакоммиченное в рабочей копии (НЕ моё — не трогать без спроса)

- `ARCHITECTURE.md`, `server/README.md` — правки мейнтейнера (были до старта).
- `fable.md` — план другой нейросети (справочник, не коммитить в код).
- `panorama/sounds/` — арт/звук мейнтейнера.
