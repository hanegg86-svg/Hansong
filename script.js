/* ============================================================
   1. INDEXED-DB STORAGE ENGINE
   ============================================================ */
const DB_NAME = 'NeonPianoDB';
const DB_VERSION = 1;
const STORE_NAME = 'game_scores';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('score', 'score', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveScoreRecord(score, maxCombo, accuracy) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await store.add({
      score: score,
      maxCombo: maxCombo,
      accuracy: accuracy,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('IndexedDB Save Error:', err);
  }
}

async function getTopScores(limit = 3) {
  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const sorted = (req.result || []).sort((a, b) => b.score - a.score).slice(0, limit);
        resolve(sorted);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/* ============================================================
   2. LOW-LATENCY WEB AUDIO PIANO SYNTHESIZER
   ============================================================ */
class PianoAudioEngine {
  constructor() {
    this.ctx = null;
    this.laneFrequencies = [261.63, 329.63, 392.00, 523.25]; // C4, E4, G4, C5 (Chord Progression)
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playTone(laneIndex) {
    if (!this.ctx) this.init();
    const now = this.ctx.currentTime;
    const freq = this.laneFrequencies[laneIndex] || 440;

    // Harmonic Overtones for rich piano acoustic feel
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);

    // Natural Piano ADSR envelope
    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.65, now + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.2, now + 0.18);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.86);
    osc2.stop(now + 0.86);
  }
}

/* ============================================================
   3. GAME ENGINE, PARTICLES & ANIMATION LOOP
   ============================================================ */
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const audioEngine = new PianoAudioEngine();

const scoreDisp = document.getElementById('score-display');
const bestScoreDisp = document.getElementById('best-score-display');
const comboDisp = document.getElementById('combo-display');
const judgmentDisp = document.getElementById('judgment-display');
const modal = document.getElementById('game-modal');
const modalTitle = document.getElementById('modal-title');
const modalStats = document.getElementById('modal-stats');
const startBtn = document.getElementById('start-btn');
const finalScoreEl = document.getElementById('final-score');
const finalComboEl = document.getElementById('final-combo');
const finalAccEl = document.getElementById('final-accuracy');
const highScoreList = document.getElementById('high-score-list');
const laneTriggers = document.querySelectorAll('.lane-trigger');

const LANE_COUNT = 4;
const LANE_COLORS = ['#00f0ff', '#ff0077', '#ffd700', '#00ff88'];

let gameState = 'START';
let score = 0;
let combo = 0;
let maxCombo = 0;
let totalHits = 0;
let perfectHits = 0;
let notes = [];
let particles = [];
let lastSpawnTime = 0;
let spawnInterval = 680;
let noteSpeed = 6;
let hitLineY = 0;
let noteHeight = 70;
let laneWidth = 0;
let animationFrameId = null;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  laneWidth = rect.width / LANE_COUNT;
  hitLineY = rect.height * 0.82;
  noteHeight = Math.max(50, rect.height * 0.08);
  noteSpeed = rect.height * 0.0075;
}

window.addEventListener('resize', resizeCanvas);

class Note {
  constructor(lane) {
    this.lane = lane;
    this.y = -noteHeight;
    this.hit = false;
    this.missed = false;
  }

  update(delta) {
    this.y += noteSpeed * (delta / 16.66);
  }

  draw(context) {
    const x = this.lane * laneWidth + 8;
    const w = laneWidth - 16;
    const color = LANE_COLORS[this.lane];

    context.save();
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = 15;

    // Rounded glowing bar
    context.beginPath();
    context.roundRect(x, this.y, w, noteHeight, 10);
    context.fill();

    // Gloss effect
    context.fillStyle = 'rgba(255, 255, 255, 0.4)';
    context.fillRect(x + 4, this.y + 4, w - 8, 4);
    context.restore();
  }
}

class HitParticle {
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.radius = Math.random() * 4 + 2;
    this.vx = (Math.random() - 0.5) * 8;
    this.vy = (Math.random() - 0.7) * 9;
    this.alpha = 1;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.alpha -= 0.035;
  }

  draw(context) {
    context.save();
    context.globalAlpha = Math.max(0, this.alpha);
    context.fillStyle = this.color;
    context.shadowColor = this.color;
    context.shadowBlur = 8;
    context.beginPath();
    context.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function spawnParticles(lane) {
  const x = lane * laneWidth + laneWidth / 2;
  const color = LANE_COLORS[lane];
  for (let i = 0; i < 14; i++) {
    particles.push(new HitParticle(x, hitLineY, color));
  }
}

function setJudgment(text, color) {
  judgmentDisp.innerText = text;
  judgmentDisp.style.color = color;
  judgmentDisp.style.transform = 'scale(1.3)';
  setTimeout(() => {
    judgmentDisp.style.transform = 'scale(1)';
  }, 120);
}

function handleLaneHit(laneIndex) {
  if (gameState !== 'PLAYING') return;

  audioEngine.playTone(laneIndex);

  // Activate lane visual
  laneTriggers[laneIndex].classList.add('active');
  setTimeout(() => laneTriggers[laneIndex].classList.remove('active'), 120);

  // Hit detection threshold
  const targetNote = notes.find(n => n.lane === laneIndex && !n.hit && !n.missed && Math.abs((n.y + noteHeight) - hitLineY) < noteHeight * 1.5);

  if (targetNote) {
    targetNote.hit = true;
    totalHits++;
    const diff = Math.abs((targetNote.y + noteHeight) - hitLineY);

    if (diff < noteHeight * 0.45) {
      score += 150 + combo * 5;
      combo++;
      perfectHits++;
      setJudgment('PERFECT!', '#00ff88');
    } else {
      score += 80 + combo * 2;
      combo++;
      setJudgment('GREAT', '#00f0ff');
    }

    if (combo > maxCombo) maxCombo = combo;
    spawnParticles(laneIndex);
  } else {
    // Tapped with no note (Penalty)
    combo = 0;
    setJudgment('MISS', '#ff0055');
  }

  updateHUD();
}

function updateHUD() {
  scoreDisp.innerText = score.toLocaleString();
  comboDisp.innerText = `${combo} COMBO`;
}

function gameLoop(time) {
  if (gameState !== 'PLAYING') return;

  const delta = 16.66;
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  // Draw Lane Dividing Guides
  ctx.lineWidth = 1;
  for (let i = 1; i < LANE_COUNT; i++) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.moveTo(i * laneWidth, 0);
    ctx.lineTo(i * laneWidth, rect.height);
    ctx.stroke();
  }

  // Draw Hit Zone Line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, hitLineY);
  ctx.lineTo(rect.width, hitLineY);
  ctx.stroke();

  // Spawning Rhythm Notes
  if (time - lastSpawnTime > spawnInterval) {
    const randomLane = Math.floor(Math.random() * LANE_COUNT);
    notes.push(new Note(randomLane));
    lastSpawnTime = time;
    // Gradually speed up
    if (spawnInterval > 380) spawnInterval -= 1.5;
  }

  // Update & Draw Notes
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    note.update(delta);
    note.draw(ctx);

    // Miss condition
    if (!note.hit && !note.missed && note.y > hitLineY + noteHeight * 0.8) {
      note.missed = true;
      totalHits++;
      combo = 0;
      setJudgment('MISS', '#ff0055');
      updateHUD();
    }

    // Cleanup offscreen notes
    if (note.y > rect.height + 40 || note.hit) {
      notes.splice(i, 1);
    }
  }

  // Update & Draw Hit Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.update();
    p.draw(ctx);
    if (p.alpha <= 0) particles.splice(i, 1);
  }

  animationFrameId = requestAnimationFrame(gameLoop);
}

async function renderLeaderboard() {
  const topList = await getTopScores(3);
  if (topList.length > 0) {
    bestScoreDisp.innerText = topList[0].score.toLocaleString();
    highScoreList.innerHTML = topList.map((item, idx) => `
      <li>
        <span>#${idx + 1} • ${new Date(item.timestamp).toLocaleDateString('th-TH')}</span>
        <strong>${item.score.toLocaleString()} pts</strong>
      </li>
    `).join('');
  } else {
    highScoreList.innerHTML = '<li>ยังไม่มีประวัติสถิติ</li>';
  }
}

async function gameOver() {
  gameState = 'GAMEOVER';
  cancelAnimationFrame(animationFrameId);

  const accuracy = totalHits > 0 ? Math.round((perfectHits / totalHits) * 100) : 0;
  await saveScoreRecord(score, maxCombo, accuracy);

  finalScoreEl.innerText = score.toLocaleString();
  finalComboEl.innerText = maxCombo.toString();
  finalAccEl.innerText = `${accuracy}%`;

  modalTitle.innerText = 'GAME OVER';
  modalStats.classList.remove('hide');
  startBtn.innerText = 'เล่นอีกครั้ง';
  await renderLeaderboard();
  modal.classList.remove('hide');
}

function startGame() {
  audioEngine.init();
  resizeCanvas();

  score = 0;
  combo = 0;
  maxCombo = 0;
  totalHits = 0;
  perfectHits = 0;
  notes = [];
  particles = [];
  spawnInterval = 680;
  lastSpawnTime = performance.now();

  updateHUD();
  setJudgment('READY', '#a0aec0');

  modal.classList.add('hide');
  gameState = 'PLAYING';
  animationFrameId = requestAnimationFrame(gameLoop);

  // 45 seconds game duration per round
  setTimeout(() => {
    if (gameState === 'PLAYING') gameOver();
  }, 45000);
}

/* ============================================================
   4. MULTI-TOUCH CONTROLLER BINDINGS
   ============================================================ */
laneTriggers.forEach((trigger) => {
  const lane = parseInt(trigger.dataset.lane, 10);
  
  trigger.addEventListener('touchstart', (e) => {
    e.preventDefault();
    handleLaneHit(lane);
  }, { passive: false });

  trigger.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handleLaneHit(lane);
  });
});

startBtn.addEventListener('click', startGame);

// Initialize DB and Leaderboard on page load
window.addEventListener('DOMContentLoaded', async () => {
  resizeCanvas();
  await renderLeaderboard();
  registerServiceWorker();
});

/* ============================================================
   5. SERVICE WORKER REGISTRATION
   ============================================================ */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js')
        .then(() => console.log('PWA Service Worker พร้อมทำงาน'))
        .catch((err) => console.warn('Service Worker registration failed:', err));
    });
  }
}
