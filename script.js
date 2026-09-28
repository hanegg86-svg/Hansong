/* ============================================================
   1. INDEXED-DB STORAGE ENGINE
   ============================================================ */
const DB_NAME = 'NeonPianoBeatmapDB';
const DB_VERSION = 1;
const STORE_NAME = 'song_records';

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
   2. AUDIO SYNTHESIZER & SONG CONTROLLER
   ============================================================ */
class PianoAudioEngine {
  constructor() {
    this.ctx = null;
    // ปรับจูนคีย์เสียงให้ตรงกับโทนสเกลเพลง (C4, E4, G4, B4/C5)
    this.laneFrequencies = [261.63, 329.63, 392.00, 493.88];
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

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);

    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.6, now + 0.012);
    gainNode.gain.exponentialRampToValueAtTime(0.2, now + 0.15);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.66);
    osc2.stop(now + 0.66);
  }
}

/* ============================================================
   3. GAME ENGINE, PARTICLES & BEATMAP SYNC
   ============================================================ */
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const audioEngine = new PianoAudioEngine();
const bgSong = document.getElementById('bg-song');

const scoreDisp = document.getElementById('score-display');
const bestScoreDisp = document.getElementById('best-score-display');
const comboDisp = document.getElementById('combo-display');
const judgmentDisp = document.getElementById('judgment-display');
const songProgressBar = document.getElementById('song-progress');
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
const TRAVEL_TIME = 1.5; // ความเร็วการตกลงมาของโน้ตสู่เส้น Hit Line

let gameState = 'START';
let score = 0;
let combo = 0;
let maxCombo = 0;
let totalHits = 0;
let perfectHits = 0;
let beatmap = [];
let particles = [];
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
}

window.addEventListener('resize', resizeCanvas);

/* แกะโน้ตตามช่วงเวลาและเมโลดี้จริงของเพลง (134 BPM, 1 Beat = ~0.4477s) */
function generateBeatmap() {
  const rawNotes = [
    // --- ท่อน Intro (2.0s - 12.0s): ลายอาร์เพจจิโอสังเคราะห์เปิดตัว ---
    { t: 2.24, l: 0 }, { t: 2.68, l: 1 }, { t: 3.13, l: 2 }, { t: 3.58, l: 3 },
    { t: 4.03, l: 2 }, { t: 4.47, l: 1 }, { t: 4.92, l: 0 }, { t: 5.37, l: 2 },
    { t: 5.82, l: 1 }, { t: 6.26, l: 3 }, { t: 6.71, l: 2 }, { t: 7.16, l: 0 },
    { t: 7.61, l: 1 }, { t: 8.05, l: 2 }, { t: 8.50, l: 3 }, { t: 8.95, l: 2 },
    { t: 9.40, l: 1 }, { t: 9.84, l: 0 }, { t: 10.29, l: 2 }, { t: 10.74, l: 1 },
    { t: 11.19, l: 3 }, { t: 11.63, l: 2 },

    // --- ท่อน Verse / Main Melody A (12.0s - 26.0s): เมโลดี้หลักตามเสียงซินธ์นำ ---
    { t: 12.53, l: 0 }, { t: 12.98, l: 2 }, { t: 13.42, l: 1 }, { t: 13.87, l: 3 },
    { t: 14.32, l: 2 }, { t: 14.77, l: 2 }, { t: 15.21, l: 1 }, { t: 15.66, l: 0 },
    { t: 16.11, l: 1 }, { t: 16.56, l: 2 }, { t: 17.00, l: 3 }, { t: 17.45, l: 2 },
    { t: 17.90, l: 1 }, { t: 18.35, l: 0 }, { t: 18.79, l: 2 }, { t: 19.24, l: 3 },
    { t: 19.69, l: 2 }, { t: 20.14, l: 1 }, { t: 20.58, l: 0 }, { t: 21.03, l: 1 },
    { t: 21.48, l: 2 }, { t: 21.93, l: 3 }, { t: 22.37, l: 2 }, { t: 22.82, l: 1 },
    { t: 23.27, l: 0 }, { t: 23.72, l: 2 }, { t: 24.16, l: 3 }, { t: 24.61, l: 2 },
    { t: 25.06, l: 1 }, { t: 25.51, l: 0 },

    // --- ท่อน Build-Up (26.0s - 40.0s): เพิ่มความถี่บีทและสแนร์รัวขึ้นตามเพลง ---
    { t: 26.40, l: 0 }, { t: 26.85, l: 1 }, { t: 27.30, l: 2 }, { t: 27.75, l: 3 },
    { t: 28.19, l: 2 }, { t: 28.64, l: 1 }, { t: 29.09, l: 0 }, { t: 29.54, l: 2 },
    { t: 29.98, l: 3 }, { t: 30.43, l: 2 }, { t: 30.88, l: 1 }, { t: 31.33, l: 0 },
    { t: 31.77, l: 1 }, { t: 32.22, l: 2 }, { t: 32.67, l: 3 }, { t: 33.12, l: 2 },
    // จังหวะเร่งก่อนเข้าดรอป (ซอยจังหวะบีทถี่ขึ้น)
    { t: 33.56, l: 1 }, { t: 33.79, l: 2 }, { t: 34.01, l: 3 }, { t: 34.46, l: 2 },
    { t: 34.91, l: 1 }, { t: 35.13, l: 0 }, { t: 35.36, l: 2 }, { t: 35.80, l: 3 },
    { t: 36.25, l: 0 }, { t: 36.47, l: 1 }, { t: 36.70, l: 2 }, { t: 37.15, l: 3 },
    { t: 37.59, l: 2 }, { t: 37.82, l: 1 }, { t: 38.04, l: 2 }, { t: 38.49, l: 3 },
    { t: 38.71, l: 2 }, { t: 38.94, l: 1 }, { t: 39.16, l: 0 }, { t: 39.38, l: 3 },

    // --- ท่อน Drop / Chorus (40.0s - 58.0s): จุดพีคของเพลง จังหวะสลับโน้ตกระชับ ---
    { t: 40.28, l: 0 }, { t: 40.73, l: 3 }, { t: 41.17, l: 1 }, { t: 41.62, l: 2 },
    { t: 42.07, l: 0 }, { t: 42.29, l: 1 }, { t: 42.52, l: 2 }, { t: 42.96, l: 3 },
    { t: 43.41, l: 2 }, { t: 43.86, l: 1 }, { t: 44.31, l: 0 }, { t: 44.75, l: 3 },
    { t: 45.20, l: 2 }, { t: 45.42, l: 1 }, { t: 45.65, l: 2 }, { t: 46.10, l: 3 },
    { t: 46.54, l: 0 }, { t: 46.99, l: 2 }, { t: 47.44, l: 1 }, { t: 47.89, l: 3 },
    { t: 48.33, l: 2 }, { t: 48.56, l: 1 }, { t: 48.78, l: 0 }, { t: 49.23, l: 2 },
    { t: 49.68, l: 3 }, { t: 50.12, l: 1 }, { t: 50.57, l: 2 }, { t: 51.02, l: 0 },
    { t: 51.47, l: 3 }, { t: 51.69, l: 2 }, { t: 51.91, l: 1 }, { t: 52.36, l: 0 },
    { t: 52.81, l: 2 }, { t: 53.26, l: 3 }, { t: 53.70, l: 1 }, { t: 54.15, l: 2 },
    { t: 54.60, l: 0 }, { t: 55.05, l: 3 }, { t: 55.49, l: 2 }, { t: 55.94, l: 1 },
    { t: 56.39, l: 0 }, { t: 56.84, l: 2 }, { t: 57.28, l: 3 }, { t: 57.73, l: 2 },

    // --- ท่อน Melody B & Outro (58.0s - 74.0s): คลี่คลายเข้าสู่ท่อนจบของเพลง ---
    { t: 58.63, l: 1 }, { t: 59.07, l: 0 }, { t: 59.52, l: 2 }, { t: 59.97, l: 3 },
    { t: 60.42, l: 2 }, { t: 60.86, l: 1 }, { t: 61.31, l: 0 }, { t: 61.76, l: 2 },
    { t: 62.21, l: 3 }, { t: 62.65, l: 1 }, { t: 63.10, l: 2 }, { t: 63.55, l: 0 },
    { t: 64.00, l: 1 }, { t: 64.44, l: 3 }, { t: 64.89, l: 2 }, { t: 65.34, l: 0 },
    { t: 65.79, l: 1 }, { t: 66.23, l: 2 }, { t: 66.68, l: 3 }, { t: 67.13, l: 2 },
    { t: 67.58, l: 1 }, { t: 68.02, l: 0 }, { t: 68.92, l: 2 }, { t: 69.81, l: 1 },
    { t: 70.71, l: 3 }, { t: 71.60, l: 2 }, { t: 72.50, l: 0 }, { t: 73.39, l: 3 }
  ];

  return rawNotes.map(item => ({
    time: item.t,
    lane: item.l,
    hit: false,
    missed: false
  }));
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

  laneTriggers[laneIndex].classList.add('active');
  setTimeout(() => laneTriggers[laneIndex].classList.remove('active'), 120);

  const currentTime = bgSong.currentTime;
  
  // ค้นหาโน้ตในเลนนี้ที่มีเวลาใกล้เคียงกับเวลาเพลงปัจจุบัน
  const targetNote = beatmap.find(n => 
    n.lane === laneIndex && 
    !n.hit && 
    !n.missed && 
    Math.abs(n.time - currentTime) <= 0.22
  );

  if (targetNote) {
    targetNote.hit = true;
    totalHits++;
    const timeDiff = Math.abs(targetNote.time - currentTime);

    if (timeDiff <= 0.08) {
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
    // แตะพลาดโดยไม่มีโน้ต
    combo = 0;
    setJudgment('MISS', '#ff0055');
  }

  updateHUD();
}

function updateHUD() {
  scoreDisp.innerText = score.toLocaleString();
  comboDisp.innerText = `${combo} COMBO`;
}

function gameLoop() {
  if (gameState !== 'PLAYING') return;

  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const currentTime = bgSong.currentTime;
  const songDuration = bgSong.duration || 76;
  const progressPercent = Math.min(100, (currentTime / songDuration) * 100);
  songProgressBar.style.width = `${progressPercent}%`;

  // เลนแบ่งช่อง
  ctx.lineWidth = 1;
  for (let i = 1; i < LANE_COUNT; i++) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.moveTo(i * laneWidth, 0);
    ctx.lineTo(i * laneWidth, rect.height);
    ctx.stroke();
  }

  // เส้นเป้าหมายการกด (Hit Line)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, hitLineY);
  ctx.lineTo(rect.width, hitLineY);
  ctx.stroke();

  // วาดและอัปเดตโน้ตตามเวลาเพลง (Master Clock)
  beatmap.forEach((note) => {
    if (note.hit) return;

    const timeDiff = note.time - currentTime;
    // คำนวณตำแหน่ง Y ให้ถึง Hit Line ที่ timeDiff == 0
    const y = hitLineY - (timeDiff / TRAVEL_TIME) * hitLineY - noteHeight;

    // ถ้าเลยจุดกดเกิน 180ms โดยไม่โดนกด = MISS
    if (!note.missed && timeDiff < -0.18) {
      note.missed = true;
      totalHits++;
      combo = 0;
      setJudgment('MISS', '#ff0055');
      updateHUD();
    }

    // วาดเฉพาะโน้ตที่อยู่บนหน้าจอ
    if (y > -noteHeight && y < rect.height + 20 && !note.missed) {
      const x = note.lane * laneWidth + 8;
      const w = laneWidth - 16;
      const color = LANE_COLORS[note.lane];

      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 15;

      ctx.beginPath();
      ctx.roundRect(x, y, w, noteHeight, 10);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillRect(x + 4, y + 4, w - 8, 4);
      ctx.restore();
    }
  });

  // อนุภาคเอฟเฟกต์สะเก็ดแสง
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
  bgSong.pause();

  const accuracy = totalHits > 0 ? Math.round((perfectHits / totalHits) * 100) : 0;
  await saveScoreRecord(score, maxCombo, accuracy);

  finalScoreEl.innerText = score.toLocaleString();
  finalComboEl.innerText = maxCombo.toString();
  finalAccEl.innerText = `${accuracy}%`;

  modalTitle.innerText = 'SONG FINISHED!';
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
  particles = [];
  beatmap = generateBeatmap();

  updateHUD();
  setJudgment('READY', '#a0aec0');

  modal.classList.add('hide');
  gameState = 'PLAYING';

  bgSong.currentTime = 0;
  bgSong.play().catch(err => {
    console.warn('เบราว์เซอร์ต้องการการแตะเพื่อเริ่มเล่นเสียง:', err);
  });

  animationFrameId = requestAnimationFrame(gameLoop);
}

bgSong.addEventListener('ended', () => {
  if (gameState === 'PLAYING') gameOver();
});

/* ============================================================
   4. MULTI-TOUCH CONTROLLER
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
        .then(() => console.log('Service Worker พร้อมใช้งาน'))
        .catch((err) => console.warn('Service Worker registration failed:', err));
    });
  }
}
