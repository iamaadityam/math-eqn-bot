/* =========================================================================
   graphshot ui — DOM helpers, office chrome, practice + tutorial, drawing.
   ========================================================================= */
"use strict";

const $=id=>document.getElementById(id);
const cv=$("cv"), ctx=cv.getContext("2d"), W=cv.width, H=cv.height;
const X=x=>(x-CFG.XMIN)/(CFG.XMAX-CFG.XMIN)*W;
const Y=y=>(CFG.YMAX-y)/(CFG.YMAX-CFG.YMIN)*H;
const U=W/(CFG.XMAX-CFG.XMIN);
const inp=$("expr");
const terrainCv=document.createElement("canvas"); terrainCv.width=W; terrainCv.height=H;

const CLOCK={queueMs:30000,codeMs:120000,countdownMs:3000,fast:false};
try{
  const qs=new URLSearchParams(location.search);
  if(qs.get("fast")||qs.get("dev")){
    CLOCK.fast=true; CLOCK.queueMs=3000; CLOCK.codeMs=10000; CLOCK.countdownMs=1000;
  }
}catch(e){}

let M=null, trail=[], anim=null, view="home", tutIdx=0, practiceSnapshot=null, activeInput=null;
let phase="idle";                  // idle | queue | code | countdown | combat | result | practice | tutorial
let queueState=null, ranked=null;  // owned by ranked.js

const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtTime=ms=>{
  const t=Math.max(0,Math.ceil(ms/1000));
  return Math.floor(t/60)+":"+String(t%60).padStart(2,"0");
};

/* --------------------------------------------------------------- tiny bus */
const bus=new Map();
function onEvent(name,cb){
  if(!bus.has(name)) bus.set(name,new Set());
  bus.get(name).add(cb);
  return ()=>bus.get(name)?.delete(cb);
}
function emit(name,detail){
  try{ window.dispatchEvent(new CustomEvent("graphshot:"+name,{detail})); }catch(e){}
  const set=bus.get(name); if(set) for(const cb of [...set]){ try{ cb(detail); }catch(e){} }
}
function emitState(){
  if(window.GraphShot&&typeof GraphShot.getState==="function"){
    try{ emit("state",GraphShot.getState()); }catch(e){}
  }
}
function announcePhase(){
  emit("phase",{phase,state:(window.GraphShot&&GraphShot.getState)?GraphShot.getState():null});
  emitState();
}

/* --------------------------------------------------------------- screens */
const SCREENS=["home","queue","game","help","board"];
function show(id){
  SCREENS.forEach(s=>$(s).classList.toggle("hidden",s!==id));
  const el=$(id);
  if(!el) return;
  const wins=id==="home"?[...el.querySelectorAll(".win")]:[el];
  wins.forEach((w,i)=>{ w.classList.remove("pop"); w.style.animationDelay=(i*70)+"ms"; void w.offsetWidth; w.classList.add("pop"); });
  const labels={home:"desktop",queue:"matchmaker.exe",help:"help.txt",board:"leaderboards.dat"};
  $("tasklabel").textContent = id==="game" ? ($("gtitle").textContent+".exe") : (labels[id]||"desktop");
  window.scrollTo(0,0);
  if(id==="game"&&M) draw();
}

/* --------------------------------------------------------------- settings */
function readSettings(){
  const n=(id,lo,hi)=>{ const v=parseInt($(id).value); return clamp(isNaN(v)?lo:v,lo,hi); };
  const st={
    mode:$("s-mode").value,
    relative:$("s-rel").value==="rel",
    enemies:n("s-en",0,8),
    shields:n("s-sh",0,4),
    bots:n("s-bt",0,3),
    allies:n("s-al",0,12),
    obstacles:n("s-ob",0,14)
  };
  if(st.enemies+st.shields+st.bots===0) st.enemies=1;
  return st;
}
function getOptions(){ return readSettings(); }
function applyOptionsToDom(o={}){
  if(o.mode&&["normal","ode1","ode2"].includes(o.mode)) $("s-mode").value=o.mode;
  if(o.relative!=null) $("s-rel").value=o.relative?"rel":"abs";
  const set=(id,key,lo,hi)=>{ if(o[key]!=null&&isFinite(o[key])) $(id).value=clamp(Math.round(o[key]),lo,hi); };
  set("s-en","enemies",0,8); set("s-sh","shields",0,4); set("s-bt","bots",0,3);
  set("s-al","allies",0,12); set("s-ob","obstacles",0,14);
}
function setOptions(o={}){
  applyOptionsToDom(o);
  if(phase==="practice") startPractice(true);
  emitState();
  return getOptions();
}

/* ----------------------------------------------------------- practice mode */
function startPractice(newMap=true){
  if(newMap||!practiceSnapshot) practiceSnapshot=genMatch(readSettings());
  M=clone(practiceSnapshot);
  M.ranked=false;
  resetPracticeRuntime();
  loadPracticeMatch("Practice");
  setPracticeChrome();
}
function resetPracticeRuntime(){
  if(!M) return;
  trail=[]; fx=[];
  M.shots=0; M.friendly=0; M.over=false;
  M.terrain=clone(practiceSnapshot?practiceSnapshot.terrain:M.terrain);
  M.soldiers.forEach(s=>s.alive=true);
}
function loadPracticeMatch(title){
  trail=[]; fx=[];
  $("gtitle").textContent=title.toLowerCase();
  $("gwin").textContent=title.toLowerCase()+".exe";
  phase=title==="Tutorial"?"tutorial":"practice";
  inp.value=""; $("angle").value="0";
  buildFieldRows(); setMode(); renderTerrain(); setStatus("",""); $("fire").disabled=false;
  activeInput=inp; updateOffset(); updateStats();
  show("game"); draw();
  announcePhase();
}
function startTutorial(i){
  tutIdx=i;
  const L=TUTORIAL[i];
  M={mode:"normal",relative:false,options:{},shots:0,friendly:0,over:false,ranked:false,...clone(L.match)};
  loadPracticeMatch("Tutorial");
  $("settings").classList.add("hidden");
  $("tut").classList.remove("hidden");
  $("tut-title").textContent=L.title;
  $("tut-text").innerHTML=L.text;
  $("tut-hinttext").innerHTML=""; $("tut-next").disabled=true;
  $("tut-next").textContent = i===TUTORIAL.length-1 ? "Finish ✔" : "Next →";
  setPracticeChrome();
  $("settings").classList.add("hidden");
}
function setPracticeChrome(){
  $("settings").classList.toggle("hidden",phase==="tutorial");
  $("tut").classList.toggle("hidden",phase!=="tutorial");
  $("rankedhud").classList.add("hidden");
  $("practicelegend").classList.remove("hidden");
  $("rankedlegend").classList.add("hidden");
  $("fields").classList.toggle("hidden",!M.zones||!M.zones.some(z=>z.kind==="assist"));
  $("fire").textContent="fire!";
  $("fire").disabled=!!(M&&M.over);
  inp.disabled=false; $("angle").disabled=false;
}
function buildFieldRows(){
  const box=$("fieldrows"); box.innerHTML="";
  let n=0;
  (M.zones||[]).forEach((z,zi)=>{
    if(z.kind!=="assist") return; n++; z.label="A"+n;
    const row=document.createElement("div"); row.className="frow"; row.dataset.zone=zi;
    row.innerHTML='<b>'+esc(z.label)+'</b><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="none" placeholder="turn rate, e.g. 0.7  or  sin(x)">';
    const fi=row.querySelector("input");
    fi.addEventListener("focus",()=>{ activeInput=fi; });
    fi.addEventListener("keydown",e=>{ if(e.key==="Enter") fireAction(); });
    box.appendChild(row);
  });
  $("fields").classList.toggle("hidden",n===0||phase==="ranked");
}
function refreshFieldRows(){
  if(!M) return;
  document.querySelectorAll("#fieldrows .frow").forEach(r=>r.classList.toggle("down",!zoneLive(M,M.zones[+r.dataset.zone])));
}
function setMode(){
  if(!M) return;
  const lab={normal:"f(x) =",ode1:"y' =",ode2:"y'' ="}[M.mode]||"f(x) =";
  $("flabel").textContent=lab;
  $("angwrap").classList.toggle("hidden",M.mode!=="ode2"||M.ranked);
  const al=allowedFor(M.mode);
  const hasFields=(M.zones||[]).some(z=>z.kind==="assist");
  document.querySelectorAll("[data-needs]").forEach(b=>b.disabled=!(al.has(b.dataset.needs)||(hasFields&&b.dataset.needs==="y")));
}

/* ---------------------------------------------------------------- drawing */
function renderTerrain(){
  const t=terrainCv.getContext("2d"); t.clearRect(0,0,W,H);
  t.fillStyle="#141211"; t.strokeStyle="#141211"; t.lineWidth=1.5;
  for(const [cx,cy,r] of M.terrain.circles){ t.beginPath(); t.arc(X(cx),Y(cy),r*U,0,7); t.fill(); }
  t.globalCompositeOperation="destination-out";
  for(const [cx,cy,r] of M.terrain.craters){ t.beginPath(); t.arc(X(cx),Y(cy),r*U,0,7); t.fill(); }
  t.globalCompositeOperation="source-over";
}
const MONO='"Space Mono","IBM Plex Mono",Consolas,"Courier New",monospace';
const TEAM={player:["#ff732d","#141211","you"], ally:["#3fcf6b","#141211","ally"], enemy:["#3b5bff","#141211","enemy"]};
const KIND_LABEL={bot:"parry bot",shield:"shielded"};

function drawBaseField(){
  ctx.clearRect(0,0,W,H); ctx.fillStyle="#fbf7ec"; ctx.fillRect(0,0,W,H);
  ctx.lineWidth=1; ctx.font="11px "+MONO; ctx.fillStyle="#7c7463"; ctx.textAlign="center";
  for(let x=CFG.XMIN;x<=CFG.XMAX;x++){
    ctx.strokeStyle=x%5===0?"#cfc5a8":"#e9e1ca"; ctx.beginPath(); ctx.moveTo(X(x),0); ctx.lineTo(X(x),H); ctx.stroke();
    if(x%5===0&&x!==0) ctx.fillText(x,X(x),Y(0)+13);
  }
  ctx.textAlign="right";
  for(let y=CFG.YMIN;y<=CFG.YMAX;y++){
    ctx.strokeStyle=y%5===0?"#cfc5a8":"#e9e1ca"; ctx.beginPath(); ctx.moveTo(0,Y(y)); ctx.lineTo(W,Y(y)); ctx.stroke();
    if(y%5===0&&y!==0) ctx.fillText(y,X(0)-4,Y(y)+4);
  }
  ctx.strokeStyle="#141211"; ctx.lineWidth=1.6;
  ctx.beginPath(); ctx.moveTo(X(0),0); ctx.lineTo(X(0),H); ctx.moveTo(0,Y(0)); ctx.lineTo(W,Y(0)); ctx.stroke();
  if(M) ctx.drawImage(terrainCv,0,0);
}

function draw(upto){
  if(!M) return;
  if(M.ranked) drawRanked();
  else drawPractice(upto);
}
function drawPractice(upto){
  if(!M) return;
  drawBaseField();
  M.zones.forEach(z=>{
    if(!zoneLive(M,z)) return;
    const px=X(z.x), py=Y(z.y), rr=z.r*U;
    const col = z.kind==="perimeter"?["rgba(255,75,58,.13)","#e0301e"]: z.kind==="parry"?["rgba(154,107,255,.16)","#7a3cff"]:["rgba(63,207,107,.13)","#14883f"];
    ctx.fillStyle=col[0]; ctx.strokeStyle=col[1]; ctx.lineWidth=2; ctx.setLineDash(z.kind==="parry"?[]:[8,6]);
    ctx.beginPath(); ctx.arc(px,py,rr,0,7); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle=col[1]; ctx.font="bold 11px "+MONO; ctx.textAlign="center";
    ctx.fillText(z.kind==="perimeter"?"shield d/dx":z.kind==="parry"?"parry field":(z.label||"assist"),px,py+rr+12);
  });

  const n=upto===undefined?trail.length:upto;
  if(n>1){
    ctx.strokeStyle="#141211"; ctx.lineWidth=6; ctx.lineJoin="round"; ctx.lineCap="round"; ctx.beginPath();
    ctx.moveTo(X(trail[0][0]),Y(trail[0][1]));
    for(let i=1;i<n;i++) ctx.lineTo(X(trail[i][0]),Y(trail[i][1]));
    ctx.stroke();
    ctx.strokeStyle="#ff732d"; ctx.lineWidth=3; ctx.beginPath();
    ctx.moveTo(X(trail[0][0]),Y(trail[0][1]));
    for(let i=1;i<n;i++) ctx.lineTo(X(trail[i][0]),Y(trail[i][1]));
    ctx.stroke();
    if(upto!==undefined){ const hx=X(trail[n-1][0]), hy=Y(trail[n-1][1]);
      ctx.fillStyle="#141211"; ctx.beginPath(); ctx.arc(hx,hy,8,0,7); ctx.fill();
      ctx.fillStyle="#ffe2cf"; ctx.beginPath(); ctx.arc(hx,hy,4.5,0,7); ctx.fill(); }
  }
  ctx.textAlign="center"; ctx.font="bold 11px "+MONO;
  M.soldiers.forEach(s=>{
    const [fill,stroke,label]=TEAM[s.team], px=X(s.x), py=Y(s.y);
    if(!s.alive){
      ctx.strokeStyle="#141211"; ctx.lineWidth=3; ctx.beginPath();
      ctx.moveTo(px-7,py-7); ctx.lineTo(px+7,py+7); ctx.moveTo(px+7,py-7); ctx.lineTo(px-7,py+7); ctx.stroke(); return;
    }
    ctx.fillStyle=fill; ctx.strokeStyle=stroke; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(px,py,6,0,7); ctx.fill(); ctx.stroke();
    if(s.team==="enemy"){ ctx.beginPath(); ctx.arc(px,py,CFG.SOLDIER_R*U,0,7); ctx.strokeStyle="rgba(59,91,255,.5)"; ctx.lineWidth=1.5; ctx.stroke(); }
    const lab=KIND_LABEL[s.kind]||label; ctx.lineWidth=3; ctx.strokeStyle="#fbf7ec"; ctx.strokeText(lab,px,py-12); ctx.fillStyle="#141211"; ctx.fillText(lab,px,py-12);
  });
  drawFx();
}

/* hit effects (practice) */
let fx=[], fxRaf=null;
const FX_MS=750;
function addFx(x,y,color,big){ fx.push({x,y,color,big:!!big,t0:performance.now()}); if(!fxRaf) fxRaf=requestAnimationFrame(fxLoop); }
function fxLoop(now){ fx=fx.filter(f=>now-f.t0<FX_MS); if(M&&!M.ranked) drawPractice(); if(fx.length) fxRaf=requestAnimationFrame(fxLoop); else fxRaf=null; }
function drawFx(){
  const now=performance.now();
  fx.forEach(f=>{
    const k=Math.min(1,(now-f.t0)/FX_MS), e=1-Math.pow(1-k,3), px=X(f.x), py=Y(f.y), R=(f.big?3.2:1.8)*U*e;
    ctx.globalAlpha=1-k; ctx.strokeStyle="#141211"; ctx.lineWidth=5; ctx.beginPath(); ctx.arc(px,py,R,0,7); ctx.stroke();
    ctx.strokeStyle=f.color; ctx.lineWidth=2.5; ctx.beginPath(); ctx.arc(px,py,R,0,7); ctx.stroke();
    for(let i=0;i<10;i++){ const a=i/10*Math.PI*2+f.x, r0=R*.55, r1=R*1.15;
      ctx.beginPath(); ctx.moveTo(px+Math.cos(a)*r0,py+Math.sin(a)*r0); ctx.lineTo(px+Math.cos(a)*r1,py+Math.sin(a)*r1); ctx.stroke(); }
    ctx.globalAlpha=1;
  });
}
function shake(){ cv.classList.remove("shake"); void cv.offsetWidth; cv.classList.add("shake"); }

/* ------------------------------------------------------------ practice shot */
function firePractice(){
  if(anim||!M||M.over) return;
  let res;
  try{
    const f=compile(inp.value, allowedFor(M.mode));
    const fields={};
    document.querySelectorAll("#fieldrows .frow").forEach(r=>{
      const zi=+r.dataset.zone, txt=r.querySelector("input").value;
      if(!txt.trim()) return;
      try{ fields[zi]=compile(txt,new Set(["y"])); }catch(e){ throw new Error("Field "+M.zones[zi].label+": "+e.message); }
    });
    res=simulate(f,M,{angle:parseFloat($("angle").value)||0,fields,relative:!!M.relative,shooter:0});
  }catch(e){ setStatus("⚠ "+e.message,"err"); return; }
  M.shots++; trail=res.pts; updateStats();
  $("fire").disabled=true; setStatus("","");
  const t0=Date.now(), dur=Math.min(2200,600+trail.length*1.2);
  anim=setInterval(()=>{
    const k=Math.min(1,(Date.now()-t0)/dur), n=Math.max(2,Math.floor(k*trail.length));
    drawPractice(n);
    if(k<1) return;
    clearInterval(anim); anim=null; finishPracticeShot(res);
  },33);
}
function finishPracticeShot(res){
  let en=0, al=0;
  res.killed.forEach(i=>{ const s=M.soldiers[i]; s.alive=false; addFx(s.x,s.y,s.team==="enemy"?"#3b5bff":s.team==="ally"?"#3fcf6b":"#ff732d",true); if(s.team==="enemy") en++; else al++; });
  res.events.forEach(e=>addFx(e.x,e.y,e.kind==="perimeter"?"#e0301e":e.kind==="parry"?"#7a3cff":"#14883f",false));
  if(res.killed.length||res.selfHit) shake();
  M.friendly+=al;
  if(res.impact){ M.terrain.craters.push([res.impact[0],res.impact[1],CFG.CRATER_R]); renderTerrain(); addFx(res.impact[0],res.impact[1],"#141211",false); }
  $("fire").disabled=false; draw(); updateStats();

  const left=M.soldiers.filter(s=>s.team==="enemy"&&s.alive).length;
  refreshFieldRows();
  let msg="";
  const P0=M.soldiers[0];
  if(res.exit&&(res.exit.why==="top"||res.exit.why==="bottom")&&res.exit.x-P0.x<8&&res.events.length===0&&!res.killed.length){
    msg+="📈 Your curve shot off the "+res.exit.why+" of the map after only "+Math.max(0,res.exit.x-P0.x).toFixed(1)+" units — too steep. "+
      (M.relative?"":"<i>x</i> is the map's x-coordinate and you stand at x = "+P0.x+", so <code>5x^2</code> has slope "+(10*P0.x).toFixed(0)+" right at your feet. Use <code>(x+"+(-P0.x).toFixed(1)+")</code> to measure from yourself, or switch “x is measured from” to <b>the player</b>. ")+"<br>";
  }
  if(res.exit&&res.exit.why==="undefined"&&res.pts.length<3&&!res.killed.length) msg+="⚠ The function is undefined right after your soldier. ";
  const ev=k=>res.events.filter(e=>e.kind===k).length;
  if(ev("perimeter")) msg+="🛡 Shield triggered — your curve became its derivative. ";
  if(ev("assist")) msg+="🌀 Assist field"+(ev("assist")>1?"s":"")+" steered the shot ("+ev("assist")+"). ";
  if(ev("parry")) msg+="↩ Parry field bent your shot back! ";
  if(en) msg+="💥 "+en+(en>1?" enemies":" enemy")+" down. ";
  if(al) msg+="😬 Friendly fire: "+al+" ally down. ";
  if(!en&&!al&&!res.selfHit) msg+="Missed"+(isFinite(res.closest)?" — closest pass "+res.closest.toFixed(2)+" units from an enemy":"")+". ";
  if(res.impact) msg+="Hit an obstacle. ";

  if(res.selfHit){
    M.over=true; $("fire").disabled=true;
    setStatus(msg+"<br>☠ Your own shot came back and got you! Press <b>Retry map</b>.","err"); return;
  }
  if(left===0){
    M.over=true; $("fire").disabled=true;
    if(phase==="tutorial"){ setStatus(msg+"✔ Level clear!","ok"); $("tut-next").disabled=false; }
    else setStatus(msg+"<br>🎯 All enemies eliminated in "+M.shots+" shot"+(M.shots>1?"s":"")+"! Flag: <code>"+CFG.FLAG+"</code>","ok");
  } else setStatus(msg+left+(left>1?" enemies":" enemy")+" left.",(en||al)?"ok":"err");
}

/* -------------------------------------------------------------- misc UI */
function setStatus(html,cls){ const s=$("status"); s.innerHTML=html; s.className="status "+(cls||""); }
function updateStats(){
  if(!M){ $("stats").textContent=""; return; }
  if(M.ranked){
    const alive=M.soldiers.filter(s=>s.alive).length;
    $("stats").textContent=alive+" alive · 10-player lobby";
    return;
  }
  const P=M.soldiers[0], left=M.soldiers.filter(s=>s.team==="enemy"&&s.alive).length;
  $("stats").textContent="You ("+P.x+", "+P.y+") · Enemies left: "+left+" · Shots: "+M.shots;
}
function updateOffset(){
  const el=$("off");
  if(!M){ el.textContent=""; return; }
  if(M.ranked){
    if(M.mode!=="normal"){ el.textContent="y₀ = "+M.soldiers[rankedSlot()].y; return; }
    try{
      const slot=rankedSlot(), L=localWorldFor(M,slot), P=L.match.soldiers[slot];
      const f0=compile(inp.value||"0",allowedFor("normal"))(0,0,0);
      if(!isFinite(f0)) throw 0;
      const o=P.y-f0;
      el.textContent=(o<0?"- ":"+ ")+Math.abs(o).toFixed(3);
    }catch(e){ el.textContent="+ ?"; }
    return;
  }
  if(M.mode!=="normal"){ el.textContent = M.mode==="ode2" ? "y₀ = "+M.soldiers[0].y : "y₀ = "+M.soldiers[0].y; return; }
  try{
    const ox=M.relative?0:M.soldiers[0].x;
    const f0=compile(inp.value||"0",allowedFor("normal"))(ox,0,0);
    if(!isFinite(f0)) throw 0;
    const o=M.soldiers[0].y-f0;
    el.textContent=(o<0?"- ":"+ ")+Math.abs(o).toFixed(3);
  }catch(e){ el.textContent="+ ?"; }
}
function fireAction(){
  if(phase==="code"){ lockIn(); return; }
  firePractice();
}

/* ---------------------------------------------------------- leaderboard UI */
function renderLeaderboard(){
  const live=window.GraphShot&&GraphShot.getLeaderboard?GraphShot.getLeaderboard():null;
  const profileView=window.GraphShot&&GraphShot.getProfile?GraphShot.getProfile():null;
  const rows=Array.isArray(live)?live:getLeaderboard();
  const me=profileView||getProfile();
  $("boardbody").innerHTML=
    '<p style="font-size:12px;color:var(--mut);margin:0 0 10px">'+
    (NET.connected?'live server ladder':'offline ladder')+' · '+
    'you are <b>'+esc(me.name)+'</b> · '+esc(String(me.rating))+' rating · '+
    'matches '+me.matches+' · wins '+me.wins+'</p>'+
    '<table class="boardtable"><thead><tr><th>#</th><th>player</th><th>rating</th><th>matches</th><th>wins</th><th>kills</th><th>points</th></tr></thead><tbody>'+
    rows.map(r=>'<tr class="'+(r.me?"me":"")+'"><td>'+r.pos+'</td><td><span class="dot" style="background:'+
      (r.me?"#ff732d":r.isBot?"#b9b19c":"#3b5bff")+'"></span>'+esc(r.name)+
      (r.me?' <span class="tag you">you</span>':r.isBot?' <span class="tag bot">bot</span>':'')+
      '</td><td>'+r.rating+'</td><td>'+r.matches+'</td><td>'+r.wins+'</td><td>'+r.kills+'</td><td>'+r.points+'</td></tr>').join("")+
    '</tbody></table>';
}

/* --------------------------------------------------------------- controls */
inp.addEventListener("input",updateOffset);
inp.addEventListener("focus",()=>{ activeInput=inp; });
inp.addEventListener("keydown",e=>{ if(e.key==="Enter") fireAction(); });
$("fire").addEventListener("click",fireAction);

$("b-new").addEventListener("click",()=>{ if(anim) return; startPractice(true); });
$("b-retry").addEventListener("click",()=>{ if(anim) return; startPractice(false); });
$("s-mode").addEventListener("change",()=>{ if(!anim) startPractice(true); });
$("s-rel").addEventListener("change",()=>{ if(!anim) startPractice(true); });
for(const id of ["s-en","s-sh","s-bt","s-al","s-ob"]){
  $(id).addEventListener("change",()=>{ if(!anim) startPractice(true); });
}

$("tut-hint").addEventListener("click",()=>{
  $("tut-hinttext").innerHTML=" Try: <code>"+TUTORIAL[tutIdx].hint+"</code> ";
  inp.value=TUTORIAL[tutIdx].hint;
  (TUTORIAL[tutIdx].hintFields||[]).forEach((t,i)=>{ const f=document.querySelectorAll("#fieldrows .frow input")[i]; if(f) f.value=t; });
  updateOffset();
});
$("tut-next").addEventListener("click",()=>{
  if(tutIdx<TUTORIAL.length-1) startTutorial(tutIdx+1);
  else if(window.GraphShot&&GraphShot.navigate) GraphShot.navigate("home");
});

document.querySelectorAll(".pad button").forEach(b=>b.addEventListener("click",()=>{
  if(b.disabled) return;
  const t=(activeInput&&document.body.contains(activeInput))?activeInput:inp;
  const k=b.dataset.k, ins=b.dataset.i, s=t.selectionStart, e=t.selectionEnd;
  if(ins!==undefined){ t.setRangeText(ins,s,e,"end"); }
  else if(k==="clear"){ t.value=""; }
  else if(k==="back"){ if(s!==e) t.setRangeText("",s,e,"end"); else if(s>0) t.setRangeText("",s-1,s,"end"); }
  else if(k==="left"){ const p=Math.max(0,s-1); t.setSelectionRange(p,p); }
  else if(k==="right"){ const p=Math.min(t.value.length,e+1); t.setSelectionRange(p,p); }
  t.focus(); updateOffset();
}));

$("b-refresh-board").addEventListener("click",()=>{
  if(window.GraphShot&&GraphShot.refresh) GraphShot.refresh();
  renderLeaderboard(); emitState();
});

/* collapse + drag + clock */
document.querySelectorAll(".win .min").forEach(b=>b.addEventListener("click",e=>{ e.stopPropagation(); b.closest(".win").classList.toggle("collapsed"); }));
document.querySelectorAll("[data-drag]").forEach(w=>{
  const bar=w.querySelector(".tbar"); let sx,sy,ox=0,oy=0,on=false;
  bar.addEventListener("pointerdown",e=>{
    if(e.target.closest("button")||innerWidth<761) return;
    on=true; sx=e.clientX; sy=e.clientY; w.classList.add("dragging"); bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener("pointermove",e=>{ if(!on) return; w.style.translate=(ox+e.clientX-sx)+"px "+(oy+e.clientY-sy)+"px"; });
  const end=e=>{ if(!on) return; on=false; w.classList.remove("dragging"); ox+=e.clientX-sx; oy+=e.clientY-sy; };
  bar.addEventListener("pointerup",end); bar.addEventListener("pointercancel",end);
});
(function tick(){ $("clock").textContent=new Date().toTimeString().slice(0,8); setTimeout(tick,1000); })();

const glow=$("pointerglow");
addEventListener("pointermove",e=>{ if(!glow) return; glow.style.transform=`translate(${e.clientX}px,${e.clientY}px)`; glow.classList.add("on"); },{passive:true});
addEventListener("pointerleave",()=>{ if(glow) glow.classList.remove("on"); });

/* boot */
(function boot(){
  const el=$("boot"); let seen=false;
  try{ seen=sessionStorage.getItem("gs-boot")==="1"; }catch(e){}
  if(seen||matchMedia("(prefers-reduced-motion: reduce)").matches){ el.remove(); show("home"); return; }
  const lines=[...el.querySelectorAll(".l")]; let i=0, done=false, timer;
  const finish=()=>{ if(done) return; done=true; clearTimeout(timer); try{ sessionStorage.setItem("gs-boot","1"); }catch(e){}
    el.classList.add("out"); setTimeout(()=>el.remove(),400); show("home"); removeEventListener("keydown",finish); removeEventListener("pointerdown",finish); };
  const step=()=>{ if(i<lines.length){ lines[i++].classList.add("on"); timer=setTimeout(step,i===lines.length-1?420:170); } else timer=setTimeout(finish,500); };
  addEventListener("keydown",finish); addEventListener("pointerdown",finish); step();
})();
