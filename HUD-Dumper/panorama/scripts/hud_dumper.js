// Panorama adapter: one owned schedule, bounded collector, small repeated packets.
(() => {
    'use strict';
    const CORE = HUDDumpCore;
    // Temporary diagnostic controls; no persistent settings or game config writes.
    const ROOT_ID = 'Hud'; // Or a verified subtree ID, e.g. hudActivePlayerStats.
    const INCLUDE_MEASUREMENTS = false;
    const SLICE_DELAY = 0.01;
    const PACKET_DELAY = 0.05;
    const PACKET_COPIES = 2;
    const DEADLINE_MS = 1800000;
    let job = null, handle = null, sequence = 0, lastKeyMs = -Infinity;

    function log(message) { $.Msg('[HUD-DUMPER] ' + message); }
    function stop(reason) {
        if (handle !== null) { try { $.CancelScheduled(handle); } catch (_) {} handle = null; }
        if (job) job.collector.cancel();
        job = null;
        log(reason);
    }
    function later(delay, callback, current) {
        handle = $.Schedule(delay, () => {
            handle = null;
            if (job !== current) return;
            if (!CORE.alive(current.host) || Date.now() - current.started > DEADLINE_MS) {
                stop('Aborted: context destroyed or deadline exceeded. No complete export claimed.');
                return;
            }
            try { callback(current); }
            catch (e) { stop('Aborted: ' + (e.message || e)); }
        });
    }
    function send(current) {
        // Signature used by QOLLOCK ui/config_tab.js. No large TextEntry or CEF.
        $.DispatchEvent('CopyStringToClipboard', current.packet, current.packet);
        current.copies++;
        later(PACKET_DELAY, current.copies < PACKET_COPIES ? send : resume, current);
    }
    function resume(current) {
        current.packet = null;
        if (current.sendingEnd) {
            stop('Sending finished. Only the Python receiver can confirm a complete saved capture.');
            return;
        }
        crawl(current);
    }
    function crawl(current) {
        const done = current.collector.step();
        const progress = current.collector.progress();
        if (Date.now() - current.lastProgress >= 2000) {
            current.lastProgress = Date.now();
            log('Streaming: ' + progress.panels + ' panels serialized; ' + current.sent + ' batches dispatched.');
        }
        current.packet = current.collector.takePacket(current.session);
        if (current.packet) current.sent++;
        else if (done) {
            current.packet = current.collector.endPacket(current.session);
            current.sendingEnd = true;
            log('Collection complete: ' + progress.panels + ' panels; sending completion marker.');
        }
        if (current.packet) {
            current.copies = 0;
            send(current);
        } else later(SLICE_DELAY, crawl, current);
    }
    function run() {
        const now = Date.now();
        if (now - lastKeyMs < 500) return;
        lastKeyMs = now;
        if (job) { log('Capture already running; repeated key press ignored.'); return; }
        try {
            const host = $.GetContextPanel();
            let root = host;
            if (host.id !== ROOT_ID) {
                root = host.FindChild(ROOT_ID) || host.FindChildTraverse(ROOT_ID);
            }
            if (!CORE.alive(root)) { log('Requested root not available: ' + ROOT_ID); return; }
            job = { host, started: now, lastProgress: now, session: now.toString(36) + '-' + (++sequence).toString(36),
                packet: null, copies: 0, sent: 0, sendingEnd: false, collector: CORE.createCollector(root, {
                    scope: ROOT_ID, measurements: INCLUDE_MEASUREMENTS, streaming: true,
                }) };
            log('Started ' + job.session + ' under ' + ROOT_ID + '; open the receiver before capture.');
            later(SLICE_DELAY, crawl, job);
        } catch (e) { stop('Could not start: ' + (e.message || e)); }
    }
    // A single binding avoids invoking the handler twice through two scopes.
    $.RegisterKeyBind('', 'key_m', run);
    log('Loaded v' + CORE.VERSION + '. Press M to capture. Clipboard will be used during export.');
})();
