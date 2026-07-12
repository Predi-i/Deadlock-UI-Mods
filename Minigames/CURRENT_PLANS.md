# Текущие планы (рабочий трекер агента)

> Живой чеклист для продолжения работы. Обновлять по ходу. Читать вместе с
> `DEVELOPMENT_PLAN.md` (части A–F), `fable.md` (security-волны), `trust_refactor_plan.md`
> и `ARCHITECTURE.md`. Автор коммитов = **Predi-i**
> (`Predi-i@users.noreply.github.com`), трейлер `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
> **Не пушить** без явного запроса мейнтейнера. Коммитить по ходу — можно.

## Порядок задач (от мейнтейнера, приоритет сверху вниз)

1. **Quickmatch «Select Multiple»** — галочки, чтобы искать сразу несколько игр (Part E). — ✅ СДЕЛАНО.
2. **Починить дропдаун UI-scale** — жмёшь «100%», а меню не появляется. — ✅ фикс `3d4097a` (reasoned).
3. **Качество рендера UI-scale** — пикселизация («как 480p»). — ⏳ нужен мейнтейнер (B1 vs B2).
4. **Внедрить fable.md** — security-правки. — ⚠ Wave 1 + P2 §7 сделаны; Wave 2 (Play Again) опц.
5. Разбивать на мелкие коммиты по ходу. — ✅ делаем.
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
⚠ Оболочка — PowerShell: разделять команды `;`, НЕ `&&`. (cmd.exe — можно `&&`.)
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

- ✅ **UI-scale dropdown фикс** (коммит `3d4097a`). `.mg-header { overflow: noclip; z-index: 10; }`
  — попап `.mg-scale-menu` больше не режется шапкой и рисуется над телом. verified: `node --check`;
  reasoned: сам дропдаун виден только в игре. Если всё же капризит in-game → fallback кнопка-циклер
  (`DEVELOPMENT_PLAN §B1`, устраняет клиппинг/стекинг разом).

- ✅ **E — Quickmatch «Select Multiple»** (коммиты `eb9b030`, `4ddc9c9`, `93b56e3`; 94 server-check).
  - **E1 worker** (`eb9b030`): роут `/api/mquick?games=1,2,4,5&tok=T` — джоинер матчится с любым
    ждущим хостом, чья игра (или неопределённый набор `games[]` у multi-лобби `game:0`) пересекается
    с набором, ФИКСИРУЯ игру. Без матча — хостит ОДНО неопределённое лобби (`game:0`),
    зарегистрированное во ВСЕХ выбранных `pubq:g`; первый джоинер фиксирует игру. `/api/status` теперь
    несёт `game+1` в высоте → обе стороны узнают выбранную игру. `quick`/`cancel` совместимы с
    multi-лобби (`finalizeJoin`/`clearQueuesFor`). Durak (3) исключён (свой route-set). **+16 → 94.**
  - **E2 net** (`4ddc9c9`): `MG.Api.mquick(games[], tok, cb({role,code}))`; `status` отдаёт `game`.
  - **E3 UI** (`93b56e3`): тумблер «Select multiple games» (скрыт для durak) → чекбоксы по multi-играм
    + одна кнопка `QUICK MATCH (N)`; `startMultiQuick` → `waitForMultiMatch` поллит status до
    `players==2 && game>0`, монтирует игру для любой роли. Чекбоксы панелями в фирменной палитре.
    verified: 94 server-check; reasoned: рендер/флоу/онлайн-синк.

- ✅ **fable.md P2 §7 — durak TTL keep-alive** (коммит `bf521fa`). `lobby.t = nowSeq()` на
  `/api/start` и `/api/dact`, чтобы активная партия дурака не сносилась 30-мин свипом.

---

## TODO

### A. UI-scale качество рендера (задача 3) — ⏳ нужен мейнтейнер

**Диагноз:** `pre-transform-scale2d` на `.mg-modal` — растровый апскейл уже отрисованной панели.
Апскейл ВВЕРХ мылит битмапы (арт `.vtex` доски/карт) → «480p». SDF-шрифты (radiance/oracle)
масштабируются чётко; мылят именно картинки.

**Варианты (все reasoned, требуют репак VPK):**
- **B1 (supersample, идея мейнтейнера):** базовый layout модалки крупнее, скейлить ВНИЗ (downscale
  чёткий). «100%» = `scale2d=0.5` от вдвое большего базового. Дорого: удвоить всю px-геометрию
  (900→1800, доски, карты, шрифты) — большой риск. **Отложить, обсудить.**
- **B2 (дёшево):** верхний предел качества = нативные картинки; при увеличении мыло, пока арт не будет
  в 2× (задача мейнтейнера — перекомпилить `.vtex`).
- **Рекомендация:** спросить мейнтейнера — B1 (supersample) или B2 (2× арт). Не пилить B1 вслепую.

### B. Остаток fable.md (security, опционально/позже)

- **P2 §8 — brute-force `/api/join`/hijack приватного лобби:** решается **WAF rate-limit на Cloudflare**
  (правило на `/api/join` и `/api/*` по IP). Инфраструктурное, не файловое — записать в
  `server/README.md` как обязательный шаг перед публичным релизом.
- **fable Wave 2 — `over/winner/rv` + Play Again через `/api/reset` (голосование обоих):** крупнее;
  баннер победы/поражения + рематч по согласию. Отдельной волной, если мейнтейнер захочет. Патчи в
  `fable.md` (2.1–2.7). Требует UI-части в `mg_ui.js` (поймать `(91, winner+1)` в poll → баннер + кнопка).

### C. Документация — частично

- `server/README.md`: добавить роут `/api/mquick` + заметку про WAF rate-limit. У мейнтейнера файл с
  локальными правками (uncommitted) — **не затирать без спроса**.
- `ARCHITECTURE.md §5`: дописать `/api/mquick` + `(9,6)` unsupported-game + cancel/reset/validTok.
  У мейнтейнера файл с локальными правками — **не затирать**.
- `README.md`: устарел (пишет, что играбельны только шашки) — обновить статус игр (checkers/ttt/chess/
  connect four онлайн + vs bot; durak vs bot + онлайн 2p). Этот файл чистый — можно править.

---

## Статус DEVELOPMENT_PLAN (части A–F)

- **A** (фикс козыря дурака) — ✅ сделано (`fdcb8b7`).
- **B** (UI-scale) — ✅ дропдаун реализован (`7467928`) + фикс клиппинга (`3d4097a`); качество (B) → TODO A.
- **C** (Connect Four) — ✅ сделано (`d31e25c`…`5e2baa0`).
- **D** (Durak online 2–4) — ✅ 2-player онлайн (`4851328`…`0b4cf1c`) + keep-alive (`bf521fa`); 3–4 seat отложены.
- **E** (Quickmatch multi-select) — ✅ сделано (`eb9b030`, `4ddc9c9`, `93b56e3`).
- **F** (доки) — ⚠ частично; см. TODO C.

## Незакоммиченное в рабочей копии (НЕ моё — не трогать без спроса)

- `ARCHITECTURE.md`, `server/README.md` — правки мейнтейнера (были до старта).
- `fable.md` — план другой нейросети (справочник, не коммитить в код).
- `panorama/sounds/` — арт/звук мейнтейнера.
