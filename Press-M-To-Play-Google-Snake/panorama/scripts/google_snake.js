(() => {
    'use strict';

    const CONFIG = {
        toggleKey: 'key_m',
        url: 'https://www.google.com/fbx?fbx=snake_arcade',
        windowSize: '600px',
        debounceMs: 200,
    };

    let backdrop = null;
    let win = null;
    let htmlPanel = null;
    let isOpen = false;
    let lastToggleTime = 0;

    function getUIRoot() {
        let root = $.GetContextPanel();
        while (root && root.GetParent && root.GetParent()) {
            root = root.GetParent();
        }
        if (!root) return $.GetContextPanel();
        const hud = root.FindChild ? (root.FindChild('Hud') || root.FindChildTraverse('Hud')) : null;
        return (hud && hud.IsValid()) ? hud : root;
    }

    function applyStyles() {
        backdrop.style.width = '100%';
        backdrop.style.height = '100%';
        backdrop.style.horizontalAlign = 'center';
        backdrop.style.verticalAlign = 'center';
        backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.70)';
        backdrop.style.flowChildren = 'none';
        backdrop.style.zIndex = '999999';
        backdrop.style.visibility = 'collapse';
        backdrop.style.opacity = '0.0';
        backdrop.style.transitionProperty = 'opacity';
        backdrop.style.transitionDuration = '0.12s';

        win.style.horizontalAlign = 'center';
        win.style.verticalAlign = 'center';
        win.style.width = CONFIG.windowSize;
        win.style.height = CONFIG.windowSize;
        win.style.border = '2px solid #578a34';
        win.style.backgroundColor = '#4a752c';
        win.style.flowChildren = 'none';

        htmlPanel.style.width = '100%';
        htmlPanel.style.height = '100%';
    }

    function ensureUI() {
        if (backdrop && backdrop.IsValid()) {
            return true;
        }

        const root = getUIRoot();
        if (!root) return false;

        backdrop = root.FindChildTraverse('GoogleSnakeBackdrop');
        if (backdrop && backdrop.IsValid()) {
            win = backdrop.FindChildTraverse('GoogleSnakeWindow');
            htmlPanel = backdrop.FindChildTraverse('GoogleSnakeCEF');
            applyStyles();
            return true;
        }

        backdrop = $.CreatePanel('Panel', root, 'GoogleSnakeBackdrop');
        backdrop.AddClass('GoogleSnakeBackdrop');

        backdrop.SetPanelEvent('onactivate', (clickedPanel) => {
            if (clickedPanel === backdrop) {
                closeSnake();
            }
        });
        backdrop.SetPanelEvent('oncancel', closeSnake);

        win = $.CreatePanel('Panel', backdrop, 'GoogleSnakeWindow');
        win.AddClass('GoogleSnakeWindow');
        if (typeof win.SetAcceptsFocus === 'function') win.SetAcceptsFocus(true);
        win.SetPanelEvent('onactivate', () => {});
        win.SetPanelEvent('oncancel', closeSnake);

        htmlPanel = $.CreatePanel('CitadelHTMLPanel', win, 'GoogleSnakeCEF');
        htmlPanel.AddClass('GoogleSnakeCEF');
        if (typeof htmlPanel.SetAcceptsFocus === 'function') htmlPanel.SetAcceptsFocus(true);
        htmlPanel.SetPanelEvent('oncancel', closeSnake);

        applyStyles();

        htmlPanel.SetURL(CONFIG.url);

        return true;
    }

    function openSnake() {
        if (!ensureUI()) return;

        isOpen = true;

        backdrop.AddClass('Visible');
        backdrop.style.visibility = 'visible';
        backdrop.style.opacity = '1.0';
        backdrop.hittest = true;

        $.DispatchEvent('CitadelConCommand', 'hud_free_cursor 1');

        $.Schedule(0.05, () => {
            if (htmlPanel && htmlPanel.IsValid()) {
                if (typeof htmlPanel.SetFocus === 'function') htmlPanel.SetFocus();
                $.DispatchEvent('SetInputFocus', htmlPanel);
            }
        });
    }

    function closeSnake() {
        if (!isOpen) return;
        isOpen = false;

        if (backdrop && backdrop.IsValid()) {
            backdrop.RemoveClass('Visible');
            backdrop.style.visibility = 'collapse';
            backdrop.style.opacity = '0.0';
            backdrop.hittest = false;
        }

        $.DispatchEvent('CitadelConCommand', 'hud_free_cursor -1');
        $.DispatchEvent('DropInputFocus');
    }

    function onToggle() {
        const now = Date.now();
        if (now - lastToggleTime < CONFIG.debounceMs) return;
        lastToggleTime = now;

        if (isOpen) {
            closeSnake();
        } else {
            openSnake();
        }
    }

    const panel = $.GetContextPanel();
    $.RegisterKeyBind(panel, CONFIG.toggleKey, onToggle);
    $.RegisterKeyBind('', CONFIG.toggleKey, onToggle);
})();
