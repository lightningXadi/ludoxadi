/* ═══════════════════════════════════════════════════════════
   LUDO NEXUS v2 — FRONTEND ENGINE
   Features:
   • Smooth cell-by-cell token animation via SVG + RAF
   • Full canvas board rendering
   • Real-time Socket.IO sync
   • 3D dice animation
   • Confetti winner burst
   • Sound via Web Audio API
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ── Backend URL ─────────────────────────────────────────── */
const BACKEND_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://ludoback.onrender.com'; // ← Update after deploying Render

const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

/* ═══════════════════════════════════════════════════════════
   BOARD GEOMETRY
   15×15 grid, CELL = boardSize/15
   52-cell clockwise path + 4 home lanes
═══════════════════════════════════════════════════════════ */

// The 52-cell main path as [col, row] in grid coords (0–14)
const PATH52 = [
  [1,6],[2,6],[3,6],[4,6],[5,6],          // 0–4   Red  → right
  [6,5],[6,4],[6,3],[6,2],[6,1],[6,0],     // 5–10  up col 6
  [7,0],                                   // 11    top mid
  [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],     // 12–17 down col 8
  [9,6],[10,6],[11,6],[12,6],[13,6],[14,6],// 18–23 right row 6
  [14,7],                                  // 24    right mid
  [14,8],[13,8],[12,8],[11,8],[10,8],[9,8],// 25–30 left row 8
  [8,9],[8,10],[8,11],[8,12],[8,13],[8,14],// 31–36 down col 8
  [7,14],                                  // 37    bot mid
  [6,14],[6,13],[6,12],[6,11],[6,10],[6,9],// 38–43 up col 6
  [5,8],[4,8],[3,8],[2,8],[1,8],[0,8],     // 44–49 left row 8
  [0,7],                                   // 50    left mid
  [0,6],                                   // 51    loops to 0
];

// Home finishing lanes (6 steps towards centre)
const HOME_LANES = {
  red:    [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  blue:   [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  green:  [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
};

// Entry index on PATH52 for each colour
const COLOR_START = { red:0, blue:13, green:26, yellow:39 };

// Safe cells (indices on PATH52)
const SAFE_SET = new Set([0,8,13,21,26,34,39,47]);

// Yard positions (fractional grid coords) for each colour × 4 tokens
const YARD_POSITIONS = {
  red:    [[1.5,1.5],[3.5,1.5],[1.5,3.5],[3.5,3.5]],
  blue:   [[10.5,1.5],[12.5,1.5],[10.5,3.5],[12.5,3.5]],
  green:  [[10.5,10.5],[12.5,10.5],[10.5,12.5],[12.5,12.5]],
  yellow: [[1.5,10.5],[3.5,10.5],[1.5,12.5],[3.5,12.5]],
};

// Center finish cluster
const HOME_CLUSTER = [
  [7.15,7.15],[7.85,7.15],[7.15,7.85],[7.85,7.85]
];

/* ── Visual colour map ──────────────────────────────────── */
const COLOR = {
  red:    { fill:'#f43f5e', glow:'rgba(244,63,94,0.6)',    zone:'rgba(244,63,94,0.82)',    lane:'rgba(244,63,94,0.22)' },
  blue:   { fill:'#3b82f6', glow:'rgba(59,130,246,0.6)',   zone:'rgba(59,130,246,0.82)',   lane:'rgba(59,130,246,0.22)' },
  green:  { fill:'#10b981', glow:'rgba(16,185,129,0.6)',   zone:'rgba(16,185,129,0.82)',   lane:'rgba(16,185,129,0.22)' },
  yellow: { fill:'#f59e0b', glow:'rgba(245,158,11,0.6)',   zone:'rgba(245,158,11,0.82)',   lane:'rgba(245,158,11,0.22)' },
};

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
let mySocketId   = null;
let myRoomCode   = null;
let myPlayerId   = null;
let gameState    = null;
let selectedCount= 3;
let animating    = false;   // block actions during animation
let canvas, ctx, svgEl;
let CELL = 40;              // px per grid cell, recalculated on resize

/* Token SVG elements: tokenEls[color][index] = <g> */
const tokenEls = {};
/* Previous token world-positions for animation */
const tokenPositions = {};

/* ═══════════════════════════════════════════════════════════
   UTILITY
═══════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
function qs(sel, root=document) { return root.querySelector(sel); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

let toastTimer;
function toast(msg, ms=2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function setErr(msg) { $('lobby-error').textContent = msg; }

/* ── Grid coord → canvas pixel ──────────────────────────── */
function gx(col) { return col * CELL + CELL * 0.5; }
function gy(row) { return row * CELL + CELL * 0.5; }

/* ── Token world position (canvas px) from state ────────── */
function tokenWorldPos(token, color, idx) {
  if (token.state === 'yard') {
    const [c,r] = YARD_POSITIONS[color][idx];
    return [c * CELL, r * CELL];
  }
  if (token.state === 'home') {
    const [c,r] = HOME_CLUSTER[idx];
    return [c * CELL, r * CELL];
  }
  if (token.state === 'onBoard') {
    const [c,r] = PATH52[token.position % 52];
    // Slight offset if stacked
    const ox = (idx % 2 === 0 ? -4 : 4);
    const oy = (idx < 2 ? -4 : 4);
    return [gx(c) + ox, gy(r) + oy];
  }
  if (token.state === 'homeStretch') {
    const lane = HOME_LANES[color];
    const step = Math.min((token.homeStep || 1) - 1, lane.length - 1);
    const [c,r] = lane[step];
    return [gx(c), gy(r)];
  }
  const yard = YARD_POSITIONS[color][idx];
  return [yard[0] * CELL, yard[1] * CELL];
}

/* ── Get sequence of intermediate positions for animation ── */
function getMovePath(fromState, toToken, color, idx) {
  const steps = [];
  // We reconstruct steps from dice value stored on token
  if (toToken.state === 'onBoard' && fromState.state === 'onBoard') {
    const fromPos = fromState.position;
    const toPos   = toToken.position;
    let cur = fromPos;
    while (cur !== toPos) {
      cur = (cur + 1) % 52;
      const [c,r] = PATH52[cur];
      steps.push([gx(c), gy(r)]);
    }
  } else if (toToken.state === 'onBoard' && fromState.state === 'yard') {
    // Coming out of yard — just direct
    const [c,r] = PATH52[toToken.position];
    steps.push([gx(c), gy(r)]);
  } else if (toToken.state === 'homeStretch') {
    const lane = HOME_LANES[color];
    const toStep = Math.min((toToken.homeStep||1)-1, lane.length-1);
    const fromStep = fromState.state === 'homeStretch'
      ? Math.min((fromState.homeStep||1)-1, lane.length-1)
      : -1;
    for (let s = fromStep + 1; s <= toStep; s++) {
      const [c,r] = lane[s];
      steps.push([gx(c), gy(r)]);
    }
  } else if (toToken.state === 'home') {
    const [c,r] = HOME_CLUSTER[idx];
    steps.push([c * CELL, r * CELL]);
  }
  return steps.length ? steps : [tokenWorldPos(toToken, color, idx)];
}

/* ═══════════════════════════════════════════════════════════
   LOBBY INTERACTIONS
═══════════════════════════════════════════════════════════ */

/* Tabs */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${tab}`).classList.add('active');
    setErr('');
  });
});

/* Player count pills */
document.querySelectorAll('.pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedCount = parseInt(btn.dataset.count);
  });
});

$('create-btn').addEventListener('click', () => {
  const name = $('create-name').value.trim();
  if (!name) { setErr('Please enter your name'); return; }
  setErr('');
  socket.emit('createRoom', { playerName: name, maxPlayers: selectedCount });
});

$('join-btn').addEventListener('click', () => {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name) { setErr('Please enter your name'); return; }
  if (code.length < 4) { setErr('Enter a valid room code'); return; }
  setErr('');
  socket.emit('joinRoom', { playerName: name, roomCode: code });
});

$('join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
});

$('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(myRoomCode).then(() => toast('Room code copied!'));
});

$('start-btn').addEventListener('click', () => socket.emit('startGame'));
$('leave-waiting-btn').addEventListener('click', () => { socket.emit('leaveRoom'); showScreen('screen-lobby'); });
$('quit-btn').addEventListener('click', () => {
  if (confirm('Leave the game?')) { socket.emit('leaveRoom'); location.reload(); }
});
$('play-again-btn').addEventListener('click', () => location.reload());

$('roll-btn').addEventListener('click', () => {
  if (!gameState || animating) return;
  if (gameState.currentPlayer !== myPlayerId) return;
  if (gameState.phase !== 'roll') return;
  socket.emit('rollDice');
});

/* ═══════════════════════════════════════════════════════════
   SOCKET EVENTS
═══════════════════════════════════════════════════════════ */
socket.on('connect', () => { mySocketId = socket.id; });

socket.on('roomCreated', ({ roomCode, playerId, gameState: gs }) => {
  myRoomCode = roomCode; myPlayerId = playerId; gameState = gs;
  $('display-code').textContent = roomCode;
  $('hud-code').textContent = roomCode;
  renderWaiting(gs);
  showScreen('screen-waiting');
});

socket.on('joinedRoom', ({ roomCode, playerId, gameState: gs }) => {
  myRoomCode = roomCode; myPlayerId = playerId; gameState = gs;
  $('display-code').textContent = roomCode;
  $('hud-code').textContent = roomCode;
  renderWaiting(gs);
  showScreen('screen-waiting');
});

socket.on('playerJoined', ({ gameState: gs }) => {
  gameState = gs; renderWaiting(gs);
});

socket.on('joinError', ({ message }) => { setErr(message); toast(message); });

socket.on('gameStarted', ({ gameState: gs }) => {
  gameState = gs;
  initCanvas();
  initTokens(gs);
  renderBoard();
  renderTokens(gs, false);
  renderHUD(gs);
  showScreen('screen-game');
});

socket.on('gameUpdate', ({ gameState: gs, event }) => {
  const prev = gameState;
  gameState = gs;
  handleEvent(event, prev, gs);
});

socket.on('playerLeft', ({ gameState: gs, playerName }) => {
  gameState = gs;
  toast(`${playerName} left`);
  if (gs.phase !== 'waiting') { renderHUD(gs); renderTokens(gs, false); }
  else renderWaiting(gs);
});

socket.on('gameOver', ({ winner, gameState: gs }) => {
  gameState = gs;
  renderHUD(gs);
  renderTokens(gs, false);
  showWinner(winner);
});

socket.on('error', ({ message }) => toast(message));

/* ═══════════════════════════════════════════════════════════
   WAITING ROOM RENDER
═══════════════════════════════════════════════════════════ */
function renderWaiting(gs) {
  const grid = $('players-grid');
  grid.innerHTML = '';

  gs.players.forEach(p => {
    const isMe = p.id === myPlayerId;
    const div = document.createElement('div');
    div.className = 'player-slot' + (isMe ? ' is-you' : '');
    div.innerHTML = `
      <div class="ps-swatch" style="background:${COLOR[p.color].fill};box-shadow:0 0 8px ${COLOR[p.color].fill}60"></div>
      <div class="ps-name">${escHtml(p.name)}</div>
      ${p.isHost ? '<div class="ps-tag">HOST</div>' : ''}
      ${isMe     ? '<div class="ps-tag">YOU</div>'  : ''}
    `;
    grid.appendChild(div);
  });

  const me = gs.players.find(p => p.id === myPlayerId);
  const btn = $('start-btn');
  btn.style.display = me?.isHost ? 'flex' : 'none';
  btn.disabled = gs.players.length < 2;

  $('wait-hint').textContent = gs.players.length >= gs.maxPlayers
    ? `Room full (${gs.players.length}/${gs.maxPlayers}) — Host can start!`
    : `Waiting… ${gs.players.length}/${gs.maxPlayers} joined`;
}

/* ═══════════════════════════════════════════════════════════
   CANVAS BOARD INIT & DRAW
═══════════════════════════════════════════════════════════ */
function initCanvas() {
  const shell = $('board-shell');
  canvas = $('game-canvas');
  svgEl  = $('token-svg');

  const size = shell.clientWidth;
  canvas.width  = size;
  canvas.height = size;
  CELL = size / 15;
  ctx  = canvas.getContext('2d');

  window.addEventListener('resize', onResize);
}

function onResize() {
  if (!canvas) return;
  const shell = $('board-shell');
  const size  = shell.clientWidth;
  canvas.width  = size;
  canvas.height = size;
  CELL = size / 15;
  renderBoard();
  if (gameState) { repositionTokens(gameState); renderHUD(gameState); }
}

/* ── Draw the static board ──────────────────────────────── */
function renderBoard() {
  if (!ctx) return;
  const S = canvas.width;

  ctx.clearRect(0, 0, S, S);
  drawBg(S);
  drawColorZones(S);
  drawMainPath(S);
  drawHomeLanes(S);
  drawSafeMarkers(S);
  drawCenterStar(S);
  drawArrows(S);
}

function drawBg(S) {
  ctx.fillStyle = '#0d0f1a';
  ctx.fillRect(0, 0, S, S);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 15; i++) {
    ctx.beginPath(); ctx.moveTo(i*CELL,0);   ctx.lineTo(i*CELL,S);   ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,i*CELL);   ctx.lineTo(S,i*CELL);   ctx.stroke();
  }
}

function drawColorZones(S) {
  const zones = [
    { col:0, row:0, color:'red' },
    { col:9, row:0, color:'blue' },
    { col:9, row:9, color:'green' },
    { col:0, row:9, color:'yellow' },
  ];
  zones.forEach(z => {
    const x = z.col*CELL, y = z.row*CELL, w = 6*CELL;
    const c = COLOR[z.color];

    // Outer zone
    ctx.fillStyle = c.zone;
    rrect(ctx, x, y, w, w, CELL*0.4); ctx.fill();

    // Glassy inner yard
    const p = CELL*0.55;
    ctx.fillStyle = 'rgba(10,12,25,0.75)';
    rrect(ctx, x+p, y+p, w-p*2, w-p*2, CELL*0.25); ctx.fill();

    ctx.strokeStyle = c.fill + '55';
    ctx.lineWidth = 1.5;
    rrect(ctx, x+p, y+p, w-p*2, w-p*2, CELL*0.25); ctx.stroke();

    // Colour name
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${CELL*0.7}px Orbitron,monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(z.color.toUpperCase(), x+w/2, y+w/2);
    ctx.restore();
  });
}

function drawMainPath(S) {
  PATH52.forEach(([c,r]) => {
    const x = c*CELL, y = r*CELL;
    // Cell bg
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    rrect(ctx, x+1, y+1, CELL-2, CELL-2, 3); ctx.fill();
    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.5;
    rrect(ctx, x+1, y+1, CELL-2, CELL-2, 3); ctx.stroke();
  });
}

function drawHomeLanes(S) {
  Object.entries(HOME_LANES).forEach(([color, cells]) => {
    const c = COLOR[color];
    cells.forEach(([col,row]) => {
      const x = col*CELL, y = row*CELL;
      ctx.fillStyle = c.lane;
      rrect(ctx, x+1, y+1, CELL-2, CELL-2, 3); ctx.fill();
      ctx.strokeStyle = c.fill + '40';
      ctx.lineWidth = 0.5;
      rrect(ctx, x+1, y+1, CELL-2, CELL-2, 3); ctx.stroke();
    });
  });
}

function drawSafeMarkers(S) {
  SAFE_SET.forEach(i => {
    const [c,r] = PATH52[i];
    const x = c*CELL + CELL/2, y = r*CELL + CELL/2;
    ctx.save();
    ctx.fillStyle   = 'rgba(251,191,36,0.2)';
    ctx.strokeStyle = 'rgba(251,191,36,0.45)';
    ctx.lineWidth   = 1;
    star(ctx, x, y, CELL*0.3, CELL*0.14, 6);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  });
}

function drawCenterStar(S) {
  const cx = S/2, cy = S/2;
  // Four-colour triangles
  const tri = [
    { color:'red',    pts:[[cx,cy],[cx-CELL*2.4,cy-CELL*2.4],[cx+CELL*2.4,cy-CELL*2.4]] },
    { color:'blue',   pts:[[cx,cy],[cx+CELL*2.4,cy-CELL*2.4],[cx+CELL*2.4,cy+CELL*2.4]] },
    { color:'green',  pts:[[cx,cy],[cx+CELL*2.4,cy+CELL*2.4],[cx-CELL*2.4,cy+CELL*2.4]] },
    { color:'yellow', pts:[[cx,cy],[cx-CELL*2.4,cy+CELL*2.4],[cx-CELL*2.4,cy-CELL*2.4]] },
  ];
  tri.forEach(t => {
    ctx.beginPath();
    ctx.moveTo(...t.pts[0]);
    ctx.lineTo(...t.pts[1]);
    ctx.lineTo(...t.pts[2]);
    ctx.closePath();
    ctx.fillStyle = COLOR[t.color].fill + 'aa';
    ctx.fill();
  });

  // Centre star
  ctx.save();
  ctx.fillStyle   = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = '#fff'; ctx.shadowBlur = 16;
  star(ctx, cx, cy, CELL*0.55, CELL*0.22, 6);
  ctx.fill();
  ctx.restore();
}

function drawArrows(S) {
  const arrows = [
    { idx:0,  color:'red',    angle:0 },
    { idx:13, color:'blue',   angle:Math.PI/2 },
    { idx:26, color:'green',  angle:Math.PI },
    { idx:39, color:'yellow', angle:-Math.PI/2 },
  ];
  arrows.forEach(a => {
    const [c,r] = PATH52[a.idx];
    const x = c*CELL + CELL/2, y = r*CELL + CELL/2;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a.angle);
    ctx.fillStyle = COLOR[a.color].fill + 'cc';
    ctx.beginPath();
    const s = CELL*0.18;
    ctx.moveTo(s,0); ctx.lineTo(-s,-s*0.7); ctx.lineTo(-s,s*0.7);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  });
}

/* ── Canvas helpers ────────────────────────────────────── */
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);   ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);     ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function star(ctx, cx, cy, or, ir, n) {
  ctx.beginPath();
  for (let i=0; i<n*2; i++) {
    const r = i%2===0 ? or : ir;
    const a = (i*Math.PI/n) - Math.PI/2;
    i===0 ? ctx.moveTo(cx+r*Math.cos(a),cy+r*Math.sin(a))
           : ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a));
  }
  ctx.closePath();
}

/* ═══════════════════════════════════════════════════════════
   TOKEN SVG SYSTEM
   We use SVG <g> elements for each token, positioned via
   the transform attribute. This lets us use JS tweening for
   smooth cell-by-cell animation without canvas overdraw.
═══════════════════════════════════════════════════════════ */

const TOKEN_R = 0.33; // radius as fraction of CELL

function initTokens(gs) {
  svgEl.innerHTML = '';
  // SVG viewBox matches canvas
  const sz = canvas.width;
  svgEl.setAttribute('viewBox', `0 0 ${sz} ${sz}`);
  svgEl.setAttribute('width',  sz);
  svgEl.setAttribute('height', sz);

  gs.players.forEach(p => {
    tokenEls[p.color]      = [];
    tokenPositions[p.color] = [];
    p.tokens.forEach((tok, i) => {
      const g = createTokenEl(p.color, i, tok);
      svgEl.appendChild(g);
      tokenEls[p.color][i] = g;
      const [wx,wy] = tokenWorldPos(tok, p.color, i);
      tokenPositions[p.color][i] = { x:wx, y:wy };
      setTokenXY(g, wx, wy);
    });
  });

  // Click handler on SVG
  svgEl.style.pointerEvents = 'all';
  svgEl.addEventListener('click', onTokenClick);
}

function createTokenEl(color, idx, tok) {
  const ns = 'http://www.w3.org/2000/svg';
  const g  = document.createElementNS(ns,'g');
  g.setAttribute('class','token-group');
  g.dataset.color = color;
  g.dataset.idx   = idx;

  const r  = CELL * TOKEN_R;

  // Pulse ring (for selectable state)
  const pulse = document.createElementNS(ns,'circle');
  pulse.setAttribute('class','token-pulse');
  pulse.setAttribute('r', r+4);
  pulse.setAttribute('fill','none');
  pulse.setAttribute('stroke', COLOR[color].fill);
  pulse.setAttribute('stroke-width','2');
  pulse.setAttribute('opacity','0');

  // Drop shadow
  const shadow = document.createElementNS(ns,'circle');
  shadow.setAttribute('r', r+2);
  shadow.setAttribute('fill','rgba(0,0,0,0.35)');
  shadow.setAttribute('transform','translate(2,3)');

  // Token body
  const body = document.createElementNS(ns,'circle');
  body.setAttribute('class','token-body');
  body.setAttribute('r', r);
  body.setAttribute('fill', COLOR[color].fill);

  // Specular highlight
  const shine = document.createElementNS(ns,'ellipse');
  shine.setAttribute('rx', r*0.38); shine.setAttribute('ry', r*0.22);
  shine.setAttribute('cx', -r*0.22); shine.setAttribute('cy', -r*0.3);
  shine.setAttribute('fill','rgba(255,255,255,0.35)');

  // Number label
  const text = document.createElementNS(ns,'text');
  text.setAttribute('text-anchor','middle');
  text.setAttribute('dominant-baseline','central');
  text.setAttribute('fill','#fff');
  text.setAttribute('font-size', r*0.9);
  text.setAttribute('font-family','Outfit,sans-serif');
  text.setAttribute('font-weight','700');
  text.setAttribute('pointer-events','none');
  text.textContent = idx + 1;

  g.appendChild(pulse);
  g.appendChild(shadow);
  g.appendChild(body);
  g.appendChild(shine);
  g.appendChild(text);

  return g;
}

function setTokenXY(g, x, y) {
  g.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)})`);
}

/* ── Reposition without animation ──────────────────────── */
function repositionTokens(gs) {
  if (!gs || !svgEl) return;
  const sz = canvas.width;
  svgEl.setAttribute('viewBox', `0 0 ${sz} ${sz}`);
  svgEl.setAttribute('width',  sz);
  svgEl.setAttribute('height', sz);

  gs.players.forEach(p => {
    p.tokens.forEach((tok, i) => {
      const g = tokenEls[p.color]?.[i];
      if (!g) return;
      const [wx,wy] = tokenWorldPos(tok, p.color, i);
      tokenPositions[p.color][i] = { x:wx, y:wy };
      setTokenXY(g, wx, wy);
    });
  });
}

/* ── Update canMove highlights ──────────────────────────── */
function updateTokenHighlights(gs) {
  gs.players.forEach(p => {
    p.tokens.forEach((tok, i) => {
      const g = tokenEls[p.color]?.[i];
      if (!g) return;
      const pulse = g.querySelector('.token-pulse');
      const body  = g.querySelector('.token-body');

      if (tok.canMove && p.id === myPlayerId) {
        g.classList.add('can-move');
        g.style.pointerEvents = 'all';
        pulse.setAttribute('opacity','1');
        body.setAttribute('filter','url(#glow)');
      } else {
        g.classList.remove('can-move');
        g.style.pointerEvents = p.id === myPlayerId ? 'all' : 'none';
        pulse.setAttribute('opacity','0');
        body.removeAttribute('filter');
      }
    });
  });
}

/* ── Full re-render tokens (no animation) ──────────────── */
function renderTokens(gs, animated) {
  if (!gs || !svgEl) return;
  if (!animated) {
    repositionTokens(gs);
    updateTokenHighlights(gs);
  }
}

/* ── Smooth cell-by-cell animation ─────────────────────── */
function animateTokenMove(color, tokenIdx, pathPts, onComplete) {
  if (!pathPts || pathPts.length === 0) { onComplete && onComplete(); return; }
  const g = tokenEls[color][tokenIdx];
  const STEP_MS = 180; // ms per cell (~180ms feels fast but readable)

  let start = null;
  let stepIdx = 0;

  const cur = tokenPositions[color][tokenIdx];
  let fromX = cur.x, fromY = cur.y;

  function tick(ts) {
    if (!start) start = ts;
    const elapsed = ts - start;
    const t = Math.min(elapsed / STEP_MS, 1);
    // ease-in-out
    const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;

    const [toX, toY] = pathPts[stepIdx];
    const nx = fromX + (toX - fromX) * e;
    const ny = fromY + (toY - fromY) * e;

    setTokenXY(g, nx, ny);

    // Scale pop on each landing
    const scale = stepIdx === pathPts.length-1 && t > 0.85
      ? 1 + 0.2 * Math.sin((t-0.85)/0.15 * Math.PI)
      : 1;
    g.style.transform = `translate(${nx.toFixed(2)}px,${ny.toFixed(2)}px) scale(${scale})`;
    g.setAttribute('transform', `translate(${nx.toFixed(2)},${ny.toFixed(2)}) scale(${scale})`);

    if (t >= 1) {
      // Step done
      tokenPositions[color][tokenIdx] = { x: toX, y: toY };
      fromX = toX; fromY = toY;
      stepIdx++;
      if (stepIdx >= pathPts.length) {
        g.setAttribute('transform', `translate(${toX.toFixed(2)},${toY.toFixed(2)})`);
        onComplete && onComplete();
        return;
      }
      start = ts;
      requestAnimationFrame(tick);
      return;
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

/* ── Board click handler ────────────────────────────────── */
function onTokenClick(e) {
  if (!gameState || animating) return;
  if (gameState.currentPlayer !== myPlayerId) return;
  if (gameState.phase !== 'move') return;

  const g = e.target.closest('.token-group');
  if (!g) return;

  const color = g.dataset.color;
  const idx   = parseInt(g.dataset.idx);
  const me    = gameState.players.find(p => p.id === myPlayerId);
  if (!me || me.color !== color) return;
  if (!me.tokens[idx]?.canMove) return;

  socket.emit('moveToken', { tokenIndex: idx });
}

/* ═══════════════════════════════════════════════════════════
   HANDLE GAME EVENTS (with animation)
═══════════════════════════════════════════════════════════ */
function handleEvent(event, prevGs, nextGs) {
  if (!event) { renderHUD(nextGs); renderTokens(nextGs, false); return; }

  switch (event.type) {
    case 'diceRolled':
      animateDice(event.value);
      $('dice-msg').textContent = `${event.playerName} rolled ${event.value}`;
      addLog(`<b>${escHtml(event.playerName)}</b> rolled ${event.value}`);
      renderHUD(nextGs);
      updateTokenHighlights(nextGs);
      break;

    case 'tokenMoved':
    case 'tokenKilled': {
      const color = event.color;
      const tidx  = event.tokenIndex;
      const prevPlayer = prevGs.players.find(p => p.color === color);
      const nextPlayer = nextGs.players.find(p => p.color === color);
      if (!prevPlayer || !nextPlayer) { renderHUD(nextGs); renderTokens(nextGs, false); break; }

      const prevTok = prevPlayer.tokens[tidx];
      const nextTok = nextPlayer.tokens[tidx];
      const path    = getMovePath(prevTok, nextTok, color, tidx);

      // If a kill happened, also track returning token
      let killedColor=null, killedIdx=-1, killedPath=null;
      if (event.type === 'tokenKilled') {
        // Find which opponent token moved back to yard
        for (const np of nextGs.players) {
          if (np.color === color) continue;
          const pp = prevGs.players.find(p => p.color === np.color);
          if (!pp) continue;
          for (let ki=0; ki<np.tokens.length; ki++) {
            const ntk = np.tokens[ki], ptk = pp.tokens[ki];
            if (ptk.state === 'onBoard' && ntk.state === 'yard') {
              killedColor = np.color; killedIdx = ki;
              killedPath = [tokenWorldPos(ntk, np.color, ki)];
            }
          }
        }
        addLog(`<b>${escHtml(event.killerName)}</b> sent <b>${escHtml(event.victimName)}</b>'s token home! 💀`, 'kill');
        toast(`💀 ${event.killerName} got ${event.victimName}!`);
        sfx('kill');
      } else {
        addLog(`<b>${escHtml(event.playerName)}</b> moved token ${tidx+1}`);
        sfx('move');
      }

      animating = true;
      $('roll-btn').disabled = true;

      animateTokenMove(color, tidx, path, () => {
        // Snap killed token
        if (killedColor !== null) {
          const [kx,ky] = tokenWorldPos(nextGs.players.find(p=>p.color===killedColor).tokens[killedIdx], killedColor, killedIdx);
          tokenPositions[killedColor][killedIdx] = { x:kx, y:ky };
          setTokenXY(tokenEls[killedColor][killedIdx], kx, ky);
        }
        animating = false;
        renderHUD(nextGs);
        renderTokens(nextGs, false);
      });
      break;
    }

    case 'turnSkipped':
      addLog(`<b>${escHtml(event.playerName)}</b> has no valid moves — skipped`);
      $('dice-msg').textContent = 'No moves — turn skipped';
      renderHUD(nextGs);
      renderTokens(nextGs, false);
      break;

    default:
      renderHUD(nextGs);
      renderTokens(nextGs, false);
  }
}

/* ═══════════════════════════════════════════════════════════
   HUD RENDER
═══════════════════════════════════════════════════════════ */
function renderHUD(gs) {
  if (!gs) return;

  // Turn card
  const cp = gs.players.find(p => p.id === gs.currentPlayer);
  if (cp) {
    const c = COLOR[cp.color];
    $('tc-name').textContent = cp.name;
    $('tc-orb').style.background  = c.fill;
    $('tc-orb').style.boxShadow   = `0 0 18px ${c.glow}`;
    const badge = $('tc-badge');
    badge.classList.toggle('show', cp.id === myPlayerId);
  }

  // Roll button
  const isMyTurn = gs.currentPlayer === myPlayerId;
  $('roll-btn').disabled = animating || !(isMyTurn && gs.phase === 'roll');

  // Player strips
  renderStrips(gs);
}

function renderStrips(gs) {
  const container = $('player-strips');
  container.innerHTML = '';
  gs.players.forEach(p => {
    const isActive = p.id === gs.currentPlayer;
    const isMe     = p.id === myPlayerId;
    const homeCount = p.tokens.filter(t => t.state === 'home').length;
    const c = COLOR[p.color];

    const div = document.createElement('div');
    div.className = 'pstrip' + (isActive ? ' is-active' : '');
    div.innerHTML = `
      <div class="pstrip-dot" style="background:${c.fill};color:${c.fill}${isActive?' box-shadow:0 0 10px '+c.fill:''}"></div>
      <div class="pstrip-body">
        <div class="pstrip-name">${escHtml(p.name)}</div>
        <div class="pstrip-home">🏠 ${homeCount}/4</div>
      </div>
      ${isMe ? '<div class="pstrip-you">YOU</div>' : ''}
    `;
    // Active glow via inline style
    if (isActive) {
      div.style.borderColor = c.fill + '60';
      div.style.boxShadow   = `0 0 12px ${c.glow}`;
    }
    container.appendChild(div);
  });
}

/* ═══════════════════════════════════════════════════════════
   DICE ANIMATION
═══════════════════════════════════════════════════════════ */
const FACE_TRANSFORMS = {
  1:'rotateY(0deg)',
  2:'rotateY(180deg)',
  3:'rotateY(-90deg)',
  4:'rotateY(90deg)',
  5:'rotateX(-90deg)',
  6:'rotateX(90deg)',
};

function animateDice(value) {
  const die = $('die');
  die.classList.remove('rolling');
  // Force reflow
  void die.offsetWidth;
  die.classList.add('rolling');
  sfx('roll');

  setTimeout(() => {
    die.classList.remove('rolling');
    die.style.transform = FACE_TRANSFORMS[value] || '';
    die.dataset.face    = value;
  }, 900);
}

/* ═══════════════════════════════════════════════════════════
   GAME LOG
═══════════════════════════════════════════════════════════ */
function addLog(html, cls='') {
  const list = $('log-list');
  const li   = document.createElement('li');
  li.className = 'log-item ' + cls;
  li.innerHTML = html;
  list.prepend(li);
  while (list.children.length > 40) list.removeChild(list.lastChild);
}

/* ═══════════════════════════════════════════════════════════
   WINNER MODAL + CONFETTI
═══════════════════════════════════════════════════════════ */
function showWinner(winner) {
  $('modal-winner-name').textContent = winner?.name || '?';
  burst($('confetti-burst'));
  $('winner-modal').classList.remove('hidden');
}

function burst(container) {
  container.innerHTML = '';
  const colors = ['#6366f1','#10b981','#f59e0b','#f43f5e','#3b82f6','#a78bfa'];
  for (let i = 0; i < 48; i++) {
    const el = document.createElement('div');
    el.className = 'cf';
    const angle = (Math.random() * 360);
    const dist  = 80 + Math.random() * 180;
    const tx = Math.cos(angle * Math.PI/180) * dist;
    const ty = Math.sin(angle * Math.PI/180) * dist - 60;
    el.style.cssText = `
      background:${colors[i%colors.length]};
      --tx:${tx}px; --ty:${ty}px; --r:${Math.random()*720-360}deg;
      animation-delay:${Math.random()*0.3}s;
      animation-duration:${0.9+Math.random()*0.5}s;
      width:${5+Math.random()*8}px; height:${5+Math.random()*8}px;
      border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
    `;
    container.appendChild(el);
  }
}

/* ═══════════════════════════════════════════════════════════
   WEB AUDIO SFX (synthetic, no files needed)
═══════════════════════════════════════════════════════════ */
let audioCtx;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function sfx(type) {
  try {
    const ac = getAudioCtx();
    if (ac.state === 'suspended') ac.resume();
    const osc  = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);

    const now = ac.currentTime;
    switch(type) {
      case 'roll':
        osc.type = 'square';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(660, now+0.15);
        osc.frequency.exponentialRampToValueAtTime(110, now+0.35);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now+0.4);
        osc.start(now); osc.stop(now+0.4);
        break;
      case 'move':
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now+0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now+0.18);
        osc.start(now); osc.stop(now+0.18);
        break;
      case 'kill':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(110, now+0.3);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now+0.35);
        osc.start(now); osc.stop(now+0.35);
        break;
    }
  } catch(e) { /* Audio not available */ }
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* Add SVG defs for glow filter */
function addSvgDefs() {
  const ns   = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns,'defs');
  defs.innerHTML = `
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  `;
  svgEl.insertBefore(defs, svgEl.firstChild);
}

/* Patch initTokens to add defs */
const _initTokens = initTokens;
function initTokens(gs) { _initTokens(gs); addSvgDefs(); }
