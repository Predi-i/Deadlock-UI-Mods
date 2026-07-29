"use strict";
// mg_widgets_test.js - exercise the state-free helpers mg_games.js exposes on MG.Widgets
// (winPos / parsePx / squareFromPanel / makeNavBtn / setNavState), which chess and checkers both
// alias. They used to be duplicated per controller, where nothing could reach them; hosting them
// on MG.Widgets makes them the ONLY part of those two files a Node test can touch, so they get
// one. Run: node tools/mg_widgets_test.js
const fs=require("fs");
const created=[];
function panel(type,parent,id){
  const p={type,id,_text:"",classes:[],children:[],style:{},
    AddClass(c){this.classes.push(c);}, RemoveClass(c){this.classes=this.classes.filter(x=>x!==c);},
    SetHasClass(){}, IsValid:()=>true, SetPanelEvent(n,f){this["on_"+n]=f;}, DeleteAsync(){},
    RemoveAndDeleteChildren(){}, FindChildTraverse:()=>null, GetParent(){return this.parent||null;},
    SetImage(){}, SetAttributeString(){}, GetPositionWithinWindow(){ return this._wp; }};
  Object.defineProperty(p,"text",{get(){return this._text;},set(v){this._text=String(v);}});
  if(parent){ p.parent=parent; parent.children.push(p); }
  created.push(p); return p;
}
const $={CreatePanel:(t,p,id)=>panel(t,p,id), Schedule:()=>{}, Msg(){}, Warning(){}, DispatchEvent(){}};
$.MG={Sound:{play(){}}, Rules:{}, Api:{}, Net:{}};
new Function("$", fs.readFileSync("panorama/scripts/mg_games.js","utf8"))($);
const W=$.MG.Widgets;
if(!W){ console.log("MG keys:", Object.keys($.MG).join(",")); process.exit(2); }
let fails=0;
function ok(c,m){ if(!c){fails++;console.log("  FAIL "+m);} else console.log("  ok   "+m); }
// parsePx
ok(W.parsePx("60px")===60,"parsePx('60px')=60");
ok(W.parsePx("-12.5px")===-12.5,"parsePx negative float");
ok(W.parsePx("")===null && W.parsePx(null)===null,"parsePx rejects empty/non-string");
// winPos
const a=panel("Panel",null,"a"); a._wp={x:10,y:20};
ok(JSON.stringify(W.winPos(a))==='{"x":10,"y":20}',"winPos reads {x,y}");
const b=panel("Panel",null,"b"); b._wp=[7,8];
ok(JSON.stringify(W.winPos(b))==='{"x":7,"y":8}',"winPos reads array form");
const c=panel("Panel",null,"c"); c._wp={x:1e9,y:0};
ok(W.winPos(c)===null,"winPos rejects the FLT_MAX sentinel");
ok(W.winPos(null)===null,"winPos(null)=null");
// squareFromPanel
const cell=panel("Panel",null,"cell_42");
const child=panel("Panel",cell,"piece");
const grand=panel("Panel",child,"img");
ok(W.squareFromPanel(cell)===42,"squareFromPanel on the cell itself");
ok(W.squareFromPanel(grand)===42,"squareFromPanel walks up from a grandchild");
ok(W.squareFromPanel(panel("Panel",null,"cell_99"))===-1,"squareFromPanel rejects out-of-range");
ok(W.squareFromPanel(panel("Panel",null,"nope"))===-1,"squareFromPanel returns -1 with no cell");
// nav buttons
const parent=panel("Panel",null,"row");
let clicked=false;
const btn=W.makeNavBtn(parent,"<",()=>{clicked=true;});
ok(btn.type==="Button" && btn.classes.includes("mg-nav-btn"),"makeNavBtn creates a classed Button");
ok(btn.children.length===1 && btn.children[0]._text==="<","makeNavBtn labels it");
btn.on_onactivate(); ok(clicked,"makeNavBtn wires onactivate");
W.setNavState(btn,false); ok(btn.classes.includes("mg-nav-disabled"),"setNavState(false) disables");
W.setNavState(btn,true); ok(!btn.classes.includes("mg-nav-disabled"),"setNavState(true) enables");
W.setNavState(null,true); ok(true,"setNavState(null) is a no-op");
console.log(fails===0?"\nALL WIDGET HELPER CHECKS PASSED":"\n"+fails+" FAILURES");
process.exitCode = fails?1:0;
