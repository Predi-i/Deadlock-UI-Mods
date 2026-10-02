// Diagnostic only. Attempts multiple web techniques to write/download a file from CEF:
// 1. <a download> with data: URI
// 2. <a download> with Blob URL
// 3. File System Access API (showSaveFilePicker)
// 4. Origin Private File System (navigator.storage.getDirectory)
// 5. Legacy webkitRequestFileSystem
(function () {
    var SOURCE_URL = 'file:///C:/Users/Public/Documents/DeadlockFileProbe.txt';
    var TARGET_URL = 'file:///C:/Users/Public/Documents/DeadlockWriteProbe-FE223F1D.txt';
    var MARKER = 'DL_WRITE_PROBE_FE223F1D';
    var PREFIX = 'FILEWRITE|';
    var ctx = $.GetContextPanel();
    var panel = null;
    var label = null;
    var checking = false;
    var attempts = 'none';
    var readback = 'none';

    function show(message) {
        $.Msg('[FILEWRITE] ' + message);
        if (label) label.text = 'File write probe: ' + message;
    }

    try {
        label = $.CreatePanel('Label', ctx, 'FileWriteProbeStatus');
        label.hittest = false;
        label.style.position = '16px 96px 0px';
        label.style.width = '1200px';
        label.style.height = '34px';
        label.style.zIndex = '99999';
        label.style.fontSize = '18px';
        label.style.color = '#ffffff';
        label.style.backgroundColor = '#171717dd';
    } catch (e) {
        $.Warning('[FILEWRITE] Could not create status label: ' + e);
    }

    show('opening local source file...');

    try {
        panel = $.CreatePanel('CitadelHTMLPanel', ctx, 'FileWriteProbeCEF');
        panel.hittest = false;
        panel.acceptsfocus = false;
        panel.style.width = '2px';
        panel.style.height = '2px';
        panel.style.opacity = '0.01';
        panel.style.visibility = 'visible';

        $.RegisterEventHandler('HTMLTitle', panel, function (source, title) {
            if (typeof title !== 'string' || title.indexOf(PREFIX) !== 0) return;
            var message = title.substring(PREFIX.length);
            if (message.indexOf('ATTEMPTS|') === 0) {
                attempts = message.substring(9);
                show('write attempts: ' + attempts);
            } else if (message.indexOf('READBACK|') === 0) {
                readback = message.substring(9);
                show('readback: ' + readback + '; attempts: ' + attempts);
            } else {
                show(message.substring(0, 150));
            }
        });

        $.RegisterEventHandler('HTMLFinishRequest', panel, function (source, url) {
            if (url === SOURCE_URL && !checking) $.Schedule(0.3, tryWrite);
            if (url === TARGET_URL && checking) $.Schedule(0.3, readTarget);
        });

        panel.SetURL(SOURCE_URL);
    } catch (e) {
        show('panel setup failed: ' + e);
        return;
    }

    function inject(js) {
        if (!panel || (panel.IsValid && !panel.IsValid())) return;
        try { panel.SetURL('javascript:' + js); }
        catch (e) { show('injection failed: ' + e); }
    }

    function tryWrite() {
        if (checking) return;
        var js = "(function(){try{" +
            "if(location.protocol!=='file:'||!/deadlockfileprobe[.]txt$/i.test(location.pathname)){document.title='FILEWRITE|WRONG_SOURCE';return;}" +
            "if(window.__fileWriteProbeStarted)return;window.__fileWriteProbeStarted=true;" +
            "var marker='" + MARKER + "';" +
            "var res={a_data:'none',a_blob:'none',fsa:'none',opfs:'none',wkfs:'none'};" +
            "function report(){document.title='FILEWRITE|ATTEMPTS|a_data='+res.a_data+';a_blob='+res.a_blob+';fsa='+res.fsa+';opfs='+res.opfs+';wkfs='+res.wkfs;}" +
            "try{var a=document.createElement('a');a.download='DeadlockWriteProbe-FE223F1D.txt';a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(marker);document.body.appendChild(a);a.click();res.a_data='clicked';}catch(e){res.a_data='err_'+(e&&e.name||e);}" +
            "try{var b=new Blob([marker],{type:'text/plain'});var u=URL.createObjectURL(b);var a2=document.createElement('a');a2.download='DeadlockWriteProbe-FE223F1D.txt';a2.href=u;document.body.appendChild(a2);a2.click();res.a_blob='clicked';}catch(e){res.a_blob='err_'+(e&&e.name||e);}" +
            "try{if(typeof window.showSaveFilePicker==='function'){res.fsa='supported';window.showSaveFilePicker().then(function(){res.fsa='picked';report();},function(e){res.fsa='err_'+(e&&e.name||e);report();});}else{res.fsa='unsupported';}}catch(e){res.fsa='throw_'+(e&&e.name||e);}" +
            "try{if(navigator.storage&&navigator.storage.getDirectory){res.opfs='supported';navigator.storage.getDirectory().then(function(d){return d.getFileHandle('DeadlockWriteProbe.txt',{create:true});}).then(function(){res.opfs='written';report();}).catch(function(e){res.opfs='err_'+(e&&e.name||e);report();});}else{res.opfs='unsupported';}}catch(e){res.opfs='throw_'+(e&&e.name||e);}" +
            "try{var rfs=window.requestFileSystem||window.webkitRequestFileSystem;if(rfs){res.wkfs='supported';rfs(0,1024,function(){res.wkfs='ready';report();},function(e){res.wkfs='err_'+(e&&e.name||e);report();});}else{res.wkfs='unsupported';}}catch(e){res.wkfs='throw_'+(e&&e.name||e);}" +
            "report();setTimeout(report,1500);" +
            "}catch(e){document.title='FILEWRITE|SCRIPT_ERROR:'+String(e&&e.name||e).substring(0,30);}})();void(0);";
        inject(js);
    }

    function checkTarget() {
        if (checking) return;
        checking = true;
        show('opening target file for readback...');
        try { panel.SetURL(TARGET_URL); }
        catch (e) { show('target navigation failed: ' + e); }
        $.Schedule(2.0, readTarget);
        $.Schedule(3.0, readTarget);
    }

    function readTarget() {
        var js = "(function(){try{" +
            "if(location.protocol!=='file:'||!/deadlockwriteprobe-fe223f1d[.]txt$/i.test(location.pathname)){document.title='FILEWRITE|READBACK|WRONG_DOCUMENT';return;}" +
            "var b=document.body,t=b?(b.innerText||b.textContent||'').trim():'';" +
            "document.title=t==='" + MARKER + "'?'FILEWRITE|READBACK|CREATED':'FILEWRITE|READBACK|NO_MARKER';" +
            "}catch(e){document.title='FILEWRITE|READBACK|SCRIPT_ERROR';}})();void(0);";
        inject(js);
    }

    $.Schedule(2.0, tryWrite);
    $.Schedule(4.0, tryWrite);
    $.Schedule(7.0, checkTarget);
    $.Schedule(12.0, function () {
        show('final: readback=' + readback + '; attempts=' + attempts);
    });
})();
