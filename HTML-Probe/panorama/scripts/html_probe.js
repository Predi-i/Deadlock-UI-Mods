// ─────────────────────────────────────────────────────────────────────────────
// HTML-Probe - Panorama data-channel probe (DIAGNOSTIC MOD, no gameplay change)
//
// ══ ANSWERED. Four in-game runs, 2026-08-23. ══
//
// ── HEADLINE: the page inside CitadelHTMLPanel is a FULL BROWSER. ──
// Measured from inside a data: URL page (run 4):
//   typeof fetch=function  WebSocket=function  XMLHttpRequest=function
//   EventSource=function
//   fetch('https://dl-arcade-cloudflare.predi-i.workers.dev/api/ping.png')
//                                    -> ok, 72 bytes. The REAL production path works.
//   new WebSocket('wss://ws.postman-echo.com/raw')
//                                    -> open, send, echo received, close code 1000 clean.
//   location.href                    -> readable, so a query string passed via SetURL is
//                                       the uplink INTO the page.
//   localStorage                     -> THROWS SecurityError (opaque origin). See below.
//   fetch('https://api.github.com/zen') -> "TypeError: Failed to fetch", twice, while the
//                                       worker and postman-echo both worked. UNEXPLAINED;
//                                       likely local DNS/filtering, not a CEF limit. To
//                                       settle it, retry with mode:'no-cors' - that
//                                       separates a CORS rejection from unreachable.
// So the transport chain is:
//   Panorama JS --URL query (SetURL)--> page --fetch/WS/SSE--> worker
//   worker --push--> page --document.title--> Panorama JS
// NO POLLING is required on the downlink. A socket in the page replaces the poll loop.
//
// ⚠ THE TRAP THAT COST RUN 3: a data: URL document has an OPAQUE ORIGIN, and in Chrome
//   `typeof localStorage` THROWS there (SecurityError - it is a throwing getter, not a
//   plain undefined lookup). Run 3 had that read in the FIRST statement, unguarded and
//   at top level, so the exception aborted the ENTIRE page script: not one report
//   arrived, not even the pure-typeof line that needs no network, and not the
//   try/catch-wrapped fetch blocks below it. The console read as "fetch is absent" when
//   nothing had run. Guard EVERY probe individually and emit a liveness beacon at the
//   end (`scriptEND=reached`) so "script died" and "all probes failed" stay
//   distinguishable. The tell was stage 17: same kind of data: URL, no localStorage
//   access, and its 12 ticks all landed.
//
// ── THE DOWNLINK: CitadelHTMLPanel + $.RegisterEventHandler ──
//   HTMLTitle          arg0=panel arg1=document.title       <- the payload
//   HTMLFinishRequest  arg0=panel arg1=url arg2=title       <- same text, second copy
//   HTMLJSAlert        arg1=alert text  (HTMLJSAlertV8 fires too, same text)
//   HTMLURLChanged     arg1=full url, #fragment included
//   HTMLStatusText     NEVER FIRED. window.status is dead.
//   Registers via $.RegisterEventHandler (24 of 41 probed names are known to the
//     engine). SetPanelEvent delivered NOTHING. RegisterForUnhandledEvent only
//     duplicates, so use one path.
//   Payloads arrive ONLY in event arguments - never on the panel, no property, no
//     getter, no attribute.
//   HTMLTitle fires 2x per navigation, so dedup on CONTENT (not length - see hit()).
//   CAPACITY: exactly 4096 chars. 64/256/1024/4096 whole; 16384 and 65536 both cut to
//     exactly 4096, silently.
//   CADENCE: 12 of 12 title rewrites at 250ms arrived, zero loss, ~1% drift
//     (257/506/753/1002/1264/1512/1760/2008/2255/2503/2753/3002). So 4 updates/sec is
//     comfortable. Frame time stayed fine with CEF live: 2.2% of frames over 17.5ms.
//
// ── NO NETWORKING IN PANORAMA ITSELF ──
// Present globals, complete: Promise, JSON, globalThis, $, panorama.
// Absent: fetch, XMLHttpRequest, WebSocket, EventSource, navigator, window, document,
//   location, localStorage, setTimeout, atob/btoa, TextDecoder, GameUI, GameEvents,
//   SteamUtils, LoadKeyValues, FileSystem.
// $.AsyncWebRequest exists as a binding but logs "ERROR: AsyncWebRequest has been
//   removed." Valve pulled it. Concluding "no networking" from that is CORRECT - the
//   channel above is not a networking API, it is a news-popup display widget that
//   leaks page text back through events.
// $ has: RegisterEventHandler, RegisterForUnhandledEvent, UnregisterForUnhandledEvent,
//   DispatchEvent, DispatchEventAsync, CreatePanel, CreatePanelWithProperties,
//   GetContextPanel, Schedule, CancelScheduled, Msg, Warning, Localize, LocalizePlural,
//   HTMLEscape, Language, Each, FindChildInContext.
//
// Valid paneltypes: Panel, Label, Image, TextEntry, Button, MoviePanel,
//   CitadelHTMLPanel, HTML. Invalid (CreatePanel throws): HTMLPanel, WebPanel,
//   CefPanel, CitadelWebPanel, SteamHTMLPanel.
// CitadelHTMLPanel creates fine in the HUD context (ctx = CitadelHudRoot).
// data: URLs load and run their scripts, at least to 1938 chars of URL; the Chrome-60
//   top-level data: block does not apply to an embedder calling SetURL.
//
// Console filter:  con_filter_enable 1 ; con_filter_text HTMLPROBE
// The buffer is ~3 MB and the game spams it, so keep output lean or the RESULT block
// gets pushed out - that happened on run 1.
//
// ── THE FULL DUPLEX BRIDGE IS PROVEN (run 5) ──
// `javascript:` URLs execute in the CURRENT document, they do NOT create a fresh one:
//   page planted window.MGPLANT + window.mgEcho, then a javascript: URL read both back
//   -> CTX|readback|planted_ok|fn|function
//   and NO HTMLURLChanged / HTMLStartRequest fired for that SetURL, only HTMLTitle.
// So Panorama calls into the live page without renavigating, and an open socket survives.
//   Panorama -> page : SetURL("javascript:mgSend('...')")   (no reload, socket intact)
//   page -> server   : fetch / WebSocket / XHR / EventSource
//   page -> Panorama : document.title, 4096 chars, push
//
// ── LONGEVITY IS PROVEN (run 5, 62 seconds) ──
//   VERDICT=fetchOk=60=fetchErr=0=wsSent=12=wsRecv=12=wsDead=false
//   60/60 fetches of the mod's own worker, ZERO errors, 72 bytes each.
//   WebSocket opened at 733ms and stayed open the whole minute: 12 pings out, 12 back.
//   Frame cost with CEF live actually improved across the run: 2.1% -> 1.2% of frames
//   over 17.5ms. (Baseline without CEF still unmeasured, so treat as "no visible cost",
//   not as "free".)
//
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const TAG = '[HTMLPROBE]';
    const START_DELAY = 50.0; // seconds after HUD load, so game spam scrolls past first
    const MARK = 'MGPROBE';

    // Any reachable https page works; it only has to load. Swap this for your own
    // host if you want to serve a page that PUSHES text back (see stage 6b): a page
    // doing `location.hash = longString` is the write half of the same channel.
    const TEST_PAGE = 'https://hantu-raya.github.io/hp-colors-preset-builder/supporters-strip/';

    // A deliberately LONG payload: if a channel truncates, we see where.
    function payload(kind) {
        let s = '';
        for (let i = 0; i < 20; i++) { s += '0123456789'; }
        return `${MARK}_${kind}_${s}_END`;
    }

    const transcript = [];
    const hits = [];   // channels that actually delivered the marker
    const found = [];  // API surface that exists

    function say(msg) {
        const line = `${TAG} ${msg}`;
        transcript.push(line);
        try { $.Msg(line); } catch (e) {}
    }

    function hr(title) {
        say('--------------------------------------------------------------');
        say(`## ${title}`);
    }

    function errStr(e) {
        if (!e) { return 'null'; }
        if (e.message) { return `${e.name || 'Error'}: ${e.message}`; }
        return String(e);
    }

    // Short, safe rendering of an arbitrary value for the log.
    function brief(v) {
        const t = typeof v;
        if (v === null) { return 'null'; }
        if (t === 'undefined') { return 'undefined'; }
        if (t === 'string') {
            const cut = v.length > 300 ? `${v.substring(0, 300)}...(${v.length} chars)` : v;
            return `string[${v.length}] "${cut}"`;
        }
        if (t === 'number' || t === 'boolean') { return `${t} ${v}`; }
        if (t === 'function') { return `function(${v.length} args)`; }
        // Panel-ish?
        try {
            if (v.paneltype !== undefined) { return `panel<${v.paneltype}> id="${v.id}"`; }
        } catch (e) {}
        try { return `object ${JSON.stringify(v).substring(0, 200)}`; } catch (e) {}
        return 'object <unstringifiable>';
    }

    // Longest string actually received per channel. This is THE number that decides
    // whether a channel can serve as a transport, so it is tracked separately from
    // the marker hits: a channel that delivers a truncated payload still "hits".
    const maxLen = {};
    const seenPayload = {}; // dedup: HTMLTitle fires more than once per navigation

    function hit(channel, value) {
        const rec = `${channel} -> ${brief(value)}`;
        // Dedup key must include CONTENT, not just length. Keying on (channel, length)
        // collapsed the five stream ticks - STREAM1..STREAM5 are all exactly 24 chars on
        // the same channel - into one "x7" row, which read as "the stream never fired"
        // when the log proves all five arrived. Head+tail+length is enough of a
        // fingerprint and stays cheap on a 4096-char payload.
        const s = typeof value === 'string' ? value : '';
        const key = `${channel}|${s.length}|${s.substring(0, 24)}|${s.substring(s.length - 8)}`;
        if (seenPayload[key]) {
            seenPayload[key]++;
            return; // already reported; only the repeat count matters
        }
        seenPayload[key] = 1;
        hits.push(rec);
        say(`*** MARKER FOUND *** ${rec}`);
    }

    // Record + report a marker if the string carries one. Also records the length even
    // when the marker is absent, so a channel that mangles rather than truncates is
    // still visible in the summary.
    // Run-3 payloads are prefixed NETP| and TICK| instead of carrying MARK, because they
    // are reports from the page rather than an echo test. Collect them so the answer
    // survives into the RESULT block even if the console scrolls.
    const netFindings = [];
    const tickFindings = [];
    const liveFindings = [];  // stage 19: longevity of page + socket
    const ctxFindings = [];   // stage 20: javascript: URL document context

    function collectPageReport(v) {
        if (typeof v !== 'string') { return; }
        if (v.substring(0, 5) === 'NETP|') {
            if (netFindings.indexOf(v) < 0) { netFindings.push(v); }
        } else if (v.substring(0, 5) === 'TICK|') {
            if (tickFindings.indexOf(v) < 0) { tickFindings.push(v); }
        } else if (v.substring(0, 5) === 'LIVE|') {
            if (liveFindings.indexOf(v) < 0) { liveFindings.push(v); }
        } else if (v.substring(0, 4) === 'CTX|') {
            if (ctxFindings.indexOf(v) < 0) { ctxFindings.push(v); }
        }
    }

    function checkString(channel, v) {
        if (typeof v !== 'string' || !v.length) { return false; }
        collectPageReport(v);
        // Only strings long enough to be a payload go in the capacity table. Without
        // this floor, the scraper's own reads of .id (22 chars) and .paneltype (16)
        // bury the real measurements: 24 junk rows against 8 real ones.
        if (v.length >= 32) {
            const base = channel.split(':arg')[0];
            if (!maxLen[base] || maxLen[base] < v.length) { maxLen[base] = v.length; }
        }
        if (v.indexOf(MARK) >= 0) {
            hit(channel, v);
            // Did it arrive WHOLE? The payload ends in "_END"; if the marker is present
            // but the tail is not, the channel truncated and we know roughly where.
            if (v.indexOf('_END') < 0) {
                say(`    !! TRUNCATED: marker present but "_END" missing, got ${v.length} chars`);
            }
            return true;
        }
        return false;
    }

    // ── stage runner ────────────────────────────────────────────────────────
    // Every stage is separated in time so async CEF loads have room to finish and
    // so the console output stays readable instead of interleaving.
    const steps = [];
    function step(name, fn, waitAfter) {
        steps.push({ name: name, fn: fn, wait: (waitAfter === undefined) ? 0.4 : waitAfter });
    }
    function runNext() {
        if (!steps.length) { finish(); return; }
        const s = steps.shift();
        if (s.name) { hr(s.name); }
        try { s.fn(); } catch (e) { say(`!! EXCEPTION in stage "${s.name}": ${errStr(e)}`); }
        $.Schedule(s.wait, runNext);
    }

    // ── generic surface probing ─────────────────────────────────────────────
    // Panorama's C++-backed objects are frequently NOT enumerable, so `for...in`
    // can come back empty on a real panel. Explicit `typeof obj[name]` still works
    // on a non-enumerable binding, so we do BOTH: enumerate, and probe a name list.

    function enumerate(obj, label) {
        const out = [];
        try {
            for (const k in obj) { if (out.indexOf(k) < 0) { out.push(k); } }
        } catch (e) { say(`  (for-in on ${label} threw: ${errStr(e)})`); }
        try {
            const own = Object.getOwnPropertyNames(obj);
            for (let i = 0; i < own.length; i++) {
                if (out.indexOf(own[i]) < 0) { out.push(own[i]); }
            }
        } catch (e) {}
        try {
            let p = Object.getPrototypeOf(obj);
            let guard = 0;
            while (p && guard < 6) {
                const pk = Object.getOwnPropertyNames(p);
                for (let i = 0; i < pk.length; i++) {
                    if (out.indexOf(pk[i]) < 0) { out.push(pk[i]); }
                }
                p = Object.getPrototypeOf(p);
                guard++;
            }
        } catch (e) {}
        out.sort();
        if (!out.length) {
            say(`  ${label}: enumeration EMPTY (C++ bindings are non-enumerable here)`);
        } else {
            say(`  ${label}: ${out.length} keys`);
            // Chunk so no single console line gets clipped.
            let line = '';
            for (let i = 0; i < out.length; i++) {
                line += (line ? ', ' : '') + out[i];
                if (line.length > 220) { say(`    ${line}`); line = ''; }
            }
            if (line) { say(`    ${line}`); }
        }
        return out;
    }

    // Probe an explicit list of member names on obj; log which exist and their type.
    function probeMembers(obj, label, names) {
        const present = [];
        for (let i = 0; i < names.length; i++) {
            const n = names[i];
            let t = 'missing';
            try { t = typeof obj[n]; } catch (e) { t = `throws(${errStr(e)})`; }
            if (t !== 'undefined' && t !== 'missing') {
                present.push(`${n}:${t}`);
                found.push(`${label}.${n} (${t})`);
            }
        }
        if (!present.length) {
            say(`  ${label}: none of the ${names.length} probed members exist`);
        } else {
            say(`  ${label}: ${present.length}/${names.length} present`);
            let line = '';
            for (let i = 0; i < present.length; i++) {
                line += (line ? ', ' : '') + present[i];
                if (line.length > 200) { say(`    ${line}`); line = ''; }
            }
            if (line) { say(`    ${line}`); }
        }
        return present;
    }

    // Read every plausible text-bearing member of a panel and look for the marker.
    // Only zero-arg Get*-style calls are made, and never anything mutating, because
    // this runs against a live panel.
    const UNSAFE_CALL = /Delete|Remove|Clear|Set|Load|Close|Stop|Focus|Scroll|Play|Start|Toggle|Apply|Move|Sort|Swap|Reload|Back|Forward|Find|Print|Screen/;

    function scrape(panel, label, names) {
        let any = false;

        // 1. direct properties (panel.text / .url / .title / ...)
        for (let i = 0; i < names.length; i++) {
            const n = names[i];
            let v;
            try { v = panel[n]; } catch (e) { continue; }
            if (typeof v === 'string' && v.length) {
                say(`  ${label}.${n} = ${brief(v)}`);
                if (checkString(`${label}.${n}`, v)) { any = true; }
            }
        }

        // 2. zero-arg getters
        const enumerated = [];
        try {
            let p = panel;
            let guard = 0;
            while (p && guard < 6) {
                const pk = Object.getOwnPropertyNames(p);
                for (let i = 0; i < pk.length; i++) {
                    if (enumerated.indexOf(pk[i]) < 0) { enumerated.push(pk[i]); }
                }
                p = Object.getPrototypeOf(p);
                guard++;
            }
        } catch (e) {}
        const callable = enumerated.concat(names);
        for (let i = 0; i < callable.length; i++) {
            const n = callable[i];
            if (n.substring(0, 3) !== 'Get') { continue; }
            if (UNSAFE_CALL.test(n)) { continue; }
            let fn;
            try { fn = panel[n]; } catch (e) { continue; }
            if (typeof fn !== 'function' || fn.length !== 0) { continue; }
            let v;
            try { v = fn.call(panel); } catch (e) { continue; }
            if (typeof v === 'string' && v.length) {
                say(`  ${label}.${n}() = ${brief(v)}`);
                if (checkString(`${label}.${n}()`, v)) { any = true; }
            }
        }

        // 3. attributes (a page cannot write these, but SetURL-adjacent code might)
        const attrs = ['url', 'src', 'text', 'title', 'html', 'status', 'contents', 'value'];
        for (let i = 0; i < attrs.length; i++) {
            let v;
            try { v = panel.GetAttributeString(attrs[i], ''); } catch (e) { continue; }
            if (typeof v === 'string' && v.length) {
                say(`  ${label}[attr ${attrs[i]}] = ${brief(v)}`);
                if (checkString(`${label}[attr ${attrs[i]}]`, v)) { any = true; }
            }
        }

        if (!any) { say(`  ${label}: no marker in any readable member`); }
        return any;
    }

    // ── the panel under test ────────────────────────────────────────────────
    let htmlPanel = null;
    let hostPanel = null;

    const HTML_METHODS = [
        'SetURL', 'GetURL', 'LoadURL', 'Navigate',
        'RunJavascript', 'RunJavaScript', 'EvaluateJavaScript', 'ExecuteJavaScript',
        'EvalJS', 'ExecuteJavascript', 'AddJavascript',
        'SetHTML', 'SetHTMLContent', 'LoadHTML', 'SetPageContents',
        'GetPageTitle', 'GetTitle', 'GetStatusText', 'GetPageContents', 'GetSource',
        'GetLinkAtPosition', 'GetSelectedText', 'GetSecurityStatus',
        'GoBack', 'GoForward', 'Reload', 'StopLoading', 'ViewSource',
        'AddHeader', 'SetPostData', 'SetUserAgent', 'AllowJavascript',
        'SetAllowJavaScript', 'SetZoom', 'RequestRepaint', 'SetKeyFocus',
        'SetHorizontalScroll', 'SetVerticalScroll', 'SetIgnoreCursor',
        'Find', 'StopFind', 'TakeScreenshot',
        // generic panel members worth confirming on this type
        'paneltype', 'id', 'text', 'url', 'title', 'status', 'contents',
        'actuallayoutwidth', 'actuallayoutheight',
        'SetPanelEvent', 'GetAttributeString', 'SetAttributeString', 'BHasClass'
    ];

    const TEXT_PROPS = [
        'text', 'url', 'title', 'status', 'contents', 'html', 'value', 'src',
        'statustext', 'pagetitle', 'currenturl'
    ];

    // Every HTML* engine event name seen in client_strings.txt:26704-26733, plus the
    // two names PROVEN to fire in-game (hanturaya's 2026-08-23 console dump):
    //   HTMLURLChanged  arg0=panel arg1=<full url string>  arg2=<empty>
    //   HTMLTitle       arg0=panel arg1=<full document.title string> arg2=<empty>
    // Note "HTMLTitle", NOT HTMLChangedTitle / HTMLTitleChanged - both of those are
    // what the C++ callback struct is called, and neither is the script event name.
    // HTMLTitle fired TWICE for one page load in his log, so payloads need dedup.
    const HTML_EVENTS = [
        'HTMLTitle', 'HTMLURLChanged',
        'HTMLContentLoaded', 'HTMLFinishRequest', 'HTMLStartRequest',
        'HTMLStatusText', 'HTMLJSAlert', 'HTMLJSAlertV8',
        'HTMLJSConfirm', 'HTMLLoadPage', 'HTMLBackForwardState',
        'HTMLCommitZoom', 'HTMLCloseWindow', 'HTMLFileDialog',
        'HTMLFocusedNodeValue', 'HTMLFormFocusPending', 'HTMLFormHasFocus',
        'HTMLFullScreen', 'HTMLOpenLinkInNewTab', 'HTMLOpenPopupLink',
        'HTMLRequestRepaint', 'HTMLScreenShotCaptured', 'HTMLScreenShotTaken',
        'HTMLSecurityStatus', 'HTMLSetCursor', 'HTMLShowToolTip',
        'HTMLHideToolTip', 'HTMLUpdateToolTip', 'HTMLSearchResults',
        'HTMLNewWindow', 'HTMLHorizontalScrollBar', 'HTMLVerticalScrollBar',
        'HTMLChangedTitle', 'HTMLTitleChanged', 'HTMLLinkAtPosition',
        'HTMLNeedsPaint', 'HTMLStartMousePanning', 'HTMLStopMousePanning',
        // long shots, in case Citadel renamed them
        'CitadelHTMLLoaded', 'WebPanelLoaded', 'PageLoaded'
    ];

    // Events with no text payload, or that just echo the URL we set. These flooded the
    // first run: HTMLBackForwardState fires twice per navigation with two booleans, and
    // StartRequest/LoadPage/URLChanged/FinishRequest all hand back the URL we ourselves
    // passed to SetURL, which the marker check then dutifully reported as a find. The
    // console only holds ~3 MB, so this noise cost us the summary.
    const NOISY = /NeedsPaint|RequestRepaint|SetCursor|ToolTip|MousePanning|ScrollBar|CommitZoom|BackForwardState|StartRequest|LoadPage/;
    const noisyCount = {};

    // The URL currently loading. A string equal to it is our own uplink coming back,
    // not a downlink, and must not be counted as a delivered payload.
    let lastSetUrl = '';

    function makeHandler(label) {
        return function () {
            const n = arguments.length;
            if (NOISY.test(label)) {
                noisyCount[label] = (noisyCount[label] || 0) + 1;
                if (noisyCount[label] === 1) { say(`EVENT ${label} (${n} args) [noisy, counted only]`); }
                return;
            }
            const parts = [];
            let hasText = false;
            for (let i = 0; i < n; i++) {
                const v = arguments[i];
                // Our own URL echoed back: note it, do not print 300 chars of it.
                if (typeof v === 'string' && lastSetUrl && v === lastSetUrl) {
                    parts.push(`arg${i}=<echo of the URL we set>`);
                    continue;
                }
                parts.push(`arg${i}=${brief(v)}`);
                if (typeof v === 'string' && v.length) { hasText = true; }
            }
            say(`EVENT ${label} (${n} args) ${parts.join(' | ')}`);
            for (let i = 0; i < n; i++) {
                const v = arguments[i];
                if (typeof v !== 'string') { continue; }
                if (lastSetUrl && v === lastSetUrl) { continue; }
                checkString(`event:${label}:arg${i}`, v);
            }
            // Only scrape when the event carried NO string at all. Every payload so far
            // arrived in an argument, so scraping on every event produced three useless
            // lines (.paneltype, .id, "no marker") per event and nothing else.
            if (!hasText && htmlPanel) {
                try { scrape(htmlPanel, `on:${label}:panel`, TEXT_PROPS.concat(HTML_METHODS)); } catch (e) {}
            }
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STAGES
    // ═══════════════════════════════════════════════════════════════════════

    // Run 1 (2026-08-23, in-game) already dumped the API surface and answered stages
    // 0-13. Set this to true only to re-collect that inventory; leaving it false spends
    // the whole ~3 MB console budget on the one open question, the capacity ladder.
    // What run 1 established:
    //   CitadelHTMLPanel DOES create in the HUD context.
    //   data: URLs load AND execute their scripts (the Chrome-60 block did not apply).
    //   HTMLTitle arg1        = full <title>, 218 chars intact, incl. the _END tail
    //   HTMLTitle arg1 again  = a LATE document.title write fired a SECOND event, so the
    //                           channel is a stream and needs no renavigation per update
    //   HTMLJSAlert arg1 + HTMLJSAlertV8 arg1 = 218 chars, both fire
    //   HTMLURLChanged arg1   = full URL incl. a 220-char #fragment
    //   HTMLFinishRequest     = arg1 URL + arg2 title together
    //   window.status         = DEAD, no HTMLStatusText ever fired
    //   $.RegisterEventHandler delivers; SetPanelEvent delivered nothing.
    const RUN_INVENTORY = false;

    function inventoryStep(name, fn, waitAfter) {
        if (!RUN_INVENTORY) { return; }
        step(name, fn, waitAfter);
    }

    step('0. CONTEXT', function () {
        say(`payload marker = "${MARK}", payload length = ${payload('X').length} chars`);
        const ctx = $.GetContextPanel();
        say(`context panel: ${brief(ctx)}`);
        try { say(`context paneltype=${ctx.paneltype} id=${ctx.id}`); } catch (e) {}
    });

    inventoryStep('1. GLOBALS - is there a real network API in scope?', function () {
        // typeof on an undeclared identifier is safe (no ReferenceError), so these
        // are all written out longhand rather than looked up from an array.
        const g = [];
        function rec(name, t) { if (t !== 'undefined') { g.push(`${name}:${t}`); found.push(`global ${name} (${t})`); } }
        rec('fetch', typeof fetch);
        rec('XMLHttpRequest', typeof XMLHttpRequest);
        rec('WebSocket', typeof WebSocket);
        rec('EventSource', typeof EventSource);
        rec('Request', typeof Request);
        rec('Response', typeof Response);
        rec('Headers', typeof Headers);
        rec('Worker', typeof Worker);
        rec('SharedWorker', typeof SharedWorker);
        rec('navigator', typeof navigator);
        rec('window', typeof window);
        rec('document', typeof document);
        rec('location', typeof location);
        rec('localStorage', typeof localStorage);
        rec('sessionStorage', typeof sessionStorage);
        rec('indexedDB', typeof indexedDB);
        rec('alert', typeof alert);
        rec('atob', typeof atob);
        rec('btoa', typeof btoa);
        rec('TextDecoder', typeof TextDecoder);
        rec('TextEncoder', typeof TextEncoder);
        rec('setTimeout', typeof setTimeout);
        rec('setInterval', typeof setInterval);
        rec('Promise', typeof Promise);
        rec('JSON', typeof JSON);
        rec('globalThis', typeof globalThis);
        // Panorama / Source-side globals worth knowing about
        rec('$', typeof $);
        rec('GameUI', typeof GameUI);
        rec('GameEvents', typeof GameEvents);
        rec('Game', typeof Game);
        rec('Players', typeof Players);
        rec('Entities', typeof Entities);
        rec('CitadelUI', typeof CitadelUI);
        rec('SteamUtils', typeof SteamUtils);
        rec('SteamFriends', typeof SteamFriends);
        rec('SteamHTML', typeof SteamHTML);
        rec('LoadKeyValues', typeof LoadKeyValues);
        rec('LoadKeyValuesFromString', typeof LoadKeyValuesFromString);
        rec('FileSystem', typeof FileSystem);
        rec('Application', typeof Application);
        rec('panorama', typeof panorama);
        say(`present globals (${g.length}): ${g.join(', ') || 'NONE'}`);

        // If a real global object is reachable, dump it: that is the ground truth.
        let root = null;
        try { root = Function('return this')(); } catch (e) { say(`  Function('return this') blocked: ${errStr(e)}`); }
        if (root) { enumerate(root, 'globalThis'); } else { say('  no reachable global object'); }
    });

    inventoryStep('2. $ API SURFACE (runtime, since panorama.dll is not in GameTracking)', function () {
        enumerate($, '$');
        probeMembers($, '$', [
            'AsyncWebRequest', 'CreateAsyncWebRequest', 'WebRequest', 'HTTPRequest',
            'RegisterEventHandler', 'RegisterForUnhandledEvent', 'UnregisterEventHandler',
            'UnregisterForUnhandledEvent', 'DispatchEvent', 'DispatchEventAsync',
            'CreatePanel', 'CreatePanelWithProperties', 'GetContextPanel', 'Schedule',
            'CancelScheduled', 'Msg', 'Warning', 'Localize', 'LocalizePlural',
            'LoadKeyValuesFile', 'LoadKeyValues3File', 'HTMLEscape', 'UrlEncode',
            'Language', 'DebugLog', 'Each', 'GetContextObject', 'GetCurrentScheduleTime',
            'FindChildInContext', 'PlaySoundEvent', 'DevBrowser', 'OpenExternalBrowser'
        ]);
    });

    step('3. PANEL TYPES - what can we even create?', function () {
        hostPanel = $.CreatePanel('Panel', $.GetContextPanel(), 'HTMLProbe_Host');
        try {
            hostPanel.style.position = '2px 2px 0px';
            hostPanel.style.width = '480px';
            hostPanel.style.height = '360px';
            hostPanel.style.zIndex = '99999';
        } catch (e) { say(`host style exc: ${errStr(e)}`); }
        // NOTE: kept fully opaque on purpose. A hidden/zero-opacity panel is skipped
        // by the engine's loader (documented for the <Image> transport), and a CEF
        // surface that is never composited may never load its page either. It sits in
        // the top-left corner for the duration of the probe; that is expected.
        try { hostPanel.SetAttributeString('hittest', 'false'); } catch (e) {}
        try { hostPanel.SetAttributeString('hittestchildren', 'false'); } catch (e) {}

        const types = [
            'Panel', 'Label', 'Image', 'TextEntry', 'Button', 'MoviePanel',
            'CitadelHTMLPanel', 'HTML', 'HTMLPanel', 'WebPanel', 'CefPanel',
            'CitadelWebPanel', 'SteamHTMLPanel'
        ];
        for (let i = 0; i < types.length; i++) {
            const t = types[i];
            let p = null;
            try { p = $.CreatePanel(t, hostPanel, `probe_${t}`); } catch (e) {
                say(`  CreatePanel("${t}") THREW: ${errStr(e)}`);
                continue;
            }
            if (!p) { say(`  CreatePanel("${t}") -> null`); continue; }
            let pt = '?';
            try { pt = p.paneltype; } catch (e) {}
            say(`  CreatePanel("${t}") OK, paneltype=${pt}`);
            found.push(`paneltype ${t}`);
            if (t !== 'CitadelHTMLPanel') {
                try { p.DeleteAsync(0); } catch (e) {}
            } else {
                htmlPanel = p;
                try {
                    p.style.width = '480px';
                    p.style.height = '360px';
                } catch (e) {}
            }
        }
        if (!htmlPanel) { say('  !! CitadelHTMLPanel could NOT be created - CEF stages will be skipped'); }
    }, 1.0);

    inventoryStep('4. CitadelHTMLPanel API', function () {
        if (!htmlPanel) { say('  skipped (no panel)'); return; }
        enumerate(htmlPanel, 'CitadelHTMLPanel');
        probeMembers(htmlPanel, 'CitadelHTMLPanel', HTML_METHODS);
    });

    step('5. EVENT HANDLERS - register for every HTML* event', function () {
        if (!htmlPanel) { say('  skipped (no panel)'); return; }
        // PROVEN in the first in-game run: RegisterEventHandler delivers, SetPanelEvent
        // delivered nothing at all, and RegisterForUnhandledEvent delivered an exact
        // duplicate of every RegisterEventHandler call - which doubled the whole log.
        // One path only.
        let evh = 0;
        for (let i = 0; i < HTML_EVENTS.length; i++) {
            const name = HTML_EVENTS[i];
            if (typeof $.RegisterEventHandler === 'function') {
                try { $.RegisterEventHandler(name, htmlPanel, makeHandler(name)); evh++; } catch (e) {}
            }
        }
        say(`  registered ${evh}/${HTML_EVENTS.length} via $.RegisterEventHandler`);
        say('  (SetPanelEvent delivered nothing in run 1; RegisterForUnhandledEvent only duplicated)');
    });

    // ── payload tests ───────────────────────────────────────────────────────
    // Each test: point the panel at a URL that tries to push a long string back
    // through one specific channel, then scrape everything readable.

    function setUrl(url) {
        if (!htmlPanel) { say('  skipped (no panel)'); return; }
        lastSetUrl = url;
        // Print only the length and a short head. On the capacity ladder the URL itself
        // reaches 65 KB, and echoing it would blow the console budget by itself.
        say(`  SetURL len=${url.length}: ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
        if (typeof htmlPanel.SetURL !== 'function') { say('  !! SetURL is not a function on this panel'); return; }
        try { htmlPanel.SetURL(url); } catch (e) { say(`  SetURL THREW: ${errStr(e)}`); }
    }

    // Run 1 proved every payload arrives in an event ARGUMENT, never on the panel, so
    // the per-stage scrape is now off by default. It stays available because it is the
    // only thing that would catch a property-based channel if one exists.
    const SCRAPE_AFTER_EACH_STAGE = false;

    function scrapeNow(label) {
        if (!htmlPanel) { say('  skipped (no panel)'); return; }
        scrape(htmlPanel, label, TEXT_PROPS.concat(HTML_METHODS));
    }

    // Stages already answered by run 1. Gated so they cost nothing unless re-collecting.
    function inventoryPayload(stageName, url, waitSecs) {
        if (!RUN_INVENTORY) { return; }
        payloadTest(stageName, url, waitSecs);
    }

    function payloadTest(stageName, url, waitSecs) {
        step(stageName, function () { setUrl(url); }, waitSecs || 3.0);
        if (SCRAPE_AFTER_EACH_STAGE) {
            step('', function () { scrapeNow(`after:${stageName}`); }, 0.4);
        }
    }

    // 6. data: URL, plain text. Does the panel load a data: URL at all?
    // ⚠ CEF blocks TOP-LEVEL navigation to data: URLs (Chrome 60+). An embedder
    //   calling LoadURL directly is often still allowed, but if it is not, stages
    //   6-12 all go quiet and that silence must NOT be read as "no channel exists".
    //   Stage 6b below is the control that separates the two failure modes.
    inventoryPayload('6. data:text/plain', `data:text/plain,${payload('PLAIN')}`);

    // 6b. CONTROL TEST - splits the READ path from the WRITE path.
    // We put the long string in the URL fragment ourselves, on a real https page.
    // No page JS is involved, so this cannot be blocked by a data:-URL policy.
    //   marker comes back  => a read path EXISTS. Any page can then push arbitrary
    //                         text by rewriting location.hash, and all we need is a
    //                         hosted test page instead of a data: URL.
    //   marker absent      => there is no URL read-back at all, and every
    //                         URL-shaped channel is dead regardless of hosting.
    // This is the single most informative stage in the file.
    inventoryPayload('6b. CONTROL: long #fragment on a real URL (read path only)',
        `${TEST_PAGE}#${payload('FRAGMENT')}`, 5.0);

    // 7. <title> - HTML_ChangedTitle_t is a real Steam callback. If the title
    //    reaches JS, that alone is an arbitrary-length downlink.
    inventoryPayload('7. data: <title> channel',
        `data:text/html,<html><head><title>${payload('TITLE')}</title></head><body>t</body></html>`);

    // 8. window.status - HTML_StatusText_t.
    inventoryPayload('8. window.status channel',
        `data:text/html,<html><body>s<script>window.status=%22${payload('STATUS')}%22;</script></body></html>`);

    // 9. alert() - HTML_JSAlert_t. The channel hanturaya's suggestion implies.
    //    WARNING: an unanswered JS alert can leave the CEF browser blocked. It is
    //    late in the run on purpose, and only the embedded browser is affected.
    inventoryPayload('9. alert() channel',
        `data:text/html,<html><body>a<script>alert(%22${payload('ALERT')}%22);</script></body></html>`);

    // 10. location.hash - HTML_URLChanged_t. The most promising one: a URL can
    //     legitimately carry kilobytes and URLChanged is a documented callback.
    inventoryPayload('10. location.hash / URLChanged channel',
        `data:text/html,<html><body>h<script>location.hash=%22${payload('HASH')}%22;</script></body></html>`);

    // 11. document.title set from script, after load (separate callback path from
    //     a static <title>).
    inventoryPayload('11. document.title set late',
        `data:text/html,<html><body>d<script>setTimeout(function(){document.title=%22${payload('DOCTITLE')}%22;},300);</script></body></html>`);

    // 12. javascript: URL. The literal "javascript:" appears in client_strings.txt:43572.
    inventoryPayload('12. javascript: URL', `javascript:alert("${payload('JSURL')}");void(0);`);

    // 13. Does the panel reach the real internet at all? This is the page from the
    //     Discord thread; a plain remote HTML document with visible text.
    inventoryPayload('13. remote page (network reach)',
        'https://hantu-raya.github.io/hp-colors-preset-builder/supporters-strip/', 6.0);

    // 14. If some form of async web request exists, actually call it.
    inventoryStep('14. $.AsyncWebRequest (if it exists)', function () {
        const names = ['AsyncWebRequest', 'CreateAsyncWebRequest', 'WebRequest', 'HTTPRequest'];
        let any = false;
        for (let i = 0; i < names.length; i++) {
            const n = names[i];
            if (typeof $[n] !== 'function') { continue; }
            any = true;
            say(`  $.${n} EXISTS - calling it`);
            try {
                $[n]('https://hantu-raya.github.io/hp-colors-preset-builder/supporters-strip/', {
                    type: 'GET',
                    success: function (data) {
                        say(`  $.${n} SUCCESS: ${brief(data)}`);
                        checkString(`$.${n}:success`, typeof data === 'string' ? data : JSON.stringify(data));
                    },
                    error: function (e) { say(`  $.${n} ERROR: ${brief(e)}`); },
                    complete: function (e) { say(`  $.${n} COMPLETE: ${brief(e)}`); }
                });
            } catch (e) { say(`  $.${n} THREW: ${errStr(e)}`); }
        }
        if (!any) { say('  none of AsyncWebRequest / CreateAsyncWebRequest / WebRequest / HTTPRequest exist'); }
    }, 6.0);

    // 14b. CAPACITY LADDER. hanturaya's proven payload was ~330 chars of JSON. The
    // question that decides whether this is a transport or a display gimmick is how
    // far it goes before the engine (or CEF, or the console) truncates. Each rung is
    // one navigation with a title of a known size; the summary prints the largest
    // string that actually arrived per channel.
    // Depends on data: URLs being permitted. If stage 6 showed nothing loaded, this
    // ladder is meaningless and the same test has to be run from a hosted page.
    // ANSWERED run 2: cap is exactly 4096. 64/256/1024/4096 whole; 16384 and 65536 both
    // cut to exactly 4096. Gated so the console budget goes to the open question below.
    const LADDER = [64, 256, 1024, 4096, 16384, 65536];
    for (let li = 0; RUN_INVENTORY && li < LADDER.length; li++) {
        const size = LADDER[li];
        step(`14b. capacity ladder: ${size} chars in <title>`, function () {
            let s = MARK + '_LADDER' + size + '_';
            while (s.length < size - 4) { s += 'x'; }
            s = `${s.substring(0, size - 4)}_END`;
            setUrl(`data:text/html,<html><head><title>${s}</title></head><body>L${size}</body></html>`);
        }, 2.5);
    }

    // 14c. PUSH STREAM. Everything above is one payload per navigation, which for a
    // game loop would mean a full CEF navigation per poll. If a page can rewrite
    // document.title repeatedly and each write fires HTMLTitle, the panel becomes a
    // persistent server-push channel and no navigation is needed per update. That is
    // the difference between "replaces mg_net.js" and "does not".
    // ANSWERED run 2: all five ticks arrived, one HTMLTitle each, no renavigation.
    inventoryStep('14c. push stream: title rewritten 5x without renavigating', function () {
        const js = [
            'var i=0;',
            'var t=setInterval(function(){',
            'i++;',
            `document.title='${MARK}_STREAM'+i+'_tick_END';`,
            'if(i>=5){clearInterval(t);}',
            '},600);'
        ].join('');
        setUrl(`data:text/html,<html><head><title>${MARK}_STREAM0_init_END</title></head><body>stream<script>${js}</script></body></html>`);
    }, 6.0);

    // ── run 3: does the PAGE have real network? ─────────────────────────────
    // This is the question that decides the architecture. The page inside CEF is a
    // real browser, so the candidate chain is:
    //   Panorama JS --SetURL(?query)--> page --real network--> server
    //   page --document.title (4096, push)--> Panorama JS
    // The first and last links are PROVEN (run 2). The middle one is not, and if it
    // works there is no polling: the page holds a socket and pushes.
    //
    // Endpoints verified live from the shell 2026-08-23 BEFORE this run, so a failure
    // in-game means CEF blocked it, not that the service is down:
    //   https://api.github.com/zen                    200, Access-Control-Allow-Origin: *
    //   https://dl-arcade-cloudflare.predi-i.workers.dev/api/ping.png
    //                                                  200, image/png, ACAO: *
    //   wss://ws.postman-echo.com/raw                  101 Switching Protocols
    //   wss://echo.websocket.org/                      101 Switching Protocols
    // The worker already sends ACAO:* (worker.core.js:2216), so a same-page fetch to
    // it is not a CORS case at all.
    const WORKER_URL = 'https://dl-arcade-cloudflare.predi-i.workers.dev';

    // A data: URL body must not contain raw # % & ? " space or +, or the URL parser
    // eats them ('#' silently truncates the whole page into a fragment). Percent
    // escapes decode correctly inside CEF - proven in run 1, where window.status=%22..%22
    // came back with real quotes. '%' MUST be escaped first or it corrupts the rest.
    function encDataUrl(s) {
        // Chained on one expression with the dots at line END, not line start: the
        // project rule is that no shipped-JS line may begin with an operator, because
        // the Panorama minifier mangles it. A leading '.' is not actually an ASI hazard
        // ('.' cannot begin a statement) but the rule is cheap to honour, so honour it.
        let out = s.replace(/%/g, '%25');
        out = out.replace(/#/g, '%23');
        out = out.replace(/&/g, '%26');
        out = out.replace(/\?/g, '%3F');
        out = out.replace(/"/g, '%22');
        out = out.replace(/\+/g, '%2B');
        out = out.replace(/ /g, '%20');
        return out;
    }

    // The page reports through document.title, one write per finding. Each write fires
    // its own HTMLTitle, so ordering and count are visible in the console. No '+' is
    // used for concatenation anywhere in the page script: join() avoids needing it.
    //
    // ⚠ EVERY probe is individually guarded, and that is not defensive padding - run 3
    // failed exactly here. The first version put the whole inventory in ONE statement:
    //   rep([...,'LS',typeof localStorage,'origin',String(location.origin)].join('='))
    // A data: URL document has an OPAQUE ORIGIN, and in Chrome touching localStorage
    // there throws SecurityError - `typeof localStorage` throws too, because it is a
    // throwing getter, not a plain undefined lookup. That exception was uncaught and at
    // top level, so it aborted the ENTIRE script: not one report arrived, including the
    // pure-typeof line that needs no network and the try/catch-wrapped fetch blocks
    // below it. The log read as "fetch is absent" when nothing had run at all.
    // The tell was stage 17: same kind of data: URL, no localStorage/location access,
    // and its 12 ticks all landed. So: never let one probe's failure hide the others.
    function netProbePage() {
        const js = [
            "var n=0;",
            "function rep(s){try{document.title=['NETP',++n,s].join('|');}catch(e){}}",
            // Guard each read separately. Returns the typeof, or the throw, never both.
            "function g(f){try{var v=f();return String(v);}catch(e){return['THREW',String(e).slice(0,50)].join(':');}}",
            // 1a. the pure existence checks that CANNOT touch storage or origin
            "rep(['fetch',g(function(){return typeof fetch;}),",
            "'WS',g(function(){return typeof WebSocket;}),",
            "'XHR',g(function(){return typeof XMLHttpRequest;}),",
            "'ES',g(function(){return typeof EventSource;})].join('='));",
            // 1b. the ones that legitimately throw in an opaque origin, kept apart
            "rep(['LS',g(function(){return typeof localStorage;}),",
            "'origin',g(function(){return location.origin;}),",
            "'href',g(function(){return String(location.href).slice(0,30);})].join('='));",
            // 2. fetch a CORS-* third party: proves page-side HTTP end to end
            "try{fetch('https://api.github.com/zen').then(function(r){return r.text();})",
            ".then(function(t){rep(['fetchGH','ok','len',String(t).length,'body',String(t).slice(0,40)].join('='));})",
            ".catch(function(e){rep(['fetchGH','ERR',String(e).slice(0,90)].join('='));});}",
            "catch(e){rep(['fetchGH','THREW',String(e).slice(0,90)].join('='));}",
            // 3. fetch HIS worker: the real production path. It sends ACAO:*.
            "try{fetch('" + WORKER_URL + "/api/ping.png').then(function(r){return r.arrayBuffer();})",
            ".then(function(b){rep(['fetchWorker','ok','bytes',b.byteLength].join('='));})",
            ".catch(function(e){rep(['fetchWorker','ERR',String(e).slice(0,90)].join('='));});}",
            "catch(e){rep(['fetchWorker','THREW',String(e).slice(0,90)].join('='));}",
            // 4. WebSocket. If this connects, the downlink becomes a subscription and
            //    the whole request-budget problem disappears.
            "try{var w=new WebSocket('wss://ws.postman-echo.com/raw');",
            "w.onopen=function(){rep(['WS','open'].join('='));try{w.send('MGPROBE_WS_PING');}catch(x){rep(['WS','sendTHREW',String(x).slice(0,60)].join('='));}};",
            "w.onmessage=function(e){rep(['WS','msg',String(e.data).slice(0,40)].join('='));try{w.close();}catch(x){}};",
            "w.onerror=function(){rep(['WS','onerror'].join('='));};",
            "w.onclose=function(e){rep(['WS','close','code',e.code,'clean',e.wasClean].join('='));};}",
            "catch(e){rep(['WS','THREW',String(e).slice(0,90)].join('='));}",
            // 5. Liveness beacon. If this arrives but nothing above did, the script ran
            //    and every individual probe failed - a completely different diagnosis
            //    from "the script never executed", which is what run 3 could not tell.
            "rep(['scriptEND','reached'].join('='));"
        ].join('');
        const html = `<html><head><title>NETP|0|boot</title></head><body>net<script>${js}</script></body></html>`;
        return `data:text/html,${encDataUrl(html)}`;
    }

    // Two candidate causes for run 3's silence, and they need separating:
    //   (a) the opaque-origin SecurityError aborting the script (fixed above), or
    //   (b) a length/complexity limit on a data: URL that carries a script. The longest
    //       data: script PROVEN to run is ~331 chars (run 1 stages 8-11). Stage 16's was
    //       1540, i.e. 4.6x past anything verified. The 65 KB ladder URLs loaded, but
    //       they carried only a <title> and no script, so they do not settle this.
    // So: climb by COMPLEXITY, smallest first. If A works and C does not, it is size.
    // If A fails too, size is not the story and something more basic is wrong.

    // 16a. Absolute minimum. No network, no storage, no origin. ~150-char URL.
    inventoryStep('16a. MINIMAL: typeof only, tiny data: URL', function () {
        const js = "document.title=['NETP','A',typeof fetch,typeof WebSocket].join('|');";
        setUrl(`data:text/html,${encDataUrl(`<html><head><title>NETP|0|a</title></head><body>a<script>${js}</script></body></html>`)}`);
    }, 4.0);

    // 16b. One fetch, nothing else. URL lands near the proven ~331-char range.
    inventoryStep('16b. MINIMAL: a single fetch, short data: URL', function () {
        const js = [
            "fetch('https://api.github.com/zen').then(function(r){return r.text();})",
            ".then(function(t){document.title=['NETP','B','ok',String(t).length].join('|');})",
            ".catch(function(e){document.title=['NETP','B','ERR',String(e).slice(0,50)].join('|');});"
        ].join('');
        setUrl(`data:text/html,${encDataUrl(`<html><head><title>NETP|0|b</title></head><body>b<script>${js}</script></body></html>`)}`);
    }, 8.0);

    inventoryStep('16c. FULL BATTERY: fetch x2 + WebSocket, guarded per probe', function () {
        setUrl(netProbePage());
    }, 14.0);

    // 17. Latency of one round trip through the panel, and whether the title channel
    // can be driven at a game-loop cadence. The page stamps performance.now() into the
    // title every 250ms for 3s; the gaps between our HTMLTitle events show the real
    // achievable rate and any frame stalls.
    inventoryStep('17. CADENCE: title rewritten every 250ms for 3s', function () {
        const js = [
            "var i=0,t0=Date.now();",
            "var h=setInterval(function(){i++;",
            "document.title=['TICK',i,Date.now()-t0].join('|');",
            "if(i>=12){clearInterval(h);}},250);"
        ].join('');
        const html = `<html><head><title>TICK|0|0</title></head><body>c<script>${js}</script></body></html>`;
        setUrl(`data:text/html,${encDataUrl(html)}`);
    }, 6.0);

    // ── 19. LONGEVITY: does a page (and its socket) survive minutes? ────────
    // Everything proven so far was a 4-14s burst. The rewrite's shape depends on this:
    //   socket survives  -> downlink is a SUBSCRIPTION, no polling at all
    //   socket dies      -> downlink is one navigation per update (still 4096 chars,
    //                       still ~2700x the current 12 bits, just not push)
    // Uses the EXISTING worker route, so no deploy is needed to answer it.
    // Guarded per probe with a liveness beacon, per the run-3 lesson.
    // ── 20. Does `javascript:` run in the CURRENT document? ─────────────────
    // Decides the uplink design. If it executes in the loaded page's context, Panorama
    // can call into the page WITHOUT renavigating, so an open socket survives an action.
    // If it gets a fresh document, every uplink action costs a navigation and the socket
    // must live in a SECOND, never-navigated panel.
    // The test: page 1 plants a global and a function. Then a javascript: URL asks for
    // them back. Seeing the planted value proves same-context; seeing 'undefined' proves
    // a fresh document. Two steps so the plant is definitely committed first.
    step('20a. plant a global in the page', function () {
        const js = [
            "window.MGPLANT='planted_ok';",
            "window.mgEcho=function(){document.title=['CTX','fn',String(window.MGPLANT)].join('|');};",
            "document.title=['CTX','planted',String(window.MGPLANT)].join('|');"
        ].join('');
        setUrl(`data:text/html,${encDataUrl(`<html><head><title>CTX|0|boot</title></head><body>p<script>${js}</script></body></html>`)}`);
    }, 3.0);

    step('20b. javascript: URL reads it back', function () {
        // Report BOTH the raw global and whether the planted function is callable. If the
        // document is fresh, MGPLANT is undefined and mgEcho does not exist.
        const js = [
            "javascript:(function(){",
            "var v;try{v=String(window.MGPLANT);}catch(e){v='THREW';}",
            "var f;try{f=typeof window.mgEcho;}catch(e){f='THREW';}",
            "document.title=['CTX','readback',v,'fn',f].join('|');",
            "})();void(0);"
        ].join('');
        // A javascript: URL is not a data: URL, but the same characters still need
        // escaping for the URL parser, so reuse the same encoder.
        setUrl(`javascript:${encDataUrl(js.substring('javascript:'.length))}`);
    }, 4.0);

    step('19. LONGEVITY: 60s page, fetch loop + held WebSocket', function () {
        const js = [
            "var n=0,fOk=0,fErr=0,wsUp=0,wsDown=0,t0=Date.now();",
            "function rep(s){try{document.title=['LIVE',++n,Date.now()-t0,s].join('|');}catch(e){}}",
            // A: fetch the worker once a second for 60s. Report sparsely: the first, then
            // every 10th, then any error immediately. Console budget is ~3 MB shared with
            // the game, so a report per second would be wasteful.
            "var i=0;",
            "var fh=setInterval(function(){i++;",
            "try{fetch('" + WORKER_URL + "/api/ping.png?rnd='+i).then(function(r){return r.arrayBuffer();})",
            ".then(function(b){fOk++;if(i===1||i%10===0){rep(['fetch','n',i,'ok',fOk,'err',fErr,'bytes',b.byteLength].join('='));}})",
            ".catch(function(e){fErr++;if(fErr<=3){rep(['fetch','n',i,'ERR',String(e).slice(0,50),'okSoFar',fOk].join('='));}});}",
            "catch(e){fErr++;}",
            "if(i>=60){clearInterval(fh);rep(['fetchLOOP','done','ok',fOk,'err',fErr].join('='));}},1000);",
            // B: hold one WebSocket open the whole time, pinging every 5s so an idle
            // timeout on the echo service cannot be mistaken for CEF dropping it.
            "var w=null,wsDead=false;",
            "try{w=new WebSocket('wss://ws.postman-echo.com/raw');",
            "w.onopen=function(){rep(['ws','OPEN'].join('='));};",
            "w.onmessage=function(e){wsDown++;if(wsDown===1||wsDown%4===0){rep(['ws','alive','sent',wsUp,'recv',wsDown,'last',String(e.data).slice(0,20)].join('='));}};",
            "w.onerror=function(){rep(['ws','ERROR','sent',wsUp,'recv',wsDown].join('='));};",
            "w.onclose=function(e){wsDead=true;rep(['ws','CLOSED','code',e.code,'clean',e.wasClean,'sent',wsUp,'recv',wsDown].join('='));};",
            "var wh=setInterval(function(){",
            "if(wsDead){clearInterval(wh);return;}",
            "try{if(w.readyState===1){wsUp++;w.send('ping'+wsUp);}else{rep(['ws','state',w.readyState].join('='));}}catch(x){rep(['ws','sendTHREW',String(x).slice(0,40)].join('='));}",
            "},5000);}",
            "catch(e){rep(['ws','CTORTHREW',String(e).slice(0,60)].join('='));}",
            // C: final verdict from inside the page, after the full minute.
            "setTimeout(function(){rep(['VERDICT','fetchOk',fOk,'fetchErr',fErr,'wsSent',wsUp,'wsRecv',wsDown,'wsDead',wsDead].join('='));},62000);",
            "rep(['scriptEND','armed'].join('='));"
        ].join('');
        const html = `<html><head><title>LIVE|0|0|boot</title></head><body>live<script>${js}</script></body></html>`;
        setUrl(`data:text/html,${encDataUrl(html)}`);
    }, 68.0);

    step('18. FINAL SCRAPE (only channel that could still hide a property-based path)', function () {
        scrapeNow('final');
    }, 1.0);

    function finish() {
        hr('RESULT');

        // Stage 19/20 first: these two decide the transport's shape.
        if (liveFindings.length) {
            say(`LONGEVITY (${liveFindings.length} reports, fields are LIVE|seq|msSinceStart|detail):`);
            for (let i = 0; i < liveFindings.length; i++) { say(`  ${liveFindings[i]}`); }
            const verdict = liveFindings.filter((s) => s.indexOf('VERDICT') >= 0);
            if (!verdict.length) {
                say('  ⚠ no VERDICT line: the page did not survive to the 62s mark, OR the');
                say('    probe moved on first. Either way the page did not last a minute.');
            }
        } else {
            say('LONGEVITY: no reports. The 60s page never ran.');
        }

        if (ctxFindings.length) {
            say(`javascript: DOCUMENT CONTEXT (${ctxFindings.length} reports):`);
            for (let i = 0; i < ctxFindings.length; i++) { say(`  ${ctxFindings[i]}`); }
            const back = ctxFindings.filter((s) => s.indexOf('readback') >= 0)[0];
            if (back && back.indexOf('planted_ok') >= 0) {
                say('  => SAME CONTEXT. Panorama can call into the loaded page without');
                say('     renavigating, so an open WebSocket survives an uplink action.');
            } else if (back) {
                say('  => FRESH DOCUMENT. Every uplink navigation destroys the page, so the');
                say('     socket must live in a second panel that is never navigated.');
            }
        } else {
            say('javascript: DOCUMENT CONTEXT: no reports (the javascript: URL did not run).');
        }

        if (netFindings.length) {
            say(`PAGE NETWORK REPORT (${netFindings.length} lines from inside the CEF page):`);
            for (let i = 0; i < netFindings.length; i++) { say(`  ${netFindings[i]}`); }
            // "NETP|0|boot" is the STATIC <title>, delivered by the engine before any
            // script runs. On its own it proves the page loaded and proves NOTHING about
            // the script. Run 3 reported exactly that one line and it read as a result.
            const scripted = netFindings.filter((s) => s.indexOf('|0|') < 0);
            if (!scripted.length) {
                say('  ⚠ ONLY the static <title> arrived. The page script did NOT execute a');
                say('    single statement - this is NOT evidence about fetch. Compare 16a/16b/16c:');
                say('    16a runs no network at all, so if 16a is silent too the cause is the');
                say('    data: URL or its script, not the network.');
            }
        } else if (RUN_INVENTORY) {
            say('PAGE NETWORK REPORT: NOTHING AT ALL, not even the static title.');
            say('  The page did not even load. Check the data: URL survived encoding.');
        } else {
            // Do NOT raise an alarm for a stage that was deliberately switched off.
            say('PAGE NETWORK: stages 16a-16c gated off (answered run 4). fetch/WebSocket/');
            say('  XHR/EventSource all exist in the page; the worker fetch returned 72 bytes.');
        }
        if (tickFindings.length) {
            // TICK|0|0 is the static title, so subtract it from the scripted count.
            const scriptedTicks = tickFindings.filter((s) => s.indexOf('|0|') < 0).length;
            say(`CADENCE: ${scriptedTicks} of 12 scripted ticks arrived (plus the static title).`);
            for (let i = 0; i < tickFindings.length; i++) { say(`  ${tickFindings[i]}`); }
        } else if (RUN_INVENTORY) {
            say('CADENCE: no ticks arrived.');
        } else {
            say('CADENCE: stage 17 gated off (answered run 4: 12/12 at 250ms, ~1% drift).');
        }

        say(`API surface that EXISTS (${found.length}):`);
        let line = '';
        for (let i = 0; i < found.length; i++) {
            line += (line ? ' | ' : '') + found[i];
            if (line.length > 200) { say(`  ${line}`); line = ''; }
        }
        if (line) { say(`  ${line}`); }

        // Capacity is the number that matters. A channel that delivers 330 chars is a
        // leaderboard; one that delivers 16k is a transport.
        const lenKeys = Object.keys(maxLen).sort();
        if (lenKeys.length) {
            say(`LONGEST STRING RECEIVED per channel (${lenKeys.length}):`);
            for (let i = 0; i < lenKeys.length; i++) {
                say(`  ${lenKeys[i]} = ${maxLen[lenKeys[i]]} chars`);
            }
        }

        // Repeat counts prove whether a channel fires once or many times per payload,
        // which decides whether a consumer needs dedup.
        const dupKeys = Object.keys(seenPayload);
        let dupes = 0;
        for (let i = 0; i < dupKeys.length; i++) { if (seenPayload[dupKeys[i]] > 1) { dupes++; } }
        if (dupes) {
            say(`DUPLICATE deliveries (dedup required) on ${dupes} payload(s):`);
            for (let i = 0; i < dupKeys.length; i++) {
                if (seenPayload[dupKeys[i]] > 1) { say(`  ${dupKeys[i]} x${seenPayload[dupKeys[i]]}`); }
            }
        }

        const noisyKeys = Object.keys(noisyCount);
        if (noisyKeys.length) {
            const parts = [];
            for (let i = 0; i < noisyKeys.length; i++) { parts.push(`${noisyKeys[i]}=${noisyCount[noisyKeys[i]]}`); }
            say(`noisy events suppressed: ${parts.join(', ')}`);
        }

        if (hits.length) {
            say(`CHANNELS THAT DELIVERED THE LONG STRING (${hits.length}):`);
            for (let i = 0; i < hits.length; i++) { say(`  ${i + 1}. ${hits[i]}`); }
        } else {
            say('CHANNELS THAT DELIVERED THE MARKER: none this run.');
            say('  Expected when RUN_INVENTORY is false: the marker-bearing stages are');
            say('  gated off and run 3 answered them already. Read the PAGE NETWORK and');
            say('  CADENCE blocks above instead - they are this run\'s result.');
        }
        say(`transcript: ${transcript.length} lines, all prefixed ${TAG}`);
        say('==================== HTMLPROBE END ====================');

        // Leave the CEF panel behind only if it actually rendered something useful
        // to look at; otherwise clean up so the probe does not sit over the HUD.
        $.Schedule(20.0, function () {
            try { if (hostPanel) { hostPanel.DeleteAsync(0); } } catch (e) {}
            say('probe panel torn down');
        });
    }

    // ── arm ─────────────────────────────────────────────────────────────────
    // One line now so it is clear the mod loaded; everything else after the delay
    // so the run is not buried in the game's own boot spam.
    try { $.Msg(`${TAG} armed. First output in ${START_DELAY}s. Filter: con_filter_enable 1 ; con_filter_text HTMLPROBE`); } catch (e) {}
    $.Schedule(START_DELAY, function () {
        say('==================== HTMLPROBE START ====================');
        runNext();
    });
})();
