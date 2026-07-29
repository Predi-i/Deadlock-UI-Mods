"use strict";

/*
 * Wordle - offline five-letter word game.
 *
 * No worker routes, matchmaking, or image-side-channel traffic are used. The controller
 * owns the answer, guesses, duplicate-letter scoring, and physical-keyboard input via a
 * hidden TextEntry. It self-registers game id 8 after mg_games.js has created the shared
 * registry.
 */
(function () {
    var MG = $.MG = $.MG || {};
    if (MG.Wordle) return;
    MG.Wordle = {};

    var ANSWERS = (
        "ABOUT ABOVE ABUSE ACTOR ACUTE ADMIT ADOPT ADULT AFTER AGAIN AGENT AGREE AHEAD ALARM " +
        "ALBUM ALERT ALIKE ALIVE ALLOW ALONE ALONG ALTER AMONG ANGER ANGLE ANGRY APART APPLE " +
        "APPLY ARGUE ARISE ARRAY ASIDE ASSET AUDIO AUDIT AVOID AWAKE AWARD AWARE BADLY BAKER " +
        "BASIC BASIS BEACH BEGAN BEGIN BEING BELOW BENCH BIRTH BLACK BLAME BLIND BLOCK BLOOD " +
        "BOARD BRAIN BRAND BREAD BREAK BRIEF BRING BROAD BROKE BROWN BUILD BUILT BUYER CABLE " +
        "CARRY CATCH CAUSE CHAIN CHAIR CHART CHASE CHEAP CHECK CHEST CHIEF CHILD CHINA CHOSE " +
        "CIVIL CLAIM CLASS CLEAN CLEAR CLIMB CLOCK CLOSE CLOUD COACH COAST COULD COUNT COURT " +
        "COVER CRAFT CRASH CREAM CRIME CROSS CROWD CROWN CURVE CYCLE DAILY DANCE DEALT DEATH " +
        "DEBUT DELAY DEPTH DOING DOUBT DOZEN DRAFT DRAMA DRAWN DREAM DRESS DRINK DRIVE DROVE " +
        "DYING EAGER EARLY EARTH EIGHT ELITE EMPTY ENEMY ENJOY ENTER ENTRY EQUAL ERROR EVENT " +
        "EVERY EXACT EXIST EXTRA FAITH FALSE FAULT FIBER FIELD FIFTH FIFTY FIGHT FINAL FIRST " +
        "FIXED FLASH FLEET FLOOR FLUID FOCUS FORCE FORTH FORTY FORUM FOUND FRAME FRESH FRONT " +
        "FRUIT FULLY FUNNY GIANT GIVEN GLASS GLOBE GOING GRACE GRADE GRAND GRANT GRASS GREAT " +
        "GREEN GROSS GROUP GROWN GUARD GUESS GUEST GUIDE HAPPY HEART HEAVY HENCE HORSE HOTEL " +
        "HOUSE HUMAN IDEAL IMAGE INDEX INNER INPUT ISSUE JOINT JUDGE KNOWN LABEL LARGE LASER " +
        "LATER LAUGH LAYER LEARN LEAST LEAVE LEGAL LEVEL LIGHT LIMIT LOCAL LOGIC LOOSE LOVER " +
        "LOWER LUCKY LUNCH MAJOR MAKER MARCH MATCH MAYBE MAYOR MEDIA METAL MIGHT MINOR MODEL " +
        "MONEY MONTH MORAL MOTOR MOUNT MOUSE MOUTH MOVIE MUSIC NEEDS NEVER NEWLY NIGHT NOISE " +
        "NORTH NOVEL NURSE OCCUR OCEAN OFFER OFTEN ORDER OTHER OUGHT PAINT PANEL PAPER PARTY " +
        "PEACE PHASE PHONE PHOTO PIECE PILOT PITCH PLACE PLAIN PLANE PLANT PLATE POINT POUND " +
        "POWER PRESS PRICE PRIDE PRIME PRINT PRIOR PRIZE PROOF PROUD PROVE QUEEN QUICK QUIET " +
        "QUITE RADIO RAISE RANGE RAPID RATIO REACH READY REFER RIGHT RIVAL RIVER ROBIN ROUGH " +
        "ROUND ROUTE ROYAL RURAL SCALE SCENE SCOPE SCORE SENSE SERVE SEVEN SHALL SHAPE SHARE " +
        "SHARP SHEET SHELF SHELL SHIFT SHIRT SHOCK SHOOT SHORT SHOWN SIGHT SINCE SIXTH SIXTY " +
        "SKILL SLEEP SMALL SMART SMILE SOLID SOLVE SORRY SOUND SOUTH SPACE SPARE SPEAK SPEED " +
        "SPEND SPENT SPLIT SPOKE SPORT STAFF STAGE STAKE STAND START STATE STEAM STEEL STICK " +
        "STILL STOCK STONE STOOD STORE STORM STORY STRIP STUCK STUDY STUFF STYLE SUGAR TABLE " +
        "TAKEN TASTE TEACH TEETH THANK THEME THERE THICK THING THINK THIRD THOSE THREE THROW " +
        "TIGHT TIMES TIRED TITLE TODAY TOPIC TOTAL TOUCH TOUGH TOWER TRACK TRADE TRAIN TREAT " +
        "TREND TRIAL TRIED TRUCK TRULY TRUST TRUTH TWICE UNDER UNION UNITY UNTIL UPPER UPSET " +
        "URBAN USAGE USUAL VALID VALUE VIDEO VIRUS VISIT VITAL VOICE WASTE WATCH WATER WHEEL " +
        "WHERE WHICH WHILE WHITE WHOLE WHOSE WOMAN WOMEN WORLD WORRY WORSE WORST WORTH WOULD " +
        "WRITE WRONG WROTE YOUNG YOUTH"
    ).split(" ");
    var EXTRA_GUESSES = (
        "ABBEY ABODE ABORT ACTED ADMIN ADOBE AISLE ALIEN AMBER AMEND AMPLE ANGEL ANKLE ARENA " +
        "ARMOR ARROW ATLAS ATTIC BACON BADGE BEARD BEAST BEGUN BELLY BERRY BLADE BLAST BLEED " +
        "BLEND BLESS BLOOM BLUES BLUNT BOOTH BOUND BOWEL BRAVE BRICK BRIDE BRUSH BUNCH CABIN " +
        "CAMEL CANDY CEDAR CHARM CHEER CHESS CHILL CHUNK CLERK CLIFF CLOTH CLOWN CORAL COUGH " +
        "CRANE CRATE CRAWL CRAZY CREEK CRISP CRUEL DAIRY DEMON DIZZY DONOR DOUGH EAGLE ELECT " +
        "FAIRY FAVOR FEAST FENCE FEWER FLAME FLOOD FLOUR FROST GHOST GLORY GRAPE GRAPH GRIEF " +
        "HABIT HONEY HONOR HUMOR JUICE KNIFE KNOCK LEMON LODGE MAGIC MAPLE MERCY METER MICRO " +
        "NINTH ONION OPERA PASTE PAUSE PEACH PEARL PIANO PIZZA PLUMB POETS QUEUE RANCH RAVEN " +
        "REACT RHYME RIDER RULER SAUCE SHORE SKATE SKULL SNAKE SOLAR SPELL SPIKE SPOON SPRAY " +
        "SQUAD STARE SWEET SWORD THUMB TIGER TOAST TOKEN TRACE TRICK TROOP UNCLE VENUE WEARY"
    ).split(" ");
    if (!MG.WordleWords || !MG.WordleWords.answers || !MG.WordleWords.guesses) {
        $.Warning("[Minigames] Full Wordle dictionary was not loaded; using fallback words.\n");
    } else {
        ANSWERS = MG.WordleWords.answers;
        EXTRA_GUESSES = MG.WordleWords.guesses;
    }
    var VALID = {};
    for (var wi = 0; wi < ANSWERS.length; wi++) VALID[ANSWERS[wi]] = true;
    for (wi = 0; wi < EXTRA_GUESSES.length; wi++) VALID[EXTRA_GUESSES[wi]] = true;

    // ── wordle pure scoring ──
    // Returns 2=correct, 1=present elsewhere, 0=absent. Exact matches consume letters
    // before present matches, which is the important duplicate-letter rule.
    function scoreGuess(answer, guess) {
        var score = [0, 0, 0, 0, 0];
        var left = {};
        var i;
        for (i = 0; i < 5; i++) {
            if (guess.charAt(i) === answer.charAt(i)) score[i] = 2;
            else left[answer.charAt(i)] = (left[answer.charAt(i)] || 0) + 1;
        }
        for (i = 0; i < 5; i++) {
            var ch = guess.charAt(i);
            if (!score[i] && left[ch] > 0) {
                score[i] = 1;
                left[ch]--;
            }
        }
        return score;
    }
    // ── end wordle pure scoring ──

    function createWordle(container, session) {
        session = session || {};
        var destroyed = false, row = 0, current = "", over = false;
        var keyState = {}, keyButtons = {};
        // Fresh random answer per game. The old formula was (day + gamesStarted*37), which tied the
        // word to the UTC day and only stepped it by a fixed 37 indices per Play Again - so two
        // sessions on the same day always opened with the SAME word and the sequence after it was
        // fully predictable. This is an offline puzzle with nothing at stake, so plain Math.random
        // is the right tool (no CSPRNG needed).
        var answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length) % ANSWERS.length];

        function status(text) { if (!destroyed && session.onStatus) session.onStatus(text); }
        function sfx(name) { if (MG.Sound) MG.Sound.play(name); }
        function addLabel(parent, className, text) {
            var label = $.CreatePanel("Label", parent, "");
            label.AddClass(className);
            label.text = text || "";
            return label;
        }

        var root = $.CreatePanel("Panel", container, "MG_Wordle");
        root.AddClass("mg-wordle");
        var layout = $.CreatePanel("Panel", root, "");
        layout.AddClass("mg-wordle-layout");

        // Left: board + hidden input
        var boardWrap = $.CreatePanel("Panel", layout, "");
        boardWrap.AddClass("mg-wordle-boardwrap");
        var board = $.CreatePanel("Panel", boardWrap, "");
        board.AddClass("mg-wordle-board");
        var tiles = [];
        for (var r = 0; r < 6; r++) {
            var rowPanel = $.CreatePanel("Panel", board, "");
            rowPanel.AddClass("mg-wordle-row");
            tiles[r] = [];
            for (var c = 0; c < 5; c++) {
                var tile = $.CreatePanel("Panel", rowPanel, "");
                tile.AddClass("mg-wordle-tile");
                tiles[r][c] = { panel: tile, label: addLabel(tile, "mg-wordle-letter", "") };
            }
        }

        // Hidden TextEntry captures the physical keyboard. It overlaps the board (flow:none
        // boardwrap) so any click on the board gives it focus. `ontextentrychange` fires per
        // keystroke and `oninputsubmit` on Enter - the game's own confirmed input idiom
        // (chat.xml / popup_join_party.xml). The entry's own text is the source of truth for the
        // current guess: we read it back, upper-case it, drop anything that isn't A–Z, cap it at
        // 5, and mirror the result into the tiles. Backspace is handled for free (the text just
        // gets shorter). maxchars caps it so the field can't outrun the row.
        var entry = $.CreatePanel("TextEntry", boardWrap, "MG_WordleInput");
        entry.AddClass("mg-wordle-input");
        entry.SetAttributeInt("maxchars", 5);
        var syncing = false;                 // guard: rewriting entry.text must not re-enter onChange
        try { entry.SetFocus(); } catch (e) {}

        function refocus() { if (!destroyed && !over) { try { entry.SetFocus(); } catch (e) {} } }
        boardWrap.SetPanelEvent("onactivate", refocus);

        function paintCurrent() {
            for (var i = 0; i < 5; i++) {
                var t = tiles[row] && tiles[row][i];
                if (!t) continue;
                t.label.text = current.charAt(i);
                if (i < current.length) t.panel.AddClass("mg-wordle-filled");
                else t.panel.RemoveClass("mg-wordle-filled");
            }
        }

        function finish(won) {
            over = true;
            sfx("GameEnd");
            status(won ? "Solved in " + row + (row === 1 ? " guess!" : " guesses!") :
                "The word was " + answer + ".");
            if (session.onGameOver) session.onGameOver(won ? "win" : "lose");
        }

        function submit() {
            if (over || current.length !== 5) {
                if (!over) { status("Enter five letters first."); sfx("Illegal"); }
                return;
            }
            if (!VALID[current]) {
                status("Not in the word list.");
                sfx("Illegal");
                return;
            }
            var guess = current, result = scoreGuess(answer, guess);
            for (var i = 0; i < 5; i++) {
                var panel = tiles[row][i].panel;
                panel.RemoveClass("mg-wordle-filled");
                panel.AddClass(result[i] === 2 ? "mg-wordle-correct" :
                    result[i] === 1 ? "mg-wordle-present" : "mg-wordle-absent");
                setKeyState(guess.charAt(i), result[i]);
            }
            row++;
            current = "";
            clearEntry();
            sfx("MoveSelf");
            if (guess === answer) { finish(true); return; }
            if (row >= 6) { finish(false); return; }
            status("Guess " + (row + 1) + " of 6.");
            paintCurrent();
        }

        // Blank the hidden field without re-triggering onChange (the guard) so the next row
        // starts empty and the caret resets.
        function clearEntry() {
            syncing = true;
            try { entry.text = ""; } catch (e) {}
            syncing = false;
        }

        // Read whatever the OS typed into the entry, normalise it to at most 5 A–Z letters, and
        // mirror it into the current row. If normalisation changed the string (lower-case, digits,
        // spaces, or a 6th char the maxchars cap somehow let through) we write the clean version
        // back so the field and the tiles never diverge.
        function onEntryChange() {
            if (destroyed || over || syncing) return;
            var raw = "";
            try { raw = entry.text || ""; } catch (e) { raw = ""; }
            var clean = raw.toUpperCase().replace(/[^A-Z]/g, "").substring(0, 5);
            if (clean !== raw) { syncing = true; try { entry.text = clean; } catch (e2) {} syncing = false; }
            current = clean;
            paintCurrent();
        }

        entry.SetPanelEvent("ontextentrychange", onEntryChange);
        entry.SetPanelEvent("oninputsubmit", submit);

        // Right: keyboard hint panel
        var kbd = $.CreatePanel("Panel", layout, "");
        kbd.AddClass("mg-wordle-kbd");
        var KBD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
        for (var kr = 0; kr < KBD_ROWS.length; kr++) {
            var krow = $.CreatePanel("Panel", kbd, "");
            krow.AddClass("mg-wordle-kbd-row");
            krow.AddClass("mg-wordle-kbd-row" + (kr + 1));
            for (var kc = 0; kc < KBD_ROWS[kr].length; kc++) {
                (function (letter) {
                    var btn = $.CreatePanel("Button", krow, "");
                    btn.AddClass("mg-wordle-kbd-key");
                    addLabel(btn, "mg-wordle-kbd-label", letter);
                    keyButtons[letter] = btn;
                    btn.SetPanelEvent("onactivate", function () {
                        if (destroyed || over) return;
                        if (current.length < 5) {
                            current += letter;
                            syncing = true;
                            try { entry.text = current; } catch (e) {}
                            syncing = false;
                            paintCurrent();
                        }
                        refocus();
                    });
                })(KBD_ROWS[kr].charAt(kc));
            }
        }
        // BACK and ENTER buttons
        var krowExtra = $.CreatePanel("Panel", kbd, "");
        krowExtra.AddClass("mg-wordle-kbd-row");
        var backBtn = $.CreatePanel("Button", krowExtra, "");
        backBtn.AddClass("mg-wordle-kbd-key");
        backBtn.AddClass("mg-wordle-kbd-wide");
        addLabel(backBtn, "mg-wordle-kbd-label", "BACK");
        backBtn.SetPanelEvent("onactivate", function () {
            if (destroyed || over || !current.length) return;
            current = current.substring(0, current.length - 1);
            syncing = true;
            try { entry.text = current; } catch (e) {}
            syncing = false;
            paintCurrent();
            refocus();
        });
        var enterBtn = $.CreatePanel("Button", krowExtra, "");
        enterBtn.AddClass("mg-wordle-kbd-key");
        enterBtn.AddClass("mg-wordle-kbd-wide");
        addLabel(enterBtn, "mg-wordle-kbd-label", "ENTER");
        enterBtn.SetPanelEvent("onactivate", function () { submit(); refocus(); });

        function setKeyState(letter, value) {
            // First assignment always applies (even absent=0); afterwards only UPGRADE
            // (absent → present → correct), never downgrade. Using an explicit undefined
            // check, not `(keyState||0) >= value`, so the first absent (0 >= 0) isn't skipped.
            if (keyState[letter] !== undefined && keyState[letter] >= value) return;
            keyState[letter] = value;
            var btn = keyButtons[letter];
            if (!btn) return;
            btn.RemoveClass("mg-wordle-kbd-absent");
            btn.RemoveClass("mg-wordle-kbd-present");
            btn.RemoveClass("mg-wordle-kbd-correct");
            if (value === 2) btn.AddClass("mg-wordle-kbd-correct");
            else if (value === 1) btn.AddClass("mg-wordle-kbd-present");
            else btn.AddClass("mg-wordle-kbd-absent");
        }

        status("Type your guess, then press Enter.");
        return {
            destroy: function () {
                destroyed = true;
                try { root.DeleteAsync(0); } catch (e) {}
            }
        };
    }

    MG.Wordle.scoreGuess = scoreGuess;
    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 8, enabled: true, create: createWordle });
    }
})();
