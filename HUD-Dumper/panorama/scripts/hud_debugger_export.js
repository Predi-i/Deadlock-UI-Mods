// Native inspector descriptions -> bounded HUD_DUMP4 batches. No HUD mutations.
var HUDDebuggerExport = (() => {
    'use strict';
    if (typeof HUDDebuggerExport !== 'undefined' && HUDDebuggerExport) HUDDebuggerExport.cancel();
    const CORE = HUDDumpCore;
    const MAX_ROWS = 100000, MAX_TEXT = 65536, WORK = 32, CHUNK = 8192;
    const START_DELAY = 20, STEP_DELAY = 0.01, SEND_DELAY = 0.05, DEADLINE = 1800000;
    let handle = null, owner = null, stopped = false, restoring = false;
    let started = 0, lastProgress = 0, session = '', position = 0, expectedCount = 0;
    let pendingExpansion = null, pendingRestore = null, pending = '', packet = '', copies = 0, chunkIndex = 0;
    let rowIndex = 0, openRows = 0, closeRows = 0, expanded = 0, remainingCollapsed = 0;
    const rows = [], changed = [];

    function log(message) { $.Msg('[HUD-DEBUGGER-EXPORT] ' + message); }
    function later(delay, callback) {
        handle = $.Schedule(delay, () => {
            handle = null;
            if (stopped) return;
            if (!CORE.alive(owner) && owner !== null) { release(); log('ABORTED debugger destroyed'); return; }
            try {
                if (!restoring && started && Date.now() - started > DEADLINE) throw new Error('deadline exceeded');
                callback();
            } catch (e) { abort(e.message || e); }
        });
    }
    function release() {
        stopped = true;
        if (handle !== null) { try { $.CancelScheduled(handle); } catch (_) {} handle = null; }
        rows.length = 0; changed.length = 0; pending = ''; packet = ''; pendingExpansion = null; pendingRestore = null;
    }
    function restore() {
        if (!restoring) log('Restoring ' + changed.length + ' owned branch toggles.');
        restoring = true;
        rows.length = 0; pending = ''; packet = ''; pendingExpansion = null;
        if (pendingRestore) {
            if (CORE.alive(pendingRestore.toggle) && !pendingRestore.toggle.IsSelected()) throw new Error('native collapse activation did not restore toggle');
            pendingRestore = null;
        }
        let work = 0;
        while (changed.length && work++ < WORK) {
            const item = changed.pop();
            // Restore only the same row/toggle handles. A rebuilt inspector owns new ones.
            if (!CORE.alive(item.row) || !CORE.alive(item.indent) || !CORE.alive(item.toggle)) continue;
            if (item.row.FindChild('Indent') !== item.indent || item.indent.FindChild('DebugLabelToggle') !== item.toggle) continue;
            if (!item.toggle.IsSelected()) {
                pendingRestore = item;
                $.DispatchEvent('Activated', item.toggle, 'mouse');
                // A native activation may schedule its change; yield after each one.
                later(STEP_DELAY, restore);
                return;
            }
        }
        if (changed.length) later(STEP_DELAY, restore);
        else { release(); log('Cleanup finished: owned expansion toggles restored where still valid.'); }
    }
    function abort(reason) {
        log('ABORTED ' + reason + '. No complete export claimed.');
        if (restoring) { release(); log('Cleanup interrupted; reopen debugger to reset its expansion state.'); }
        else if (CORE.alive(owner)) restore();
        else release();
    }
    function cancel() {
        // Reload must not leave callbacks from the previous script racing the new job.
        if (changed.length || pendingRestore) log('Reload cancelled export; reopen debugger to reset expansion state.');
        release();
    }
    function count() {
        const n = owner.GetChildCount();
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw new Error('debugger child count empty or outside limit: ' + n);
        return n;
    }
    function describe(row) {
        if (!CORE.alive(row)) throw new Error('row destroyed');
        const open = row.FindChild('DebugLayoutPanelOpen'), close = row.FindChild('DebugLayoutPanelClose');
        if (!!open === !!close) throw new Error('unexpected debugger row structure');
        const label = open || close;
        if (!CORE.alive(label)) throw new Error('row label destroyed');
        const text = label.text;
        if (typeof text !== 'string' || !text.length || text.length > MAX_TEXT) throw new Error('row description unavailable or outside limit');
        const hasChildren = !!open && row.BHasClass('ShowChildren');
        let indent = null, toggle = null, collapsed = false;
        if (hasChildren) {
            indent = row.FindChild('Indent');
            if (!CORE.alive(indent)) throw new Error('branch indent unavailable');
            toggle = indent.FindChild('DebugLabelToggle');
            if (!CORE.alive(toggle) || typeof toggle.IsSelected !== 'function') throw new Error('branch toggle unavailable');
            collapsed = toggle.IsSelected();
            if (typeof collapsed !== 'boolean') throw new Error('invalid toggle state');
        }
        return { row, label, indent, toggle, role: open ? 'open' : 'close', text, hasChildren, collapsed };
    }
    function progress(phase) {
        if (Date.now() - lastProgress >= 2000) {
            lastProgress = Date.now();
            log(phase + ': ' + position + ' rows scanned, ' + expanded + ' branches expanded, ' + chunkIndex + ' batches dispatched.');
        }
    }
    function expand() {
        if (pendingExpansion) {
            const item = pendingExpansion;
            if (owner.GetChild(item.index) !== item.row || !CORE.alive(item.toggle) || item.toggle.IsSelected()) {
                throw new Error('native branch activation did not expand the same row');
            }
            const after = count();
            if (after < item.before) throw new Error('debugger rebuilt during expansion');
            expanded++;
            if (expanded === 1) log('ACTIVATION VERIFIED ' + JSON.stringify({ beforeRows: item.before, afterRows: after }));
            pendingExpansion = null;
        }
        let work = 0;
        const sliceStart = Date.now();
        while (position < count() && work++ < WORK && Date.now() - sliceStart < 3) {
            const item = describe(owner.GetChild(position));
            if (item.collapsed) {
                item.index = position; item.before = count();
                changed.push({ row: item.row, indent: item.indent, toggle: item.toggle }); pendingExpansion = item;
                // Same native Activated signature used by QOLLOCK panel.activate.
                // Effect on this control is checked on the next scheduled step.
                $.DispatchEvent('Activated', item.toggle, 'mouse');
                progress('Expanding');
                later(STEP_DELAY, expand);
                return;
            }
            rows.push(item.row); position++;
        }
        progress('Expanding');
        if (position < count()) { later(STEP_DELAY, expand); return; }
        expectedCount = count(); position = 0;
        append({ kind: 'start', version: '4.0.0', format: 'debugger-rows-v1',
            timestampUtc: new Date(started).toISOString(), scope: 'native DebugLayout descriptions' });
        log('Expansion scan finished: ' + expectedCount + ' rows; streaming raw descriptions.');
        later(STEP_DELAY, collect);
    }
    function append(record) { pending += JSON.stringify(record) + '\n'; }
    function makePacket(body, kind, index) {
        return 'HUD_DUMP4|' + session + '|' + index + '|' + kind + '|' + CORE.checksum(body) + '|' + body;
    }
    function send() {
        $.DispatchEvent('CopyStringToClipboard', packet, packet);
        if (++copies < 2) later(SEND_DELAY, send);
        else later(SEND_DELAY, resume);
    }
    function flush(callback, final = false) {
        if (!pending.length || (!final && pending.length < CHUNK)) { later(STEP_DELAY, callback); return; }
        if (chunkIndex >= 65536) throw new Error('receiver stream size limit exceeded');
        let n = Math.min(CHUNK, pending.length);
        const last = pending.charCodeAt(n - 1);
        if (n < pending.length && last >= 0xd800 && last <= 0xdbff) n--;
        packet = makePacket(pending.slice(0, n), 'chunk', chunkIndex++);
        pending = pending.slice(n); copies = 0;
        resume = () => { packet = ''; flush(callback, final); };
        send();
    }
    let resume = null;
    function collect() {
        if (count() !== expectedCount) throw new Error('debugger row count changed during capture');
        const sliceStart = Date.now();
        let work = 0;
        while (position < expectedCount && work++ < WORK && Date.now() - sliceStart < 3) {
            const row = owner.GetChild(position);
            if (row !== rows[position]) throw new Error('debugger row replaced or reordered');
            const item = describe(row);
            if (item.role === 'open') openRows++; else closeRows++;
            if (item.collapsed) remainingCollapsed++;
            append({ kind: 'row', index: rowIndex++, childIndex: position++, role: item.role,
                text: item.text, visible: row.visible, hasChildren: item.hasChildren, collapsed: item.collapsed });
            if (pending.length >= CHUNK) break;
        }
        progress('Streaming');
        if (position < expectedCount) flush(collect);
        else { position = 0; flush(validate); }
    }
    function validate() {
        if (count() !== expectedCount) throw new Error('debugger row count changed before completion');
        let work = 0;
        while (position < expectedCount && work++ < WORK) {
            if (owner.GetChild(position) !== rows[position] || !CORE.alive(rows[position])) throw new Error('debugger row replaced before completion');
            position++;
        }
        if (position < expectedCount) { later(STEP_DELAY, validate); return; }
        append({ kind: 'end', summary: { totalRows: rowIndex, openRows, closeRows }, durationMs: Date.now() - started,
            meta: { classCoverage: 'Debugger-rendered', debuggerRowsComplete: true, fullHudCapture: false,
                expandedBranches: expanded, remainingCollapsed, readErrors: {}, stylesCaptured: false,
                descriptionFreshness: 'native debugger controls refresh timing; unverified', asynchronous: true } });
        flush(complete, true);
    }
    function complete() {
        packet = makePacket(JSON.stringify({ chunks: chunkIndex }), 'end', chunkIndex); copies = 0;
        resume = () => {
            log('Sending finished: ' + openRows + ' opening rows, ' + closeRows + ' closing rows. Python confirms receipt and tree validity.');
            restore();
        };
        send();
    }
    function start() {
        owner = $.GetContextPanel();
        if (!CORE.alive(owner) || owner.id !== 'DebugLayout') throw new Error('expected DebugLayout context');
        started = Date.now(); lastProgress = started;
        session = started.toString(36) + '-debug';
        log('BEGIN ' + session + '. Expanding native debugger branches; keep the debugger target unchanged.');
        expand();
    }
    later(START_DELAY, start);
    log('LOADED. Automatic debugger export starts in ' + START_DELAY + ' seconds; Python receiver must already be running.');
    return { cancel };
})();
