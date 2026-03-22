'use strict';
/* ═══════════════════════════════════════════════════════════
   LUDO NEXUS — GAME ENGINE (FULLY FIXED)
═══════════════════════════════════════════════════════════ */

const BACKEND_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://ludoback.onrender.com';

const CANVAS_SIZE = 600;
const GRID = 15;
const CELL = CANVAS_SIZE / GRID; // 40px

const socket = io(BACKEND_URL, { transports: ['websocket','polling'] });

const PATH52 = [
  [1,6],[2,6],[3,6],[4,6],[5,6],
  [6,5],[6,4],[6,3],[6,2],[6,1],[6,0],
  [7,0],
  [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],
  [9,6],[10,6],[11,6],[12,6],[13,6],[14,6],
  [14,7],
  [14,8],[13,8],[12,8],[11,8],[10,8],[9,8],
  [8,9],[8,10],[8,11],[8,12],[8,13],[8,14],
  [7,14],
  [6,14],[6,13],[6,12],[6,11],[6,10],[6,9],
  [5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
  [0,7],
  [0,6],
];

const HOME_LANES = {
  red:    [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  blue:   [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  green:  [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
};

const SAFE_SET = new Set([0,8,13,21,26,34,39,47]);

const YARD_POS = {
  red:    [[1.5,1.5],[3.5,1.5],[1.5,3.5],[3.5,3.5]],
  blue:   [[10.5,1.5],[12.5,1.5],[10.5,3.5],[12.5,3.5]],
  green:  [[10.5,10.5],[12.5,10.5],[10.5,12.5],[12.5,12.5]],
  yellow: [[1.5,10.5],[3.5,10.5],[1.5,12.5],[3.5,12.5]],
};

const FINISH_POS = [[7.2,7.2],[7.8,7.2],[7.2,7.8],[7.8,7.8]];

const CLR = {
  red:    {fill:'#f43f5e',zone:'rgba(244,63,94,0.82)',  lane:'rgba(244,63,94,0.22)',  glow:'rgba(244,63,94,0.65)' },
  blue:   {fill:'#3b82f6',zone:'rgba(59,130,246,0.82)', lane:'rgba(59,130,246,0.22)', glow:'rgba(59,130,246,0.65)'},
  green:  {fill:'#10b981',zone:'rgba(16,185,129,0.82)', lane:'rgba(16,185,129,0.22)', glow:'rgba(16,185,129,0.65)'},
  yellow: {fill:'#f59e0b',zone:'rgba(245,158,11,0.82)', lane:'rgba(245,158,11,0.22)', glow:'rgba(245,158,11,0.65)'},
};

let mySocketId=null, myRoomCode=null, myPlayerId=null, gameState=null, selectedCount=3, animating=false;
let canvas, ctx, svgEl;
const tokenEls={}, tokenPos={};

const $  = id => document.getElementById(id);
const px = col => col*CELL + CELL/2;
const py = row => row*CELL + CELL/2;

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  $(id).classList.add('active');
}

let _tt;
function toast(msg,ms=2600){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),ms);}
function setErr(msg){$('lobby-error').textContent=msg;}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function tokenWorldXY(tok, color, idx) {
  if (tok.state==='yard')  { const [c,r]=YARD_POS[color][idx]; return [c*CELL,r*CELL]; }
  if (tok.state==='home')  { const [c,r]=FINISH_POS[idx]; return [c*CELL,r*CELL]; }
  if (tok.state==='onBoard') {
    const [c,r]=PATH52[tok.position%52];
    return [px(c)+(idx%2===0?-4:4), py(r)+(idx<2?-4:4)];
  }
  if (tok.state==='homeStretch') {
    const lane=HOME_LANES[color];
    const step=Math.min((tok.homeStep||1)-1,lane.length-1);
    return [px(lane[step][0]),py(lane[step][1])];
  }
  const [c,r]=YARD_POS[color][idx]; return [c*CELL,r*CELL];
}

function buildMovePath(from, to, color, idx) {
  const pts=[];
  if (from.state==='yard' && to.state==='onBoard') {
    pts.push([px(PATH52[to.position][0]),py(PATH52[to.position][1])]);
  } else if (from.state==='onBoard' && to.state==='onBoard') {
    let cur=from.position, end=to.position;
    for (let s=0;s<7;s++) { cur=(cur+1)%52; pts.push([px(PATH52[cur][0]),py(PATH52[cur][1])]); if(cur===end)break; }
  } else if (to.state==='homeStretch') {
    const lane=HOME_LANES[color];
    const fs=from.state==='homeStretch'?Math.min((from.homeStep||1)-1,lane.length-1):-1;
    const ts=Math.min((to.homeStep||1)-1,lane.length-1);
    for (let s=fs+1;s<=ts;s++) pts.push([px(lane[s][0]),py(lane[s][1])]);
  } else if (to.state==='home') {
    const [c,r]=FINISH_POS[idx]; pts.push([c*CELL,r*CELL]);
  }
  return pts.length?pts:[tokenWorldXY(to,color,idx)];
}

/* ── Lobby UI ────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
    b.classList.add('active'); $('tab-'+b.dataset.tab).classList.add('active'); setErr('');
  });
});
document.querySelectorAll('.pill').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
    b.classList.add('active'); selectedCount=parseInt(b.dataset.count);
  });
});
$('create-btn').addEventListener('click',()=>{const n=$('create-name').value.trim();if(!n){setErr('Please enter your name');return;}setErr('');socket.emit('createRoom',{playerName:n,maxPlayers:selectedCount});});
$('join-btn').addEventListener('click',()=>{const n=$('join-name').value.trim(),c=$('join-code').value.trim().toUpperCase();if(!n){setErr('Enter your name');return;}if(c.length<4){setErr('Enter room code');return;}setErr('');socket.emit('joinRoom',{playerName:n,roomCode:c});});
$('join-code').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');});
$('copy-btn').addEventListener('click',()=>navigator.clipboard.writeText(myRoomCode).then(()=>toast('Copied!')));
$('start-btn').addEventListener('click',()=>socket.emit('startGame'));
$('leave-waiting-btn').addEventListener('click',()=>{socket.emit('leaveRoom');sessionStorage.clear();showScreen('screen-lobby');});
$('quit-btn').addEventListener('click',()=>{if(confirm('Leave game?')){socket.emit('leaveRoom');sessionStorage.clear();location.reload();}});
$('play-again-btn').addEventListener('click',()=>{sessionStorage.clear();location.reload();});
$('roll-btn').addEventListener('click',()=>{
  if(!gameState||animating)return;
  if(gameState.currentPlayer!==myPlayerId||gameState.phase!=='roll')return;
  socket.emit('rollDice');
});

/* ── Socket events ───────────────────────────────────────── */
socket.on('connect',()=>{
  mySocketId=socket.id;
  // Use sessionStorage so each tab has its own isolated identity
  const savedRoom = sessionStorage.getItem('myRoomCode');
  const savedId   = sessionStorage.getItem('myPlayerId');
  if(savedRoom && savedId){
    myRoomCode = savedRoom;
    myPlayerId = savedId;
    socket.emit('rejoinRoom',{roomCode:savedRoom, oldPlayerId:savedId});
  }
});

socket.on('roomCreated',({roomCode,playerId,gameState:gs})=>{
  myRoomCode=roomCode; myPlayerId=playerId; gameState=gs;
  sessionStorage.setItem('myRoomCode', roomCode);
  sessionStorage.setItem('myPlayerId', playerId);
  $('display-code').textContent=roomCode; $('hud-code').textContent=roomCode;
  renderWaiting(gs); showScreen('screen-waiting');
});
socket.on('joinedRoom',({roomCode,playerId,gameState:gs})=>{
  myRoomCode=roomCode; myPlayerId=playerId; gameState=gs;
  sessionStorage.setItem('myRoomCode', roomCode);
  sessionStorage.setItem('myPlayerId', playerId);
  $('display-code').textContent=roomCode; $('hud-code').textContent=roomCode;
  renderWaiting(gs); showScreen('screen-waiting');
});
socket.on('playerJoined',({gameState:gs})=>{ gameState=gs; renderWaiting(gs); });
socket.on('joinError',({message})=>{ setErr(message); toast(message); });
socket.on('rejoinedRoom',({roomCode,playerId,gameState:gs})=>{
  myRoomCode=roomCode; myPlayerId=playerId; gameState=gs;
  sessionStorage.setItem('myRoomCode', roomCode);
  sessionStorage.setItem('myPlayerId', playerId);
  if(gs.phase==='waiting'){renderWaiting(gs);showScreen('screen-waiting');}
  else if(gs.phase!=='ended') launchGame(gs);
});
socket.on('gameStarted',({gameState:gs})=>{ gameState=gs; launchGame(gs); });
socket.on('gameUpdate',({gameState:gs,event})=>{ const prev=gameState; gameState=gs; handleEvent(event,prev,gs); });
socket.on('playerLeft',({gameState:gs,playerName})=>{
  gameState=gs; toast(`${playerName} left`);
  if(gs.phase!=='waiting'){renderHUD(gs);placeTokensStatic(gs);}else renderWaiting(gs);
});
socket.on('gameOver',({winner,gameState:gs})=>{ gameState=gs; renderHUD(gs); placeTokensStatic(gs); showWinner(winner); });
socket.on('error',({message})=>toast(message));

function launchGame(gs) {
  showScreen('screen-game');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    initCanvas();
    drawBoard();
    initSVGTokens(gs);
    placeTokensStatic(gs);
    renderHUD(gs);
  }));
}

/* ── Canvas init ─────────────────────────────────────────── */
function initCanvas() {
  const shell=document.getElementById('board-shell');
  canvas=$('game-canvas'); svgEl=$('token-svg');

  const body=document.querySelector('.game-body');
  const br=body.getBoundingClientRect();
  const availW=br.width-210-18-28;
  const availH=br.height-28;
  const size=Math.floor(Math.min(availW,availH,560,Math.max(availW,260)));

  shell.style.width=size+'px'; shell.style.height=size+'px';
  canvas.width=CANVAS_SIZE; canvas.height=CANVAS_SIZE;
  canvas.style.width=size+'px'; canvas.style.height=size+'px';
  svgEl.setAttribute('viewBox','0 0 '+CANVAS_SIZE+' '+CANVAS_SIZE);
  svgEl.style.width=size+'px'; svgEl.style.height=size+'px';
  ctx=canvas.getContext('2d');
  svgEl.style.pointerEvents='all';
  svgEl.removeEventListener('click',onSVGClick);
  svgEl.addEventListener('click',onSVGClick);
  window.removeEventListener('resize',onResize);
  window.addEventListener('resize',onResize);
  console.log('[Canvas] shell='+size+'px  CELL='+CELL);
}

function onResize() {
  if(!canvas||!$('screen-game').classList.contains('active'))return;
  initCanvas(); drawBoard();
  if(gameState){placeTokensStatic(gameState);renderHUD(gameState);}
}

/* ── Board drawing ───────────────────────────────────────── */
function drawBoard() {
  if(!ctx)return;
  const S=CANVAS_SIZE;
  ctx.fillStyle='#0d0f1a'; ctx.fillRect(0,0,S,S);
  ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=0.5;
  for(let i=0;i<=GRID;i++){
    ctx.beginPath();ctx.moveTo(i*CELL,0);ctx.lineTo(i*CELL,S);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i*CELL);ctx.lineTo(S,i*CELL);ctx.stroke();
  }
  drawZones(); drawPathCells(); drawLaneCells(); drawSafe(); drawCenter(); drawArrows();
}

function drawZones(){
  [{col:0,row:0,color:'red'},{col:9,row:0,color:'blue'},{col:9,row:9,color:'green'},{col:0,row:9,color:'yellow'}]
  .forEach(({col,row,color})=>{
    const c=CLR[color],x=col*CELL,y=row*CELL,w=6*CELL,p=CELL*0.6;
    ctx.fillStyle=c.zone; rr(x,y,w,w,CELL*0.35); ctx.fill();
    ctx.fillStyle='rgba(8,10,22,0.78)'; rr(x+p,y+p,w-p*2,w-p*2,CELL*0.22); ctx.fill();
    ctx.strokeStyle=c.fill+'55'; ctx.lineWidth=1.5; rr(x+p,y+p,w-p*2,w-p*2,CELL*0.22); ctx.stroke();
    ctx.save(); ctx.globalAlpha=0.08; ctx.fillStyle='#fff';
    ctx.font='900 '+(CELL*0.7)+'px Orbitron,monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(color.toUpperCase(),x+w/2,y+w/2); ctx.restore();
  });
}

function drawPathCells(){
  PATH52.forEach(([c,r])=>{
    const x=c*CELL+1,y=r*CELL+1,w=CELL-2;
    ctx.fillStyle='rgba(255,255,255,0.05)'; rr(x,y,w,w,3); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.09)'; ctx.lineWidth=0.5; rr(x,y,w,w,3); ctx.stroke();
  });
}

function drawLaneCells(){
  Object.entries(HOME_LANES).forEach(([color,cells])=>{
    const c=CLR[color];
    cells.forEach(([col,row])=>{
      const x=col*CELL+1,y=row*CELL+1,w=CELL-2;
      ctx.fillStyle=c.lane; rr(x,y,w,w,3); ctx.fill();
      ctx.strokeStyle=c.fill+'45'; ctx.lineWidth=0.5; rr(x,y,w,w,3); ctx.stroke();
    });
  });
}

function drawSafe(){
  SAFE_SET.forEach(i=>{
    const [c,r]=PATH52[i]; const x=c*CELL+CELL/2,y=r*CELL+CELL/2;
    ctx.save(); ctx.fillStyle='rgba(251,191,36,0.2)'; ctx.strokeStyle='rgba(251,191,36,0.5)'; ctx.lineWidth=1;
    starPath(x,y,CELL*0.27,CELL*0.12,6); ctx.fill(); ctx.stroke(); ctx.restore();
  });
}

function drawCenter(){
  const cx=CANVAS_SIZE/2,cy=CANVAS_SIZE/2,arm=CELL*2.4;
  [{color:'red',pts:[[cx,cy],[cx-arm,cy-arm],[cx+arm,cy-arm]]},
   {color:'blue',pts:[[cx,cy],[cx+arm,cy-arm],[cx+arm,cy+arm]]},
   {color:'green',pts:[[cx,cy],[cx+arm,cy+arm],[cx-arm,cy+arm]]},
   {color:'yellow',pts:[[cx,cy],[cx-arm,cy+arm],[cx-arm,cy-arm]]}]
  .forEach(t=>{
    ctx.beginPath(); ctx.moveTo(...t.pts[0]); ctx.lineTo(...t.pts[1]); ctx.lineTo(...t.pts[2]); ctx.closePath();
    ctx.fillStyle=CLR[t.color].fill+'bb'; ctx.fill();
  });
  ctx.save(); ctx.fillStyle='rgba(255,255,255,0.92)'; ctx.shadowColor='#fff'; ctx.shadowBlur=12;
  starPath(cx,cy,CELL*0.5,CELL*0.2,6); ctx.fill(); ctx.restore();
}

function drawArrows(){
  [{idx:0,color:'red',angle:0},{idx:13,color:'blue',angle:Math.PI/2},
   {idx:26,color:'green',angle:Math.PI},{idx:39,color:'yellow',angle:-Math.PI/2}]
  .forEach(({idx,color,angle})=>{
    const [c,r]=PATH52[idx]; const x=c*CELL+CELL/2,y=r*CELL+CELL/2,s=CELL*0.16;
    ctx.save(); ctx.translate(x,y); ctx.rotate(angle); ctx.fillStyle=CLR[color].fill+'cc';
    ctx.beginPath(); ctx.moveTo(s,0); ctx.lineTo(-s,-s*0.65); ctx.lineTo(-s,s*0.65); ctx.closePath(); ctx.fill(); ctx.restore();
  });
}

function rr(x,y,w,h,r){
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}
function starPath(cx,cy,or,ir,n){
  ctx.beginPath();
  for(let i=0;i<n*2;i++){const r=i%2===0?or:ir,a=(i*Math.PI/n)-Math.PI/2;
    i===0?ctx.moveTo(cx+r*Math.cos(a),cy+r*Math.sin(a)):ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a));}
  ctx.closePath();
}

/* ── SVG Tokens ──────────────────────────────────────────── */
const NS='http://www.w3.org/2000/svg';
const TOKEN_R=CELL*0.3;

function initSVGTokens(gs){
  svgEl.innerHTML='';
  const defs=document.createElementNS(NS,'defs');
  defs.innerHTML='<filter id="tk-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
  svgEl.appendChild(defs);
  gs.players.forEach(p=>{
    tokenEls[p.color]=[]; tokenPos[p.color]=[];
    p.tokens.forEach((tok,i)=>{
      const g=makeToken(p.color,i); svgEl.appendChild(g);
      tokenEls[p.color][i]=g;
      const [wx,wy]=tokenWorldXY(tok,p.color,i);
      tokenPos[p.color][i]={x:wx,y:wy}; setTXY(g,wx,wy);
    });
  });
}

function makeToken(color,idx){
  const g=document.createElementNS(NS,'g');
  g.setAttribute('class','token-group'); g.dataset.color=color; g.dataset.idx=idx;
  const r=TOKEN_R, fill=CLR[color].fill;
  const sh=document.createElementNS(NS,'circle');
  sh.setAttribute('r',r+2); sh.setAttribute('fill','rgba(0,0,0,0.4)'); sh.setAttribute('transform','translate(2,3)');
  const pulse=document.createElementNS(NS,'circle');
  pulse.setAttribute('class','pulse'); pulse.setAttribute('r',r+5);
  pulse.setAttribute('fill','none'); pulse.setAttribute('stroke',fill);
  pulse.setAttribute('stroke-width','2'); pulse.setAttribute('opacity','0');
  pulse.innerHTML='<animate attributeName="r" values="'+(r+4)+';'+(r+10)+';'+(r+4)+'" dur="1.2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0;0.7" dur="1.2s" repeatCount="indefinite"/>';
  const body=document.createElementNS(NS,'circle');
  body.setAttribute('class','body'); body.setAttribute('r',r); body.setAttribute('fill',fill);
  const hl=document.createElementNS(NS,'ellipse');
  hl.setAttribute('rx',r*0.38); hl.setAttribute('ry',r*0.2);
  hl.setAttribute('cx',-r*0.2); hl.setAttribute('cy',-r*0.27);
  hl.setAttribute('fill','rgba(255,255,255,0.28)');
  const txt=document.createElementNS(NS,'text');
  txt.setAttribute('text-anchor','middle'); txt.setAttribute('dominant-baseline','central');
  txt.setAttribute('fill','#fff'); txt.setAttribute('font-size',r*0.85);
  txt.setAttribute('font-family','Outfit,sans-serif'); txt.setAttribute('font-weight','700');
  txt.setAttribute('pointer-events','none'); txt.textContent=idx+1;
  g.append(sh,pulse,body,hl,txt);
  return g;
}

function setTXY(g,x,y){ g.setAttribute('transform','translate('+x.toFixed(1)+','+y.toFixed(1)+')'); }

function placeTokensStatic(gs){
  if(!svgEl||!gs)return;
  gs.players.forEach(p=>p.tokens.forEach((tok,i)=>{
    const g=tokenEls[p.color]?.[i]; if(!g)return;
    const [wx,wy]=tokenWorldXY(tok,p.color,i);
    tokenPos[p.color][i]={x:wx,y:wy}; setTXY(g,wx,wy);
  }));
  updateHighlights(gs);
}

function updateHighlights(gs){
  if(!gs)return;
  gs.players.forEach(p=>p.tokens.forEach((tok,i)=>{
    const g=tokenEls[p.color]?.[i]; if(!g)return;
    const pulse=g.querySelector('.pulse'), body=g.querySelector('.body');
    const can=tok.canMove&&p.id===myPlayerId;
    g.classList.toggle('can-move',can);
    if(pulse)pulse.setAttribute('opacity',can?'1':'0');
    if(body) body.setAttribute('filter',can?'url(#tk-glow)':'');
    g.style.pointerEvents=p.id===myPlayerId?'all':'none';
  }));
}

function onSVGClick(e){
  if(!gameState||animating)return;
  if(gameState.currentPlayer!==myPlayerId||gameState.phase!=='move')return;
  const g=e.target.closest('.token-group'); if(!g)return;
  const color=g.dataset.color, idx=parseInt(g.dataset.idx);
  const me=gameState.players.find(p=>p.id===myPlayerId);
  if(!me||me.color!==color||!me.tokens[idx]?.canMove)return;
  socket.emit('moveToken',{tokenIndex:idx});
}

function animateToken(color,ti,path,onDone){
  if(!path||!path.length){onDone?.();return;}
  const g=tokenEls[color][ti]; const STEP=170;
  let si=0, start=null;
  let fromX=tokenPos[color][ti].x, fromY=tokenPos[color][ti].y;
  function tick(ts){
    if(!start)start=ts;
    const t=Math.min((ts-start)/STEP,1);
    const e=t<0.5?2*t*t:-1+(4-2*t)*t;
    const [toX,toY]=path[si];
    setTXY(g, fromX+(toX-fromX)*e, fromY+(toY-fromY)*e);
    if(t>=1){
      tokenPos[color][ti]={x:toX,y:toY}; fromX=toX; fromY=toY; si++;
      if(si>=path.length){onDone?.();return;}
      start=null; requestAnimationFrame(tick); return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ── Events ──────────────────────────────────────────────── */
function handleEvent(event, prevGs, nextGs){
  if(!event){renderHUD(nextGs);placeTokensStatic(nextGs);return;}
  switch(event.type){
    case 'diceRolled':
      animateDice(event.value);
      $('dice-msg').textContent=event.playerName+' rolled '+event.value;
      addLog('<b>'+esc(event.playerName)+'</b> rolled <b>'+event.value+'</b>');
      // During 'animating' phase the server is about to auto-move — keep button disabled
      renderHUD(nextGs);
      updateHighlights(nextGs);
      break;
    case 'tokenMoved':
    case 'tokenKilled':{
      const {color,tokenIndex:ti}=event;
      const prevP=prevGs.players.find(p=>p.color===color);
      const nextP=nextGs.players.find(p=>p.color===color);
      if(!prevP||!nextP){renderHUD(nextGs);placeTokensStatic(nextGs);break;}
      const path=buildMovePath(prevP.tokens[ti],nextP.tokens[ti],color,ti);
      if(event.type==='tokenKilled'){
        addLog('<b>'+esc(event.killerName)+'</b> sent <b>'+esc(event.victimName)+'</b> home! 💀','kill');
        toast('💀 '+event.killerName+' eliminated '+event.victimName);
        sfx('kill');
      } else { addLog('<b>'+esc(event.playerName)+'</b> moved token '+(ti+1)); sfx('move'); }
      animating=true; $('roll-btn').disabled=true;
      animateToken(color,ti,path,()=>{
        if(event.type==='tokenKilled'){
          nextGs.players.forEach(np=>{
            if(np.color===color)return;
            const pp=prevGs.players.find(p=>p.color===np.color); if(!pp)return;
            np.tokens.forEach((ntk,ki)=>{
              if(pp.tokens[ki].state==='onBoard'&&ntk.state==='yard'){
                const [kx,ky]=tokenWorldXY(ntk,np.color,ki);
                tokenPos[np.color][ki]={x:kx,y:ky}; setTXY(tokenEls[np.color][ki],kx,ky);
              }
            });
          });
        }
        animating=false; renderHUD(nextGs); placeTokensStatic(nextGs);
      });
      break;
    }
    case 'turnSkipped':
      addLog('<b>'+esc(event.playerName)+'</b> — no valid moves');
      $('dice-msg').textContent='No moves — skipped';
      renderHUD(nextGs); placeTokensStatic(nextGs);
      break;
    default: renderHUD(nextGs); placeTokensStatic(nextGs);
  }
}

/* ── HUD ─────────────────────────────────────────────────── */
function renderHUD(gs){
  if(!gs)return;
  const cp=gs.players.find(p=>p.id===gs.currentPlayer);
  if(cp){
    $('tc-name').textContent=cp.name;
    $('tc-orb').style.background=CLR[cp.color].fill;
    $('tc-orb').style.boxShadow='0 0 18px '+CLR[cp.color].glow;
    $('tc-badge').classList.toggle('show',cp.id===myPlayerId);
  }
  // Disable roll button during: not my turn, not roll phase, animating, or animating phase from server
  const canRoll = gs.currentPlayer===myPlayerId
    && gs.phase==='roll'
    && !animating;
  $('roll-btn').disabled=!canRoll;

  // Show dice message for whose turn it is (helps everyone see the state)
  if (gs.phase === 'roll' || gs.phase === 'animating') {
    const isMe = gs.currentPlayer === myPlayerId;
    const name = gs.players.find(p=>p.id===gs.currentPlayer)?.name || '?';
    $('dice-msg').textContent = isMe ? 'Your turn — roll the dice!' : `${name}'s turn…`;
  }

  const cont=$('player-strips'); cont.innerHTML='';
  gs.players.forEach(p=>{
    const active=p.id===gs.currentPlayer, isMe=p.id===myPlayerId;
    const hc=p.tokens.filter(t=>t.state==='home').length;
    const c=CLR[p.color];
    const d=document.createElement('div');
    d.className='pstrip'+(active?' is-active':'');
    if(active){d.style.borderColor=c.fill+'65';d.style.boxShadow='0 0 10px '+c.fill+'40';}
    d.innerHTML='<div class="pstrip-dot" style="background:'+c.fill+';color:'+c.fill+'"></div><div class="pstrip-body"><div class="pstrip-name">'+esc(p.name)+'</div><div class="pstrip-home">🏠 '+hc+'/4</div></div>'+(isMe?'<div class="pstrip-you">YOU</div>':'');
    cont.appendChild(d);
  });
}

/* ── Waiting room ────────────────────────────────────────── */
function renderWaiting(gs){
  const grid=$('players-grid'); grid.innerHTML='';
  gs.players.forEach(p=>{
    const isMe=p.id===myPlayerId;
    const d=document.createElement('div');
    d.className='player-slot'+(isMe?' is-you':'');
    d.innerHTML='<div class="ps-swatch" style="background:'+CLR[p.color].fill+';box-shadow:0 0 8px '+CLR[p.color].fill+'55"></div><div class="ps-name">'+esc(p.name)+'</div>'+(p.isHost?'<div class="ps-tag">HOST</div>':'')+(isMe?'<div class="ps-tag">YOU</div>':'');
    grid.appendChild(d);
  });
  const me=gs.players.find(p=>p.id===myPlayerId);
  const iAmHost=me?.isHost===true;
  const btn=$('start-btn');
  btn.style.display=iAmHost?'flex':'none';
  btn.disabled=gs.players.length<2;
  $('wait-hint').textContent=gs.players.length>=gs.maxPlayers
    ?'Room full ('+gs.players.length+'/'+gs.maxPlayers+') — Ready!'
    :'Waiting… '+gs.players.length+'/'+gs.maxPlayers+' joined';
  console.log('[Waiting] myId='+myPlayerId+' isHost='+iAmHost+' players='+gs.players.length+'/'+gs.maxPlayers);
}

/* ── Dice animation ──────────────────────────────────────── */
const FACE_XFORM={1:'rotateY(0deg)',2:'rotateY(180deg)',3:'rotateY(-90deg)',4:'rotateY(90deg)',5:'rotateX(-90deg)',6:'rotateX(90deg)'};
function animateDice(val){
  const die=$('die'); die.classList.remove('rolling'); void die.offsetWidth;
  die.classList.add('rolling'); sfx('roll');
  setTimeout(()=>{ die.classList.remove('rolling'); die.style.transform=FACE_XFORM[val]||''; }, 860);
}

/* ── Log ─────────────────────────────────────────────────── */
function addLog(html,cls=''){
  const list=$('log-list'), li=document.createElement('li');
  li.className='log-item '+cls; li.innerHTML=html; list.prepend(li);
  while(list.children.length>40)list.removeChild(list.lastChild);
}

/* ── Winner ──────────────────────────────────────────────── */
function showWinner(winner){
  $('modal-winner-name').textContent=winner?.name||'?';
  burst($('confetti-burst'));
  $('winner-modal').classList.remove('hidden');
}
function burst(c){
  c.innerHTML='';
  const cols=['#6366f1','#10b981','#f59e0b','#f43f5e','#3b82f6','#a78bfa','#34d399'];
  for(let i=0;i<52;i++){
    const el=document.createElement('div'); el.className='cf';
    const a=Math.random()*360,d=80+Math.random()*180;
    el.style.cssText='background:'+cols[i%cols.length]+';--tx:'+Math.cos(a*Math.PI/180)*d+'px;--ty:'+(Math.sin(a*Math.PI/180)*d-50)+'px;--r:'+(Math.random()*720-360)+'deg;animation-delay:'+(Math.random()*0.25)+'s;animation-duration:'+(0.9+Math.random()*0.5)+'s;width:'+(5+Math.random()*8)+'px;height:'+(5+Math.random()*8)+'px;border-radius:'+(Math.random()>0.5?'50%':'2px');
    c.appendChild(el);
  }
}

/* ── SFX ─────────────────────────────────────────────────── */
let _ac;
function sfx(type){
  try{
    if(!_ac)_ac=new(window.AudioContext||window.webkitAudioContext)();
    if(_ac.state==='suspended')_ac.resume();
    const osc=_ac.createOscillator(),gain=_ac.createGain(),t=_ac.currentTime;
    osc.connect(gain); gain.connect(_ac.destination);
    if(type==='roll'){osc.type='square';osc.frequency.setValueAtTime(220,t);osc.frequency.exponentialRampToValueAtTime(660,t+0.14);osc.frequency.exponentialRampToValueAtTime(110,t+0.32);gain.gain.setValueAtTime(0.1,t);gain.gain.exponentialRampToValueAtTime(0.001,t+0.38);osc.start(t);osc.stop(t+0.38);}
    else if(type==='move'){osc.type='sine';osc.frequency.setValueAtTime(440,t);osc.frequency.exponentialRampToValueAtTime(880,t+0.09);gain.gain.setValueAtTime(0.09,t);gain.gain.exponentialRampToValueAtTime(0.001,t+0.16);osc.start(t);osc.stop(t+0.16);}
    else if(type==='kill'){osc.type='sawtooth';osc.frequency.setValueAtTime(440,t);osc.frequency.exponentialRampToValueAtTime(100,t+0.28);gain.gain.setValueAtTime(0.13,t);gain.gain.exponentialRampToValueAtTime(0.001,t+0.32);osc.start(t);osc.stop(t+0.32);}
  }catch(e){}
}
