/* =========================================================================
   graphshot ai — pure aim planner shared by the browser and the server.
   Depends on core.js globals only. Loaded before bots.js / ranked.js.
   ========================================================================= */
"use strict";

const skillOf = rating=>clamp(((rating||1000)-760)/640,0.08,1);

const fmt = v=>{
  if(!isFinite(v)) return "0";
  const s=v.toFixed(6);
  return s.replace(/\.?0+$/,"")||"0";
};

function aimCandidates(match,slot,skill){
  const L=localWorldFor(match,slot);
  const P=L.match.soldiers[slot];
  const targets=[];
  for(let i=0;i<L.match.soldiers.length;i++){
    const s=L.match.soldiers[i];
    if(i===slot||!s.alive) continue;
    const u=s.x-P.x, v=s.y-P.y;
    if(u>2.2) targets.push({slot:i,u,v,dist:u,world:match.soldiers[i]});
  }
  if(!targets.length) return {L,candidates:[],targets:[]};
  const errScale=(1-skill)*2.1;
  const candidates=[];
  const pickCount=skill>0.52?targets.length:Math.min(targets.length,3);
  const picked=shuffle(targets).slice(0,pickCount);
  for(const t of picked){
    const err=rand(-1,1)*errScale;
    const m=(t.v+err)/t.u;
    candidates.push({expression:`${fmt(m)}*x`,targetSlot:t.slot,kind:"line"});
    if(skill>0.2||Math.random()<0.5){
      const amps=[0.002,0.004,0.008,0.016,0.032];
      for(const amp of amps){
        const sgn=Math.random()<0.5?-1:1;
        candidates.push({
          expression:`${fmt(m)}*x+${fmt(sgn*amp)}*x*(x-${fmt(t.u)})`,
          targetSlot:t.slot,kind:"arc"
        });
      }
    }
  }
  // high-skill bots try a quadratic through two targets (one shot, two kills)
  if(skill>0.58&&targets.length>1){
    const pairs=[];
    for(let i=0;i<targets.length;i++) for(let j=i+1;j<targets.length;j++) pairs.push([targets[i],targets[j]]);
    for(const [t1,t2] of shuffle(pairs).slice(0,10)){
      if(Math.abs(t2.u-t1.u)<2.5) continue;
      const a=(t2.v-t1.v*(t2.u/t1.u))/(t2.u*(t2.u-t1.u));
      const b=(t1.v-a*t1.u*t1.u)/t1.u;
      if(!isFinite(a)||!isFinite(b)) continue;
      candidates.push({expression:`${fmt(a)}*x^2+${fmt(b)}*x`,targetSlot:t1.slot,secondSlot:t2.slot,kind:"pair"});
    }
  }
  return {L,candidates,targets};
}

/* Choose a shot for a bot. skill 0..1 controls error + how many candidates
   are actually evaluated. Returns a compiled-safe expression string. */
function chooseBotShot(match,slot,opts={}){
  const soldier=match.soldiers[slot];
  const skill=opts.skill!=null?opts.skill:skillOf(soldier.rating);
  const built=aimCandidates(match,slot,skill);
  if(!built||!built.candidates.length) return {expression:"0",targetSlot:null,expectedKills:0,skill};
  const candidates=built.candidates;
  let usable=candidates;
  if(skill<0.35) usable=shuffle(candidates).slice(0,2);
  else if(skill<0.65) usable=shuffle(candidates).slice(0,Math.min(8,candidates.length));
  // low-skill bots do not perfectly filter: they pick one of their wild tries.
  if(skill<0.3&&Math.random()<0.75){
    const c=choice(usable);
    return {expression:c.expression,targetSlot:c.targetSlot,expectedKills:0,skill,kind:c.kind};
  }
  let best=null;
  for(const c of usable){
    let res;
    try{ res=shotPath(match,slot,c.expression); }
    catch(e){ continue; }
    const hit=res.killed.filter(k=>k!==slot);
    let score=hit.length*12;
    if(c.targetSlot!=null&&hit.includes(c.targetSlot)) score+=6;
    if(c.kind==="pair"&&c.secondSlot!=null&&hit.includes(c.secondSlot)) score+=5;
    if(res.impact) score-=1.5;
    score-=Math.min(2,res.length/90);
    score+=rand(0,skill*2.5);
    if(!best||score>best.score) best={score,expression:c.expression,targetSlot:c.targetSlot,expectedKills:hit.length,kind:c.kind};
  }
  if(!best){
    const c=choice(candidates);
    return {expression:c.expression,targetSlot:c.targetSlot,expectedKills:0,skill,kind:c.kind};
  }
  return {expression:best.expression,targetSlot:best.targetSlot,expectedKills:best.expectedKills,skill,kind:best.kind};
}

/* deterministic-ish ready time for a bot */
function botReadyDelay(rating){
  const s=skillOf(rating);
  return Math.round(rand(3200,12000)+(1-s)*rand(3000,12000));
}
