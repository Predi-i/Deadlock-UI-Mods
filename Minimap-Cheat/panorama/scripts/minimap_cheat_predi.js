(function() {
    'use strict';

    var WAVE_COUNT = 2;
    var CLICK_DELAY = 3.0;
    var WAVE_DELAY = 3.0;
    var TRIGGER_KEY = 'key_m';

    var State = {
        isPinging: false,
        rootPanel: null
    };

    function IsPanelValid(panel) {
        return !!(panel && panel.IsValid && panel.IsValid());
    }

    function GetUIRoot() {
        var root;
        var guard;

        if (IsPanelValid(State.rootPanel)) {
            return State.rootPanel;
        }

        root = $.GetContextPanel();
        guard = 0;
        while (root && root.GetParent && root.GetParent() && guard < 50) {
            root = root.GetParent();
            guard++;
        }

        State.rootPanel = root || null;
        return State.rootPanel;
    }

    function PerformClick(btn, root) {
        var minimap = root ? (root.FindChildTraverse('hud_minimap') || root.FindChildTraverse('minimap_container')) : null;
        var hoverPanel = btn ? (btn.FindChildTraverse('HoverPanel') || btn.FindChildTraverse('hover_panel') || btn) : null;

        if (!IsPanelValid(btn) || !IsPanelValid(hoverPanel)) {
            return;
        }

        if (IsPanelValid(minimap)) {
            minimap.AddClass('gScoreboardOpen');
        }
        btn.AddClass('gScoreboardOpen');

        try { if (IsPanelValid(minimap)) { minimap.hittest = true; minimap.hittestchildren = true; } } catch (e) {}
        try { btn.hittest = true; btn.hittestchildren = true; } catch (e) {}
        try { hoverPanel.hittest = true; hoverPanel.hittestchildren = true; } catch (e) {}
        try { $.DispatchEvent('Activated', hoverPanel, 'mouse'); } catch (e) {}

        $.Schedule(0.02, function() {
            if (IsPanelValid(minimap)) {
                minimap.RemoveClass('gScoreboardOpen');
            }
            if (IsPanelValid(btn)) {
                btn.RemoveClass('gScoreboardOpen');
            }
        });
    }

    function CollectEnemyButtons(root) {
        var buttons;
        var enemies;
        var i;
        var btn;

        enemies = [];
        if (!root || !root.FindChildrenWithClassTraverse) {
            return enemies;
        }

        buttons = root.FindChildrenWithClassTraverse('map_button') || [];
        for (i = 0; i < buttons.length; i++) {
            btn = buttons[i];
            if (IsPanelValid(btn) && btn.BHasClass('enemy') && btn.BHasClass('player')) {
                enemies.push(btn);
            }
        }

        return enemies;
    }

    function FirePingWave(waveIndex) {
        var root;
        var enemies;

        if (waveIndex >= WAVE_COUNT) {
            State.isPinging = false;
            return;
        }

        root = GetUIRoot();
        enemies = CollectEnemyButtons(root);

        function ClickNextEnemy(enemyIndex) {
            var targetBtn;

            if (enemyIndex >= enemies.length) {
                $.Schedule(WAVE_DELAY, function() {
                    FirePingWave(waveIndex + 1);
                });
                return;
            }

            targetBtn = enemies[enemyIndex];
            if (IsPanelValid(targetBtn)) {
                PerformClick(targetBtn, root);
            }

            $.Schedule(CLICK_DELAY, function() {
                ClickNextEnemy(enemyIndex + 1);
            });
        }

        ClickNextEnemy(0);
    }

    function StartPingSequence() {
        if (State.isPinging) {
            return;
        }

        State.isPinging = true;
        FirePingWave(0);
    }

    $.RegisterKeyBind($.GetContextPanel(), TRIGGER_KEY, StartPingSequence);
})();
