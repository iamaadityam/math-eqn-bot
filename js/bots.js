/* =========================================================================
   graphshot bots — ladder persistence, skill matchmaking, bot aim planner.
   ========================================================================= */
"use strict";

const STORE_KEYS={ladder:"gs-ladder-v1",profile:"gs-profile-v1",name:"gs-name-v1"};
const store={
  get(key,fallback){
    try{ const raw=localStorage.getItem(key); return raw?JSON.parse(raw):fallback; }catch(e){ return fallback; }
  },
  set(key,val){ try{ localStorage.setItem(key,JSON.stringify(val)); }catch(e){} },
  del(key){ try{ localStorage.removeItem(key); }catch(e){} }
};

const BOT_NAMES=[
  "euler","gauss","newton","noether","riemann","turing","lovelace","cantor",
  "hilbert","laplace","fourier","maxwell","galois","ramanujan","erdos","poincare",
  "archimedes","pythagoras","descartes","leibniz","cauchy","weierstrass","bolzano","lagrange",
  "jacobi","hamilton","abel","dirichlet","dedekind","kronecker","zeta","lhopital"
];

function defaultLadder(){
  return BOT_NAMES.map((name,i)=>({
    id:"bot-"+name,
    name,
    rating:760+i*26,             // 760 .. 1566
    matches:0,wins:0,kills:0,points:0,
    isBot:true
  }));
}
function defaultProfile(){
  return {id:"human",name:store.get(STORE_KEYS.name,"user"),rating:1000,matches:0,wins:0,kills:0,points:0,isBot:false};
}
function getLadder(){
  let l=store.get(STORE_KEYS.ladder,null);
  if(!Array.isArray(l)||!l.length){ l=defaultLadder(); store.set(STORE_KEYS.ladder,l); }
  return l;
}
function getProfile(){
  let p=store.get(STORE_KEYS.profile,null);
  if(!p||p.id!=="human"){ p=defaultProfile(); store.set(STORE_KEYS.profile,p); }
  const nm=store.get(STORE_KEYS.name,null);
  if(nm&&p.name!==nm){ p.name=nm; store.set(STORE_KEYS.profile,p); }
  return p;
}
function setName(name){
  const clean=String(name||"").trim().slice(0,20)||"user";
  store.set(STORE_KEYS.name,clean);
  const p=getProfile(); p.name=clean; store.set(STORE_KEYS.profile,p);
  return clean;
}
function getLeaderboard(){
  const rows=[getProfile(),...getLadder()].map((p,i)=>({...p}));
  rows.sort((a,b)=>b.rating-a.rating||b.wins-a.wins||b.kills-a.kills||a.name.localeCompare(b.name));
  rows.forEach((r,i)=>{ r.pos=i+1; r.me=!r.isBot; });
  return rows;
}

/* ------------------------------------------------------- skill matchmaking
   Pure function. Give it any number of participants and it returns lobbies.
   30s is a UI concern; this is the premade rating-snake algorithm.
   Every returned lobby is exactly 10 players. */
function skillMatchmake(participants, opts={}){
  const size=opts.size||CFG.RANKED_SIZE;
  const input=(participants||[]).filter(p=>p&&p.id);
  const seen=new Set(), uniq=[];
  for(const p of input){ if(seen.has(p.id)) continue; seen.add(p.id); uniq.push(p); }
  if(!uniq.length) return [];
  const lobbyCount=Math.max(1,Math.ceil(uniq.length/size));
  const sorted=uniq.slice().sort((a,b)=>(b.rating||1000)-(a.rating||1000));
  const lobbies=Array.from({length:lobbyCount},(_,i)=>({index:i,players:[],fill:[]}));
  // serpentine / snake draft keeps every lobby's average close
  sorted.forEach((p,i)=>{
    const round=Math.floor(i/lobbyCount), pos=i%lobbyCount;
    const idx=(round%2===0)?pos:lobbyCount-1-pos;
    lobbies[idx].players.push({...p});
  });
  const used=new Set(uniq.map(p=>p.id));
  for(const lobby of lobbies){
    const avg=lobby.players.reduce((a,p)=>a+(p.rating||1000),0)/Math.max(1,lobby.players.length);
    while(lobby.players.length<size){
      const bot=chooseBotNear(avg,used);
      used.add(bot.id);
      lobby.players.push({...bot});
      lobby.fill.push(bot.id);
    }
    lobby.avgRating=Math.round(lobby.players.reduce((a,p)=>a+(p.rating||1000),0)/lobby.players.length);
  }
  return lobbies;
}

let syntheticBot=0;
function chooseBotNear(avg,used){
  const pool=getLadder().filter(b=>!used.has(b.id)&&!b.me);
  if(pool.length){
    const sorted=pool.map(b=>({b,d:Math.abs(b.rating-avg)+rand(0,85)}))
      .sort((a,b)=>a.d-b.d);
    return sorted[0].b;
  }
  syntheticBot++;
  const rating=Math.round(clamp(avg+rand(-120,120),600,1800));
  return {id:"synthetic-"+syntheticBot,name:"bot "+syntheticBot,rating,matches:0,wins:0,kills:0,points:0,isBot:true};
}

/* Aim planner helpers (skillOf, chooseBotShot, botReadyDelay, …) live in
   js/ai.js so the browser and the authoritative server share one implementation. */
