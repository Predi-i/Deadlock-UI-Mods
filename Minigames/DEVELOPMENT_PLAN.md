# Minigames — план дальнейшего развития (для агента)

> Рабочий план для следующего агента. Разбит на **части A–E**, каждая часть — на
> **мелкие осмысленные коммиты**. Автор всех коммитов = **Predi-i**
> (`Predi-i@users.noreply.github.com`), с трейлером:
> ```
> Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
> ```
> **Не пушить** без явного запроса мейнтейнера. PR не создавать — описание PR писать
> плейн-текстом в чат.
>
> Читать вместе с `ARCHITECTURE.md` (особенно §2 транспорт, §5 протокол+авторитет,
> §6 Панорама-ловушки, §7 checkers input recipe, §8.6 durak, §9 sync), `server/README.md`
> и `trust_refactor_plan.md`.

---

## 0. Текущее состояние (факты на момент написания)

**Trust-refactor УЖЕ выполнен** — это меняет старый durak-план:

- Чистые движки вынесены в `panorama/scripts/rules/{checkers,ttt,chess}.js` и
  вешаются на `$.MG.Rules` (клиент) / `globalThis.MGRules` (worker).
- `tools/build_worker.js` конкатенирует `rules/*.js` + `server/worker.core.js`
  → `server/worker.js` (единый источник правил, паритет проверяет `mg_parity_test.js`).
- Сервер **авторитетен**: `worker.core.js` держит `lobby.state`, валидирует каждый
  `/api/move` (`validateCheckers/Ttt/Chess`), коды отказа `(9,1)` turn · `(9,2)` illegal
  · `(9,3)` bad-token · `(9,9)` gone.
- **Seat-токен** (`MG.Session.newToken`) течёт только вверх; `mg_ui.js` генерит его в
  `startCreate/startQuickMatch/doJoin` и кладёт в `session.tok`.
- Реестр игр: `MG.Games.register({id,create,enabled?})` в конце `mg_games.js`; durak
  саморегистрируется в `mg_durak.js` (`id:3`). Порядок `<include>` в `base_hud.xml`:
  `mg_net → rules/checkers → rules/ttt → rules/chess → mg_games → mg_durak → mg_ui`.

**Список игр** (`mg_games.js` `MG.Games.list`):
`1 checkers`✓ · `2 tictactoe`✓ · `3 durak`(enabled:false в list, но `mg_durak` флипает в
true через register — играбелен vs бот) · `4 chess`✓ · `5 connectfour`✗ · `6–9 soon`✗.

**Ключевое следствие:** новый durak-онлайн строим **сразу как server-authoritative**
(worker владеет колодой/руками/сидом, приватная раздача по tok), а **Connect Four**
ложится на уже готовый 2-int авторитетный транспорт почти без нового протокола.

**Транспорт-напоминание (жёсткое ограничение):**
- **Downlink** = размеры PNG = **ровно 2 целых**, каждое ≤ ~99–128 px (иначе округление
  от UI-scale портит значение).
- **Uplink** = URL query = **не ограничен** (сюда течёт tok и любые данные хода).
- Один запрос за раз (FIFO `reqQueue`), калибровка `/api/probe`, `suspectDecode` —
  **не трогать**.

**Чеклист верификации** (гонять перед каждым коммитом, расширяется по ходу плана):
```
node tools/build_worker.js
node --check panorama/scripts/rules/checkers.js
node --check panorama/scripts/rules/ttt.js
node --check panorama/scripts/rules/chess.js
node --check panorama/scripts/mg_games.js
node --check panorama/scripts/mg_durak.js
node --check panorama/scripts/mg_ui.js
node --check panorama/scripts/mg_net.js
node --check server/worker.js
node tools/mg_rules_test.js
node tools/mg_chess_test.js
node tools/mg_durak_test.js
node tools/mg_server_test.js
node tools/mg_parity_test.js
```
В отчётах ЧЕСТНО делить **verified** (синтаксис/правила/протокол/tok — проверяемо в
Node) и **reasoned** (рендер/анимация/drag/hover/онлайн-синк — только репак VPK +
запуск мейнтейнером; из шелла не рендерится).

**Дефолты, принятые для этого плана** (можно поменять — мейнтейнер решает):
- Масштаб UI (часть B): шаги **100 / 125 / 150 / 175 / 200 %**, с запоминанием выбора.
- Порядок работ: **A → B → C → D → E** (A,B,C быстрые и независимые; D крупный; E поверх D).
- Durak-онлайн throw-in v1: **упрощённый** (подкидывает только основной атакующий, как в
  текущих Stage-1 правилах); полный подкидной — отдельный follow-up.
- Connect Four: хост = seat 0, ходит первым; поставляется **и** vs Bot, **и** онлайн.

---

## Часть A — Фикс козырной карты в Дураке (баг 1)

**Симптом (скриншот мейнтейнера):** козырь не повёрнут на 90°, визуально ~«300% scale».

**Диагноз.** В `mg_durak.js` `buildDecor()` козырь — панель `.mg-dk-card` (100×140),
позиционируется `tc.style.transform = xform(ts.x, ts.y, ts.rot)` с `rot:0`. Комментарий
в коде честно фиксирует: прошлый `rotateZ` давал «300% scale» и уводил карту за пределы
сцены. Корень почти наверняка — **смешивание `translate3d(...) rotateZ(...)` в ОДНОЙ
inline-строке transform** (Панорама криво считает такую комбинацию — та же природа, что
ловушка §6.5 про `scale3d` внутри `transform`). При этом **одиночный** `rotateZ` в CSS
работает штатно — доказано `.mg-x-bar-a { transform: rotateZ(45deg); }` в TTT. Вторая
причина — поворот 100×140 вокруг центра у левого края (`DECK_X=32`) режется краем стола.

### A1 — Козырь: обёртка (translate) + внутренняя карта (чистый rotateZ) [1 коммит]

Файлы: `panorama/scripts/mg_durak.js`, `panorama/styles/mg.css`.

1. В `buildDecor()` заменить одиночную панель козыря на **две вложенные**:
   - **wrapper** `mg-dk-trump-wrap` — позиционируется `xform(x, y, 0)` (только translate,
     БЕЗ поворота);
   - **inner** `mg-dk-card` + новый класс `mg-dk-trump` — лицо козыря
     (`style.backgroundImage = faceCss(st.trumpCard)`), поворот задаётся ТОЛЬКО через CSS
     (`transform: rotateZ(90deg)`), а не inline вместе с translate.
2. Новый CSS-класс:
   ```css
   /* Козырь лежит горизонтально ПОД колодой. Поворот — ОДИНОЧНЫЙ rotateZ (как .mg-x-bar-a),
      никогда не в одной строке с translate3d (иначе Панорама даёт «300% scale» + culling). */
   .mg-dk-trump { transform: rotateZ(90deg); }
   ```
   Явно оставить `width:100px; height:140px` (наследуется от `.mg-dk-card`) — исключает
   любой «300%».
3. Геометрия `trumpSlot()`: повёрнутая карта имеет габарит 140(ш)×100(в). Пересчитать
   `x/y` так, чтобы:
   - козырь лежал горизонтально ПОД стопкой колоды, правым краем выглядывая из-под неё
     (классический вид Дурака);
   - весь габарит остался в пределах `STAGE_W×STAGE_H` (сдвинуть вправо/вниз от `DECK_X`).
   Стопка бэков колоды рисуется ПОСЛЕ (поверх) — уже так и есть.
4. Порядок рисования: козырь (wrapper) → бэки колоды → счётчик. Сохранить.

**Верификация.** verified: `node --check mg_durak.js`, `node tools/mg_durak_test.js`
(правила не тронуты). reasoned: сам вид/поворот/что не режется — только репак VPK.

**Коммит A1:** `fix(durak): render trump card rotated 90° under the deck without scale glitch`

---

## Часть B — Масштаб интерфейса из выпадающего окна (пункт 2)

**Цель.** Слева от «X» (закрытие) — выпадашка масштаба (100/125/150/175/200%). Масштаб
влияет на ВСЮ панель: пикер, доски, стол Дурака, все карты; ничего не ломается.

**Механика.** Применять `pre-transform-scale2d: N` к `.mg-modal` (визуальный масштаб
вокруг центра ПОСЛЕ раскладки; `dim` — сосед, остаётся во весь экран). Дети модалки
(включая игровые доски и карты) масштабируются автоматически. Drag-математика Дурака
(`stagePointFromGhost`: `scale = layerW/STAGE_W` от `actuallayoutwidth`) **уже
относительна** → корректно отработает любой масштаб. `pre-transform-scale2d` анимируем
(добавить в transition модалки для плавности) — идиома §6.5.

### B1 — Контрол выпадашки в шапке [1 коммит]

Файлы: `panorama/scripts/mg_ui.js`, `panorama/styles/mg.css`.

1. В `buildOverlay()` в `header` ПЕРЕД кнопкой `close` создать контейнер масштаба
   (flow идёт слева-направо; `headerLeft` = `fill-parent-flow(1.0)`, поэтому выпадашка и
   «X» уедут вправо — задать выпадашке `horizontal-align:right` тоже, либо разместить в
   отдельном правом кластере вместе с close).
2. Реализация: **`DropDown`** (нативный Панорама-тип) с пунктами 100/125/150/175/200, или
   — если DropDown окажется капризным в HUD-контексте — **кнопка-циклер**, показывающая
   текущий «150%» и переключающая по кругу. Начать с DropDown; при проблемах в игре
   (reasoned) fallback на циклер. Значение по умолчанию — 100%.
3. Обработчик `onValueChanged` (или `onactivate` циклера) → `applyUiScale(pct)`.
4. CSS `.mg-scale-dd` в фирменной палитре (dark fill `#161f2b`, hairline `#2a3849`,
   radiance-текст, высота ~30px, `vertical-align:center`, margin слева от close).

### B2 — Применение масштаба ко всей модалке [1 коммит]

1. `function applyUiScale(pct)`: хранить `uiScalePct` в модуле; ставить
   `modal.style.preTransformScale2d = String(pct/100)` (проверить точное имя свойства в
   inline-JS: `preTransformScale2d`; в CSS — `pre-transform-scale2d`).
2. Вызвать `applyUiScale(uiScalePct)` в конце `buildOverlay()` и после каждого
   пересоздания модалки, чтобы масштаб держался между view.
3. В `.mg-modal` добавить `transition-property` c `pre-transform-scale2d` (longhand,
   §6.2) для плавного зума.
4. ⚠ На 200% модалка (900px→1800px) может выйти за экран на 1080p — это ожидаемо
   (мейнтейнер сам просил такие значения). Отметить в отчёте как reasoned; при желании
   позже ограничить максимум по факту теста.

### B3 — Запоминание выбора (опционально) [1 коммит]

1. Проверить доступность `$.persistentStorage` (или аналога) в HUD-контексте Панорамы
   (грепнуть игровые/QOLLOCK скрипты). Если есть — сохранять/читать `uiScalePct`.
2. Если персистентного стораджа нет — оставить выбор на время сессии (переменная модуля),
   отметить в отчёте.

**Верификация.** verified: `node --check mg_ui.js`. reasoned: визуальный зум, поведение
DropDown, клиппинг на 200%, drag Дурака под масштабом — только в игре.

**Коммиты:** B1 `feat(ui): add UI-scale dropdown left of the close button` ·
B2 `feat(ui): scale the whole modal via pre-transform-scale2d` ·
B3 `feat(ui): persist UI-scale choice` (если стордж есть).

---

## Часть C — Connect Four: новая игра сразу с онлайном (пункт 7)

Полная информация, 2 игрока → **используем существующий авторитетный 2-int транспорт**.
Ход = номер колонки; сервер сам считает строку падения и валидирует. Почти нет нового
протокола — это самая «дешёвая» онлайн-игра.

**Модель.** Доска 7 колонок × 6 строк. Внутренний `Array(42)` (индекс `row*7+col`,
row 0 = верх). Значения `0` пусто, `1` host (красный, seat 0, ходит первым), `2` joiner
(жёлтый, seat 1). Ход кодируется как `from=col (0..6)`, `to=COL_MARKER=7` (как TTT
`to=9`): `from != to` всегда → `(1,1)` остаётся «nothing new». Сервер вычисляет строку
падения, ставит фишку, определяет победу/ничью, пишет `{f:col, t:7, e:1}` в лог.

### C1 — Чистый движок `rules/connectfour.js` [1 коммит]

Файл: `panorama/scripts/rules/connectfour.js` (UI-free, без `$`/`MG`; на клиенте вешается
на `$.MG.Rules.connectfour`, в worker — на `globalThis.MGRules.connectfour`; та же
IIFE-обёртка что и у checkers/ttt/chess — взять образец из `rules/ttt.js`).

Экспортировать:
- `COLS=7, ROWS=6`
- `initialBoard()` → `Array(42).fill(0)`
- `legalCols(board)` → массив колонок, где верхняя ячейка пуста
- `dropRow(board, col)` → индекс строки, куда упадёт фишка, или `-1` если колонка полна
- `drop(board, col, player)` → мутирует/возвращает новую доску (решить: как checkers
  `applyHop` мутирует, или как chess `makeMove` возвращает — выбрать под удобство worker;
  рекомендуется **вернуть** новую доску + landing index)
- `winner(board)` → `0` нет / `1` / `2` (проверка 4-в-ряд по 4 направлениям), плюс
  `isDraw(board)` (нет legalCols и нет winner)
- `cfBotMove(board, player)` → колонка. Эвристика: выиграть в 1 ход > заблокировать
  выигрыш соперника > центр-ориентированный минимакс (глубина 4–6, node-budget как у
  chess-бота §8.5). ⚠ глубину подобрать под перф Панорамы (reasoned).

### C2 — Тест правил `tools/mg_connectfour_test.js` [1 коммит]

По образцу `mg_rules_test.js`/`mg_chess_test.js`:
- горизонталь/вертикаль/обе диагонали дают `winner`;
- полная колонка не принимает фишку (`dropRow=-1`);
- ничья на заполненной доске без 4-в-ряд;
- полная партия двух ботов завершается (winner или draw), фишек ≤ 42.
Добавить строку `node tools/mg_connectfour_test.js` в чеклист (§0 и `ARCHITECTURE §10`).

### C3 — Серверная валидация + сборка [1 коммит]

Файлы: `server/worker.core.js`, `tools/build_worker.js`, тесты.
1. `build_worker.js`: добавить `"connectfour.js"` в массив `RULES` (после `chess.js`).
2. `worker.core.js`:
   - `initState(game)`: `if (game === 5) return { board: R.connectfour.initialBoard() };`
   - `validateMove`: `if (lobby.game === 5) return validateConnectFour(R.connectfour, lobby, seat, from, to);`
   - `validateConnectFour(RC, lobby, seat, from, to)`:
     - `if (seat !== lobby.turn) return {ok:false, code:1}`
     - `to` должен быть маркер `7`; `from` = колонка `0..6`; `RC.dropRow(board, from) < 0`
       (полна) → `{ok:false, code:2}`
     - применить `drop`, `lobby.turn = seat===0?1:0`, вернуть `{ok:true, move:{f:from, t:7, e:1}}`
   - (Победа/ничья определяются на клиенте из реплея — серверу хранить не обязательно, но
     можно положить в `state` для будущего.)
3. `mg_server_test.js`: добавить кейсы Connect Four (легальный дроп проходит и виден в
   poll; дроп не в свой ход `(9,1)`; дроп в полную колонку `(9,2)`; чужой tok `(9,3)`).
4. `mg_parity_test.js`: убедиться, что клиентский и серверный `connectfour` дают
   одинаковый набор `legalCols`/исход на N случайных позиций.

### C4 — Контроллер в `mg_games.js` [1 коммит]

`createConnectFour(container, session)` — по образцу `createTicTacToe`/`createCheckers`:
- рендер сетки 7×6 (явные строки/колонки, §6.8 — НЕ flow-wrap): кликабельны колонки
  (клик по любой ячейке колонки = дроп в неё; подсветка колонки на hover);
- фишки — панели, падение сверху вниз анимируется слайдом (`translate3d` + `.mg-anim`
  арминг через `$.Schedule(0.0)`, как checkers §6.3);
- предиктор+`sendMove`(reuse `Api.move` с `from=col,to=7,end=1`, `session.tok`);
- poll (`Api.poll` с `validate(from,to)= from∈0..6 && to===7`), `end=1` всегда →
  ход отдаётся; resync при `(9,x)` (`replayAccepted`-аналог);
- бот-ветка `session.bot` (offline): после моего хода `$.Schedule` → `cfBotMove`;
  чередование стороны как у checkers (`session.isHost`).
- `MG.Games.register({ id: 5, enabled: true, create: createConnectFour });` внизу файла.

### C5 — Стили + подключение + пикер [1 коммит]

Файлы: `panorama/styles/mg.css`, `panorama/layout/base_hud.xml`, `mg_ui.js` (описание).
1. CSS: `.mg-cf`, `.mg-cf-board` (7 колонок), `.mg-cf-cell`, `.mg-cf-disc`
   (`.mg-cf-red`/`.mg-cf-yellow`), hover-колонка, слайд-анимация (longhand). Геометрия
   должна совпадать с px-математикой в контроллере.
2. `base_hud.xml`: `<include src="s2r://panorama/scripts/rules/connectfour.vjs_c" />`
   ПЕРЕД `mg_games` (после `rules/chess`).
3. `mg_games.js` list: у `id:5 connectfour` оставить `enabled:false` в статике — контроллер
   флипнёт в `true` через `register` (как durak). Проверить, что пикер показывает игру
   играбельной.
4. `GAME_DESC.connectfour` в `mg_ui.js` уже есть — оставить.
5. Арт карточки пикера `panorama/images/cards/connectfour.vtex` компилирует мейнтейнер
   (PNG→VTEX); до этого — фолбэк-фон.

**Верификация.** verified: правила/сервер/паритет в Node (C1–C3). reasoned: рендер/
падение фишки/ввод/онлайн-синк — репак VPK.

**Коммиты:** C1 `feat(connect4): pure engine in rules/connectfour.js` ·
C2 `test(connect4): rules + bot-game harness` ·
C3 `feat(connect4): server-authoritative validation + build` ·
C4 `feat(connect4): controller (render, input, net, bot)` ·
C5 `feat(connect4): styles, includes, enable in picker`

---

## Часть D — Дурак онлайн 2–4 (авторитетный раздатчик) (пункт 4)

Самая крупная часть. Дурак не влезает в «ход = 2 int» и имеет **скрытые руки**, поэтому
worker становится **авторитетным раздатчиком**: владеет колодой/руками/сидом, раздаёт
приватно по местам (индексируемый канал `/api/ddraw` под tok), а публичные действия
транслирует индексируемым логом `/api/dlog`. Клиенты восстанавливают стол/козырь/чей
ход/роли/размер колоды/число карт у всех из публичного лога; личность СВОИХ карт — только
через `ddraw`. Компромисс скрытности (упорный читер может подставить чужой seat, но tok
это закрывает — без чужого tok `ddraw` не отдаётся) — тот же уровень доверия, что и в
текущих играх.

### D1 — Вынести чистые правила в `rules/durak.js` [1 коммит]

1. Перенести секцию `// ── durak: pure rules ──` … (до `// ── durak controller ──`) из
   `mg_durak.js` в новый `panorama/scripts/rules/durak.js` (IIFE-обёртка как у остальных
   rules; вешать на `$.MG.Rules.durak` / `globalThis.MGRules.durak`). Экспортировать:
   `SUITS/RANKS, DECK_SIZE, suitOf, rankOf, makeRng, freshDeck, deal, beats, newGame,
   canAttackWith, legalAttacks, canDefendPair, legalDefends, applyAttack, applyDefend,
   endBout, checkOver, refill, updateOut, firstAttacker, nextInPlay,` + бот
   (`durakBotAttack/Defend`, `sortByValue`, `cardValue`).
2. `mg_durak.js`: удалить перенесённую секцию, использовать `MG.Rules.durak.*` в
   контроллере (оффлайн-бот работает через тот же движок; поведение НЕ меняется).
3. `base_hud.xml`: `<include ... rules/durak.vjs_c />` ПЕРЕД `mg_games`? — durak-контроллер
   грузится ПОСЛЕ mg_games, но rules должны быть до первого использования. Поставить
   `rules/durak` рядом с прочими rules (после `rules/chess`, перед `mg_games`).
4. `tools/mg_durak_test.js`: сейчас режет секцию по баннерам внутри `mg_durak.js`.
   Переключить на чтение `rules/durak.js` целиком (как `mg_rules_test.js` читает
   `rules/checkers.js`). Сохранить все существующие проверки (раздача, легальность,
   добор, 120 партий, сохранение 36 карт).
5. `build_worker.js`: добавить `"durak.js"` в `RULES`.

**Верификация.** verified: `mg_durak_test.js` зелёный на новом источнике; `node --check`
на изменённых файлах; `build_worker` + `mg_server_test` (durak пока без серверных роутов —
не должно ломаться). reasoned: оффлайн-рендер не тронут, но перепроверить в игре.

**Коммит D1:** `refactor(durak): extract pure rules to rules/durak.js (shared with server)`

### D2 — worker: durak-лобби, роуты, кодировка событий [1–2 коммита]

Файл: `server/worker.core.js` (+ ре-билд).

**Лобби Дурака** (создаётся когда `game===3`): расширить структуру —
```
{ game:3, players, seats:[{tok},…≤4], np,        // np = число мест 2..4
  started, seed, trump, trumpCard, deck, hands[], // авторитетные, во владении DO
  table:[{a,d}], attacker, defender, phase, discard, out[], loser,
  pub:[],       // ПУБЛИЧНЫЙ индексируемый лог событий (аналог moves[])
  priv:[[],…],  // priv[seat] = индексируемый лог приватно добранных карт места
  t }
```

**Роуты** (ответ = 2 целых; аплинк в query; все действия — с `tok`):
- `/api/room?code=C` → `(players, started?1:0)` — рассадка/ожидание (гости и хост
  опрашивают до `started`).
- `/api/start?code=C&tok=T` (только хост seat 0, `players≥2`) → сервер: `seed` (свой),
  `newGame(np, seed)` из `rules/durak`, раздать по 6, определить козырь, `started=1`.
  Записать публичные события: `TRUMP`, для каждого места — приватные `DRAW` (в `priv`) +
  публичный `DRAW(seat,count)`. Ответ `(1,1)` ok / `(9,3)` bad-token / `(9,1)` не хост /
  `(9,2)` мало игроков.
- `/api/dact?code=C&tok=T&a=A&p=P&c=C2` → действие места:
  `a` = тип (1 attack, 2 cover, 3 take, 4 bito), `p` = индекс пары (для cover), `c` =
  id карты (для attack/cover). Валидировать `rules/durak` (`canAttackWith`/`canDefendPair`
  + очередь/фаза/роль по `tok→seat`). При успехе применить к авторитетному состоянию,
  добавить публичное событие в `pub` (и при доборе — приватные в `priv` + публичный DRAW).
  Ответ `(1,1)` / `(9,1)` не твой ход/роль / `(9,2)` нелегально / `(9,3)` bad-token /
  `(9,9)` нет лобби.
- `/api/dlog?code=C&since=S` → следующее публичное событие `pub[S]` (или `(1,1)` если нет
  нового; выбрать «nothing»-маркер, не пересекающийся с валидными событиями — напр.
  `(0? )` нельзя, dims≥1; использовать зарезервированный `(1,1)` и гарантировать, что ни
  одно событие не кодируется как `(1,1)` — см. таблицу ниже).
- `/api/ddraw?code=C&tok=T&i=I` → `i`-я приватная карта места (`priv[seat][i]`):
  `(card+1, 1)`; нет новой → `(1,1)`; чужой seat недоступен (tok→seat, только своё) →
  `(9,3)`.

**Кодировка публичных событий в 2 целых** (черновик, финализировать в D2; держать оба ≤ ~63):

| Событие | `w` | `h` | Пояснение |
|---|---|---|---|
| TRUMP | `2` | `trumpCard+1` (2..37) | козырная карта; `h≥2`, не `(1,1)` |
| PLAY (attack) seat s, card c | `10+s` (10..13) | `c+1` (1..36) | атака |
| COVER pair p, card c | `20+p` (20..25) | `c+1` (1..36) | защита пары p |
| TAKE seat s | `30+s` (30..33) | `1` | «беру» |
| BITO (done) | `40` | `1` | бито |
| DRAW seat s, count n | `50+s` (50..53) | `n+1` (1..7) | добор n карт |
| OVER loser L | `60` | `L+2` (1=draw, 2..5=seat) | конец партии |

Все `w ≤ 63`, `h ≤ 37` → в пределах probe-калибровки (600×1000). Ни одно событие не
кодируется `(1,1)` (у всех `w≥2`), так что `(1,1)` — безопасный «nothing new».
⚠ Кодировку `dlog`-«nothing» и диапазоны событий покрыть server-тестом (D6).

**Приватность.** `ddraw` строго по `tok→seat`: запросить `priv` другого места нельзя
(нет своего tok на нём) → `(9,3)`. Это закрывает T3 из `trust_refactor_plan §1`.

**Совместимость.** 2-игроковые роуты (`create/join/quick/status/move/poll/reset`) НЕ
трогать. Durak использует ОТДЕЛЬНЫЙ набор роутов; `create`/`join` для durak должны
проставлять `np` и допускать `players` до `np` (или ввести `/api/dcreate`,`/api/djoin` —
решить в D2; предпочтительно переиспользовать `create/join` с доп. параметром `np` и
ветвлением по `game===3`).

**Коммит(ы) D2:** `feat(durak-online): authoritative dealer routes in worker (room/start/dact/dlog/ddraw)`
(при большом объёме — разбить: сначала лобби+start+ddraw, затем dact+dlog).

### D3 — `mg_net.js`: обёртки роутов Дурака [1 коммит]

Добавить рядом с существующими `MG.Api`:
- `room(code, cb({players,started}), err)`
- `start(code, tok, cb(ok), err)`
- `dact(code, tok, a, p, c, cb({ok,reason}), err)`
- `dlog(code, since, cb(event|null), err)` — декодит `(w,h)` в `{type,seat,pair,card,count,loser,seq}`
  по таблице D2, с диапазон-чеком (как `poll`); неверное → `suspectDecode`.
- `ddraw(code, tok, i, cb(card|null), err)` — `(card+1,1)`→card; `(1,1)`→null; `(9,3)`→err.
Не трогать 2-игроковые обёртки, калибровку, FIFO.

**Коммит D3:** `feat(durak-online): mg_net wrappers for durak routes`

### D4 — `mg_ui.js`: view «room» 2–4 + включение онлайна Дурака [1–2 коммита]

1. Снять гейт `onlineReady = (g.key !== "durak")` — для Дурака показать Create/Join/Quick.
   Но с учётом числа игроков: у Дурака при Create — селектор `np` (2/3/4).
2. Новый view `renderRoom(code, isHost, np)`:
   - показать код (для приватного) + список занятых мест (`/api/room` опрос);
   - гостям — «ожидаем старта»; хосту — кнопка **Start** (активна при `players≥2`),
     по нажатию `MG.Api.start(code, tok)`.
   - по `started` → `renderGame(3, code, isHost, false)` c прокинутыми
     `session.seat` (сервер сообщает seat при join/quick — вернуть его в ответе join как
     game-id уже занят; для durak вернуть seat в `h`?) и `session.numPlayers=np`.
     ⚠ join сейчас возвращает `(game,1)`; для durak нужно вернуть **seat** — заложить в
     D2 (напр. `(game, seat+1)` для durak) и распарсить здесь.
3. `session` для durak-онлайна: `{ code, isHost, bot:false, tok, seat, numPlayers, onStatus }`.

**Коммит(ы) D4:** `feat(durak-online): room view (2–4 seats) with host Start` ·
`feat(durak-online): enable online buttons + seat/np plumbing`

### D5 — `mg_durak.js`: онлайн-ветка контроллера [1–2 коммита]

Контроллер уже умеет рендерить 2–4 места (перспективная рассадка `seatZone`) и держит
`st` из `rules/durak`. Добавить сетевой режим (когда `!session.bot`):
- **Инициализация:** после `start` клиент НЕ создаёт локальную колоду сам — состояние
  строится из `dlog` (TRUMP, DRAW-события задают размеры рук/козырь/колоду) + свои карты
  из `ddraw`. Держать локальный `st` как предиктор/UI, синхронизируемый с сервером.
- **Приём:** опрос `dlog` по `since` (FIFO-safe), применение событий к `st` теми же
  мутаторами (`applyAttack/applyDefend/endBout/…`); после каждого DRAW-события подтянуть
  свои новые карты `ddraw` по индексу.
- **Отправка:** мои действия (клик/драг) → предсказать локально + `dact(...)`; при
  `(9,x)` — откат предсказания и ресинк из `dlog` (как `rejectAndResync` в §9).
- Оффлайн-ветка (`session.bot`) — без изменений.
- ⚠ Расхождение публичного лога и приватных карт: единственный источник личности своих
  карт — `ddraw`; чужие руки всегда рубашки по количеству из публичных DRAW/PLAY/COVER.

**Коммит(ы) D5:** `feat(durak-online): apply public dlog + private ddraw, send dact`

### D6 — Тесты сервера + паритет для Дурака [1 коммит]

1. `mg_server_test.js`: durak-поток — create(np)/join до np; start только хостом; раздача
   6 карт; `dact` легальная атака/защита проходит и появляется в `dlog`; нелегальные
   `(9,2)`; не в свой ход `(9,1)`; `ddraw` своего места отдаёт карту, чужого (др. tok)
   `(9,3)`; кодировка событий в диапазонах таблицы D2; `dlog`-«nothing» = `(1,1)`.
2. `mg_parity_test.js`: клиентский `rules/durak` и серверный (через `MGRules`) дают
   идентичные `legalAttacks/legalDefends` на N случайных достижимых позиций.
3. Обновить `mg_durak_test.js` при необходимости (после D1 уже на `rules/durak.js`).

**Коммит D6:** `test(durak-online): server routes, privacy, event encoding, parity`

### Арт .vtex
36 карт `deck/<S><R>.vtex` + `deck/BACK.vtex` компилирует мейнтейнер (как chess-спрайты).
PNG уже в `panorama/images/deck/`.

---

## Часть E — Quick Match: мульти-выбор игр + число игроков (пункт 3)

Отдельная фича матчмейкинга (шире Дурака). Делать **после D** (нужен `np` Дурака).

### E1 — UI мульти-выбора [1–2 коммита]

Файлы: `mg_ui.js`, `mg.css`.
- В правой панели — режим **«Select Multiple»** (чекмарк/тумблер). При включении вместо
  одиночного Quick Match — список чекбоксов по ВКЛЮЧЁННЫМ играм (в какие игрок готов
  залететь) + одна кнопка Quick Match на набор.
- Для Дурака в наборе — селектор числа игроков (2/3/4/any).
- CSS чекбоксов/тумблера в фирменной палитре.

### E2 — worker: матчер по пересечению [1–2 коммита]

Файл: `worker.core.js` (+ ре-билд), `mg_server_test.js`.
- Клиент шлёт `games=1,2,5` (+ `np=` для Дурака). Аплинк неограничен.
- Хост при отсутствии совпадения регистрируется в очередях ВСЕХ выбранных игр
  (`pubq:g` для каждого g в наборе) + запись о совместимом числе мест. Джоинер с набором
  S ищет любого ждущего хоста, чья игра ∈ S и число мест совместимо; при матче — join в то
  лобби с той игрой. При матче/отмене чистить все `pubq:g` хоста.
- Ответ квику — существующая роль host/joiner (+ код), плюс какая игра выбрана (нужно
  вернуть выбранную `game` джоинеру — сейчас quick это не отдаёт; заложить: для мульти —
  вернуть `game` во втором целом или ввести `/api/mquick`). Финализировать протокол в E2.

### E3 — Склейка клиента [1 коммит]

- `mg_net.js`/`mg_ui.js` под новый протокол мульти-квика; корректный `renderGame`/
  `renderRoom` по возвращённой игре и роли.
- `mg_server_test.js`: пересечения наборов, несовместимые `np`, отмена чистит все очереди.

**Коммиты:** E1 `feat(quickmatch): multi-select games + player-count picker` ·
E2 `feat(quickmatch): worker matcher over game-set intersection` ·
E3 `feat(quickmatch): client wiring + server tests`

---

## Часть F — Документация (сопровождает A–E)

- `ARCHITECTURE.md`: §8.6 обновить под реализованный durak-онлайн (роуты, кодировка
  событий, приватность ddraw); добавить §8.7 Connect Four; добавить короткий раздел про
  UI-scale (`pre-transform-scale2d` на модалке). Обновить чеклист §10 (новые тесты).
- `README.md`: устарел (пишет, что играбельны только шашки) — обновить статус игр
  (checkers/ttt/chess/connect four играбельны онлайн; durak vs bot → затем онлайн 2–4).
- `server/README.md`: добавить durak/connect-four роуты в «Protocol reference».
- Обновлять доки **в тех же частях** (не отдельным поздним коммитом), чтобы описание не
  отставало от кода.

---

## Сводный порядок коммитов (рекомендуемый)

1. **A1** — фикс козыря.
2. **B1, B2, (B3)** — масштаб UI.
3. **C1 → C5** — Connect Four (правила → тест → сервер → контроллер → стили).
4. **D1 → D6** — Дурак онлайн (extract rules → worker → net → ui → controller → tests).
5. **E1 → E3** — Quick Match рефактор.
6. **F** — доки вплетать по ходу соответствующих частей.

Каждый коммит: прогон полного чеклиста §0; в сообщении/отчёте — что **verified** (Node)
и что **reasoned** (только репак VPK мейнтейнером). Автор = Predi-i, co-author Claude.
Не пушить и не открывать PR без запроса.

---

## Открытые вопросы / решения по ходу (перепроверить с мейнтейнером)

1. **B:** DropDown vs кнопка-циклер (если DropDown капризен в HUD-контексте); наличие
   персистентного стораджа для запоминания масштаба.
2. **D2:** переиспользовать `create/join/quick` с параметром `np` и ветвлением по
   `game===3` **или** отдельные `/api/dcreate|djoin`; как вернуть `seat` джоинеру Дурака
   в 2-int ответе (черновик: `(game, seat+1)`).
3. **D:** объём подкидного throw-in для v1 (упрощённый) — подтвердить; фиксирует ли хост
   `np` при Create или гибко до Start.
4. **E2:** как джоинер узнаёт выбранную игру в 2-int ответе квика (второй int / отдельный
   роут `/api/mquick`).
5. **C:** глубина/бюджет бота Connect Four под перф Панорамы (тюнить в игре).
