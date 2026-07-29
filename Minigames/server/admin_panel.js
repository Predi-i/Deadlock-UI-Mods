/*
 * Browser admin panel assets for Pixel Battle.
 *
 * This file is concatenated into server/worker.js by tools/build_worker.js. The page
 * contains no credentials and receives no trusted identity from client-side code:
 * worker.core.js validates a signed GitHub OAuth session before serving any /admin route.
 */
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pixel Battle Admin</title>
  <link rel="stylesheet" href="/admin/style.css">
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">DEADLOCK MINIGAMES</p>
      <h1>Pixel Battle Admin</h1>
    </div>
    <div class="identity"><span id="adminLogin">Authenticating…</span><a href="/admin/logout">Sign out</a></div>
  </header>
  <main>
    <section class="panel canvas-panel">
      <div class="section-head">
        <div><h2>Canvas</h2><p id="canvasMeta">Loading current state…</p></div>
        <div class="toolbar">
          <button id="reloadCanvas" class="secondary">Reload</button>
          <button id="clearQueue" class="secondary">Clear queue</button>
          <button id="applyPixels" class="primary" disabled>Apply 0 pixels</button>
        </div>
      </div>
      <div class="canvas-nav">
        <div class="zoom-tools" aria-label="Canvas navigation">
          <button id="zoomOut" class="secondary zoom-button" type="button" title="Zoom out">−</button>
          <button id="zoomFit" class="secondary" type="button" title="Fit the complete map">Fit</button>
          <button id="zoomIn" class="secondary zoom-button" type="button" title="Zoom in">+</button>
          <span id="zoomLevel" class="zoom-level">100%</span>
          <button id="panMode" class="secondary" type="button" aria-pressed="false">Pan</button>
          <button id="inspectMode" class="secondary inspect-button" type="button" aria-pressed="false">Inspect pixel</button>
        </div>
        <div id="pixelCoords" class="pixel-coords">PIXEL -, -</div>
      </div>
      <div id="canvasShell" class="canvas-shell"><canvas id="canvas" width="512" height="256"></canvas></div>
      <div id="debugPanel" class="debug-panel" hidden>
        <div class="debug-copy">
          <p id="debugEyebrow" class="debug-eyebrow">INSPECTOR</p>
          <h3 id="debugTitle">Pixel details</h3>
          <div id="debugLines" class="debug-lines"></div>
        </div>
        <div id="debugActions" class="debug-actions"></div>
      </div>
      <div id="palette" class="palette" aria-label="Paint palette"></div>
      <p class="hint">Wheel zooms toward the cursor. Use Pan, Shift-drag, or middle-drag to move. Left-drag paints. Admin uploads do not spend a Steam account's pixel bank.</p>
    </section>

    <section class="panel log-panel">
      <div class="section-head">
        <div><h2>Action log</h2><p>Exact server-accepted changes, newest first.</p></div>
        <form id="searchForm" class="search">
          <input id="steamId" inputmode="numeric" autocomplete="off" placeholder="Steam32 ID (optional)">
          <button class="secondary" type="submit">Search</button>
          <button id="banUser" class="danger" type="button" disabled>Ban</button>
          <button id="unbanUser" class="secondary" type="button" disabled>Unban</button>
        </form>
      </div>
      <div id="logStatus" class="status"></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Pixels</th><th>State</th><th></th></tr></thead>
          <tbody id="actions"></tbody>
        </table>
      </div>
      <button id="moreActions" class="secondary more" hidden>Load more</button>
    </section>
  </main>
  <div id="toast" role="status" aria-live="polite"></div>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

const ADMIN_CSS = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0d12;color:#edf2f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,#1a2534 0,transparent 34rem),#0a0d12}
header{height:82px;padding:0 max(24px,calc((100vw - 1400px)/2));display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #27303c;background:#0c1017dd}
h1,h2,p{margin:0}h1{font-size:23px;letter-spacing:.01em}.eyebrow{color:#63d7bd;font-size:11px;font-weight:800;letter-spacing:.18em;margin-bottom:4px}
.identity{display:flex;gap:16px;align-items:center;color:#aab5c3;font-size:13px}.identity a{color:#63d7bd;text-decoration:none}
main{max-width:1400px;margin:0 auto;padding:28px 24px 48px;display:grid;gap:24px}.panel{background:#111720;border:1px solid #293341;border-radius:14px;box-shadow:0 18px 50px #0007;overflow:hidden}
.section-head{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #27303c}.section-head h2{font-size:17px}.section-head p,.hint{color:#8996a6;font-size:12px;margin-top:5px}
.toolbar,.search{display:flex;gap:9px;align-items:center}button,input{border:1px solid #354253;border-radius:8px;background:#19212c;color:#edf2f7;font:inherit;height:38px;padding:0 14px}
button{font-size:12px;font-weight:750;cursor:pointer}button:hover{border-color:#64748b}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:#24a98b;border-color:#38c9a9;color:#04120f}.secondary{background:#18202b}
  input{width:220px;outline:none}input:focus{border-color:#63d7bd}.canvas-nav{margin:18px 22px 10px;display:flex;align-items:center;justify-content:space-between;gap:12px}.zoom-tools{display:flex;align-items:center;gap:8px}.zoom-button{width:42px;padding:0;font-size:21px;line-height:1}.zoom-level{min-width:64px;padding:6px 9px;border-radius:7px;background:#0c1118;border:1px solid #293747;color:#85e1ca;text-align:center;font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace}.pixel-coords{color:#9aabba;font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.05em}.canvas-shell{height:min(72vh,820px);min-height:420px;margin:0 22px 16px;overflow:auto;border:1px solid #394758;background:#080b10;padding:12px;border-radius:10px;overscroll-behavior:contain;scrollbar-color:#43556a #101720}
  canvas{display:block;max-width:none;image-rendering:pixelated;cursor:crosshair;background:#183443;touch-action:none;user-select:none}.canvas-shell.pan-mode canvas{cursor:grab}.canvas-shell.panning canvas{cursor:grabbing}.canvas-shell.inspect-mode canvas{cursor:help}.canvas-shell.pan-mode{border-color:#4f9d8b;box-shadow:inset 0 0 0 1px #4f9d8b44}.canvas-shell.inspect-mode{border-color:#5ca7dc;box-shadow:inset 0 0 0 1px #5ca7dc44}#panMode.active{background:#244b43;border-color:#5cc6aa;color:#b8ffeb}#inspectMode.active{background:#1c405b;border-color:#62b8ef;color:#c9ecff}
  [hidden]{display:none!important}.debug-panel{margin:0 22px 16px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:20px;border:1px solid #38506a;border-radius:10px;background:#0c131c}.debug-copy{min-width:0}.debug-eyebrow{color:#69bfea;font-size:10px;font-weight:800;letter-spacing:.15em;margin-bottom:4px}.debug-copy h3{font-size:16px}.debug-lines{display:flex;flex-wrap:wrap;gap:7px 16px;margin-top:8px;color:#9eacbb;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.debug-lines .important{color:#f3f7fb}.debug-lines .conflict{color:#ff8c95}.debug-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px}.debug-actions button{height:32px;padding:0 10px}.palette{display:flex;flex-wrap:wrap;gap:7px;padding:0 22px}.swatch{width:34px;height:34px;padding:0;border-radius:7px;position:relative}.swatch.selected{outline:2px solid #fff;outline-offset:2px}.swatch.eraser{background:repeating-linear-gradient(135deg,#d7dde5 0 7px,#687586 7px 14px)}
.swatch span{position:absolute;visibility:hidden}.hint{padding:14px 22px 20px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:12px 15px;border-bottom:1px solid #222c38;white-space:nowrap}th{color:#8290a1;font-size:10px;text-transform:uppercase;letter-spacing:.1em}td.actor{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.state-ok{color:#69d9bd}.state-undone{color:#f6bd60}.state-partial{color:#ff8f70}.row-actions{display:flex;gap:7px}.row-actions button{height:30px;padding:0 9px}.danger{border-color:#7d3d42;color:#ffacb3}.status{padding:12px 15px;color:#9aa7b6;font-size:12px}.more{margin:16px}
#toast{position:fixed;right:22px;bottom:22px;max-width:420px;padding:12px 15px;border-radius:9px;background:#18222d;border:1px solid #3a4a5d;box-shadow:0 12px 35px #0009;opacity:0;transform:translateY(8px);transition:opacity .15s,transform .15s;pointer-events:none;font-size:13px}
  #toast.show{opacity:1;transform:translateY(0)}@media(max-width:800px){header{padding:0 16px}.identity span{display:none}main{padding:16px}.section-head{align-items:flex-start;flex-direction:column}.toolbar,.search{width:100%;flex-wrap:wrap}input{flex:1}.canvas-nav{margin:14px;align-items:flex-start;flex-direction:column}.zoom-tools{flex-wrap:wrap}.canvas-shell{height:65vh;min-height:360px;margin:0 14px 14px}.debug-panel{margin:0 14px 14px;align-items:flex-start;flex-direction:column}.debug-actions{justify-content:flex-start}.palette{padding:0 14px}}`;

const ADMIN_JS = `"use strict";
(function(){
  var state=null,baseImage=null,pending=new Map(),selected=1,drawing=false,lastKey="",lastPaintPoint=null,cursor="",banState=null;
  var zoom=1,panMode=false,inspectMode=false,panning=false,panStart=null,preview=null,pulseRaf=null;
  var canvas=document.getElementById("canvas"),ctx=canvas.getContext("2d",{alpha:false});
  var shell=document.getElementById("canvasShell"),applyBtn=document.getElementById("applyPixels"),toast=document.getElementById("toast");
  function notify(message,bad){toast.textContent=message;toast.style.borderColor=bad?"#8d4249":"#3a4a5d";toast.classList.add("show");setTimeout(function(){toast.classList.remove("show");},2600);}
  async function api(path,options){
    options=options||{};options.headers=Object.assign({"X-MG-Admin":"1"},options.headers||{});
    if(options.body)options.headers["Content-Type"]="application/json";
    var response=await fetch(path,options),data=null;
    try{data=await response.json();}catch(e){}
    if(!response.ok)throw new Error(data&&data.error?data.error:"Request failed ("+response.status+")");
    return data;
  }
  function hex(rgb){return "#"+rgb.map(function(v){return v.toString(16).padStart(2,"0");}).join("");}
  function updateApply(){applyBtn.disabled=pending.size===0;applyBtn.textContent="Apply "+pending.size+" pixel"+(pending.size===1?"":"s");}
  function render(){
    ctx.imageSmoothingEnabled=false;
    if(baseImage)ctx.drawImage(baseImage,0,0,512,256);else{ctx.fillStyle="#183443";ctx.fillRect(0,0,512,256);}
    pending.forEach(function(color,key){var xy=key.split(","),x=+xy[0],y=+xy[1];if(color===0){ctx.fillStyle="#183443";ctx.fillRect(x,y,1,1);}else{ctx.fillStyle=hex(state.palette[color]);ctx.fillRect(x,y,1,1);}});
    if(preview&&preview.kind==="inspect"){ctx.fillStyle="#00e5ff";ctx.fillRect(preview.x,preview.y,1,1);}
    else if(preview&&preview.pixels&&state){
      var pulse=0.5+0.5*Math.abs(Math.sin(Date.now()/380));
      preview.pixels.forEach(function(p){
        if(!preview.force&&!p.revertible){ctx.fillStyle="#ff2446";}
        else{var rgb=state.palette[p.afterDisplay]||state.palette[0];ctx.fillStyle="rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+","+pulse+")";}
        ctx.fillRect(p.x,p.y,1,1);
      });
    }
    updateApply();
  }
  function loadImage(version){
    return new Promise(function(resolve,reject){var image=new Image();image.onload=function(){if(image.naturalWidth!==512||image.naturalHeight!==256){reject(new Error("Admin canvas must be exactly 512x256."));return;}baseImage=image;render();resolve();};image.onerror=reject;image.src="/admin/api/canvas?v="+version+"&rnd="+Math.random();});
  }
  function buildPalette(){
    var host=document.getElementById("palette");host.textContent="";
    state.palette.forEach(function(rgb,index){
      var button=document.createElement("button");button.type="button";button.className="swatch"+(index===selected?" selected":"")+(index===0?" eraser":"");
      if(index!==0)button.style.background=hex(rgb);button.title=state.paletteNames[index]||("Color "+index);
      button.innerHTML="<span>"+button.title+"</span>";button.addEventListener("click",function(){selected=index;buildPalette();});host.appendChild(button);
    });
  }
  async function loadState(){
    state=await api("/admin/api/state");document.getElementById("adminLogin").textContent="@"+state.admin;
    document.getElementById("canvasMeta").textContent="Version "+state.version+" · "+state.painted+" painted pixels · "+state.bans+" banned";
    buildPalette();await loadImage(state.version);
  }
  function point(event){
    var r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(511,Math.floor((event.clientX-r.left)*512/r.width))),y:Math.max(0,Math.min(255,Math.floor((event.clientY-r.top)*256/r.height)))};
  }
  function updateCoords(event){var p=point(event);document.getElementById("pixelCoords").textContent="PIXEL "+p.x+", "+p.y;return p;}
  function queuePixel(x,y){var key=x+","+y;if(key===lastKey)return;lastKey=key;pending.set(key,selected);}
  function paint(event){
    var p=updateCoords(event);
    if(!lastPaintPoint){queuePixel(p.x,p.y);}else{
      var dx=p.x-lastPaintPoint.x,dy=p.y-lastPaintPoint.y,steps=Math.max(Math.abs(dx),Math.abs(dy));
      if(!steps)queuePixel(p.x,p.y);
      for(var i=1;i<=steps;i++)queuePixel(Math.round(lastPaintPoint.x+dx*i/steps),Math.round(lastPaintPoint.y+dy*i/steps));
    }
    lastPaintPoint=p;render();
  }
  function fitWidth(){return Math.max(512,shell.clientWidth-24);}
  function setZoom(next,event){
    next=Math.max(1,Math.min(32,next));
    var oldRect=canvas.getBoundingClientRect(),rx=.5,ry=.5,clientX=0,clientY=0;
    if(event){clientX=event.clientX;clientY=event.clientY;rx=Math.max(0,Math.min(1,(clientX-oldRect.left)/oldRect.width));ry=Math.max(0,Math.min(1,(clientY-oldRect.top)/oldRect.height));}
    else{var sr=shell.getBoundingClientRect();clientX=sr.left+shell.clientWidth/2;clientY=sr.top+shell.clientHeight/2;rx=Math.max(0,Math.min(1,(clientX-oldRect.left)/oldRect.width));ry=Math.max(0,Math.min(1,(clientY-oldRect.top)/oldRect.height));}
    zoom=next;canvas.style.width=Math.round(fitWidth()*zoom)+"px";canvas.style.height=Math.round(fitWidth()*zoom/2)+"px";
    var newRect=canvas.getBoundingClientRect();
    shell.scrollLeft+=newRect.left+rx*newRect.width-clientX;
    shell.scrollTop+=newRect.top+ry*newRect.height-clientY;
    document.getElementById("zoomLevel").textContent=Math.round(zoom*100)+"%";
    document.getElementById("zoomOut").disabled=zoom<=1;document.getElementById("zoomIn").disabled=zoom>=32;
  }
  function fitCanvas(){zoom=1;canvas.style.width=fitWidth()+"px";canvas.style.height=Math.round(fitWidth()/2)+"px";shell.scrollLeft=0;shell.scrollTop=0;document.getElementById("zoomLevel").textContent="100%";document.getElementById("zoomOut").disabled=true;document.getElementById("zoomIn").disabled=false;}
  function setToolMode(mode){
    panMode=mode==="pan";inspectMode=mode==="inspect";
    shell.classList.toggle("pan-mode",panMode);shell.classList.toggle("inspect-mode",inspectMode);
    var pan=document.getElementById("panMode"),inspect=document.getElementById("inspectMode");
    pan.classList.toggle("active",panMode);pan.setAttribute("aria-pressed",panMode?"true":"false");
    inspect.classList.toggle("active",inspectMode);inspect.setAttribute("aria-pressed",inspectMode?"true":"false");
  }
  function stopPointer(){drawing=false;panning=false;panStart=null;lastKey="";lastPaintPoint=null;shell.classList.remove("panning");}
  canvas.addEventListener("pointerdown",function(e){
    if(inspectMode&&e.button===0){inspectPixel(updateCoords(e));e.preventDefault();return;}
    if(panMode||e.shiftKey||e.button===1){
      panning=true;panStart={x:e.clientX,y:e.clientY,left:shell.scrollLeft,top:shell.scrollTop};shell.classList.add("panning");canvas.setPointerCapture(e.pointerId);e.preventDefault();return;
    }
    if(e.button!==0)return;drawing=true;lastKey="";lastPaintPoint=null;canvas.setPointerCapture(e.pointerId);paint(e);e.preventDefault();
  });
  canvas.addEventListener("pointermove",function(e){
    updateCoords(e);
    if(panning&&panStart){shell.scrollLeft=panStart.left-(e.clientX-panStart.x);shell.scrollTop=panStart.top-(e.clientY-panStart.y);return;}
    if(drawing)paint(e);
  });
  canvas.addEventListener("pointerup",stopPointer);
  canvas.addEventListener("pointercancel",stopPointer);
  canvas.addEventListener("pointerleave",function(){if(!drawing&&!panning)document.getElementById("pixelCoords").textContent="PIXEL -, -";});
  canvas.addEventListener("contextmenu",function(e){e.preventDefault();});
  shell.addEventListener("wheel",function(e){if(!canvas.contains(e.target)&&e.target!==canvas)return;e.preventDefault();setZoom(e.deltaY<0?zoom*2:zoom/2,e);},{passive:false});
  document.getElementById("zoomOut").addEventListener("click",function(){setZoom(zoom/2);});
  document.getElementById("zoomIn").addEventListener("click",function(){setZoom(zoom*2);});
  document.getElementById("zoomFit").addEventListener("click",fitCanvas);
  document.getElementById("panMode").addEventListener("click",function(){setToolMode(panMode?"paint":"pan");});
  document.getElementById("inspectMode").addEventListener("click",function(){setToolMode(inspectMode?"paint":"inspect");});
  window.addEventListener("resize",function(){if(zoom===1)fitCanvas();});
  function focusBounds(bounds){
    if(!bounds)return;
    var span=Math.max(bounds[2]-bounds[0]+1,bounds[3]-bounds[1]+1),target=span<=4?32:(span<=16?16:(span<=48?8:(span<=128?4:2)));
    setZoom(target);
    var rect=canvas.getBoundingClientRect(),centerX=(bounds[0]+bounds[2]+1)/2,centerY=(bounds[1]+bounds[3]+1)/2;
    shell.scrollLeft=centerX/512*rect.width-shell.clientWidth/2+12;
    shell.scrollTop=centerY/256*rect.height-shell.clientHeight/2+12;
  }
  function debugButton(label,className,handler){
    var button=document.createElement("button");button.type="button";button.className=className||"secondary";button.textContent=label;button.addEventListener("click",handler);return button;
  }
  function showDebug(eyebrow,title,lines,buttons){
    var panel=document.getElementById("debugPanel"),lineHost=document.getElementById("debugLines"),actions=document.getElementById("debugActions");
    document.getElementById("debugEyebrow").textContent=eyebrow;document.getElementById("debugTitle").textContent=title;
    lineHost.textContent="";actions.textContent="";
    lines.forEach(function(line){var span=document.createElement("span");span.textContent=line.text||line;if(line.className)span.className=line.className;lineHost.appendChild(span);});
    buttons.forEach(function(button){actions.appendChild(debugButton(button.label,button.className,button.handler));});
    panel.hidden=false;
  }
  function clearPreview(){
    stopPulse();preview=null;render();document.getElementById("debugPanel").hidden=true;
  }
  // Action previews highlight the pixels a player actually PLACED (their after-colours), pulsing
  // so they stand out against the rest of the canvas. A rAF loop just re-renders while such a
  // preview is up; stopped whenever the preview is an inspect pixel or cleared.
  function startPulse(){if(pulseRaf)return;pulseRaf=requestAnimationFrame(function loop(){if(preview&&preview.pixels){render();pulseRaf=requestAnimationFrame(loop);}else{pulseRaf=null;}});}
  function stopPulse(){if(pulseRaf){cancelAnimationFrame(pulseRaf);pulseRaf=null;}}
  function actorName(action){
    return action.steamid?("Steam32 "+action.steamid):(action.admin?("@"+action.admin):action.actor);
  }
  function transitionSummary(pixels){
    if(!state)return "";
    var groups=new Map();
    pixels.forEach(function(p){var key=p.beforeDisplay+">"+p.afterDisplay;groups.set(key,(groups.get(key)||0)+1);});
    var out=[];groups.forEach(function(count,key){var pair=key.split(">"),before=state.paletteNames[+pair[0]]||pair[0],after=state.paletteNames[+pair[1]]||pair[1];out.push(before+" в†’ "+after+" Г-"+count);});
    return out.slice(0,8).join(" В· ");
  }
  function userActions(steamid){
    document.getElementById("steamId").value=steamid;loadActions(true);document.querySelector(".log-panel").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function banFromDebug(steamid){
    document.getElementById("steamId").value=steamid;loadBanState(steamid).then(function(){setBan(true);});
  }
  function applyActionPreview(data,force,shouldFocus){
    preview={kind:"action",pixels:data.pixels||[],force:!!force,data:data};startPulse();render();if(shouldFocus)focusBounds(data.bounds);
    var lines=[
      {text:actorName(data),className:"important"},
      {text:new Date(data.at).toLocaleString()},
      {text:"Action "+data.id},
      {text:"Placed: "+data.count+" pixel"+(data.count===1?"":"s"),className:"important"},
      {text:"Safe undo reverts: "+data.revertible+" pixel"+(data.revertible===1?"":"s")},
      {text:"Conflicts: "+data.conflicts,className:data.conflicts?"conflict":""}
    ];
    var transitions=transitionSummary(data.pixels||[]);if(transitions)lines.push({text:transitions});
    var buttons=[];
    if(data.conflicts)buttons.push({label:force?"Show safe scope":"Show force scope",className:"secondary",handler:function(){applyActionPreview(data,!force,false);}});
    if(data.steamid){
      buttons.push({label:"User actions",className:"secondary",handler:function(){userActions(data.steamid);}});
      buttons.push({label:"Ban user",className:"danger",handler:function(){banFromDebug(data.steamid);}});
    }
    if(data.kind==="paint"&&!data.undoneAt){
      buttons.push({label:"Undo",className:"secondary",handler:function(){undoAction(data.id,false);}});
      buttons.push({label:"Force undo",className:"danger",handler:function(){if(confirm("Force undo and overwrite "+data.conflicts+" conflicting pixels?"))undoAction(data.id,true);}});
    }
    buttons.push({label:"Clear preview",className:"secondary",handler:clearPreview});
    showDebug("PLACED PIXELS"+(data.conflicts&&force?" (FORCE SCOPE)":""),actorName(data)+" В· "+data.count+" pixels",lines,buttons);
  }
  async function previewAction(id){
    showDebug("ACTION PREVIEW","Loading "+id+"вЂ¦",[],[]);
    try{var data=await api("/admin/api/action?id="+encodeURIComponent(id));applyActionPreview(data,false,true);}catch(e){notify(e.message,true);clearPreview();}
  }
  async function inspectPixel(p){
    showDebug("PIXEL INSPECTOR","Inspecting "+p.x+", "+p.y+"вЂ¦",[],[]);
    try{
      var data=await api("/admin/api/pixel?x="+p.x+"&y="+p.y);stopPulse();preview={kind:"inspect",x:p.x,y:p.y};render();focusBounds([p.x,p.y,p.x,p.y]);
      var lines=[{text:"Color: "+data.colorName,className:"important"},{text:"Coordinate "+p.x+", "+p.y}],buttons=[];
      if(data.action){
        lines.push({text:"Last changed by "+actorName(data.action),className:"important"},{text:new Date(data.action.at).toLocaleString()},{text:"Action "+data.action.id});
        buttons.push({label:"Preview action",className:"primary",handler:function(){previewAction(data.action.id);}});
        if(data.action.steamid){
          buttons.push({label:"User actions",className:"secondary",handler:function(){userActions(data.action.steamid);}});
          buttons.push({label:"Ban user",className:"danger",handler:function(){banFromDebug(data.action.steamid);}});
        }
      }else{lines.push({text:"No recorded owner for this pixel.",className:"conflict"});}
      buttons.push({label:"Clear",className:"secondary",handler:clearPreview});
      showDebug("PIXEL INSPECTOR","Pixel "+p.x+", "+p.y,lines,buttons);
    }catch(e){notify(e.message,true);clearPreview();}
  }
  document.getElementById("clearQueue").addEventListener("click",function(){pending.clear();render();});
  document.getElementById("reloadCanvas").addEventListener("click",async function(){try{pending.clear();clearPreview();await loadState();notify("Canvas reloaded.");}catch(e){notify(e.message,true);}});
  applyBtn.addEventListener("click",async function(){
    if(!pending.size)return;applyBtn.disabled=true;
    var pixels=[];pending.forEach(function(color,key){var xy=key.split(",");pixels.push({x:+xy[0],y:+xy[1],color:color});});
    try{
      var applied=0;
      for(var i=0;i<pixels.length;i+=4096){var result=await api("/admin/api/paint",{method:"POST",body:JSON.stringify({pixels:pixels.slice(i,i+4096)})});applied+=result.changed;}
      pending.clear();clearPreview();await loadState();await loadActions(true);notify("Applied "+applied+" changed pixels.");
    }catch(e){notify(e.message,true);updateApply();}
  });
  function esc(text){return String(text).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
  function actionRow(action){
    var tr=document.createElement("tr"),stateText="Active",stateClass="state-ok";
    if(action.undoneAt){stateText=action.undoSkipped?"Partial undo":"Undone";stateClass=action.undoSkipped?"state-partial":"state-undone";}
    var actor=action.steamid||action.admin||"admin",kind=action.kind==="undo"?"Undo "+action.targetActionId:(action.kind==="ban"?"Ban"+(action.note?": "+action.note:""):(action.kind==="unban"?"Unban":(action.actor==="admin"?"Admin paint":"Player paint")));
    tr.innerHTML="<td>"+esc(new Date(action.at).toLocaleString())+"</td><td class=\\"actor\\">"+esc(actor)+"</td><td>"+esc(kind)+"</td><td>"+action.count+"</td><td class=\\""+stateClass+"\\">"+stateText+"</td><td><div class=\\"row-actions\\"></div></td>";
    var buttons=tr.querySelector(".row-actions");
    if(action.count>0){
      var previewButton=document.createElement("button");previewButton.className="secondary";previewButton.textContent="Preview";previewButton.onclick=function(){previewAction(action.id);};buttons.appendChild(previewButton);
    }
    if(action.actor==="player"&&!action.undoneAt){
      var undo=document.createElement("button");undo.className="secondary";undo.textContent="Undo";undo.onclick=function(){undoAction(action.id,false);};buttons.appendChild(undo);
      var force=document.createElement("button");force.className="danger";force.textContent="Force";force.title="Also overwrite pixels changed by later actions";force.onclick=function(){if(confirm("Force undo this action and overwrite newer pixels at the same coordinates?"))undoAction(action.id,true);};buttons.appendChild(force);
    }
    return tr;
  }
  async function undoAction(id,force){
    try{var result=await api("/admin/api/undo",{method:"POST",body:JSON.stringify({actionId:id,force:force})});clearPreview();await loadState();await loadActions(true);notify("Reverted "+result.changed+" pixels"+(result.skipped?"; skipped "+result.skipped+" newer changes":"")+".");}catch(e){notify(e.message,true);}
  }
  async function loadActions(reset){
    if(reset){cursor="";document.getElementById("actions").textContent="";}
    var steam=document.getElementById("steamId").value.trim(),path="/admin/api/actions?limit=50";
    if(steam)path+="&steamid="+encodeURIComponent(steam);if(cursor)path+="&before="+encodeURIComponent(cursor);
    document.getElementById("logStatus").textContent="Loading…";
    try{
      var data=await api(path),body=document.getElementById("actions");data.actions.forEach(function(a){body.appendChild(actionRow(a));});
      cursor=data.next||"";document.getElementById("moreActions").hidden=!cursor;
      document.getElementById("logStatus").textContent=data.actions.length?(steam?"Actions for "+steam:"All actions"):"No actions found.";
      if(reset)await loadBanState(steam);
    }catch(e){document.getElementById("logStatus").textContent=e.message;notify(e.message,true);}
  }
  async function loadBanState(steam){
    var ban=document.getElementById("banUser"),unban=document.getElementById("unbanUser");
    banState=null;ban.disabled=true;unban.disabled=true;
    if(!steam)return;
    var data=await api("/admin/api/ban-status?steamid="+encodeURIComponent(steam));
    banState=data;ban.disabled=data.banned;unban.disabled=!data.banned;
    if(data.banned)document.getElementById("logStatus").textContent="BANNED "+steam+(data.ban.reason?" · "+data.ban.reason:"");
  }
  async function setBan(banned){
    var steam=document.getElementById("steamId").value.trim();
    if(!steam)return;
    var reason="";
    if(banned){
      reason=prompt("Optional reason shown in the admin audit log:","")||"";
      if(!confirm("Ban Steam32 "+steam+" from Pixel Battle?"))return;
    }else if(!confirm("Unban Steam32 "+steam+"? The player must reload the mod before the button unlocks."))return;
    try{
      await api(banned?"/admin/api/ban":"/admin/api/unban",{method:"POST",body:JSON.stringify({steamid:steam,reason:reason})});
      await loadState();await loadActions(true);notify((banned?"Banned ":"Unbanned ")+steam+".");
    }catch(e){notify(e.message,true);}
  }
  document.getElementById("searchForm").addEventListener("submit",function(e){e.preventDefault();loadActions(true);});
  document.getElementById("banUser").addEventListener("click",function(){setBan(true);});
  document.getElementById("unbanUser").addEventListener("click",function(){setBan(false);});
  document.getElementById("moreActions").addEventListener("click",function(){loadActions(false);});
  fitCanvas();
  Promise.all([loadState(),loadActions(true)]).catch(function(e){notify(e.message,true);});
})();`;

function adminAssetResponse(path) {
  let body = "", type = "";
  if (path === "/admin" || path === "/admin/") {
    body = ADMIN_HTML;
    type = "text/html; charset=utf-8";
  } else if (path === "/admin/style.css") {
    body = ADMIN_CSS;
    type = "text/css; charset=utf-8";
  } else if (path === "/admin/app.js") {
    body = ADMIN_JS;
    type = "text/javascript; charset=utf-8";
  } else {
    return null;
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
}
