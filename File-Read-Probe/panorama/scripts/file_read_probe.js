// Diagnostic only: checks whether CitadelHTMLPanel can read one harmless file
// outside the game and mod directories. No network request is made.
(function () {
    var TARGET_URL = 'file:///C:/Users/Public/Documents/DeadlockFileProbe.txt';
    var PREFIX = 'FILEPROBE|';
    var ctx = $.GetContextPanel();
    var panel = null;
    var label = null;
    var result = '';
    var done = false;

    function show(message) {
        $.Msg('[FILEPROBE] ' + message);
        if (label) label.text = 'File probe: ' + message;
    }

    try {
        label = $.CreatePanel('Label', ctx, 'FileReadProbeStatus');
        label.hittest = false;
        label.style.position = '16px 96px 0px';
        label.style.width = '680px';
        label.style.height = '34px';
        label.style.zIndex = '99999';
        label.style.fontSize = '20px';
        label.style.color = '#ffffff';
        label.style.backgroundColor = '#171717dd';
    } catch (e) {
        $.Warning('[FILEPROBE] Could not create status label: ' + e);
    }

    show('opening local test file...');

    try {
        panel = $.CreatePanel('CitadelHTMLPanel', ctx, 'FileReadProbeCEF');
        panel.hittest = false;
        panel.acceptsfocus = false;
        panel.style.width = '2px';
        panel.style.height = '2px';
        panel.style.opacity = '0.01';
        panel.style.visibility = 'visible';

        $.RegisterEventHandler('HTMLTitle', panel, function (source, title) {
            if (typeof title !== 'string' || title.indexOf(PREFIX) !== 0) return;
            result = title.substring(PREFIX.length);
            if (/^OK:[0-9A-F]{16}$/.test(result)) {
                done = true;
                show('READ OK, marker ' + result.substring(3));
            } else if (!done) {
                show('CEF replied: ' + result.substring(0, 80));
            }
        });

        $.RegisterEventHandler('HTMLFinishRequest', panel, function (source, url) {
            if (url === TARGET_URL) $.Schedule(0.3, probe);
        });

        panel.SetURL(TARGET_URL);
    } catch (e) {
        show('panel setup failed: ' + e);
        return;
    }

    function probe() {
        if (done || !panel || (panel.IsValid && !panel.IsValid())) return;
        // A javascript: URL runs in the loaded document. void(0) prevents
        // the expression result from replacing the current page.
        var js = "(function(){try{" +
            "if(location.protocol!=='file:'||location.pathname.toLowerCase().indexOf('deadlockfileprobe.txt')<0){document.title='FILEPROBE|WRONG_DOCUMENT';return;}" +
            "var body=document.body;var text=body?(body.innerText||body.textContent||'').trim():'';" +
            "var m=/^DL_FILE_PROBE_([0-9A-F]{16})$/.exec(text);" +
            "document.title=m?'FILEPROBE|OK:'+m[1]:'FILEPROBE|NO_MARKER';" +
            "}catch(e){document.title='FILEPROBE|SCRIPT_ERROR:'+String(e&&e.name||e).substring(0,40);}})();void(0);";
        try {
            panel.SetURL('javascript:' + js);
        } catch (e) {
            show('injection failed: ' + e);
        }
    }

    $.Schedule(2.0, probe);
    $.Schedule(4.0, probe);
    $.Schedule(8.0, probe);
    $.Schedule(10.0, function () {
        if (!done) show('NO READ after 10s; last reply: ' + (result || 'none'));
    });
})();
