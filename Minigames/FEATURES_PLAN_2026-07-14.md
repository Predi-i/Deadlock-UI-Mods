# DL Arcade — план новых фич (Play Again, звуки, история, подсветка, таймеры, премувы, стрелки)

> **Это самодостаточный гайд для СВЕЖЕГО чата-агента.** Он не видел кодовую базу.
> Здесь всё: карта репозитория, найденные паттерны, ловушки Panorama, что я узнал из
> QOLLOCK про звуки, зафиксированные продуктовые решения, и пошаговый план по коммитам.
> Читать сверху вниз. Каждый коммит атомарен и проходит валидацию из §11.

---

## 0. Как пользоваться этим документом

- Рабочая папка: `D:\GitHub2\Deadlock-UI-Mods\Minigames`. **Только Windows-среда, git bash.**
- Читать `.md` **только** из этой папки и подпапок. Для звуков можно смотреть
  `D:\GitHub2\QOLLOCK\panorama\scripts` и `D:\GitHub2\QOLLOCK\soundevents\*` (справочно).
  (мейнтейнер — predi-i). Работаем поверх текущей ветки `feat/minigames-checkers`
- **Ничего не пушить и не открывать PR без запроса.** Коммиты — от лица predi-i, добавлять
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Работаем ЭТАПАМИ.** После каждого этапа мейнтейнер репакует VPK и тестит в игре (Мейнтейнер: это не обязательно. Под этапами я подразумевал делать коммиты после выполнения этапа чтобы не потерять прогресс. Если действительно сомневаешься в чём-то и переделка этого будет занимать много времени и нужно мне проверить, то пиши. Обязательно проверю и пойдём дальше)
  (иначе визуал/ввод/звук проверить нельзя — Panorama рендерится только в Deadlock).
  Не начинать следующий этап, пока предыдущий не подтверждён в игре.
- Честность: всё визуальное/анимация/drag/звук/таймеры — **«обосновано, не проверено»**
  до подтверждения мейнтейнером. Node-проверки (§11) покрывают только синтаксис + чистые
  правила + серверный протокол.

---

## 1. Контекст и цель

**DL Arcade** — набор онлайн мини-игр внутри Esc-меню Deadlock (Source 2 Panorama HUD):
Шашки (русские), Крестики-нолики (TTT), Шахматы, Connect Four, Дурак. Транспорт —
image-side-channel (нет fetch/websockets): запрос уходит в URL картинки, ответ читается
как размеры отданного сервером PNG (2 целых числа). Cloudflare Worker авторитетно валидирует
ходы. Локальный движок — предиктор для мгновенного отклика.

**Задача:** добавить 7 фич (по приоритету мейнтейнера, поэтапно):
1. Кнопка **Play Again** (реванш) после партии.
2. **Звуки** в шашках/шахматах + слайдер громкости + мгновенный mute по клику.
3. **История ходов** справа от доски + локальная навигация вперёд/назад (обзор прошлых позиций).
4. **Подсветка последнего хода** соперника (клетка «откуда» + «куда»), шашки и шахматы.
5. **Таймеры:** шахматы/шашки — выбор игры на время; TTT/Дурак — жёстко 20 сек/ход.
6. **Стрелки ПКМ** на доске (аннотации), шашки и шахматы.
7. **Премувы** (заранее заданный ход в чужой ход), шашки и шахматы.

---

## 2. Карта кода (то, что уже есть)

```
panorama/
  layout/base_hud.xml        HUD-override; <include> скриптов+стилей. ПОРЯДОК ВАЖЕН:
                             net → rules/* → games → durak → connectfour → ui.
  styles/mg.css              весь CSS. Импортит citadel_base_styles для шрифтов oracle/radiance.
  scripts/
    mg_net.js                транспорт + протокол ($.MG.Net, $.MG.Api, $.MG.Session). BASE_URL сверху.
    rules/checkers.js|ttt.js|chess.js|connectfour.js|durak.js
                             ЧИСТЫЕ движки (общие с сервером байт-в-байт через build_worker.js).
    mg_games.js              контроллеры Checkers + TTT + Chess; реестр $.MG.Games (list/register/mount).
    mg_durak.js              контроллер Дурака; self-register id 3.
    mg_connectfour.js        контроллер Connect Four; self-register id 5.
    mg_ui.js                 Esc-кнопка + оверлей-лобби ($.MG.UI): renderMenu/renderDetail/renderGame…
  sounds/mods/*.wav          8 ГОТОВЫХ WAV (закоммичены), пока НИКЕМ не проигрываются:
                             game-start, illegal, move-check, move-opponent, move-self,
                             premove, promote, tenseconds.
  images/…                   спрайты фигур (.vtex), карты, колода.
server/
  worker.core.js             АВТОРСКИЙ релей + валидаторы + PNG-энкодер (править ЭТОТ).
  worker.js                  СГЕНЕРИРОВАННЫЙ (rules/* + worker.core.js) — деплой-артефакт. НЕ править руками.
tools/
  build_worker.js            склейка rules/* + worker.core.js → server/worker.js.
  mg_*_test.js               node-тесты (правила, сервер, паритет предиктор↔сервер).
ARCHITECTURE.md              ГЛАВНЫЙ документ: архитектура + 16 ловушек Panorama. ЧИТАТЬ ПЕРВЫМ.
README.md                    обзор + список фич.
```

### Ключевые сущности контроллеров (mg_games.js)

Каждая игра — фабрика `create<Game>(container, session)` → `{ destroy }`.
`session = { code, isHost, bot, tok, onStatus(text), seat, numPlayers }`.

Общий каркас шашек/шахмат (изучить `createCheckers` и `createChess` в `mg_games.js`):
- Модель `board` (Array(64)), `turn`, `myColor`, `appliedSeq`, `selected`, `legalTargets`,
  `gameOver`, `pollToken`, `destroyed`.
- Рендер: `boardWrap` (flow-children:none) стек из `boardPanel` (8×8 клеток) + `piecesLayer`
  (фигуры, позиционируются `transform: translate3d`). `cells[realSquare]` — панели клеток
  (id `cell_<sq>`). `pieceEls[realSquare]` — панели фигур, у каждой `_sq` (живая клетка).
- Геометрия: `SQ=60`, шашки `PIECE_SZ=46`, шахматы `PIECE_SZ=56`. `transformFor(realIdx)`.
- Ввод: клик (`onCellClick`) + drag (ghost-рецепт, ловушка 16 про `clearDrag`).
- Ход: `doLocalHop`/`doLocalMove` → анимация (`animateHop`/`applyChessMove`) → сеть
  (`sendHops`/`sendChessMove`) или бот (`scheduleBotTurn`). Приём: `pollOnce`.
- Конец: `checkEnd` → `finish(winner)` / `finishDraw()` → сейчас только `status(...)`.
- **Отображение с точки зрения игрока:** `toDisplay/fromDisplay` (чёрные видят доску на 180°).

### UI-шелл (mg_ui.js)

- `renderGame(gameId, code, isHost, bot, opts)` монтирует игру в `.mg-game-host` внутри
  `modalBody`, ниже — ряд `.mg-actions` с кнопкой **Leave**. Сюда добавим **Play Again**
  и селектор тайм-контроля.
- `renderDetail()` — правая колонка меню с кнопками QUICK MATCH / CREATE / JOIN / PLAY VS BOT.
  Сюда добавим выбор тайм-контроля для шахмат/шашек.
- `botGamesStarted` — счётчик, чередует сторону в игре с ботом.
- `setStatus`, `setTitle`, `buildScaleControl` (нативный DropDown, ловушки 11/12/15).

### API (mg_net.js) — что уже есть

```
Api.create(game, tok, cb(code), err)
Api.quick(game, tok, cb({role,code}), err)          role="host"|"joiner"
Api.join(code, tok, cb({ok,game,reason}), err)
Api.status(code, cb({gone,players,game}), err)
Api.move(code, from, to, end, tok, cb({ok,reason}), err)   reason: turn|illegal|token|gone
Api.poll(code, since, cb(move|null), err, validate)         move={from,to,end,seq}
Api.reset(code, game, tok, cb(ok), err)             ← УЖЕ ЕСТЬ: тот же game, свежий стейт
Api.room/start/dact/dlog/ddraw                       ← Дурак
Net.request(path, params, onDone(w,h), onErr)        ← сырой транспорт для новых роутов
```

Сервер `/api/reset?code&game&tok` уже сбрасывает `lobby.moves=[]`, `turn=0`,
`state=initState(game)`, `t=nowSeq()` и возвращает `(1,1)` (см. worker.core.js ~ln228).
**Но** опрашивающий это НЕ детектит (после reset `moves` пуст, `poll since=N` вернёт `(1,1)`
«ничего нового»). Реванш требует явной детекции — см. §7.1.

---

## 3. Ловушки Panorama (из ARCHITECTURE.md — читать оригинал, тут выжимка!)

Эти вещи стоили часов отладки; **не повторять**:
1. **НЕТ `position:absolute`** — Panorama молча игнорит. Наложение = родитель
   `flow-children:none` + смещение через `transform/margin/align`.
2. `transition` **только longhand** (`transition-property/-duration/-timing-function`);
   shorthand для transform молча дропается.
3. Transition — на БАЗОВОМ классе, значение меняем позже (иначе кадр пропускается).
5. Масштаб в месте — `pre-transform-scale2d`, НЕ `scale3d` в transform (улетает в 0,0).
6. В шрифте НЕТ глифов `✕`/`◯` — рисуем панелями (X = 2 бара `rotateZ`, O = кольцо).
   **Это же — рецепт для СТРЕЛОК (§8, этап 3): линия = тонкая панель, повёрнутая `rotateZ`.**
8. Сетка — явные строки-панели, не flow-wrap.
11–12,15. Кастомные попапы капризны; для скина используем **нативный DropDown** там, где
   можно (уже сделано для scale). Видимость попапа — классом на самой панели.
14. Фикс-текстуру (.vtex) рисует **дочерний `<Image>`** (`setFace`), НЕ `background-image`
   (иначе ~300% зум на первом кадре). `setFace` уже скопирован в mg_ui/mg_durak/mg_games.
16. **`clearDrag()` из ВСЕХ путей выхода**, не только DragEnd (иначе ghost висит при съедении
   перетаскиваемой фигуры). Учитывать при премувах/истории (перестройка слоя фигур).

**Проверять возможности API** грепом по `G:\GameTracking-Deadlock\...\panorama\` или
`D:\GitHub2\QOLLOCK\panorama` — не выдумывать CSS/JS API.

---

## 4. Зафиксированные продуктовые решения (мейнтейнер)

| Тема | Решение |
|---|---|
| **Тайм-контроль шахматы/шашки** | Полные **шахматные часы** (банк времени у каждой стороны, тратится только в свой ход). Выбор при старте: **Пуля 1 мин, 3 мин, 5 мин, 10 мин**. |
| **Quick Match** (шахматы/шашки) | Всегда **5 минут** (обе стороны знают заранее). |
| **Бот / Create-Join** | Игрок выбирает контроль из 1/3/5/10. Джойнер узнаёт контроль от сервера (§7.4). |
| **TTT / Дурак** | Жёстко **20 сек на ход** (per-move, сбрасывается каждый ход). |
| **Истечение времени** | **Автопоражение** (flag-fall) во всех играх. |
| **Громкость звука** | **Полноценный слайдер 0–100%** (стиль QOLLOCK: pre-generated soundevent-варианты по шагам громкости) + **клик по иконке = мгновенный mute**. |
| **Порядок** | Поэтапно; **стрелки ПКМ — последним этапом** (самое рискованное в Panorama). |

Замечания:
- Часы **онлайн** синхронизируются с дрейфом (см. §7.3) — это осознанный компромисс MVP,
  честно задокументировать. Оффлайн/бот — часы чисто локальные, тривиально.
- Настройки звука пока **session-only** (Panorama без localStorage; персист — отдельная задача,
  можно позже через cvar). Не изобретать персист без запроса.

---

## 5. Что я узнал из QOLLOCK про звук (ГЛАВНОЕ для этапа 1)

**Проигрывание звука в Panorama:** только через
```js
$.DispatchEvent("PlaySoundEffect", "<ИмяSoundEvent>");
```
`PlaySoundEffect` принимает **имя зарегистрированного soundevent**, НЕ путь к файлу, и
**НЕ принимает громкость**. Проверено: QOLLOCK нигде не передаёт путь, только имена событий.

**Регистрация кастомных soundevent'ов (трюк QOLLOCK):**
- QOLLOCK кладёт `soundevents/world_ambient_emitters.vsndevts` — **имя СУЩЕСТВУЮЩЕГО
  базового файла игры**, который движок и так грузит. Оверрайд этого файла = наши события
  попадают в уже-загруженный манифест. Чтобы не сломать базовые звуки, QOLLOCK включает
  **весь базовый файл (919 КБ)** + дописывает свои события в конец.
- Формат события (KV3):
```
QOL.BuffReminderBase =            // база: 2D UI-микс, без окклюзии/позиционирования
{
    base = "Base.UI"
    occlusion_scale = 0.000000
    ...
}
BuffReminder.Beep =
{
    base = "QOL.BuffReminderBase"
    volume = 1.000000
    vsnd_files = [ "sounds/mods/beep_normal.vsnd", ]
}
```
- **Громкость без параметра:** QOLLOCK **пре-генерит варианты** одного звука на разных
  `volume` — `BuffReminder.Beep_V0 … _V100` (V0=0.0 … V100=10.0, шаг 0.1). В рантайме играет
  вариант, ближайший к нужной громкости. Это и есть «слайдер».

**Сборка:** `build_mod.ps1` компилит `.wav → .vsnd_c`, `.vsndevts → .vsndevts_c`.
Компилит мейнтейнер. Наши WAV лежат в `panorama/sounds/mods/` → путь в `vsnd_files`
будет `panorama/sounds/mods/<name>.vsnd` (проверить относительный корень при первой сборке).

**Наш план (лучше/легче, чем городить руками):**
- Пишем **генератор** `tools/gen_soundevents.js` (Node), который:
  1. читает базовый `world_ambient_emitters.vsndevts` (источник — из
     `G:\GameTracking-Deadlock\...` либо копия из QOLLOCK; **уточнить путь у мейнтейнера**);
  2. дописывает наши 8 звуков, каждый в вариантах `_V0.._V20` (шаг 5% → volume 0.0..1.0
     шаг 0.05; 21×8 = 168 записей — вменяемо);
  3. пишет `soundevents/world_ambient_emitters.vsndevts` в репозиторий мода.
- Имена событий: `MG.MoveSelf`, `MG.MoveOpp`, `MG.Check`, `MG.Illegal`, `MG.Premove`,
  `MG.Promote`, `MG.GameStart`, `MG.TenSeconds`. Вариант громкости: `..._V<step>`, step=0..20.
- Если базовый файл достать проблема — **фолбэк**: временно маппить на встроенные события игры
  (напр. клики UI), но мейнтейнер хочет именно эти lichess-звуки, так что это лишь запасной путь.

---

## 6. Общая инфраструктура (делается в рамках этапа 1, до фич)

### 6.1 `$.MG.Sound` — новый файл `panorama/scripts/mg_sound.js`

Маленький фасад громкости/mute + `play()`. Подключить в `base_hud.xml` **после mg_net,
до rules/games** (чтобы контроллеры видели `$.MG.Sound`).

```js
"use strict";
(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.Sound) return;
    var vol = 70;          // 0..100, session-only
    var muted = false;
    var STEPS = 20;        // _V0.._V20 (шаг 5%)
    function stepFor(v) { return Math.max(0, Math.min(STEPS, Math.round(v / 100 * STEPS))); }
    MG.Sound = {
        getVol: function () { return vol; },
        isMuted: function () { return muted; },
        setVol: function (v) { vol = Math.max(0, Math.min(100, v | 0)); },
        toggleMute: function () { muted = !muted; return muted; },
        play: function (name) {
            if (muted || vol <= 0) return;
            var ev = "MG." + name + "_V" + stepFor(vol);
            try { $.DispatchEvent("PlaySoundEffect", ev); } catch (e) {}
        }
    };
})();
```

Имена для `play(...)`: `"MoveSelf" | "MoveOpp" | "Check" | "Illegal" | "Premove" |
"Promote" | "GameStart" | "TenSeconds"`.

### 6.2 Расширение session-контракта

`renderGame` в mg_ui.js передаёт в `MG.Games.mount(...)` объект session. Добавить туда
колбэки, чтобы игра могла сообщать UI о событиях (Play Again, часы):
```js
onGameOver: function (result) { /* result: "win"|"lose"|"draw" */ },
onClock:    function (mine, theirs) { /* мс; для рендера часов, этап 2 */ },
timeControl: tcSeconds   // 0 = без часов; иначе банк в секундах (этап 2)
```
Контроллеры вызывают `session.onGameOver(...)` из `finish/finishDraw` (и durak/c4 —
из их концов). UI по этому колбэку показывает Play Again.

### 6.3 Единый мост звука в контроллерах

В начало `createCheckers`/`createChess` (и позже durak/ttt/c4) добавить локальный шорткат:
```js
function sfx(n) { if (MG.Sound) MG.Sound.play(n); }
```
Точки вызова — §7.

---

## 7. ЭТАП 1 — Play Again + подсветка последнего хода + звуки

Три коммита. После этапа — репак и тест в игре.

### Коммит 1.1 — Звуковая инфраструктура

**Файлы:** новый `panorama/scripts/mg_sound.js`; новый `tools/gen_soundevents.js`;
сгенерированный `soundevents/world_ambient_emitters.vsndevts`; правка `base_hud.xml`
(добавить `<include src="s2r://panorama/scripts/mg_sound.vjs_c" />` после mg_net).

**Действия:**
1. Написать `mg_sound.js` (§6.1).
2. Написать `tools/gen_soundevents.js` (§5): вход — базовый vsndevts (путь спросить у
   мейнтейнера), выход — `soundevents/world_ambient_emitters.vsndevts` с базой + нашими
   168 записями. Событие `MG.SoundBase { base="Base.UI"; occlusion...=0 }` + по 21 варианту
   на каждый из 8 звуков (vsnd путь: `panorama/sounds/mods/<file>.vsnd`).
3. Прогнать генератор, закоммитить результат.
4. `base_hud.xml`: добавить include mg_sound (порядок: net → **sound** → rules → games…).

**Проверка:** `node --check panorama/scripts/mg_sound.js`; `node tools/gen_soundevents.js`
отрабатывает; глазами глянуть первые/последние записи в сгенерированном файле.
**In-game (мейнтейнер):** звук ещё нигде не триггерится — просто убедиться, что мод грузится
без ошибок после добавления vsndevts (компиляция проходит).

### Коммит 1.2 — Проигрывание звуков в шашках и шахматах

**Файл:** `mg_games.js` (createCheckers, createChess). Добавить `sfx()` (§6.3) и вызовы:

Шахматы (`createChess`):
- `doLocalMove`: после `applyChessMove` — если был мат/шах — `sfx("Check")`, если промо —
  `sfx("Promote")`, иначе `sfx("MoveSelf")`. (Определять по `inCheck(board, -myColor)` и по
  тому, что пешка дошла до края — проще: смотреть класс, но надёжнее — из `applyChessMove`
  вернуть флаги `{capture, promote, check}` и по ним играть.)
- `pollOnce` (ход соперника применён): `sfx(inCheck(board,myColor) ? "Check" : "MoveOpp")`;
  промо соперника → `sfx("Promote")`.
- `rejectAndResync`: `sfx("Illegal")`.
- boot (старт партии): `sfx("GameStart")`.

Шашки (`createCheckers`):
- `doLocalHop`: обычный ход `sfx("MoveSelf")`; промо (`res.promoted`) → `sfx("Promote")`.
- `pollOnce`: ход соперника → `sfx("MoveOpp")` (промо → `sfx("Promote")`).
- `rejectAndResync`: `sfx("Illegal")`.
- boot: `sfx("GameStart")`.

> Рекомендация: пусть `applyChessMove`/`applyHopFx` возвращают `{capture, promote, check}`,
> чтобы звук выбирался по семантике, а не по side-effect. Не плодить лишних движковых вызовов.

**Проверка:** `node --check mg_games.js`. In-game — мейнтейнер слышит звуки.

### Коммит 1.3 — Подсветка последнего хода (шашки + шахматы)

**Файлы:** `mg_games.js`, `mg.css`.

- В обоих контроллерах: переменные `lastFrom=-1, lastTo=-1`. Обновлять в момент применения
  ЛЮБОГО хода (свой `doLocal*`, соперника `pollOnce`, бот). Для многоскачковых шашек —
  подсвечивать первый from и последний to хода.
- В `refreshHighlights()` добавить: снять со всех `mg-lastmove`, затем повесить на
  `cells[lastFrom]` и `cells[lastTo]`.
- CSS (`mg.css`): новый класс поверх базового цвета клетки, но НИЖЕ `mg-sel`/`mg-target`
  по приоритету (последний ход — фон, выбор/цель — важнее):
```css
.mg-cell.mg-lastmove { background-color: #b9a24a66; } /* тёплая полупрозрачная подсветка */
/* убедиться, что .mg-sel и .mg-target идут ПОСЛЕ в файле, чтобы перебивать lastmove */
```
- Порядок применения в refreshHighlights: сначала lastmove, потом sel/target/check.

**Проверка:** `node --check mg_games.js`. In-game — жёлтые клетки после каждого хода.

### Коммит 1.4 — Кнопка Play Again (реванш)

**Файлы:** `mg_ui.js`, контроллеры (вызов `onGameOver`), для онлайна — `worker.core.js`
(+ регенерация `worker.js`) и `mg_net.js` (новый роут).

**UI (mg_ui.js `renderGame`):**
- В `.mg-actions` рядом с Leave добавить скрытую кнопку **Play Again** (по умолчанию collapse).
- Прокинуть в session `onGameOver(result)`, который делает кнопку видимой и меняет статус.
- Обработчик Play Again:
  - **Бот:** просто `renderGame(gameId, 0, !isHostAlt, true)` с чередованием стороны
    (инкремент `botGamesStarted`), т.е. новый вызов renderGame с флипнутой стороной. Тривиально.
  - **Онлайн:** запустить хендшейк реванша (§7.1).

**Контроллеры:** в `finish/finishDraw` (шахматы/шашки), в концах ttt/durak/c4 — вызвать
`session.onGameOver(result)`.

#### 7.1 Онлайн-реванш (детекция + хендшейк) — серверная часть

Проблема: `/api/reset` уже есть, но сброс не детектится опрашивающим. Нужно:
1. **worker.core.js:** в лобби добавить `gen` (int, стартом 0) и `rm:[false,false]`
   (флаги «хочу реванш» по сиденьям). Новый роут:
   ```
   /api/rematch?code=C&tok=T  ->  (state, gen)
     state: 1 = я отметил, жду соперника; 2 = оба готовы → сервер сделал reset и gen++
            9 = лобби закрыто/плохой токен (h различает: (9,3) токен, (9,9) gone)
   ```
   Логика: seat = seatOf(tok); `rm[seat]=true`. Если оба true → выполнить тот же сброс,
   что `/api/reset` (moves=[], turn=0, state=initState(game), t=nowSeq()), `gen++`,
   `rm=[false,false]`, вернуть `(2, gen)`. Иначе `(1, gen)`.
   Также **status** (или отдельный `/api/rgen?code`) должен возвращать текущий `gen`,
   чтобы сторона, НЕ нажавшая первой, тоже увидела инкремент и перестроилась. Проще:
   `/api/rematch` без `tok`-эффекта как «read»? Нет — сделать так: обе стороны на экране
   game-over **поллят `/api/rematch`** (idempotent: повторный вызов того же seat не ломает),
   и когда `state==2` ИЛИ `gen` вырос относительно запомненного — обе перезапускают партию.
2. `tools/build_worker.js` — регенерировать `worker.js`. **Никогда не править worker.js руками.**
3. **mg_net.js:** добавить `Api.rematch(code, tok, cb({state,gen}), err)` через `Net.request`.

#### 7.1b Онлайн-реванш — клиентская часть (mg_ui.js)

- На `onGameOver` в онлайне: показать Play Again. По клику: `Api.rematch(code,tok,…)`,
  статус «Ждём соперника…». Запустить поллинг `/api/rematch` (или rgen) с токеном-стражем
  (как `statusPollToken`). Когда `state==2`/`gen` вырос — вызвать `renderGame` заново с тем же
  gameId/code/isHost (стороны сохраняются; сервер уже сбросил стейт).
- Таймаут/закрытие лобби (`9,*`) → `kickToMenu`.
- Проиграть `sfx("GameStart")` на рестарте.

**Проверка:** `node tools/build_worker.js`; `node --check server/worker.js`;
`node --check mg_net.js mg_ui.js mg_games.js`; `node tools/mg_server_test.js`
(дописать кейс на rematch: два токена → оба rematch → gen++ и стейт свежий).
In-game — реванш и с ботом, и онлайн.

---

## 8. ЭТАП 2 — История ходов + Часы + Премувы

После этапа — репак и тест. Три-четыре коммита.

### Коммит 2.1 — Двухколоночная раскладка игрового экрана + панель истории

**Файлы:** `mg_games.js` (рендер шахмат/шашек), `mg.css`.

- Обернуть доску и новую панель истории в контейнер `flow-children:right`:
  `.mg-game-2col { flow-children:right; }` — слева `boardWrap`, справа
  `.mg-movelist` (та самая «ненужная область справа от доски», модалка 900px, доска 486px,
  места хватает ~360px).
- `.mg-movelist`: заголовок + прокручиваемый список ходов + ряд навигации `⟲ ◀ ▶ ⟳`
  (в игре нет глифов ✕/◯, но ‹/›/цифры есть; для стрелок навигации использовать
  ASCII `<` `>` или текст «Prev/Next/Live», чтобы не влететь в отсутствующий глиф).
- Стиль — в языке mg.css (нейтрали, hairline-бордеры, radiance). Никаких градиентов/glow.

### Коммит 2.2 — Запись истории + локальная навигация (обзор прошлых позиций)

**Файл:** `mg_games.js`.

Модель:
- `history = []`. На каждый завершённый ход пушим запись:
  шахматы `{ from, to, boardAfter: board.slice(), cstAfter: cloneState(cst), label }`;
  шашки — аналогично (можно хранить массив хопов хода + снапшот доски).
- `label` — координатная нотация (без полного SAN, чтобы не тащить генератор):
  файл-ранг `a1..h8` из `fromDisplay`-независимых реальных клеток, `x` при взятии,
  напр. `e2-e4`, `d4xf6`. Хелпер `sqName(realIdx)` (a..h + 1..8).
- Просмотр: `reviewIndex = null` (жив) | i (смотрим позицию после i-го хода).
  `layoutPiecesFrom(boardSnapshot)` — вынести общий рендер, чтобы можно было отрисовать
  произвольный снапшот. Во время просмотра:
  - `onCellClick`/drag/премув **заблокированы** (в начале ставим `if (reviewIndex!=null) return;`).
  - Клетки без подсветок выбора; last-move — той пары, что в просматриваемом ходе.
  - Кнопки: `<` prev, `>` next, `Live` вернуться к живой позиции (reviewIndex=null →
    перерисовать из живого `board`). Клик по строке списка → перейти к тому ходу.
- **Важно:** приход живого хода соперника во время просмотра НЕ ломает `board`
  (живой board обновляется всегда), только если `reviewIndex==null` — перерисовываем;
  иначе показываем бейдж «новый ход» и не дёргаем просмотр. При возврате на Live — полный
  `layoutPieces()` из живого board. Вызвать `clearDrag()` при любой перестройке слоя (ловушка 16).

**Проверка:** `node --check mg_games.js`. In-game — листание позиций, возврат на Live,
живой ход не сбивает просмотр.

### Коммит 2.3 — Часы (шахматы/шашки: банки; TTT/Дурак: 20с/ход)

**Файлы:** `mg_ui.js` (выбор контроля + рендер часов), `mg_games.js`, `mg_durak.js`,
`mg_connectfour.js`?(нет — по ТЗ только TTT/Дурак), `worker.core.js` + `worker.js` + `mg_net.js`
(передача контроля джойнеру), `mg.css`.

**Выбор тайм-контроля (mg_ui.js `renderDetail`, только шахматы/шашки):**
- Мини-селектор (сегменты/нативный DropDown как scale): `1 | 3 | 5 | 10` мин. Дефолт 5.
- **Quick Match** — принудительно 5 мин (не показывать выбор или дизейблить).
- **Create/Join:** хост выбирает; значение уходит на сервер при create (§7.4);
  джойнер читает из status/join и НЕ выбирает.
- **Бот:** игрок выбирает, всё локально.
- Прокинуть `session.timeControl = seconds` (0 = без часов, для TTT/Дурака — спец-режим 20с).

**Модель часов (общая, положить в контроллер или в маленький хелпер `mg_clock`):**
- Шахматы/шашки: `clock = { me: tcMs, opp: tcMs }`. Тикает ТОЛЬКО активная сторона.
  `$.Schedule(0.1, tick)` с токеном; на каждом тике вычитаем прошедшее у стороны, чей `turn`.
  На `<=0` активной стороны → **автопоражение** этой стороны: если это Я → `finish(opponent)`
  и отправить сигнал сопернику (см. ниже); если соперник (по моей оценке) → `finish(me)`.
  На отметке 10с своей стороны — `sfx("TenSeconds")` один раз.
- TTT/Дурак: `perMove = 20s`, сбрасывается в начале КАЖДОГО хода активного игрока; истёк →
  автопоражение активного (в дураке — он проигравший/дурак; в TTT — проигрыш).

**Рендер часов (mg.css + mg_ui или контроллер):** две компактные плашки времени
`M:SS`, вписанные в интерфейс — над доской справа или в ряду `.mg-actions`
(над панелью истории тоже ок). Активная плашка подсвечена. Формат — моноширинно, radiance.

#### 7.3 / 8.x Синхронизация часов онлайн (осознанный компромисс)

Даунлинк — 2 инта, банк туда не влезает вместе с ходом. Дизайн MVP:
- Каждый клиент ведёт **свои** часы локально и оценивает часы соперника, измеряя wall-clock
  между «стало ходом соперника» и «пришёл его ход через poll». Дрейф ограничен интервалом
  поллинга (~0.4с/ход) — для казуала приемлемо. **Честно задокументировать в ARCHITECTURE.md.**
- **Flag-fall:** авторитетна сторона, чьи часы истекли, — она сама объявляет себе поражение
  локально и шлёт сигнал. Сигнал через **новый лёгкий роут** `/api/timeout?code&tok` →
  сервер помечает победителя, отдаёт `(1,1)`; соперник ловит это опросом (добавить в poll
  или отдельный флаг в status). Либо (проще) кодировать таймаут как спец-ход, но `(1,1)`
  занят «ничего нового» — поэтому **отдельный роут надёжнее**.
- **Опционально (надёжный апгрейд, если попросят):** роут `/api/clocks?code` →
  `(seat0_sec, seat1_sec)` (оба ≤600 влезают), поллить раз в ~1с для коррекции дрейфа,
  и хранить банк на сервере (клиент шлёт остаток в `&clk=` при ходе — аплинк свободен).
  Это чище, но больше протокола; для MVP — локальная оценка + `/api/timeout`.

#### 7.4 Передача тайм-контроля джойнеру (worker.core.js)

- `create?...&tc=I` — хранить `lobby.tc` (индекс 0..3 = 1/3/5/10, или секунды).
- `quick` для шахмат/шашек — сервер сам ставит `tc=5мин`.
- `join`/`status` — вернуть `tc` джойнеру. Даунлинк 2 инта: у `join` сейчас `(G,1)`;
  можно вернуть `(G, tc+1)` (tc небольшой), у `status` — упаковать в свободный разряд
  либо отдельный `/api/tc?code` → `(tc+1,1)`. Выбрать минимально инвазивный вариант,
  описать в шапке worker.core.js и в §5 README-протокола.
- Регенерировать `worker.js` через `build_worker.js`.

**Проверка:** `node --check` всех правленых; `node tools/build_worker.js`;
`node --check server/worker.js`; `node tools/mg_server_test.js` (+кейсы tc и timeout).
In-game — часы идут, тикают только в свой ход, 10с-звук, автопоражение по флагу онлайн и с ботом.

### Коммит 2.4 — Премувы (шахматы/шашки)

**Файл:** `mg_games.js`, `mg.css`.

- Состояние `premove = null | {from, to}` (для шашек — первый хоп).
- Ввод в **чужой** ход: разрешить выбрать свою фигуру и клетку-цель (клик или drag) —
  но НЕ применять к board, а сохранить в `premove`, подсветить обе клетки классом
  `.mg-premove` (отличный цвет, напр. холодный красно-розовый) и `sfx("Premove")`.
- Отмена: левый клик по пустому/другой фигуре, правый клик (если ПКМ ещё не занят стрелками —
  на этом этапе занят не будет), или новый выбор премува. Хелпер `clearPremove()`.
- Исполнение: в момент, когда становится МОЙ ход (после применения хода соперника в `pollOnce`
  или бота), если `premove` задан — проверить легальность в новой позиции
  (`targetsFor(premove.from)` содержит `premove.to`?). Легально → выполнить как обычный ход
  (`doLocalHop`/`doLocalMove`), нелегально → `clearPremove()` (тихо).
- Взаимодействие: премув-фигуру мог съесть ход соперника → `clearPremove()` в тех же местах,
  где `clearDrag()` (перестройка слоя). Во время просмотра истории премувы заблокированы.
- CSS:
```css
.mg-cell.mg-premove { background-color: #b5476b88; }
```

**Проверка:** `node --check mg_games.js`. In-game — премув ставится в чужой ход, авто-исполняется
при легальности, снимается при нелегальности/съедении.

---

## 9. ЭТАП 3 — Стрелки и подсветка клеток по ПКМ (риск, Panorama)

Отдельный этап, экспериментальный. После — репак и тест.

**Файлы:** `mg_games.js` (шахматы/шашки), `mg.css`.

**Слой аннотаций:** новый оверлей `.mg-annot-layer` (flow-children:none, hittest:false)
поверх `piecesLayer`, размер = доска. Хранить список аннотаций, перерисовывать на изменение.
Чистить на любой левый клик и на новый ход (как lichess).

**Подсветка клетки ПКМ (легко):** правый клик по клетке → тоггл цветной панели в клетке
(панель на слое аннотаций по `transformFor`), цвет по модификатору (Shift/Alt) опционально.

**Стрелка A→B ПКМ-драгом (сложно):** рисуется как **тонкая повёрнутая панель** (ловушка 6 —
тот же приём, что X в TTT: бар + `rotateZ`) + треугольный наконечник (маленькая панель,
повёрнутая под angle). Геометрия: центр A и B из `transformFor`/`SQ`; `dx,dy`,
`len=hypot(dx,dy)`, `angle=atan2(dy,dx)`; панель шириной `len`, высотой ~6px, `transform:
translate3d(ax,ay,0) rotateZ(<angle>rad)`, `transform-origin: 0% 50%`. Наконечник — отдельная
панель у B. Цвет — accent.

**Детект ПКМ — НЕИЗВЕСТНО, ТРЕБУЕТ РАЗВЕДКИ:**
- В Panorama обычные `onactivate` = ЛКМ. Для ПКМ нужно найти рабочий сигнал: проверить
  `oncontextmenu`, `onmouseactivate` (с чтением кнопки), или `$.RegisterEventHandler` с
  событием мыши. **Грепнуть** `G:\GameTracking-Deadlock\...panorama\` и
  `D:\GitHub2\QOLLOCK\panorama` на `contextmenu|MouseButton|RightClick|oncontextmenu` и
  использовать ТОЛЬКО проверенный в игре паттерн (правило проекта: не выдумывать API).
- Драг ПКМ отдельно от штатного (ЛКМ) drag фигур: возможно, отслеживать mousedown-кнопку
  и mouseover-клетки вручную. Если надёжного ПКМ-драга нет — деградировать до
  «ПКМ по клетке-1, ПКМ по клетке-2 = стрелка» (два клика вместо драга).

**Честность:** пометить весь этап как «не проверено, обосновано»; сперва выяснить ПКМ-сигнал
в игре (мейнтейнер), потом рисовать стрелки.

**Проверка:** `node --check mg_games.js`. In-game — подсветка и стрелки по ПКМ, чистятся на ЛКМ/ход.

---

## 10. Что трогаем по файлам (сводка)

| Файл | Этап 1 | Этап 2 | Этап 3 |
|---|---|---|---|
| `panorama/scripts/mg_sound.js` (новый) | ✔ | | |
| `tools/gen_soundevents.js` (новый) | ✔ | | |
| `soundevents/world_ambient_emitters.vsndevts` (ген.) | ✔ | | |
| `panorama/layout/base_hud.xml` | ✔ (include) | | |
| `panorama/scripts/mg_games.js` | ✔ звук/last-move | ✔ история/часы/премув | ✔ стрелки |
| `panorama/scripts/mg_ui.js` | ✔ Play Again | ✔ выбор TC/рендер часов | |
| `panorama/scripts/mg_net.js` | ✔ Api.rematch | ✔ Api.timeout/tc | |
| `server/worker.core.js` (+`worker.js` ген.) | ✔ rematch/gen | ✔ tc/timeout | |
| `panorama/scripts/mg_durak.js` | ✔ onGameOver | ✔ 20с/ход | |
| `panorama/scripts/mg_connectfour.js` | ✔ onGameOver | | |
| TTT (в mg_games.js) | ✔ onGameOver/звук | ✔ 20с/ход | |
| `panorama/styles/mg.css` | ✔ last-move | ✔ movelist/часы/премув | ✔ annot/arrows |

---

## 11. Валидация перед КАЖДЫМ коммитом

```
node tools/build_worker.js                       # если менялись rules/* или worker.core.js
node --check panorama/scripts/mg_sound.js        # (после этапа 1)
node --check panorama/scripts/mg_net.js
node --check panorama/scripts/mg_games.js
node --check panorama/scripts/mg_durak.js
node --check panorama/scripts/mg_connectfour.js
node --check panorama/scripts/mg_ui.js
node --check server/worker.js
node tools/mg_rules_test.js
node tools/mg_chess_test.js
node tools/mg_connectfour_test.js
node tools/mg_durak_test.js
node tools/mg_server_test.js
node tools/mg_parity_test.js
node tools/gen_soundevents.js                    # (этап 1) генератор отрабатывает без ошибок
```
Все зелёные → коммит. В сообщении коммита честно разделять **verified** (синтаксис/правила/
серверный протокол) и **reasoned-only** (визуал/анимация/звук/ввод/часы — ждёт in-game
подтверждения мейнтейнером после репака VPK).

---

## 12. Открытые вопросы / риски (спросить мейнтейнера, не угадывать)

1. **Источник базового `world_ambient_emitters.vsndevts`** для генератора: брать из
   `G:\GameTracking-Deadlock\...` или из `D:\GitHub2\QOLLOCK\soundevents\...`? Точный путь.
2. **Относительный корень `vsnd_files`** после сборки: `panorama/sounds/mods/...` или
   переместить WAV в `sounds/mods/...` как в QOLLOCK? Проверить первой компиляцией.
3. **Шаг слайдера громкости:** 5% (V0..V20, 168 записей) ок, или нужен мельче/крупнее?
4. **Где физически разместить контрол громкости/mute** в модалке (header тесный: title/credit/
   support/discord/scale/close). Предложение: иконка-динамик в правом кластере header, по клику
   — mute; маленький поповер-слайдер. Утвердить размещение.
5. **Онлайн-часы:** согласен ли мейнтейнер на MVP с локальной оценкой + `/api/timeout`
   (дрейф ~poll-интервал), или сразу делать серверные банки `/api/clocks` (+протокол)?
6. **Реванш:** сохранять стороны или менять цвет/сторону при рестарте? (Дефолт — сохранять.)
7. **Стрелки ПКМ:** какой сигнал ПКМ реально работает в Deadlock Panorama — нужна разведка
   в игре до реализации; при отсутствии драга — фолбэк «два ПКМ-клика = стрелка».

---

## 13. Порядок исполнения (короткий чеклист для агента)

1. Работать на том же бренче minigames-checkers
2. **Этап 1:** 1.1 звук-инфра → 1.2 звуки в играх → 1.3 last-move → 1.4 Play Again
   (бот + онлайн-rematch с серверным роутом). Валидация §11 на каждом. **СТОП → тест в игре.**
3. **Этап 2:** 2.1 2-колонки → 2.2 история/навигация → 2.3 часы (+сервер tc/timeout) →
   2.4 премувы. Валидация. **СТОП → тест в игре.**
4. **Этап 3:** стрелки/подсветка ПКМ (сначала разведка ПКМ-сигнала). Валидация. **СТОП → тест.**
5. Не пушить/не открывать PR без запроса. Описание PR — плейн-текстом в чат мейнтейнеру.

---

### Приложение A — быстрые ссылки на код

- Ловушки Panorama и архитектура: `ARCHITECTURE.md` (§6 — 16 ловушек; §7 шашки; §8.5 шахматы).
- Реестр игр и монтаж: конец `mg_games.js` (`MG.Games` list/register/mount).
- Рендер/ввод/сеть шашек: `createCheckers` (mg_games.js ~ln43–769).
- Рендер/ввод/сеть шахмат: `createChess` (mg_games.js ~ln996–1523).
- UI-поток/renderGame/renderDetail: `mg_ui.js`.
- Транспорт/роуты/reset: `mg_net.js` (`Api.*`), `server/worker.core.js` (`/api/reset` ~ln228).
- Звук в QOLLOCK: `$.DispatchEvent("PlaySoundEffect", …)` + `soundevents/world_ambient_emitters.vsndevts`.
```
```
