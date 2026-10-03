// Temporary API discovery plus an owned, hidden class-attribute experiment.
var HUDAPIProbe = (() => {
    'use strict';
    if (typeof HUDAPIProbe !== 'undefined' && HUDAPIProbe) HUDAPIProbe.cancel();
    const START_DELAY = 20;
    const MAX_LEVELS = 16;
    const MAX_NAMES = 512;
    const LINE_NAMES = 12;
    let handle = null, cancelled = false, owner = null, lines = [];

    function log(message) { $.Msg('[HUD-API-PROBE] ' + message); }
    function cancel() {
        cancelled = true;
        lines.length = 0;
        if (handle !== null) {
            try { $.CancelScheduled(handle); } catch (_) {}
            handle = null;
        }
    }
    function alive(panel) {
        try { return !!panel && panel.IsValid(); } catch (_) { return false; }
    }
    function later(delay, callback) {
        handle = $.Schedule(delay, () => {
            handle = null;
            if (cancelled) return;
            try { callback(); }
            catch (e) { cancel(); log('Aborted: ' + (e.message || e)); }
        });
    }
    function inspect(label, object) {
        lines.push('SURFACE ' + label);
        const seen = new Set();
        const chain = new Set();
        let current = object, level = 0, limited = false;
        while (current && level < MAX_LEVELS && seen.size < MAX_NAMES) {
            if (chain.has(current)) { lines.push('ERROR prototype cycle'); break; }
            chain.add(current);
            let names;
            try { names = Object.getOwnPropertyNames(current).sort(); }
            catch (e) { lines.push('ERROR own names: ' + (e.message || e)); break; }
            let parts = [];
            for (const name of names) {
                if (seen.has(name)) continue;
                if (seen.size >= MAX_NAMES) { limited = true; break; }
                seen.add(name);
                let kind;
                try {
                    const d = Object.getOwnPropertyDescriptor(current, name);
                    // Never evaluate unknown accessors (including native style getters).
                    kind = !d ? 'no-descriptor' : ('value' in d ? typeof d.value :
                        [d.get ? 'get' : '', d.set ? 'set' : ''].filter(Boolean).join('/'));
                } catch (_) { kind = 'descriptor-error'; }
                parts.push(name + ':' + kind);
                if (parts.length === LINE_NAMES) {
                    lines.push('P' + level + ' ' + JSON.stringify(parts)); parts = [];
                }
            }
            if (parts.length) lines.push('P' + level + ' ' + JSON.stringify(parts));
            try { current = Object.getPrototypeOf(current); }
            catch (e) { lines.push('ERROR prototype: ' + (e.message || e)); break; }
            level++;
        }
        if (limited || (current && (level >= MAX_LEVELS || seen.size >= MAX_NAMES))) {
            lines.push('TRUNCATED reflection limit');
        }
        lines.push('END SURFACE ' + label + '; reflected names=' + seen.size);
    }
    function panelLabel(panel, label) {
        try { return label + ' id=' + JSON.stringify(panel.id) + ' type=' + JSON.stringify(panel.paneltype); }
        catch (_) { return label + ' (identity unreadable)'; }
    }
    function baseline(panel) {
        const kinds = [];
        for (const name of ['IsValid', 'GetChildCount', 'GetChild', 'AddClass', 'BHasClass', 'GetClasses']) {
            try { kinds.push(name + ':' + typeof panel[name]); }
            catch (_) { kinds.push(name + ':read-error'); }
        }
        lines.push('BASELINE ' + JSON.stringify(kinds));
    }
    function classAttributeExperiment() {
        let panel = null;
        const a = 'HUDDumperProbeClassA', b = 'HUDDumperProbeClassB';
        function snapshot(stage) {
            lines.push('CLASS-ATTRIBUTE ' + stage + ' ' + JSON.stringify({
                attribute: panel.GetAttributeString('class', '<missing>'),
                hasA: panel.BHasClass(a), hasB: panel.BHasClass(b),
            }));
        }
        try {
            panel = $.CreatePanel('Panel', owner, '');
            if (!alive(panel)) throw new Error('temporary panel unavailable');
            panel.visible = false;
            panel.hittest = false;
            panel.hittestchildren = false;
            snapshot('empty');
            panel.AddClass(a);
            snapshot('added-A');
            panel.AddClass(b);
            snapshot('added-B');
            panel.RemoveClass(a);
            snapshot('removed-A');
        } catch (e) { lines.push('CLASS-ATTRIBUTE ERROR ' + (e.message || e)); }
        finally {
            if (alive(panel)) {
                try { panel.DeleteAsync(0); lines.push('CLASS-ATTRIBUTE cleanup requested'); }
                catch (e) { lines.push('CLASS-ATTRIBUTE CLEANUP ERROR ' + (e.message || e)); }
            }
        }
    }
    function flush() {
        if (!alive(owner)) { cancel(); log('Aborted: HUD context destroyed'); return; }
        for (let i = 0; i < 4 && lines.length; i++) log(lines.shift());
        if (lines.length) later(0.05, flush);
        else log('FINISHED. Reflection lists exposed names; it does not capture panel classes.');
    }
    function start() {
        owner = $.GetContextPanel();
        if (!alive(owner)) { log('Aborted: HUD context unavailable'); return; }
        lines.push('BEGIN after delayed startup. Reflection plus owned class-attribute experiment.');
        classAttributeExperiment();
        inspect('$ globals', $);
        const samples = [owner];
        let hud = owner;
        if (owner.id !== 'Hud') {
            try { hud = owner.FindChild('Hud'); } catch (_) { hud = null; }
        }
        if (alive(hud)) {
            if (hud !== owner) samples.push(hud);
            try {
                const count = Math.min(2, hud.GetChildCount());
                for (let i = 0; i < count; i++) {
                    const child = hud.GetChild(i);
                    if (alive(child) && samples.indexOf(child) < 0) samples.push(child);
                }
            } catch (e) { lines.push('ERROR direct child sample: ' + (e.message || e)); }
        } else lines.push('Hud direct child unavailable; inspecting context only.');
        samples.forEach((panel, index) => {
            inspect(panelLabel(panel, 'panel ' + index), panel);
            baseline(panel);
        });
        flush();
    }
    later(START_DELAY, start);
    log('Loaded. API inspection scheduled in ' + START_DELAY + ' seconds; no key press required.');
    return { cancel };
})();
