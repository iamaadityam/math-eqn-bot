/* =========================================================================
   graphshot core — pure game logic, no DOM.
   Loaded as a classic script so it also works from file://.
   ========================================================================= */
"use strict";

const CFG = {
  XMIN:-25, XMAX:25, YMIN:-15, YMAX:15,
  SOLDIER_R: 0.7,
  CRATER_R: 1.1,
  STEP: 0.02,
  FLAG: "CTF{replace_me}",
  RANKED_SIZE: 10,
  BEAM_SPEED: 24,          // map units per second
  MAX_HEALTH: 100,
  HIT_DAMAGE: 34,          // < MAX_HEALTH: at least three clean hits to eliminate
  SPAWN_GAP: 6,            // no two cannons may spawn within this many units
  PLACEMENT: [300,220,160,110,70,40,25,15,10,5],
  ELO_K: 32
};

/* ------------------------------------------------------------------ random */
const rand = (a=0,b=1)=>a+Math.random()*(b-a);
const randInt = (a,b)=>Math.floor(rand(a,b+1));
const choice = arr=>arr[Math.floor(Math.random()*arr.length)];
function shuffle(arr){
  const a=arr.slice();
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const clone = o=>JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------- expression parser */
const FUNCS = {abs:Math.abs, ln:Math.log, log:Math.log10, sqrt:Math.sqrt,
               sin:Math.sin, cos:Math.cos, tan:Math.tan, exp:Math.exp};
const CONSTS = {pi:Math.PI, e:Math.E};
const NAMES = [...Object.keys(FUNCS),...Object.keys(CONSTS),"x","y","dy"].sort((a,b)=>b.length-a.length);

function tokenize(src){
  src = src.toLowerCase().replace(/y['′’]/g,"dy").replace(/π/g,"pi").replace(/√/g,"sqrt")
           .replace(/\*\*/g,"^").replace(/×/g,"*").replace(/÷/g,"/").replace(/−/g,"-").replace(/\s+/g,"");
  const out=[]; let i=0;
  while(i<src.length){
    const c=src[i];
    if(/[0-9.]/.test(c)){
      const m=/^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if(!m) throw new Error("Bad number near '"+src.slice(i,i+4)+"'");
      out.push({t:"num",v:parseFloat(m[0])}); i+=m[0].length;
    } else if(/[a-z]/.test(c)){
      const run=/^[a-z]+/.exec(src.slice(i))[0];
      const known=NAMES.find(k=>run.startsWith(k));
      if(!known) throw new Error("Unknown name '"+run+"'");
      out.push({t:(known in FUNCS)?"fn":"id",v:known}); i+=known.length;
    } else if("+-*/^()".includes(c)){ out.push({t:c}); i++; }
    else throw new Error("Unexpected character '"+c+"'");
  }
  return out;
}

function compile(src, allowed=new Set()){
  if(!src||!src.trim()) throw new Error("Type a function first");
  const T=tokenize(src); let p=0;
  const peek=()=>T[p], next=()=>T[p++];
  const startsValue=t=>t&&(t.t==="num"||t.t==="id"||t.t==="fn"||t.t==="(");
  const add=(a,b)=>(x,y,d)=>a(x,y,d)+b(x,y,d), sub=(a,b)=>(x,y,d)=>a(x,y,d)-b(x,y,d),
        mul=(a,b)=>(x,y,d)=>a(x,y,d)*b(x,y,d), div=(a,b)=>(x,y,d)=>a(x,y,d)/b(x,y,d);

  function expr(){
    let l=term();
    while(peek()&&(peek().t==="+"||peek().t==="-")){
      const op=next().t, r=term(); l = op==="+"?add(l,r):sub(l,r);
    }
    return l;
  }
  function term(){
    let l=unary();
    for(;;){
      const t=peek();
      if(t&&(t.t==="*"||t.t==="/")){ next(); const r=unary(); l = t.t==="*"?mul(l,r):div(l,r); }
      else if(startsValue(t)){ l=mul(l,unary()); }
      else break;
    }
    return l;
  }
  function unary(){
    const t=peek();
    if(t&&t.t==="-"){ next(); const a=unary(); return (x,y,d)=>-a(x,y,d); }
    if(t&&t.t==="+"){ next(); return unary(); }
    return power();
  }
  function power(){
    const base=atom();
    if(peek()&&peek().t==="^"){ next(); const e=unary(); return (x,y,d)=>Math.pow(base(x,y,d),e(x,y,d)); }
    return base;
  }
  function atom(){
    const t=next();
    if(!t) throw new Error("Expression ends too early");
    if(t.t==="num"){ const v=t.v; return ()=>v; }
    if(t.t==="id"){
      if(t.v==="x") return x=>x;
      if(t.v==="y"||t.v==="dy"){
        if(!allowed.has(t.v)) throw new Error("'"+(t.v==="y"?"y":"y'")+"' can't be used in this mode");
        return t.v==="y" ? (x,y)=>y : (x,y,d)=>d;
      }
      const v=CONSTS[t.v]; return ()=>v;
    }
    if(t.t==="fn"){
      if(!peek()||peek().t!=="(") throw new Error("Use parentheses: "+t.v+"(...)");
      next(); const a=expr();
      if(!peek()||next().t!==")") throw new Error("Missing ')'");
      const fn=FUNCS[t.v]; return (x,y,d)=>fn(a(x,y,d));
    }
    if(t.t==="("){
      const a=expr();
      if(!peek()||next().t!==")") throw new Error("Missing ')'");
      return a;
    }
    throw new Error("Unexpected '"+t.t+"'");
  }
  const f=expr();
  if(p<T.length) throw new Error("Unexpected '"+T[p].t+"'");
  return f;
}
const allowedFor = mode => new Set(mode==="normal"?[]:mode==="ode1"?["y"]:["y","dy"]);

/* ---------------------------------------------------------------- terrain */
function solidAt(T,x,y){
  let inside=false;
  for(const [cx,cy,r] of T.circles){ if((x-cx)*(x-cx)+(y-cy)*(y-cy)<=r*r){ inside=true; break; } }
  if(!inside) return false;
  for(const [cx,cy,r] of T.craters){ if((x-cx)*(x-cx)+(y-cy)*(y-cy)<=r*r) return false; }
  return true;
}
function clearOfTerrain(T,x,y,margin){
  return T.circles.every(([cx,cy,r])=>Math.hypot(x-cx,y-cy)>r+margin);
}
function genTerrain(s, avoid=[], x0=-12, x1=18){
  const circles=[];
  for(let i=0;i<s.obstacles;i++){
    let cx,cy,ok=false;
    for(let n=0;n<80&&!ok;n++){
      cx=rand(x0,x1); cy=rand(-11,11);
      ok = avoid.every(a=>Math.hypot(cx-a.x,cy-a.y)>3.4);
      if(ok) for(const [ox,oy,or] of circles) if(Math.hypot(cx-ox,cy-oy)<or+2.2) ok=false;
    }
    if(!ok) continue;
    const k=3+Math.floor(rand(0,3));
    for(let j=0;j<k;j++) circles.push([cx+rand(-1.4,1.4), cy+rand(-1.4,1.4), rand(0.8,1.7)]);
  }
  return {circles,craters:[]};
}

const ZR={perimeter:2.8, parry:2.3, assist:2.3, PARRY_OFFSET:3.2};
const NOTERR={circles:[],craters:[]};

/* --------------------------------------------------------- practice match */
function genMatch(opts){
  const s={enemies:2,shields:1,bots:1,allies:2,obstacles:5,mode:"normal",relative:false,...opts};
  if(s.enemies+s.shields+s.bots===0) s.enemies=1;
  const soldiers=[], zones=[];
  const place=(team,kind,x0,x1)=>{
    for(let n=0;n<700;n++){
      const x=+rand(x0,x1).toFixed(1), y=+rand(-12.5,12.5).toFixed(1);
      let z=null;
      if(kind==="shield") z={kind:"perimeter",x,y,r:ZR.perimeter};
      if(kind==="bot")    z={kind:"parry",x:+(x-ZR.PARRY_OFFSET).toFixed(1),y,r:ZR.parry};
      if(kind==="ally")   z={kind:"assist",x,y,r:ZR.assist};
      if(!clearOfTerrain(terrain,x,y,1.5)) continue;
      if(soldiers.some(o=>Math.hypot(o.x-x,o.y-y)<4.2)) continue;
      if(zones.some(q=>Math.hypot(q.x-x,q.y-y)<q.r+0.8)) continue;
      if(z&&soldiers.some(o=>Math.hypot(o.x-z.x,o.y-z.y)<z.r+0.8)) continue;
      if(z&&(z.x<CFG.XMIN+1||z.x>CFG.XMAX-1)) continue;
      soldiers.push({x,y,team,kind,alive:true});
      if(z){ z.owner=soldiers.length-1; zones.push(z); }
      return;
    }
  };
  const terrain=genTerrain({obstacles:s.obstacles},[{x:-20,y:0}]);
  place("player","player",-23,-17);
  for(let i=0;i<s.bots;i++)    place("enemy","bot",-1,22);
  for(let i=0;i<s.shields;i++) place("enemy","shield",-4,22);
  for(let i=0;i<s.allies;i++)  place("ally","ally",-22,18);
  for(let i=0;i<s.enemies;i++) place("enemy","normal",-6,23);
  return {mode:s.mode,relative:!!s.relative,options:s,terrain,soldiers,zones,shots:0,friendly:0,over:false,ranked:false};
}

/* ------------------------------------------------------------ shot engine */
function distPointSeg(px,py,ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay, l2=dx*dx+dy*dy;
  let t = l2? ((px-ax)*dx+(py-ay)*dy)/l2 : 0; t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}
const zoneLive=(M,z)=>M.soldiers[z.owner].alive;

/* generalized simulator.
   o.shooter : index of the firing soldier (default 0)
   o.relative: x in the equation = distance from the shooter
   o.bounds  : local x/y limits (ranked mirrors the world for left-facing shots)
   o.fields  : {zoneIndex: compiled fn(s, heading)} for assist fields */
function simulate(f0, M, o={}){
  const shooter=o.shooter||0, P=M.soldiers[shooter], mode=M.mode, h=CFG.STEP, MAXL=3;
  const B=o.bounds||{xmin:CFG.XMIN,xmax:CFG.XMAX,ymin:CFG.YMIN,ymax:CFG.YMAX};
  const ox=o.relative?P.x:0, f=(x,y,d)=>f0(x-ox,y,d);
  const pts=[[P.x,P.y]], killed=new Set(), events=[], used=new Set(), trig=new Set();
  let exit=null;
  const leave=(ax,ay,bx,by)=>{
    if(!isFinite(by)){ exit={why:"undefined",x:ax}; return; }
    let t=1;
    if(by>B.ymax) t=(B.ymax-ay)/(by-ay); else if(by<B.ymin) t=(B.ymin-ay)/(by-ay);
    if(bx>B.xmax) t=Math.min(t,(B.xmax-ax)/(bx-ax)); else if(bx<B.xmin) t=Math.min(t,(B.xmin-ax)/(bx-ax));
    t=Math.max(0,Math.min(1,t)); const ex=ax+t*(bx-ax), ey=ay+t*(by-ay);
    pts.push([ex,ey]); exit={why:by>B.ymax?"top":by<B.ymin?"bottom":"edge",x:ex};
  };
  let impact=null, closest=Infinity, offset=0, selfHit=false;
  let x=P.x, y=P.y, v=0;
  if(mode==="normal"){
    const f0v=f(P.x,0,0);
    if(!isFinite(f0v)) throw new Error("f(x) is undefined at the player's x ("+P.x+")");
    offset=P.y-f0v;
  } else if(mode==="ode1"){
    if(!isFinite(f(x,y,0))) throw new Error("y' is undefined at the player's position");
  } else {
    v=Math.tan((o.angle||0)*Math.PI/180);
    if(!isFinite(f(x,y,v))) throw new Error("y'' is undefined at the player's position");
  }
  let lv=[mode==="normal"?f(x,0,0)+offset:y], prev=lv.slice(), L=0, shift=0, by=y;
  for(let k=1;k<=MAXL;k++){ lv[k]=NaN; prev[k]=NaN; }
  let phase="func", zone=null, zi=-1, s=0, th=0, bounced=false;

  const hitTest=(ax,ay,bx,by2)=>{
    M.soldiers.forEach((sd,i)=>{
      if(!sd.alive||killed.has(i)) return;
      if(i===shooter&&!bounced) return;
      const d=distPointSeg(sd.x,sd.y,ax,ay,bx,by2);
      if(sd.team==="enemy"&&d<closest) closest=d;
      if(d<=CFG.SOLDIER_R){ killed.add(i); if(i===shooter) selfHit=true; }
    });
  };
  const fieldRate=(z,zIdx,sv,t,px,py)=>{
    let k;
    if(z.kind==="parry"){
      let d=Math.atan2(P.y-py,P.x-px)-t; d=Math.atan2(Math.sin(d),Math.cos(d)); k=6*d;
    } else { const g=o.fields&&o.fields[zIdx]; k=g?g(sv,t,0):0; }
    if(!isFinite(k)) return NaN;
    return Math.max(-20,Math.min(20,k));
  };
  const tryCatch=(ax,ay,bx,by2,heading)=>{
    for(let i=0;i<M.zones.length;i++){
      const z=M.zones[i]; if(z.kind==="perimeter"||used.has(i)||!zoneLive(M,z)) continue;
      if(Math.hypot(ax-z.x,ay-z.y)>z.r && Math.hypot(bx-z.x,by2-z.y)<=z.r){
        used.add(i); phase="field"; zone=z; zi=i; s=0; th=heading; bounced=true;
        events.push({kind:z.kind,zone:i,x:bx,y:by2}); return true;
      }
    }
    return false;
  };

  for(let n=0;n<7000;n++){
    let nx, ny;
    if(phase==="func"){
      nx=x+h; let nb;
      if(mode==="normal"){ nb=f(nx,0,0)+offset; }
      else if(mode==="ode1"){
        const k1=f(x,by,0), k2=f(x+h/2,by+h/2*k1,0), k3=f(x+h/2,by+h/2*k2,0), k4=f(x+h,by+h*k3,0);
        nb=by+h/6*(k1+2*k2+2*k3+k4);
      } else {
        const a1=v,           b1=f(x,by,v);
        const a2=v+h/2*b1,    b2=f(x+h/2,by+h/2*a1,v+h/2*b1);
        const a3=v+h/2*b2,    b3=f(x+h/2,by+h/2*a2,v+h/2*b2);
        const a4=v+h*b3,      b4=f(x+h,by+h*a3,v+h*b3);
        nb=by+h/6*(a1+2*a2+2*a3+a4); v=v+h/6*(b1+2*b2+2*b3+b4);
      }
      prev=lv.slice(); lv[0]=nb;
      for(let k=1;k<=MAXL;k++) lv[k]=(lv[k-1]-prev[k-1])/h;
      by=nb; ny=lv[L]+shift;
      // Keep tracing the curve even when it leaves the top/bottom of the map
      // (parabolas, high-degree polynomials) so the returning arc can still hit
      // a target. Only a non-finite value or the x edge ends the shot.
      if(!isFinite(ny)||nx>B.xmax){ leave(x,y,nx,ny); break; }
      hitTest(x,y,nx,ny);
      pts.push([nx,ny]);
      if(solidAt(M.terrain,nx,ny)){ impact=[nx,ny]; break; }
      for(let i=0;i<M.zones.length;i++){
        const z=M.zones[i]; if(z.kind!=="perimeter"||trig.has(i)||!zoneLive(M,z)||L>=MAXL) continue;
        if(Math.hypot(x-z.x,y-z.y)>z.r && Math.hypot(nx-z.x,ny-z.y)<=z.r){
          trig.add(i); L++; shift=ny-lv[L]; events.push({kind:"perimeter",zone:i,x:nx,y:ny});
          if(!isFinite(shift)) shift=NaN;
        }
      }
      const heading=Math.atan2(ny-y,nx-x);
      if(tryCatch(x,y,nx,ny,heading)){ x=nx; y=ny; continue; }
      x=nx; y=ny;
    }
    else if(phase==="field"){
      const k1=fieldRate(zone,zi,s,th,x,y), thm=th+k1*h/2;
      const k2=fieldRate(zone,zi,s+h/2,thm,x+Math.cos(th)*h/2,y+Math.sin(th)*h/2);
      if(!isFinite(k1)||!isFinite(k2)) break;
      nx=x+Math.cos(thm)*h; ny=y+Math.sin(thm)*h; th+=k2*h; s+=h;
      if(nx<B.xmin||nx>B.xmax||ny>B.ymax||ny<B.ymin){ leave(x,y,nx,ny); break; }
      hitTest(x,y,nx,ny); pts.push([nx,ny]);
      if(solidAt(M.terrain,nx,ny)){ impact=[nx,ny]; break; }
      x=nx; y=ny;
      if(Math.hypot(x-zone.x,y-zone.y)>zone.r||s>12) phase="free";
    }
    else {
      nx=x+Math.cos(th)*h; ny=y+Math.sin(th)*h;
      if(nx<B.xmin||nx>B.xmax||ny>B.ymax||ny<B.ymin){ leave(x,y,nx,ny); break; }
      hitTest(x,y,nx,ny); pts.push([nx,ny]);
      if(solidAt(M.terrain,nx,ny)){ impact=[nx,ny]; break; }
      const caught=tryCatch(x,y,nx,ny,th);
      x=nx; y=ny; if(caught) continue;
    }
  }
  return {pts,killed:[...killed],impact,closest,offset,events,selfHit,exit,offsetValue:offset};
}

/* -------------------------------------------------------------- tutorial */
const S=(x,y,team,kind)=>({x,y,team,kind:kind||(team==="player"?"player":team==="ally"?"ally":"normal"),alive:true});
const TUTORIAL=[
  { title:"1 / 7 — Shoot straight", text:"The orange soldier is you. Type <code>0</code> and press Fire — a flat line goes straight right and hits the blue enemy.",
    hint:"0", match:{mode:"normal",relative:false,terrain:NOTERR,zones:[],soldiers:[S(-20,0,"player"),S(5,0,"enemy")]} },
  { title:"2 / 7 — Add a slope", text:"The enemy is higher up. <code>0.3*x</code> is a line that rises 3 for every 10 to the right. The game shifts it so it starts at you (see the number on the right).",
    hint:"0.3*x", match:{mode:"normal",relative:false,terrain:NOTERR,zones:[],soldiers:[S(-20,0,"player"),S(0,6,"enemy")]} },
  { title:"3 / 7 — Get over the obstacle", text:"A dark obstacle blocks the straight path. Use an arch: <code>(x+20)*(x-8)</code> is zero at your x (−20) and at the enemy's x (8). Make it negative so it bulges up, and scale it so the peak clears the obstacle.",
    hint:"-0.0255*(x+20)*(x-8)", match:{mode:"normal",relative:false,terrain:{circles:[[-5,0,2],[-5,2,1.5],[-5,-2,1.5]],craters:[]},zones:[],soldiers:[S(-20,0,"player"),S(8,0,"enemy")]} },
  { title:"4 / 7 — One shot, many kills", text:"Shots don't stop at soldiers, so line up several. Both enemies sit on the same line — and keep away from the green ally!",
    hint:"0.3*x", match:{mode:"normal",relative:false,terrain:NOTERR,zones:[],soldiers:[S(-20,0,"player"),S(-5,4.5,"enemy"),S(10,9,"enemy"),S(-10,-5,"ally")]} },
  { title:"5 / 7 — The derivative shield", text:"The red circle is a <b>shield</b>. The moment your curve touches it, the curve is replaced by its <b>derivative</b> (its slope function) and carries on from the contact point. The derivative of a parabola is a straight line, so a steep parabola turns into a gentle line. Make the shot's <i>slope</i> point at the enemy rather than the curve itself.",
    hint:"0.006*(x+20)^2", match:{mode:"normal",relative:false,terrain:NOTERR,zones:[{kind:"perimeter",x:10,y:5,r:2.8,owner:1}],soldiers:[S(-20,0,"player"),S(10,5,"enemy","shield")]} },
  { title:"6 / 7 — Assist fields", text:"Your <b>ally</b> deploys a green <b>assist field</b>. If your shot enters it, the shot is caught and steered by the field's own equation (type it in the field box under the main input): the number it returns is how fast the shot turns, + = up/left. Aim a rising line into the field and make the field curl it upward to reach the enemy above.",
    hint:"0.4*x", hintFields:["0.7"], match:{mode:"normal",relative:false,terrain:NOTERR,zones:[{kind:"assist",x:-8,y:3,r:2.3,owner:1}],soldiers:[S(-20,0,"player"),S(-8,3,"ally"),S(-8,10,"enemy")]} },
  { title:"7 / 7 — The parry bot", text:"The purple circle is a <b>parry field</b> guarding the bot behind it. Anything that enters it is bent straight back at <i>you</i>. Don't go through it — arc over it and come down on the bot.",
    hint:"-0.05*(x+20)*(x-6)", match:{mode:"normal",relative:false,terrain:NOTERR,zones:[{kind:"parry",x:2.8,y:0,r:2.3,owner:1}],soldiers:[S(-20,0,"player"),S(6,0,"enemy","bot")]} }
];

/* ---------------------------------------------------------- ranked layout */
const RANKED_COLORS=["#ff732d","#3b5bff","#3fcf6b","#9a6bff","#ff4b3a","#00a6a6","#d13b8e","#8a5a2b","#2f6f9f","#7f8c2a"];
const RANKED_X_LEFT=[-21,-18,-15,-12,-9];
const RANKED_X_RIGHT=[21,18,15,12,9];
const RANKED_Y=[-11,-5.5,0,5.5,11];

function slotPose(slot){
  const left=slot<5, i=slot%5;
  return {x:left?RANKED_X_LEFT[i]:RANKED_X_RIGHT[i], y:RANKED_Y[i], dir:left?1:-1};
}
/* Every surviving soldier (player or bot) gets a fresh random spawn that is
   at least SPAWN_GAP apart from every other soldier on the board. */
function repositionSoldiers(match,minDistance=CFG.SPAWN_GAP){
  const aliveSlots=[...Array(match.soldiers.length).keys()]
    .filter(slot=>match.soldiers[slot].health!=null?match.soldiers[slot].health>0:true);
  const placed=[];
  for(const slot of aliveSlots){
    const soldier=match.soldiers[slot];
    const left=slot<5;
    let candidate=null;
    for(let attempt=0;attempt<2400;attempt++){
      const x=left?-2-Math.abs(1+Math.random()*19):(2+Math.abs(1+Math.random()*19));
      const y=+(Math.random()*24-12).toFixed(1);
      if(!clearOfTerrain(match.terrain,x,y,1.2)) continue;
      const nearest=placed.length?Math.min(...placed.map(p=>Math.hypot(p.x-x,p.y-y))):1e9;
      if(nearest>=minDistance){ candidate={x,y}; break; }
      if(!candidate||nearest>candidate.r) candidate={x,y,r:nearest};
    }
    if(!candidate) candidate={x:0,y:0,r:99};
    const pose={x:candidate.x,y:candidate.y,dir:left?1:-1};
    soldier.x=pose.x; soldier.y=pose.y; soldier.dir=pose.dir;
    placed.push({x:pose.x,y:pose.y});
  }
  for(const slot of aliveSlots) match.soldiers[slot].alive = match.soldiers[slot].health>0;
  return match;
}
function genRankedMatch(participants){
  const players=shuffle(participants).slice(0,CFG.RANKED_SIZE);
  const soldiers=[];
  for(let slot=0;slot<CFG.RANKED_SIZE;slot++){
    const p=players[slot]||{id:"bot-"+slot,name:"bot "+slot,rating:1000,isBot:true};
    const pose=slotPose(slot);
    soldiers.push({
      slot,id:p.id,name:p.name,rating:p.rating|0,isBot:!!p.isBot,
      team:"ffa",kind:p.isBot?"bot":"player",x:pose.x,y:pose.y,dir:pose.dir,
      alive:true,color:RANKED_COLORS[slot],expression:"",ready:false,lockAt:null,targetSlot:null,
      health:CFG.MAX_HEALTH,maxHealth:CFG.MAX_HEALTH,round:1,rounds:0
    });
  }
  const terrain=genTerrain({obstacles:randInt(4,7)},soldiers,-8,8);
  const match={
    ranked:true,id:"lobby-"+Date.now().toString(36),mode:"normal",relative:true,
    terrain,soldiers,zones:[],shots:0,friendly:0,over:false,
    phase:"code",createdAt:Date.now(),round:1,rounds:0,submissions:Array(CFG.RANKED_SIZE).fill(null),
    feed:[]
  };
  repositionSoldiers(match,CFG.SPAWN_GAP);
  return match;
}

/* mirrored local frame for a left-facing cannon.
   x' = 2*px - x, so the cannon always fires toward +x. */
function localWorldFor(match,slot){
  const P=match.soldiers[slot];
  if((P.dir||1)>=0){
    return {match,bounds:{xmin:CFG.XMIN,xmax:CFG.XMAX,ymin:CFG.YMIN,ymax:CFG.YMAX},toWorld:([x,y])=>[x,y]};
  }
  const fx=x=>2*P.x-x;
  const terrain={circles:match.terrain.circles.map(([x,y,r])=>[fx(x),y,r]),craters:match.terrain.craters.map(([x,y,r])=>[fx(x),y,r])};
  const soldiers=match.soldiers.map(s=>({...s,x:fx(s.x)}));
  const zones=match.zones.map(z=>({...z,x:fx(z.x)}));
  return {
    match:{...match,terrain,soldiers,zones},
    bounds:{xmin:2*P.x-CFG.XMAX,xmax:2*P.x-CFG.XMIN,ymin:CFG.YMIN,ymax:CFG.YMAX},
    toWorld:([x,y])=>[fx(x),y]
  };
}

function cumulative(pts){
  const cum=[0]; let total=0;
  for(let i=1;i<pts.length;i++){
    total+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);
    cum.push(total);
  }
  return {cum,total};
}

/* simulate one ranked shot and convert its path back to world coords. */
function shotPath(match,slot,expression,opts={}){
  const L=localWorldFor(match,slot);
  const allowed=allowedFor(match.mode||"normal");
  const f=compile(expression,allowed);
  const res=simulate(f,L.match,{
    shooter:slot,relative:true,bounds:L.bounds,
    angle:opts.angle||0,fields:opts.fields||null
  });
  const worldPts=res.pts.map(L.toWorld);
  const {cum,total}=cumulative(worldPts);
  return {
    slot,expression,angle:opts.angle||0,
    pts:worldPts,cum,length:total,pathEndAt:total/CFG.BEAM_SPEED,
    impact:res.impact?L.toWorld(res.impact):null,
    exit:res.exit,offset:res.offset,killed:res.killed,events:res.events
  };
}

/* first time a path enters a target's kill circle */
function circleFirstTime(pts,cum,tx,ty,r){
  for(let i=1;i<pts.length;i++){
    const ax=pts[i-1][0], ay=pts[i-1][1], bx=pts[i][0], by=pts[i][1];
    const dx=bx-ax, dy=by-ay, l2=dx*dx+dy*dy;
    const t0=l2?clamp(((tx-ax)*dx+(ty-ay)*dy)/l2,0,1):0;
    const d=Math.hypot(tx-(ax+t0*dx),ty-(ay+t0*dy));
    if(d>r) continue;
    // binary-search the earliest point on this segment inside the circle
    let lo=0, hi=t0;
    for(let k=0;k<18;k++){
      const m=(lo+hi)/2, px=ax+m*dx, py=ay+m*dy;
      if(Math.hypot(tx-px,ty-py)<=r) hi=m; else lo=m;
    }
    const segLen=Math.sqrt(l2);
    return (cum[i-1]+hi*segLen)/CFG.BEAM_SPEED;
  }
  return Infinity;
}

/* authoritative simultaneous resolution.
   All beams launch at t=0. Every cannon that is still standing may fire.
   Beams resolve chronologically, with hits sharing an instant landing together.
   A dead shooter's beam ends at the death instant, so later hits from it stop.
   Damage is applied per hit; health carries from round to round. */
function resolveRanked(match,submissions){
  const n=match.soldiers.length;
  const beams=Array(n).fill(null);
  const errors=Array(n).fill(null);
  const health=match.soldiers.map(s=>Number.isFinite(s.health)?s.health:CFG.MAX_HEALTH);
  const maxHealth=match.soldiers.map(s=>Number.isFinite(s.maxHealth)?s.maxHealth:CFG.MAX_HEALTH);
  const healthBefore=health.slice();
  const alive=health.map(h=>h>0);
  const damage=Array(n).fill(0);
  const hitEvents=[];
  for(let i=0;i<n;i++){
    const sub=submissions[i];
    if(health[i]<=0){ errors[i]="eliminated"; continue; }
    if(!sub||!sub.expression||!String(sub.expression).trim()){ errors[i]="no equation submitted"; continue; }
    try{
      beams[i]=shotPath(match,i,sub.expression,{angle:sub.angle,fields:sub.fields});
    }catch(e){ errors[i]=e.message; }
  }
  const deathAt=Array(n).fill(null);
  const killedBy=Array(n).fill(null);
  const kills=Array(n).fill(0);
  const hits=[];
  for(let i=0;i<n;i++){
    const b=beams[i]; if(!b) continue;
    for(let t=0;t<n;t++){
      if(t===i) continue;
      const s=match.soldiers[t];
      const time=circleFirstTime(b.pts,b.cum,s.x,s.y,CFG.SOLDIER_R);
      if(isFinite(time)&&time<=b.pathEndAt+1e-9 && health[t]>0){
        hits.push({shooter:i,target:t,time});
      }
    }
  }
  hits.sort((a,b)=>a.time-b.time);
  const events=[];
  const beamEnd=beams.map(b=>b?b.pathEndAt:0);
  let idx=0;
  while(idx<hits.length){
    const time=hits[idx].time;
    const batch=[];
    while(idx<hits.length && hits[idx].time-time<1e-7){ batch.push(hits[idx++]); }
    const atStart=health.map(h=>h>0);
    const landed=[];
    for(const h of batch){
      if(!atStart[h.shooter]||!atStart[h.target]) continue;
      if(time>beamEnd[h.shooter]+1e-9) continue;
      landed.push(h);
    }
    const killedNow=new Set();
    for(const h of landed){
      damage[h.target]+=CFG.HIT_DAMAGE;
      health[h.target]-=CFG.HIT_DAMAGE;
      hitEvents.push({time,target:h.target,shooter:h.shooter,amount:CFG.HIT_DAMAGE});
      if(atStart[h.target] && health[h.target]<=0 && deathAt[h.target]==null){
        deathAt[h.target]=time; killedBy[h.target]=h.shooter;
        killedNow.add(h.target);
      }
    }
    for(const h of landed){
      if(health[h.target]<=0) beamEnd[h.target]=Math.min(beamEnd[h.target],time);
    }
    for(const target of killedNow){
      kills[killedBy[target]]++;
      events.push({time,target,shooter:killedBy[target]});
    }
  }
  const endTime=Math.max(1,...beamEnd.filter((_,i)=>beams[i]));
  const survivors=[];
  const dead=[];
  for(let i=0;i<n;i++) (health[i]>0?survivors:dead).push(i);
  survivors.sort((a,b)=>kills[b]-kills[a]||damage[b]-damage[a]||match.soldiers[b].rating-match.soldiers[a].rating||a-b);
  dead.sort((a,b)=>(deathAt[b]??0)-(deathAt[a]??0)||kills[b]-kills[a]||damage[b]-damage[a]||a-b);
  const order=[...survivors,...dead];

  const rows=order.map((slot,rank)=>{
    const isAlive=health[slot]>0;
    const survived=isAlive?endTime:(deathAt[slot]??0);
    const points=kills[slot]*100+Math.floor(survived*3)+(CFG.PLACEMENT[rank]||0);
    return {
      slot,rank:rank+1,points,kills:kills[slot],
      alive:isAlive,survived,
      deathAt:deathAt[slot],killedBy:killedBy[slot],
      health:isAlive?health[slot]:0,
      healthBefore:healthBefore[slot],
      maxHealth:maxHealth[slot],
      damage:damage[slot],
      id:match.soldiers[slot].id,name:match.soldiers[slot].name,
      rating:match.soldiers[slot].rating,isBot:match.soldiers[slot].isBot,
      color:match.soldiers[slot].color,
      expression:submissions[slot]?submissions[slot].expression:"",
      error:errors[slot],delta:0,ratingAfter:match.soldiers[slot].rating
    };
  });

  // Elo vs. the rest of the lobby (actual = 1 for 1st ... 0 for last)
  const finalRows=applyElo(rows);
  return {
    endTime,beams,errors,events,alive:health.map(h=>h>0),deathAt,killedBy,kills,damage,health,
    healthBefore,maxHealth,hitEvents,winnerSlot:order[0],rankOf:Object.fromEntries(finalRows.map(r=>[r.slot,r.rank])),
    rows:finalRows
  };
}
function applyElo(rows){
  const n=rows.length;
  const finalRows=rows.map(r=>({...r}));
  for(const r of finalRows){
    const others=finalRows.filter(o=>o.slot!==r.slot);
    const avg=others.reduce((a,o)=>a+o.rating,0)/Math.max(1,others.length);
    const exp=1/(1+Math.pow(10,(avg-r.rating)/400));
    const actual=(n-r.rank)/(Math.max(1,n-1));
    r.delta=Math.round(CFG.ELO_K*(actual-exp));
    r.ratingAfter=r.rating+r.delta;
  }
  return finalRows;
}
