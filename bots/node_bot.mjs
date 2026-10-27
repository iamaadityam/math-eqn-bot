/** Example Graphshot bot in Node.js: authenticate, join round, launch and fire. */
const base = (process.env.GRAPSHOT_URL || 'http://localhost:3000').replace(/\/$/, '');
const botName = process.env.BOT_NAME || 'Node-ParabolaBot';
const equation = process.env.BOT_EQUATION || '-0.018*x^2 + 0.62*x';
const rctfToken = process.env.RCTF_AUTH_TOKEN || 'dev';

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  return body;
}

async function run() {
  console.log(`[*] Connecting to Graphshot server at ${base} as '${botName}'...`);

  // 1. Authenticate session
  const session = await api('/api/bot/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${rctfToken}` },
    body: JSON.stringify({ name: botName })
  });
  const headers = { authorization: `Bearer ${session.accessToken}` };
  console.log(`[+] Authenticated successfully for team: ${session.team || botName}`);

  // 2. Join current round
  try {
    const joinRes = await api('/api/rounds/current/join', { method: 'POST', headers });
    console.log(`[+] Reserved seat in round: ${joinRes.roundUid.slice(0, 8)}`);
  } catch (err) {
    console.log(`[!] Join notice: ${err.message}`);
  }

  // 3. Launch match or obtain active match
  let matchId = null;
  try {
    const launchRes = await api('/api/rounds/current/launch-now', { method: 'POST', headers });
    if (launchRes.matches && launchRes.matches[0]) {
      matchId = launchRes.matches[0];
      console.log(`[+] Launched match: ${matchId}`);
    }
  } catch (err) {
    console.log(`[!] Launch now info: ${err.message}`);
  }

  if (!matchId) {
    const me = await api('/api/me', { headers });
    matchId = me.activeMatchId;
  }

  if (!matchId) {
    console.error('[-] Could not find active match.');
    process.exit(1);
  }

  // 4. Submit programmed equation
  console.log(`[*] Submitting equation: '${equation}'`);
  const subRes = await api(`/api/matches/${matchId}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ equation })
  });
  console.log(`[+] Cannon locked in match ${matchId} (firesNow: ${subRes.firesNow})`);

  // 5. Poll for results
  console.log('[*] Waiting for volley resolution...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const view = await api(`/api/matches/${matchId}`, { headers });
    if (view.state === 'finished' && view.result) {
      console.log('\n=== MATCH RESULTS ===');
      const sorted = [...view.result.players].sort((a, b) => b.score - a.score);
      sorted.forEach((p, idx) => {
        const status = p.alive ? 'ALIVE' : 'ELIMINATED';
        console.log(`#${idx + 1} ${p.name.padEnd(20)} Score: ${String(p.score).padEnd(5)} Kills: ${String(p.kills).padEnd(3)} [${status}]`);
      });
      break;
    }
  }
}

run().catch(err => {
  console.error('[-] Bot error:', err);
  process.exit(1);
});
