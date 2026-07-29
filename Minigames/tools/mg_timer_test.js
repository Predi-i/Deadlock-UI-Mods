"use strict";
// mg_timer_test.js - the turn-timer bar's colour must SNAP to green when a fresh turn starts.
//
// Regression guard for a bug the maintainer hit in-game twice: "wait for the bar to go red, move,
// and the next turn opens red too". arm() writes an inline transition-duration LIST ("25s, 0.3s")
// for its two legs (transform + background-color). Once .mg-tt-anim is removed, the effective
// transition-property is the base rule's SINGLE background-color - which consumes that list's
// FIRST entry, so removing the red class while the stale list was still live handed the COLOUR
// 25 seconds and it crawled from red back to green. stop() and snapFull() now zero the duration
// BEFORE touching any class, and arm() restores a real one.
//
// This drives the real mg_games.js under a fake Panorama and asserts the ORDER of the writes,
// which is the part that actually matters and the part a screenshot can't show.
// Run: node tools/mg_timer_test.js
const fs=require("fs");
let log=[], recording=false;
function panel(type,parent,id){
  const st={};
  const p={type,id,_text:"",classes:[],children:[],
    style:new Proxy(st,{set(t,k,v){t[k]=v; if(recording)log.push("style."+String(k)+" = "+v); return true;},get(t,k){return t[k];}}),
    AddClass(c){if(!this.classes.includes(c))this.classes.push(c); if(recording)log.push("AddClass "+c);},
    RemoveClass(c){this.classes=this.classes.filter(x=>x!==c); if(recording)log.push("RemoveClass "+c);},
    SetHasClass(c,on){this.classes=this.classes.filter(x=>x!==c); if(on)this.classes.push(c);},
    IsValid:()=>true,SetPanelEvent(){},DeleteAsync(){},RemoveAndDeleteChildren(){},
    FindChildTraverse:()=>null,GetParent:()=>null,SetImage(){},SetAttributeString(){}};
  Object.defineProperty(p,"text",{get(){return this._text;},set(v){this._text=String(v);}});
  if(parent) parent.children.push(p); return p;
}
let pending=[];
const $={CreatePanel:(t,p,id)=>panel(t,p,id),Schedule:(d,f)=>pending.push({d,f}),Msg(){},Warning(){},DispatchEvent(){}};
$.MG={Sound:{play(){}},Rules:{},Api:{},Net:{}};
new Function("$",fs.readFileSync("panorama/scripts/mg_games.js","utf8"))($);
const W=$.MG.Widgets, host=panel("Panel",null,"host");
const t=W.createTurnTimer(host,{boardW:400});
function findFill(p){if(p.classes.includes("mg-tt-fill"))return p;for(const c of p.children){const r=findFill(c);if(r)return r;}return null;}
const fill=findFill(host);
const armOnly=()=>{const a=pending.filter(j=>j.d===0);pending=[];a.forEach(j=>j.f());};
let fails=0;
function check(c,m){ console.log((c?"  ok   ":"  FAIL ")+m); if(!c)fails++; }
// scenario A: turn goes red, then a new turn starts (the maintainer's report)
t.start(()=>{}); armOnly();
fill.SetHasClass("mg-tt-low",true); fill.SetHasClass("mg-tt-crit",true);
recording=true; log=[]; t.stop(); t.start(()=>{}); recording=false;
const firstDur=log.findIndex(l=>l.startsWith("style.transitionDuration"));
const lastRed=log.map((l,i)=>l==="RemoveClass mg-tt-crit"?i:-1).filter(i=>i>=0);
const zeroed=log.filter(l=>l==="style.transitionDuration = 0s").length;
console.log("scenario A: red -> new turn");
check(firstDur===0,"the very first write of the new turn is the duration");
check(zeroed===2,"both stop() and snapFull() zero it (got "+zeroed+")");
check(lastRed.every(i=>{ // every red-removal must be preceded by a 0s that is not yet overwritten
        const prior=log.slice(0,i).filter(l=>l.startsWith("style.transitionDuration")).pop();
        return prior==="style.transitionDuration = 0s"; }),
      "every red-class removal happens while duration is 0s");
check(!fill.classes.includes("mg-tt-crit") && !fill.classes.includes("mg-tt-low"),"new turn starts with no red/amber class");
// scenario B: arm() must restore a real drain, else the bar would not animate
armOnly();
check(fill.style.transitionDuration==="25s, 0.3s","arm() restores the 25s drain + 0.3s colour fade");
check(fill.classes.includes("mg-tt-anim"),"arm() re-adds mg-tt-anim");
// scenario C: durak's short Bito window
t.stop(); t.start(()=>{},10); armOnly();
check(fill.style.transitionDuration==="10s, 0.3s","a 10s budget arms as 10s, not the CSS 25s");
console.log(fails?("\n"+fails+" FAILURES"):"\nALL TIMER-BAR CHECKS PASSED");
process.exitCode=fails?1:0;
