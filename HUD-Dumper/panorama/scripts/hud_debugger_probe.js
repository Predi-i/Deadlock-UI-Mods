// Inspect the debugger's own materialized rows, not the target HUD's classes.
var HUDDebuggerProbe = (() => {
    'use strict';
    if (typeof HUDDebuggerProbe !== 'undefined' && HUDDebuggerProbe) HUDDebuggerProbe.cancel();
    const START_DELAY = 20;
    const MAX_NODES = 1500, MAX_DEPTH = 80, MAX_WORK = 32;
    const MAX_SAMPLES = 8, MAX_TEXT = 2048;
    let handle = null, owner = null, cancelled = false;
    const stack = [], seen = new Set();
    const stats = { visited: 0, openRows: 0, closeRows: 0, samples: 0,
        textTruncated: 0, destroyed: 0, repeated: 0, errors: 0, limited: false };

    function log(message) { $.Msg('[HUD-DEBUGGER-PROBE] ' + message); }
    function alive(panel) {
        try { return !!panel && panel.IsValid(); } catch (_) { return false; }
    }
    function cancel() {
        cancelled = true; stack.length = 0; seen.clear();
        if (handle !== null) {
            try { $.CancelScheduled(handle); } catch (_) {}
            handle = null;
        }
    }
    function later(delay, callback) {
        handle = $.Schedule(delay, () => {
            handle = null;
            if (cancelled) return;
            try { callback(); }
            catch (e) { cancel(); log('ABORTED ' + (e.message || e)); }
        });
    }
    function enter(frame) {
        const panel = frame.panel;
        const id = panel.id;
        stats.visited++;
        if (id === 'DebugLayoutPanelOpen' || id === 'DebugLayoutPanelClose') {
            if (id === 'DebugLayoutPanelOpen') stats.openRows++;
            else stats.closeRows++;
            if (stats.samples < MAX_SAMPLES) {
                const text = panel.text;
                if (typeof text !== 'string') throw new Error('debugger row text unavailable');
                let end = Math.min(text.length, MAX_TEXT);
                if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 &&
                    text.charCodeAt(end - 1) <= 0xdbff) end--;
                const clipped = end < text.length;
                if (clipped) stats.textTruncated++;
                stats.samples++;
                log('ROW ' + JSON.stringify({ id, uiDepth: frame.depth, textChars: text.length,
                    truncated: clipped, text: text.slice(0, end) }));
            }
        }
        frame.count = panel.GetChildCount();
        if (!Number.isInteger(frame.count) || frame.count < 0) throw new Error('invalid child count');
        frame.entered = true;
    }
    function finish() {
        // This reports only a bounded scan of debugger UI widgets.
        log('FINISHED ' + JSON.stringify(Object.assign({}, stats, {
            uiScanComplete: !stats.limited && !stats.errors && !stats.destroyed && !stats.repeated,
            fullHudCapture: false,
        })));
        cancel();
    }
    function scan() {
        if (!alive(owner)) { cancel(); log('ABORTED debugger context destroyed'); return; }
        let work = 0;
        while (stack.length && work++ < MAX_WORK) {
            const frame = stack[stack.length - 1];
            if (!alive(frame.panel)) { stats.destroyed++; stack.pop(); continue; }
            if (!frame.entered) {
                if (stats.visited >= MAX_NODES) { stats.limited = true; stack.length = 0; break; }
                if (seen.has(frame.panel)) { stats.repeated++; stack.pop(); continue; }
                seen.add(frame.panel);
                try { enter(frame); }
                catch (e) { stats.errors++; stack.pop(); log('READ ERROR ' + (e.message || e)); }
            } else if (frame.depth >= MAX_DEPTH) {
                if (frame.count) stats.limited = true;
                stack.pop();
            } else if (frame.next < frame.count) {
                let child;
                try { child = frame.panel.GetChild(frame.next++); }
                catch (_) { stats.errors++; continue; }
                if (child) stack.push({ panel: child, depth: frame.depth + 1, next: 0, entered: false });
                else stats.destroyed++;
            } else stack.pop();
        }
        if (stack.length) later(0.01, scan);
        else finish();
    }
    function start() {
        owner = $.GetContextPanel();
        if (!alive(owner)) { cancel(); log('ABORTED debugger context unavailable'); return; }
        log('BEGIN ' + JSON.stringify({ id: owner.id, type: owner.paneltype,
            layoutFile: owner.layoutfile, scope: 'debugger UI; current expansion state' }));
        stack.push({ panel: owner, depth: 0, next: 0, entered: false });
        scan();
    }
    later(START_DELAY, start);
    log('LOADED from debuglayout.xml. Inspection scheduled in ' + START_DELAY + ' seconds.');
    return { cancel };
})();
