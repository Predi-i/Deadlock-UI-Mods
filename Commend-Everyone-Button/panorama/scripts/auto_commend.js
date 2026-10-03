// One controller per post-game page. MVP loads this file too, but only
// forwards the button action to the page controller; it starts no extra loop.
(() => {
    'use strict';
    const context = $.GetContextPanel();
    const valid = panel => !!(panel && panel.IsValid());
    const has = (panel, name) => valid(panel) && panel.BHasClass(name);
    const child = (panel, id) => valid(panel) ? panel.Children().find(node => node.id === id) : null;
    const findPage = () => {
        let panel = context;
        for (let i = 0; valid(panel) && i < 50; i++, panel = panel.GetParent()) {
            if (panel.id === 'CitadelPostGameNew' || panel.paneltype === 'CitadelPostGameNew') return panel;
        }
        return null;
    };
    globalThis.CommendAll = () => {
        const page = findPage();
        if (page && page.__autoCommendController) page.__autoCommendController.commend();
    };
    const page = findPage();
    // A separate MVP script context must not reset the page's match state.
    if (!page || page !== context) return;
    if (page.__autoCommendController) page.__autoCommendController.dispose();
    let stopped = false;
    let job = null;
    const clicks = new Set();
    let carousel = null;
    let matchId = page.__autoCommendMatchId || '';
    let fresh = !!page.__autoCommendFresh;
    let busy = false;
    let playAgain = null;
    const getCarousel = () => {
        if (!valid(carousel)) carousel = page.FindChildTraverse('ScreensCarousel');
        return carousel;
    };
    const screens = () => valid(getCarousel()) ? getCarousel().Children() : [];
    const selected = () => ['MVP', 'Team1', 'Team2', 'Scoreboard', 'Graphs']
        .find(name => has(page, 'SelectedScreen_' + name)) || '';
    const shown = () => valid(page) && has(page, 'PageVisible');
    const buttons = () => screens().flatMap(screen => screen.Children()
        .filter(panel => has(panel, 'AutoCommendStyle')));
    const buttonScreen = button => button.id.replace('AutoCommend', '');
    function setVisible(panel, visible) {
        if (!valid(panel)) return;
        const desired = visible ? 'visible' : 'collapse';
        if (panel.style.visibility !== desired) panel.style.visibility = desired;
        panel.enabled = visible;
        panel.hittest = visible;
    }
    function cancelClicks() {
        for (const handle of clicks) $.CancelScheduled(handle);
        clicks.clear();
        busy = false;
    }
    function sync() {
        const current = selected();
        const complete = has(page, 'AutoCommendCompleted');
        for (const button of buttons()) {
            const name = buttonScreen(button);
            setVisible(button, !busy && !complete && has(page, 'CanCommendPlayers') &&
                (fresh ? current === 'MVP' && name === 'MVP' : current === name));
        }
        // The native requeue button remains controlled only within this page.
        if (!valid(playAgain)) playAgain = page.FindChildTraverse('PlayAgainButton');
        setVisible(playAgain, fresh && (complete || current !== 'MVP'));
    }
    function tick() {
        if (stopped || !valid(page)) return;
        if (shown()) {
            const label = screens().map(screen => child(screen, 'MatchID')).find(valid);
            const nextId = label ? label.text : '';
            if (nextId && nextId !== matchId) {
                cancelClicks();
                matchId = nextId;
                fresh = selected() === 'MVP';
                page.__autoCommendMatchId = matchId;
                page.__autoCommendFresh = fresh;
                page.RemoveClass('AutoCommendCompleted');
            }
            sync();
        } else if (busy) cancelClicks();
        // Hidden pages do one validity/class check, no descendant searches.
        job = $.Schedule(shown() ? 0.25 : 1, tick);
    }
    function commend() {
        if (stopped || busy || !shown() || !has(page, 'CanCommendPlayers')) return;
        const screen = child(getCarousel(), 'ScoreboardScreen');
        const scoreboard = child(screen, 'Scoreboard');
        // The current scoreboard exposes the real native buttons directly under
        // .Player. Old PlayerActionContainer targets no longer contain them.
        const players = valid(scoreboard) ? scoreboard.FindChildrenWithClassTraverse('Player') : [];
        const targets = players.filter(player => !has(player, 'IsLocalPlayer') &&
            !has(player, 'CommendedPlayer') && !has(player, 'TotalsRow'))
            .map(player => child(player, 'CommendPlayerButton'))
            .filter(panel => valid(panel) && panel.enabled !== false);
        if (!targets.length) {
            $.Msg('[AutoCommend] No eligible native scoreboard buttons. Open Scoreboard and retry.');
            return;
        }
        busy = true;
        const operationMatch = matchId;
        targets.forEach((button, index) => {
            const handle = $.Schedule(index * 0.05, () => {
                clicks.delete(handle);
                if (stopped || !shown() || matchId !== operationMatch || !valid(button) ||
                    !has(page, 'CanCommendPlayers')) return;
                const player = button.GetParent();
                if (!has(player, 'CommendedPlayer') && !has(player, 'IsLocalPlayer') && button.enabled !== false) {
                    try {
                        $.DispatchEvent('MouseActivate', button, 'mouse');
                        // Native CommendedPlayer is the acknowledgement; never
                        // synthesize success just because DispatchEvent returned.
                    } catch (error) { $.Msg('[AutoCommend] Activation failed: ' + error); }
                }
                if (index === targets.length - 1) {
                    busy = false;
                    // Do not falsely report completion if no native button activated.
                    const allAcknowledged = players.every(player => has(player, 'IsLocalPlayer') ||
                        has(player, 'TotalsRow') || has(player, 'CommendedPlayer') || !child(player, 'CommendPlayerButton'));
                    if (allAcknowledged) page.AddClass('AutoCommendCompleted');
                    sync();
                }
            });
            clicks.add(handle);
        });
        sync();
    }
    page.__autoCommendController = {
        commend,
        dispose() {
            stopped = true;
            if (job !== null) $.CancelScheduled(job);
            cancelClicks();
        }
    };
    tick();
})();
