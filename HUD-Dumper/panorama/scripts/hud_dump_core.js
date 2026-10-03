// Bounded capture/serialization. No style reads, UI creation or clipboard access.
var HUDDumpCore = (() => {
    'use strict';
    const VERSION = '3.0.0';
    const LIMITS = { maxPanels: 50000, maxDepth: 80, maxText: 4096,
        maxClasses: 512, maxClassChars: 8192, maxString: 512, chunkChars: 8192, maxChars: 8 * 1024 * 1024 };

    function checksum(text) {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
        }
        return ('00000000' + hash.toString(16)).slice(-8);
    }
    function alive(panel) {
        try { return !!panel && typeof panel.IsValid === 'function' && panel.IsValid(); }
        catch (_) { return false; }
    }
    function createCollector(root, opts = {}) {
        const limits = Object.assign({}, LIMITS, opts.limits || {});
        const now = opts.now || (() => Date.now());
        const started = now();
        const meta = { asynchronous: true, classMethod: 'GetClasses', stylesCaptured: false,
            measurementsCaptured: !!opts.measurements, truncated: false, clipped: false,
            skippedDestroyed: 0, repeatedPanels: 0, textTruncated: 0, classesIncomplete: 0,
            readErrors: {}, limits };
        const stack = [{ panel: root, parent: null, depth: 0, index: null, nextChild: 0 }];
        const seen = new Set();
        const chunks = [];
        let pending = '', chars = 0, panels = 0, done = false, cancelled = false;

        function error(field) { meta.readErrors[field] = (meta.readErrors[field] || 0) + 1; }
        function read(panel, key, fallback) {
            try { const value = panel[key]; return value === undefined ? fallback : value; }
            catch (_) { error(key); return fallback; }
        }
        function short(value, limit) {
            if (typeof value !== 'string') return '';
            if (value.length <= limit) return value;
            error('stringTruncated');
            let end = limit;
            if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
            return value.slice(0, end);
        }
        function append(record) {
            const line = JSON.stringify(record) + '\n';
            chars += line.length;
            if (chars > limits.maxChars) throw new Error('capture character budget exceeded; use a smaller subtree');
            pending += line;
            while (pending.length >= limits.chunkChars) {
                let end = limits.chunkChars;
                const last = pending.charCodeAt(end - 1);
                if (last >= 0xd800 && last <= 0xdbff) end--;
                chunks.push(pending.slice(0, end));
                pending = pending.slice(end);
            }
        }
        function capture(frame) {
            const p = frame.panel;
            const node = { id: short(read(p, 'id', ''), limits.maxString),
                type: short(read(p, 'paneltype', ''), limits.maxString),
                layoutFile: short(read(p, 'layoutfile', ''), limits.maxString), classes: [] };
            node.classesStatus = 'unavailable';
            try {
                if (typeof p.GetClasses === 'function') {
                    const value = p.GetClasses();
                    if (typeof value === 'string') {
                        const clipped = value.length > limits.maxClassChars;
                        let bounded = value.slice(0, limits.maxClassChars);
                        // Drop a partial final token rather than inventing a class name.
                        if (clipped) bounded = bounded.replace(/\S+$/, '');
                        const names = bounded.split(/\s+/).filter(Boolean);
                        node.classes = names.slice(0, limits.maxClasses).map(c => short(c, limits.maxString));
                        node.classesStatus = clipped || names.length > limits.maxClasses ||
                            names.some(c => c.length > limits.maxString) ? 'truncated' : 'read';
                    } else error('GetClassesType');
                } else error('GetClassesUnavailable');
            } catch (_) { node.classesStatus = 'error'; error('GetClasses'); }
            if (node.classesStatus !== 'read') meta.classesIncomplete++;
            for (const key of ['visible', 'enabled', 'checked', 'hittest', 'hittestchildren']) {
                const value = read(p, key, null);
                if (typeof value === 'boolean') node[key] = value;
            }
            if (node.type === 'Label' || node.type === 'TextEntry') {
                const text = read(p, 'text', null);
                node.textStatus = typeof text === 'string' ? 'read' : 'unavailable';
                if (typeof text === 'string') {
                    node.text = short(text, limits.maxText);
                    if (node.text.length < text.length) { node.textStatus = 'truncated'; meta.textTruncated++; }
                }
            }
            if (opts.measurements) {
                node.computedMeasurements = {};
                for (const pair of [['actualLayoutWidth', 'actuallayoutwidth'], ['actualLayoutHeight', 'actuallayoutheight'],
                    ['actualPanelOffsetX', 'actualxoffset'], ['actualPanelOffsetY', 'actualyoffset']]) {
                    const value = read(p, pair[1], null);
                    node.computedMeasurements[pair[0]] = typeof value === 'number' && isFinite(value) ? value : null;
                }
            }
            frame.index = panels++;
            append({ kind: 'node', index: frame.index, parent: frame.parent, node });
            try {
                frame.childCount = p.GetChildCount();
                if (!Number.isInteger(frame.childCount) || frame.childCount < 0) throw new Error('invalid child count');
            } catch (_) { error('GetChildCount'); frame.childCount = 0; }
        }
        append({ kind: 'start', version: VERSION, timestampUtc: opts.timestampUtc || new Date().toISOString(),
            scope: opts.scope || 'Hud', meta: { asynchronous: true } });

        function finish() {
            meta.classCoverage = meta.classesIncomplete ? 'partial' : 'GetClasses-returned';
            append({ kind: 'end', summary: { totalPanels: panels }, durationMs: now() - started, meta });
            if (pending) { chunks.push(pending); pending = ''; }
            done = true;
            stack.length = 0;
            seen.clear();
        }
        return {
            step(maxWork = 32, budgetMs = 3) {
                if (cancelled) throw new Error('capture cancelled');
                if (done) return true;
                if (!alive(root)) throw new Error('capture root was destroyed');
                const deadline = now() + budgetMs;
                let work = 0;
                while (stack.length && work < maxWork && (work === 0 || now() < deadline)) {
                    work++;
                    const frame = stack[stack.length - 1];
                    if (!alive(frame.panel)) { meta.skippedDestroyed++; stack.pop(); continue; }
                    if (frame.index === null) {
                        if (seen.has(frame.panel)) { meta.repeatedPanels++; stack.pop(); continue; }
                        if (panels >= limits.maxPanels) { meta.truncated = true; stack.length = 0; break; }
                        seen.add(frame.panel);
                        capture(frame);
                    } else if (frame.depth >= limits.maxDepth) {
                        if (frame.childCount) meta.clipped = true;
                        stack.pop();
                    } else if (frame.nextChild < frame.childCount) {
                        let child = null;
                        try { child = frame.panel.GetChild(frame.nextChild++); }
                        catch (_) { error('GetChild'); }
                        if (child) stack.push({ panel: child, parent: frame.index, depth: frame.depth + 1,
                            index: null, nextChild: 0 });
                        else meta.skippedDestroyed++;
                    } else stack.pop();
                }
                if (!stack.length) finish();
                return done;
            },
            packet(session, index) {
                if (!done || cancelled || index < 0 || index >= chunks.length) throw new Error('packet unavailable');
                return 'HUD_DUMP3|' + session + '|' + index + '|' + chunks.length + '|' + checksum(chunks[index]) + '|' + chunks[index];
            },
            progress: () => ({ panels, chunks: chunks.length, done }),
            cancel() { cancelled = true; chunks.length = 0; stack.length = 0; seen.clear(); pending = ''; },
        };
    }
    return { VERSION, LIMITS, checksum, alive, createCollector };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = HUDDumpCore;
