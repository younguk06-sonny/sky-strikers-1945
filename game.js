'use strict';
/* =====================================================================
 * SKY STRIKERS 1945 — 1.1 버전
 * ---------------------------------------------------------------------
 * - Phaser 3 기반 세로 스크롤 슈팅 (기준 해상도 390×844, 화면 비율 유지)
 * - 전투기·적·탄·배경은 전부 Canvas(Graphics)로 직접 그림 → 외부 이미지 불필요
 * - 효과음은 WebAudio로 즉석 합성 → 소리가 막혀 있어도 게임은 그대로 진행
 * - 1.1 추가: 폭탄, 진동 피드백, 오락실 모드(목숨·폭탄 제한·이어하기), 온라인 랭킹
 * - 장면 구성: Boot(그래픽 생성) → Menu(메인) → Game(플레이) + Pause(일시정지)
 * ===================================================================== */

if (!window.Phaser) {
  const m = document.getElementById('boot-msg');
  if (m) m.textContent = '게임 엔진(Phaser)을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 새로고침해 주세요.';
  throw new Error('Phaser not loaded');
}

const GAME_W = 390;
const GAME_H = 844;
const FONT = "'Russo One', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";

const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const rand = Phaser.Math.FloatBetween;
const randInt = Phaser.Math.Between;
const clamp = Phaser.Math.Clamp;

/* ---------------------------------------------------------------------
 * 모드 규칙
 * ------------------------------------------------------------------- */
const MODES = {
  normal: { label: '일반 모드',   desc: '하트 3개 · 폭탄 3개' },
  arcade: { label: '오락실 모드', desc: '목숨 3 · 목숨마다 폭탄 2 · 이어하기 3회' }
};
const ARCADE = { lives: 3, bombsPerLife: 2, credits: 3, continueSec: 10 };
const NORMAL = { hp: 3, bombs: 3 };

/* ---------------------------------------------------------------------
 * 저장소: localStorage가 막힌 환경(시크릿 모드 등)에서도 오류 없이 동작
 * ------------------------------------------------------------------- */
const Store = {
  get(key, def) {
    try {
      const v = localStorage.getItem('ss1945_' + key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('ss1945_' + key, JSON.stringify(val)); } catch (e) { /* 저장 불가 시 무시 */ }
  }
};

const getMode = () => (Store.get('mode', 'normal') === 'arcade' ? 'arcade' : 'normal');
const getBest = (mode) => Store.get('best_' + mode, mode === 'normal' ? Store.get('best', 0) : 0);

/* ---------------------------------------------------------------------
 * 진동: 안드로이드 크롬·삼성 인터넷 등에서 동작, iPhone(Safari)은 미지원
 * ------------------------------------------------------------------- */
const Haptics = {
  supported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
  on: Store.get('vibe', true),
  vibrate(pattern) {
    if (!this.on || !this.supported) return;
    try { navigator.vibrate(pattern); } catch (e) { /* 막힌 환경은 무시 */ }
  },
  toggle() {
    if (!this.supported) return;
    this.on = !this.on;
    Store.set('vibe', this.on);
    if (this.on) this.vibrate(40);
  },
  label() {
    if (!this.supported) return '진동 미지원';
    return this.on ? '진동 ON' : '진동 OFF';
  }
};

/* ---------------------------------------------------------------------
 * 온라인 랭킹 (Supabase REST API, 라이브러리 없이 fetch로 호출)
 * config.js에 키가 없거나 연결이 안 되면 기기 안 기록으로 대신 보여준다.
 * ------------------------------------------------------------------- */
const CFG = window.SS_CONFIG || {};

function dedupeByNick(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = String(r.nickname || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

const Ranking = {
  LIMIT: 15,
  online() { return !!(CFG.supabaseUrl && CFG.supabaseKey); },
  base() { return String(CFG.supabaseUrl).trim().replace(/\/+$/, '') + '/rest/v1/scores'; },
  headers(extra) {
    const key = String(CFG.supabaseKey).trim();
    const h = { apikey: key, 'Content-Type': 'application/json' };
    // 예전 anon 키(eyJ...)는 Authorization에도 넣고, 새 publishable 키(sb_publishable_...)는 apikey만 사용
    if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
    return Object.assign(h, extra || {});
  },
  async request(url, opt) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 7000) : null;
    try {
      return await fetch(url, Object.assign({}, opt, ctrl ? { signal: ctrl.signal } : {}));
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  saveLocal(rec) {
    const key = 'runs_' + rec.mode;
    const list = Store.get(key, []);
    list.push(Object.assign({ created_at: new Date().toISOString() }, rec));
    list.sort((a, b) => b.score - a.score);
    Store.set(key, list.slice(0, 40));
  },
  localTop(mode) { return dedupeByNick(Store.get('runs_' + mode, []), this.LIMIT); },

  // 점수 등록: 항상 기기에 저장 + (설정돼 있으면) 서버로 전송
  async submit(rec) {
    const row = {
      nickname: rec.nickname,
      score: Math.floor(rec.score),
      mode: rec.mode,
      plane: rec.plane,
      continues: rec.continues | 0
    };
    this.saveLocal(row);
    if (!this.online()) return { ok: true, online: false };
    try {
      const r = await this.request(this.base(), {
        method: 'POST',
        headers: this.headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify(row)
      });
      return { ok: r.ok, online: true };
    } catch (e) {
      return { ok: false, online: true };
    }
  },

  // 상위 기록: 닉네임마다 최고 점수 1개만
  async top(mode) {
    if (!this.online()) return { list: this.localTop(mode), source: 'local' };
    try {
      const url = this.base() + '?select=nickname,score,continues,created_at&mode=eq.' +
        encodeURIComponent(mode) + '&order=score.desc&limit=300';
      const r = await this.request(url, { headers: this.headers() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = await r.json();
      return { list: dedupeByNick(rows, this.LIMIT), source: 'online' };
    } catch (e) {
      return { list: this.localTop(mode), source: 'error' };
    }
  }
};

/* ---------------------------------------------------------------------
 * 닉네임 입력창 (index.html의 #name-modal 사용)
 * ------------------------------------------------------------------- */
const NameModal = {
  open(subtitle) {
    return new Promise((resolve) => {
      const m = document.getElementById('name-modal');
      if (!m) { resolve(null); return; }
      const input = document.getElementById('nm-input');
      const ok = document.getElementById('nm-ok');
      const cancel = document.getElementById('nm-cancel');
      const msg = document.getElementById('nm-msg');
      document.getElementById('nm-score').textContent = subtitle;
      input.value = Store.get('nick', '');
      const defaultMsg = Ranking.online()
        ? '친구들과 함께 보는 온라인 랭킹에 올라가요'
        : '온라인 랭킹 미연결 — 이 기기에만 저장돼요';
      msg.textContent = defaultMsg;
      m.classList.remove('hidden');
      setTimeout(() => { try { input.focus(); } catch (e) { /* 무시 */ } }, 60);

      const done = (v) => {
        m.classList.add('hidden');
        ok.onclick = null; cancel.onclick = null; input.onkeydown = null;
        try { input.blur(); } catch (e) { /* 무시 */ }
        resolve(v);
      };
      ok.onclick = () => {
        const v = input.value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
        if (!v) { msg.textContent = '닉네임을 입력해 주세요'; return; }
        if (v.length > 12) { msg.textContent = '12자 이내로 입력해 주세요'; return; }
        Store.set('nick', v);
        done(v);
      };
      cancel.onclick = () => done(null);
      input.onkeydown = (e) => {
        e.stopPropagation();               // 게임 키보드 조작으로 새지 않게
        if (e.key === 'Enter') ok.onclick();
        if (e.key === 'Escape') done(null);
      };
    });
  }
};

/* ---------------------------------------------------------------------
 * 효과음: 파일 없이 오실레이터/노이즈로 합성
 * 브라우저 정책상 첫 터치(버튼) 이후에만 소리가 난다.
 * ------------------------------------------------------------------- */
const Sound = {
  ctx: null, master: null, noiseBuf: null,
  on: Store.get('sound', true),
  lastShot: 0, lastHit: 0,

  unlock() {
    if (!this.on) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.6;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { this.ctx = null; }
  },
  ok() { return this.on && this.ctx && this.ctx.state === 'running'; },

  tone(freq, dur, type, vol, freqEnd) {
    if (!this.ok()) return;
    try {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* 무시 */ }
  },
  noise(dur, vol, freq) {
    if (!this.ok()) return;
    try {
      const t = this.ctx.currentTime;
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(freq, t);
      f.frequency.exponentialRampToValueAtTime(60, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t); s.stop(t + dur);
    } catch (e) { /* 무시 */ }
  },

  shoot() {
    const now = performance.now();
    if (now - this.lastShot < 90) return;
    this.lastShot = now;
    this.tone(1300, 0.045, 'square', 0.015, 650);
  },
  hit() {
    const now = performance.now();
    if (now - this.lastHit < 60) return;
    this.lastHit = now;
    this.tone(320, 0.04, 'square', 0.025, 180);
  },
  boom(size) {
    this.noise(0.25 + size * 0.25, 0.22 + size * 0.12, 2000 - size * 450);
    if (size >= 1) this.tone(130, 0.3 + size * 0.2, 'sine', 0.18, 35);
  },
  bomb() {
    this.noise(1.4, 0.45, 2600);
    this.tone(95, 1.1, 'sine', 0.28, 28);
  },
  hurt() {
    this.tone(240, 0.28, 'sawtooth', 0.07, 60);
    this.noise(0.2, 0.18, 1400);
  },
  tick() { this.tone(880, 0.08, 'square', 0.04); },
  click() { this.tone(660, 0.07, 'square', 0.035, 990); },
  toggle() {
    this.on = !this.on;
    Store.set('sound', this.on);
    if (this.on) this.unlock();
  },
  label() { return this.on ? '사운드 ON' : '사운드 OFF'; }
};

/* ---------------------------------------------------------------------
 * 게임 데이터
 * ------------------------------------------------------------------- */
const PLANES = [
  { id: 'RAPTOR-X',  type: '균형형',   atk: 3, spd: 3, def: 3, desc: '기관포 + 유도미사일', unlocked: true },
  { id: 'PHANTOM-Z', type: '고속형',   atk: 2, spd: 5, def: 2, desc: '관통 레이저',       unlocked: false },
  { id: 'THUNDER-A', type: '중장갑형', atk: 4, spd: 2, def: 5, desc: '확산탄',            unlocked: false },
  { id: 'BLAZE-F',   type: '공격형',   atk: 5, spd: 3, def: 2, desc: '폭발형 특수탄',     unlocked: false }
];

// 적 3종: 체력·점수·충돌 반경·폭발 크기 (폭격기는 지금 단계의 중간 보스)
const ENEMY = {
  fighter: { key: 'e_fighter', hp: 1,  score: 100,  radius: 15, boom: 0 },
  heli:    { key: 'e_heli',    hp: 6,  score: 400,  radius: 20, boom: 1 },
  bomber:  { key: 'e_bomber',  hp: 34, score: 2000, radius: 0,  boom: 2 }
};

/* ---------------------------------------------------------------------
 * 공통 UI 도우미
 * ------------------------------------------------------------------- */
function txt(scene, x, y, str, size, color, extra) {
  return scene.add.text(x, y, str, Object.assign({
    fontFamily: FONT, fontSize: size + 'px', color, padding: { x: 2, y: 2 }
  }, extra || {})).setOrigin(0.5);
}

const BTN_STYLES = {
  primary:   { top: 0xffc93c, bot: 0xc77d00, text: '#3a2000', line: 0xfff1b8 },
  secondary: { top: 0x24456e, bot: 0x112238, text: '#e8f1ff', line: 0x6fb3ff },
  accent:    { top: 0x2ec4b6, bot: 0x16776f, text: '#04302b', line: 0xb8fff6 }
};

// 눌림 효과가 있는 버튼 (손가락을 버튼 위에서 뗐을 때만 실행)
function makeButton(scene, x, y, w, h, label, onClick, style, fontSize) {
  const c = scene.add.container(x, y);
  const g = scene.add.graphics();
  const col = BTN_STYLES[style] || BTN_STYLES.primary;
  const r = Math.min(16, h / 2 - 2);
  const draw = (pressed) => {
    g.clear();
    const off = pressed ? 3 : 0;
    g.fillStyle(col.bot, 1);
    g.fillRoundedRect(-w / 2, -h / 2 + 4, w, h - 4, r);
    g.fillStyle(col.top, 1);
    g.fillRoundedRect(-w / 2, -h / 2 + off, w, h - 4, r);
    g.lineStyle(2, col.line, 0.55);
    g.strokeRoundedRect(-w / 2 + 1, -h / 2 + off + 1, w - 2, h - 6, r - 1);
  };
  draw(false);
  const t = txt(scene, 0, -2, label, fontSize || 24, col.text);
  c.add([g, t]);
  c.setSize(w, h);
  c.setInteractive({ useHandCursor: true });
  c.on('pointerdown', () => { c.pressed = true; draw(true); t.y = 1; });
  c.on('pointerout', () => { c.pressed = false; draw(false); t.y = -2; });
  c.on('pointerup', () => {
    if (!c.pressed) return;
    c.pressed = false; draw(false); t.y = -2;
    Sound.unlock(); Sound.click();
    onClick();
  });
  c.label = t;
  return c;
}

// 두 칸짜리 선택 스위치 (일반/오락실 모드 등)
function makeToggle(scene, x, y, w, h, labels, idx, onChange) {
  const c = scene.add.container(x, y);
  const g = scene.add.graphics();
  const texts = labels.map((l, i) => txt(scene, -w / 4 + i * (w / 2), 0, l, 16, '#cfe3ff'));
  const draw = () => {
    g.clear();
    g.fillStyle(0x0b1a2e, 0.85); g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(1.5, 0x5fa8ff, 0.6); g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.fillStyle(0xffc93c, 1); g.fillRoundedRect(-w / 2 + 3 + idx * (w / 2), -h / 2 + 3, w / 2 - 6, h - 6, (h - 6) / 2);
    texts.forEach((t, i) => t.setColor(i === idx ? '#3a2000' : '#cfe3ff'));
  };
  c.add([g].concat(texts));
  labels.forEach((l, i) => {
    const z = scene.add.zone(-w / 4 + i * (w / 2), 0, w / 2, h).setInteractive({ useHandCursor: true });
    z.on('pointerup', () => {
      if (idx === i) return;
      idx = i; draw();
      Sound.unlock(); Sound.click();
      onChange(i);
    });
    c.add(z);
  });
  draw();
  return c;
}

// 창(오버레이)을 닫을 때 안쪽 버튼의 입력까지 확실히 끈다
function setInputEnabled(obj, on) {
  if (obj.input) obj.input.enabled = on;
  if (obj.list) obj.list.forEach((o) => setInputEnabled(o, on));
}

function drawPanel(scene, x, y, w, h) {
  const g = scene.add.graphics();
  g.fillStyle(0x0f2440, 0.97); g.fillRoundedRect(x, y, w, h, 22);
  g.lineStyle(2, 0x5fa8ff, 0.6); g.strokeRoundedRect(x, y, w, h, 22);
  return g;
}

/* ---------------------------------------------------------------------
 * 그래픽 그리기 함수 (Boot에서 텍스처로 구워 둔다)
 * ------------------------------------------------------------------- */
function drawPlayer(g, c) {
  const C = Phaser.Display.Color;
  const dark = C.IntegerToColor(c).darken(25).color;
  const light = C.IntegerToColor(c).lighten(18).color;
  g.fillStyle(dark, 1); g.fillRoundedRect(2, 28, 52, 12, 5);
  g.fillStyle(c, 1); g.fillRoundedRect(2, 26, 52, 10, 5);
  g.fillStyle(light, 1); g.fillRect(7, 27, 42, 2);
  g.fillStyle(dark, 1); g.fillRoundedRect(15, 46, 26, 7, 3);
  g.fillStyle(c, 1); g.fillRoundedRect(15, 45, 26, 5, 3);
  g.fillStyle(0x8c99a8, 1); g.fillRoundedRect(22, 6, 12, 46, 6);
  g.fillStyle(0xdbe3ec, 1); g.fillRoundedRect(24, 7, 6, 42, 3);
  g.fillStyle(0xf2c14e, 1); g.fillTriangle(22, 12, 34, 12, 28, 2);
  g.fillStyle(0x1b1b1b, 0.75); g.fillRect(17, 3, 22, 2);
  g.fillStyle(0x1d2f45, 1); g.fillEllipse(28, 22, 7, 11);
  g.fillStyle(0x8fd3ff, 1); g.fillEllipse(27, 20, 2.5, 4);
  g.fillStyle(0xffffff, 1); g.fillCircle(11, 31, 3.5); g.fillCircle(45, 31, 3.5);
  g.fillStyle(0xe63946, 1); g.fillCircle(11, 31, 1.8); g.fillCircle(45, 31, 1.8);
  g.fillStyle(0x333a44, 1); g.fillRect(16, 21, 2, 6); g.fillRect(38, 21, 2, 6);
}

function drawFighter(g) { // 44×44, 기수가 아래
  g.fillStyle(0x7a2424, 1); g.fillRoundedRect(12, 2, 20, 6, 3);
  g.fillStyle(0x7a2424, 1); g.fillRoundedRect(1, 17, 42, 11, 5);
  g.fillStyle(0xa83434, 1); g.fillRoundedRect(1, 15, 42, 10, 5);
  g.fillStyle(0xd65a5a, 1); g.fillRect(5, 22, 34, 2);
  g.fillStyle(0x5a5a5a, 1); g.fillRoundedRect(17, 2, 10, 38, 5);
  g.fillStyle(0xc04444, 1); g.fillRoundedRect(18, 3, 8, 34, 4);
  g.fillStyle(0x333333, 1); g.fillTriangle(17, 34, 27, 34, 22, 43);
  g.fillStyle(0x111111, 0.75); g.fillRect(13, 41, 18, 2);
  g.fillStyle(0x222b33, 1); g.fillEllipse(22, 26, 6, 9);
  g.fillStyle(0xffd447, 1); g.fillCircle(8, 20, 3); g.fillCircle(36, 20, 3);
}

function drawHeli(g) { // 52×64, 기수가 아래
  g.fillStyle(0x3e5a3b, 1); g.fillRoundedRect(23, 2, 6, 30, 3);
  g.fillStyle(0x2c4029, 1); g.fillRect(15, 2, 22, 4);
  g.fillStyle(0x2c4029, 1); g.fillRect(5, 35, 42, 5);
  g.fillStyle(0x444444, 1); g.fillRoundedRect(4, 38, 9, 9, 2); g.fillRoundedRect(39, 38, 9, 9, 2);
  g.fillStyle(0x4a6b46, 1); g.fillEllipse(26, 41, 30, 40);
  g.fillStyle(0x6f9669, 1); g.fillEllipse(22, 37, 10, 20);
  g.fillStyle(0x1e2c33, 1); g.fillEllipse(26, 55, 18, 12);
  g.fillStyle(0x9ed8ff, 0.8); g.fillEllipse(23, 54, 6, 4);
}

function drawRotor(g) { // 72×72
  g.fillStyle(0x111111, 0.5);
  g.fillRoundedRect(1, 34, 70, 4, 2);
  g.fillRoundedRect(34, 1, 4, 70, 2);
  g.fillStyle(0x555555, 1); g.fillCircle(36, 36, 4);
}

function drawBomber(g) { // 128×88, 기수가 아래
  const b = 0x56616f, d = 0x3a434e, l = 0x7d8a99;
  g.fillStyle(d, 1); g.fillRoundedRect(40, 2, 48, 10, 4);
  g.fillStyle(d, 1); g.fillRoundedRect(2, 31, 124, 19, 8);
  g.fillStyle(b, 1); g.fillRoundedRect(2, 28, 124, 18, 8);
  g.fillStyle(l, 1); g.fillRect(8, 30, 112, 3);
  [22, 44, 84, 106].forEach((x) => {
    g.fillStyle(d, 1); g.fillRoundedRect(x - 6, 36, 12, 20, 5);
    g.fillStyle(0x1a1a1a, 0.8); g.fillRect(x - 8, 56, 16, 2);
  });
  g.fillStyle(d, 1); g.fillRoundedRect(54, 0, 20, 82, 10);
  g.fillStyle(b, 1); g.fillRoundedRect(56, 2, 16, 76, 8);
  g.fillStyle(0x1e2c33, 1); g.fillEllipse(64, 78, 14, 14);
  g.fillStyle(0x9ed8ff, 0.7); g.fillEllipse(61, 76, 5, 5);
  g.fillStyle(0xd23b3b, 1); g.fillCircle(18, 37, 4); g.fillCircle(110, 37, 4);
  g.fillStyle(0x2a2f36, 1); g.fillCircle(64, 42, 6);
}

/* =====================================================================
 * Boot: 모든 텍스처를 Canvas로 생성
 * ===================================================================== */
class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    const tex = (key, w, h, fn) => {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      fn(g);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    tex('player', 56, 56, (g) => drawPlayer(g, 0x3b78c4));
    tex('e_fighter', 44, 44, drawFighter);
    tex('e_heli', 52, 64, drawHeli);
    tex('rotor', 72, 72, drawRotor);
    tex('e_bomber', 128, 88, drawBomber);

    tex('pb', 8, 22, (g) => {
      g.fillStyle(0xffb300, 0.45); g.fillRoundedRect(0, 2, 8, 20, 4);
      g.fillStyle(0xfff6b0, 1); g.fillRoundedRect(2, 0, 4, 22, 2);
    });
    tex('eb', 14, 14, (g) => {
      g.fillStyle(0xff2e74, 1); g.fillCircle(7, 7, 7);
      g.fillStyle(0xffffff, 1); g.fillCircle(7, 7, 3.5);
    });
    tex('eb2', 22, 22, (g) => {
      g.fillStyle(0xff8a00, 0.45); g.fillCircle(11, 11, 11);
      g.fillStyle(0xffa62e, 1); g.fillCircle(11, 11, 8);
      g.fillStyle(0xffffff, 1); g.fillCircle(11, 11, 4);
    });
    tex('flame', 14, 24, (g) => {
      g.fillStyle(0xff6a00, 0.55); g.fillEllipse(7, 12, 14, 24);
      g.fillStyle(0xffc23d, 0.9); g.fillEllipse(7, 10, 9, 16);
      g.fillStyle(0xfff6d0, 1); g.fillEllipse(7, 8, 4, 8);
    });
    tex('flash', 64, 64, (g) => {
      for (let r = 32; r > 0; r -= 3) { g.fillStyle(0xffffff, 0.08); g.fillCircle(32, 32, r); }
      g.fillStyle(0xffffff, 0.9); g.fillCircle(32, 32, 6);
    });
    tex('spark', 12, 12, (g) => {
      g.fillStyle(0xffffff, 0.45); g.fillCircle(6, 6, 6);
      g.fillStyle(0xffffff, 1); g.fillCircle(6, 6, 3);
    });
    tex('smoke', 28, 28, (g) => {
      for (let r = 14; r > 0; r -= 2) { g.fillStyle(0x777777, 0.12); g.fillCircle(14, 14, r); }
    });
    tex('heart', 22, 20, (g) => {
      g.fillStyle(0xff4d6d, 1); g.fillCircle(6, 7, 6); g.fillCircle(16, 7, 6); g.fillTriangle(0.5, 9, 21.5, 9, 11, 19.5);
      g.fillStyle(0xffffff, 0.6); g.fillCircle(5, 5, 2);
    });
    tex('heart_e', 22, 20, (g) => {
      g.fillStyle(0x2b3a4f, 1); g.fillCircle(6, 7, 6); g.fillCircle(16, 7, 6); g.fillTriangle(0.5, 9, 21.5, 9, 11, 19.5);
    });
    tex('sea', 128, 128, (g) => {
      g.fillStyle(0x16507a, 1); g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 6; i++) { g.fillStyle(0x124668, 0.5); g.fillEllipse(20 + rnd() * 88, 20 + rnd() * 88, 20 + rnd() * 18, 10 + rnd() * 8); }
      for (let i = 0; i < 22; i++) { g.fillStyle(0x2c74a6, 0.55); g.fillRoundedRect(4 + rnd() * 96, 4 + rnd() * 118, 8 + rnd() * 18, 2, 1); }
    });
    tex('glint', 128, 256, (g) => {
      for (let i = 0; i < 10; i++) { g.fillStyle(0xffffff, 0.18 + rnd() * 0.15); g.fillRoundedRect(6 + rnd() * 100, 6 + rnd() * 240, 4 + rnd() * 10, 2, 1); }
    });
    tex('island', 150, 110, (g) => {
      g.fillStyle(0x3fa0c0, 0.45); g.fillEllipse(75, 55, 150, 108);
      g.fillStyle(0xd9c48a, 1); g.fillEllipse(75, 55, 128, 88);
      g.fillStyle(0x3f8a3a, 1); g.fillEllipse(72, 52, 96, 62);
      g.fillStyle(0x2f6e2c, 1); g.fillEllipse(60, 45, 40, 26); g.fillEllipse(92, 60, 36, 22);
    });
    tex('cloud', 180, 96, (g) => {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(50, 56, 30); g.fillCircle(86, 42, 36); g.fillCircle(126, 52, 32);
      g.fillCircle(152, 64, 22); g.fillCircle(28, 66, 20); g.fillRoundedRect(28, 56, 126, 30, 14);
    });

    const ct = this.textures.createCanvas('vgrad', 4, 256);
    const ctx = ct.getContext();
    const gr = ctx.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, 'rgba(0,8,20,0.85)');
    gr.addColorStop(1, 'rgba(0,8,20,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 4, 256);
    ct.refresh();

    const msg = document.getElementById('boot-msg');
    if (msg) msg.remove();
    this.scene.start('Menu');
  }
}

/* =====================================================================
 * Menu: 로고, 움직이는 배경, 모드 선택, 시작/기체/랭킹/설정
 * ===================================================================== */
class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create() {
    const W = GAME_W, H = GAME_H;

    // 배경
    this.sea = this.add.tileSprite(0, 0, W, H, 'sea').setOrigin(0);
    this.glint = this.add.tileSprite(0, 0, W, H, 'glint').setOrigin(0);
    this.island = this.add.image(randInt(60, W - 60), randInt(100, H - 200), 'island').setScale(1.2);
    this.clouds = [];
    for (let i = 0; i < 5; i++) {
      const c = this.add.image(randInt(0, W), randInt(0, H), 'cloud').setAlpha(0.32).setScale(rand(0.8, 1.6)).setDepth(3);
      c.speed = randInt(50, 90);
      this.clouds.push(c);
    }
    this.fly = this.add.image(W * 0.3, H + 80, 'player').setDepth(5).setScale(1.15);
    this.flyFlame = this.add.image(0, 0, 'flame').setOrigin(0.5, 0.1).setDepth(4).setScale(1.15);
    this.flyEnemies = [];
    for (let i = 0; i < 3; i++) this.flyEnemies.push(this.add.image(70 + i * 125, -80 - i * 170, 'e_fighter').setDepth(5));
    this.add.image(0, 0, 'vgrad').setOrigin(0).setDisplaySize(W, 430).setDepth(8);
    this.add.image(0, H - 470, 'vgrad').setOrigin(0).setFlipY(true).setDisplaySize(W, 470).setDepth(8);

    // 로고
    const logo = this.add.container(W / 2, 190).setDepth(10);
    const sky = txt(this, 0, -52, 'SKY STRIKERS', 40, '#ffffff', { stroke: '#0b2545', strokeThickness: 8 });
    sky.setShadow(0, 4, '#000000', 6, true, true);
    const year = txt(this, 0, 28, '1945', 96, '#ffc93c', { stroke: '#3a1d00', strokeThickness: 10 });
    const grd = year.context.createLinearGradient(0, 0, 0, year.height);
    grd.addColorStop(0, '#fff4c2'); grd.addColorStop(0.5, '#ffc93c'); grd.addColorStop(1, '#ff7b1c');
    year.setFill(grd);
    year.setShadow(0, 6, '#000000', 8, true, true);
    const sub = txt(this, 0, 100, '— ARCADE SHOOTER —', 15, '#9ec9ff');
    logo.add([sky, year, sub]);
    this.tweens.add({ targets: logo, y: 198, duration: 1800, yoyo: true, repeat: -1, ease: 'Sine.inOut' });

    // 최고 점수 · 선택 기체
    this.mode = getMode();
    const pill = this.add.graphics().setDepth(10);
    pill.fillStyle(0x000814, 0.55); pill.fillRoundedRect(W / 2 - 130, 318, 260, 70, 18);
    pill.lineStyle(1.5, 0xffd166, 0.5); pill.strokeRoundedRect(W / 2 - 130, 318, 260, 70, 18);
    this.bestLabel = txt(this, W / 2, 340, '', 22, '#ffd166').setDepth(11);
    this.planeLabel = txt(this, W / 2, 369, '기체  ' + Store.get('plane', 'RAPTOR-X'), 14, '#cfe3ff').setDepth(11);

    // 모드 선택
    makeToggle(this, W / 2, 432, 300, 46, [MODES.normal.label, MODES.arcade.label], this.mode === 'arcade' ? 1 : 0, (i) => {
      this.mode = i === 1 ? 'arcade' : 'normal';
      Store.set('mode', this.mode);
      this.refreshModeInfo();
    }).setDepth(20);
    this.modeDesc = txt(this, W / 2, 472, '', 13, '#9ec9ff').setDepth(20);
    this.refreshModeInfo();

    // 버튼
    const start = makeButton(this, W / 2, 540, 260, 70, 'GAME START', () => this.scene.start('Game'), 'primary', 28).setDepth(20);
    this.tweens.add({ targets: start, scale: 1.04, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
    makeButton(this, W / 2 - 66, 620, 124, 52, '기체 선택', () => this.openOverlay(this.hangar), 'secondary', 18).setDepth(20);
    makeButton(this, W / 2 + 66, 620, 124, 52, '랭킹', () => this.openRanking(), 'accent', 20).setDepth(20);
    const sBtn = makeButton(this, W / 2 - 66, 684, 124, 44, Sound.label(), () => sBtn.label.setText((Sound.toggle(), Sound.label())), 'secondary', 15).setDepth(20);
    const vBtn = makeButton(this, W / 2 + 66, 684, 124, 44, Haptics.label(), () => vBtn.label.setText((Haptics.toggle(), Haptics.label())), 'secondary', 15).setDepth(20);

    txt(this, W / 2, 760, '드래그로 이동 · 자동 발사 · BOMB 버튼', 13, '#9ec9ff').setDepth(20);
    txt(this, W / 2, 782, 'PC: 방향키·WASD 이동 · SPACE 폭탄 · P 일시정지', 11.5, '#6f8fb5').setDepth(20);

    this.hangar = this.buildHangar();
    this.ranking = this.buildRanking();
  }

  refreshModeInfo() {
    this.bestLabel.setText('BEST  ' + fmt(getBest(this.mode)));
    this.modeDesc.setText(MODES[this.mode].desc);
  }

  openOverlay(c) { c.setVisible(true); setInputEnabled(c, true); }
  closeOverlay(c) { c.setVisible(false); setInputEnabled(c, false); }

  // 기체 선택 창 (1차 버전은 RAPTOR-X만 사용 가능)
  buildHangar() {
    const W = GAME_W, H = GAME_H;
    const c = this.add.container(0, 0).setDepth(100);
    const dim = this.add.rectangle(0, 0, W, H, 0x000814, 0.85).setOrigin(0).setInteractive();
    c.add([dim, drawPanel(this, 20, 90, W - 40, 640), txt(this, W / 2, 130, 'HANGAR', 30, '#ffffff'), txt(this, W / 2, 163, '기체 선택', 14, '#9ec9ff')]);

    const p = PLANES[0];
    const card = this.add.graphics();
    card.fillStyle(0x163256, 1); card.fillRoundedRect(40, 190, W - 80, 250, 16);
    card.lineStyle(2.5, 0xffc93c, 0.9); card.strokeRoundedRect(40, 190, W - 80, 250, 16);
    const plane = this.add.image(100, 300, 'player').setScale(1.7);
    this.tweens.add({ targets: plane, y: 292, duration: 1200, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
    c.add([card, plane,
      this.add.text(160, 212, p.id, { fontFamily: FONT, fontSize: '26px', color: '#ffffff' }),
      this.add.text(160, 246, p.type, { fontFamily: FONT, fontSize: '15px', color: '#ffd166' })]);
    const bars = this.add.graphics();
    [['공격력', p.atk], ['속도', p.spd], ['방어력', p.def]].forEach(([label, v], i) => {
      const y = 288 + i * 34;
      c.add(this.add.text(160, y - 9, label, { fontFamily: FONT, fontSize: '14px', color: '#cfe3ff' }));
      for (let k = 0; k < 5; k++) {
        bars.fillStyle(k < v ? 0x5fd3ff : 0x23405f, 1);
        bars.fillRoundedRect(215 + k * 24, y - 6, 20, 12, 3);
      }
    });
    c.add(bars);
    c.add(txt(this, W / 2, 410, p.desc + ' (미사일은 2차 버전)', 14, '#cfe3ff'));

    c.add(txt(this, W / 2, 474, '추가 기체 — 2차 버전에서 열려요', 14, '#9ec9ff'));
    PLANES.slice(1).forEach((pl, i) => {
      const cx = W / 2 - 104 + i * 104;
      const cg = this.add.graphics();
      cg.fillStyle(0x112238, 1); cg.fillRoundedRect(cx - 48, 498, 96, 150, 12);
      cg.lineStyle(1.5, 0x35567e, 1); cg.strokeRoundedRect(cx - 48, 498, 96, 150, 12);
      const sil = this.add.image(cx, 556, 'player').setTintFill(0x0a1626);
      const lock = this.add.graphics();
      lock.lineStyle(3, 0x9ec9ff, 1); lock.beginPath(); lock.arc(cx, 552, 7, Math.PI, 0); lock.strokePath();
      lock.fillStyle(0x9ec9ff, 1); lock.fillRoundedRect(cx - 10, 552, 20, 15, 3);
      c.add([cg, sil, lock, txt(this, cx, 610, pl.id, 13, '#e8f1ff'), txt(this, cx, 630, pl.type, 12, '#6f8fb5')]);
    });

    c.add(makeButton(this, W / 2, 690, 220, 54, '확인', () => {
      Store.set('plane', p.id);
      this.planeLabel.setText('기체  ' + p.id);
      this.closeOverlay(c);
    }, 'primary', 22));
    this.closeOverlay(c);
    return c;
  }

  // 랭킹 창: 모드별 상위 15명 (온라인 → 실패 시 기기 기록)
  buildRanking() {
    const W = GAME_W, H = GAME_H;
    const c = this.add.container(0, 0).setDepth(100);
    const dim = this.add.rectangle(0, 0, W, H, 0x000814, 0.85).setOrigin(0).setInteractive();
    c.add([dim, drawPanel(this, 20, 70, W - 40, 720), txt(this, W / 2, 110, 'RANKING', 30, '#ffffff')]);
    this.rankMode = this.mode;
    this.rankTabs = makeToggle(this, W / 2, 160, 300, 42, [MODES.normal.label, MODES.arcade.label], this.rankMode === 'arcade' ? 1 : 0, (i) => {
      this.rankMode = i === 1 ? 'arcade' : 'normal';
      this.loadRanking();
    });
    c.add(this.rankTabs);
    this.rankStatus = txt(this, W / 2, 202, '', 12.5, '#9ec9ff');
    c.add(this.rankStatus);

    this.rankRows = [];
    for (let i = 0; i < Ranking.LIMIT; i++) {
      const y = 240 + i * 30;
      const rk = txt(this, 58, y, '', 16, '#cfe3ff');
      const nick = this.add.text(84, y, '', { fontFamily: FONT, fontSize: '15px', color: '#ffffff' }).setOrigin(0, 0.5);
      const sc = this.add.text(334, y, '', { fontFamily: FONT, fontSize: '17px', color: '#ffffff' }).setOrigin(1, 0.5);
      c.add([rk, nick, sc]);
      this.rankRows.push({ rk, nick, sc });
    }
    c.add(makeButton(this, W / 2, 735, 220, 52, '닫기', () => this.closeOverlay(c), 'primary', 22));
    this.closeOverlay(c);
    return c;
  }

  openRanking() {
    this.openOverlay(this.ranking);
    this.loadRanking();
  }

  async loadRanking() {
    const mode = this.rankMode;
    const token = (this.rankToken = (this.rankToken || 0) + 1);
    this.rankRows.forEach((r) => { r.rk.setText(''); r.nick.setText(''); r.sc.setText(''); });
    this.rankStatus.setText('불러오는 중…');
    const res = await Ranking.top(mode);
    if (token !== this.rankToken || !this.sys || !this.sys.isActive()) return;   // 그사이 탭이 바뀌었거나 화면을 떠남
    const status = {
      online: '온라인 랭킹 · 닉네임별 최고 점수',
      local: '온라인 랭킹 미연결 — 이 기기 기록',
      error: '온라인 연결 실패 — 이 기기 기록'
    };
    this.rankStatus.setText(status[res.source]);
    if (!res.list.length) { this.rankRows[3].nick.setText('아직 기록이 없어요'); return; }
    const medal = ['#ffd166', '#dfe7f2', '#e0a274'];
    res.list.forEach((r, i) => {
      const row = this.rankRows[i];
      if (!row) return;
      let name = String(r.nickname || '');
      if (name.length > 8) name = name.slice(0, 8) + '…';
      if (mode === 'arcade' && r.continues > 0) name += ' ·C' + r.continues;   // 이어하기 횟수 표시
      row.rk.setText(String(i + 1)).setColor(medal[i] || '#cfe3ff');
      row.nick.setText(name).setColor(i < 3 ? medal[i] : '#ffffff');
      row.sc.setText(fmt(r.score));
    });
  }

  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;
    const W = GAME_W, H = GAME_H;
    this.sea.tilePositionY -= 40 * dt;
    this.glint.tilePositionY -= 60 * dt;
    this.island.y += 40 * dt;
    if (this.island.y > H + 80) { this.island.y = -80; this.island.x = randInt(60, W - 60); }
    this.clouds.forEach((c) => {
      c.y += c.speed * dt;
      if (c.y > H + 60) { c.y = -60; c.x = randInt(0, W); }
    });
    this.fly.y -= 130 * dt;
    if (this.fly.y < -80) { this.fly.y = H + 80; this.fly.x = randInt(60, W - 60); }
    this.flyFlame.setPosition(this.fly.x, this.fly.y + 27).setScale(1.1, 0.9 + Math.random() * 0.5);
    this.flyEnemies.forEach((e) => {
      e.y += 95 * dt;
      if (e.y > H + 60) { e.y = randInt(-260, -60); e.x = randInt(40, W - 40); }
    });
  }
}

/* =====================================================================
 * Game: 실제 플레이
 * ===================================================================== */
class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  create() {
    const W = GAME_W, H = GAME_H;
    const mode = getMode();

    // ---- 상태 초기화 (재시작 때마다 새로 만든다) ----
    this.state = {
      mode,
      score: 0, combo: 0, comboTimer: 0, elapsed: 0, kills: 0,
      hp: NORMAL.hp, maxHp: NORMAL.hp,                         // 일반 모드
      lives: ARCADE.lives, credits: ARCADE.credits, continues: 0, // 오락실 모드
      bombs: mode === 'arcade' ? ARCADE.bombsPerLife : NORMAL.bombs,
      dead: false,     // 오락실 모드에서 격추되어 다시 나오기 전
      frozen: false,   // 이어하기 카운트다운 중
      over: false,
      best: getBest(mode)
    };
    this.fireTimer = 0;
    this.muzzleT = 0;
    this.bombT = 0;
    this.spawnT = 1.6;
    this.islandT = 3;
    this.cloudT = 1;
    this.invuln = 1.5;
    this.drag = null;
    this.trash = [];
    this.floatCount = 0;

    // ---- 배경 ----
    this.sea = this.add.tileSprite(0, 0, W, H, 'sea').setOrigin(0).setDepth(0);
    this.glint = this.add.tileSprite(0, 0, W, H, 'glint').setOrigin(0).setDepth(0.5);
    this.scenery = this.add.group();
    this.spawnIsland(randInt(80, H - 300));
    for (let i = 0; i < 3; i++) this.spawnCloud(randInt(0, H));

    // ---- 플레이어 ----
    this.player = this.physics.add.sprite(W / 2, H - 170, 'player').setDepth(10);
    this.player.body.moves = false;
    this.player.body.setCircle(7, 21, 15);   // 판정은 조종석 주변의 작은 원
    this.flame = this.add.image(0, 0, 'flame').setOrigin(0.5, 0.1).setDepth(9);
    this.muzzle = this.add.image(0, 0, 'flash').setDepth(11).setScale(0.3)
      .setTint(0xffe27a).setBlendMode(Phaser.BlendModes.ADD).setVisible(false);
    this.target = { x: this.player.x, y: this.player.y };

    // ---- 오브젝트 그룹 (탄은 재사용 풀) ----
    this.pBullets = this.physics.add.group({ maxSize: 90 });
    this.eBullets = this.physics.add.group({ maxSize: 260 });
    this.enemies = this.physics.add.group();

    // ---- 파티클 ----
    this.fxFire = this.add.particles(0, 0, 'spark', {
      speed: { min: 50, max: 260 }, lifespan: { min: 250, max: 650 },
      scale: { start: 1.3, end: 0 }, tint: [0xffffff, 0xffe066, 0xff9a2e, 0xff5a1f],
      blendMode: 'ADD', emitting: false
    }).setDepth(14);
    this.fxSmoke = this.add.particles(0, 0, 'smoke', {
      speed: { min: 15, max: 70 }, lifespan: { min: 500, max: 900 },
      scale: { start: 0.6, end: 1.7 }, alpha: { start: 0.55, end: 0 }, emitting: false
    }).setDepth(13);
    this.fxHit = this.add.particles(0, 0, 'spark', {
      speed: { min: 40, max: 140 }, lifespan: 180, scale: { start: 0.7, end: 0 },
      tint: 0xfff3a0, blendMode: 'ADD', emitting: false
    }).setDepth(14);

    // ---- 충돌 ----
    this.physics.add.overlap(this.pBullets, this.enemies, this.onBulletHitEnemy, null, this);
    this.physics.add.overlap(this.player, this.eBullets, this.onPlayerHitBullet, null, this);
    this.physics.add.overlap(this.player, this.enemies, this.onPlayerHitEnemy, null, this);

    // ---- 입력 ----
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on('pointerupoutside', this.onPointerUp, this);
    this.keys = null;
    if (this.input.keyboard) {
      // 두 번째 인자 false: 키를 가로채지 않아 닉네임 입력창에 타자가 정상 입력됨
      this.keys = this.input.keyboard.addKeys('UP,DOWN,LEFT,RIGHT,W,A,S,D', false);
      this.input.keyboard.on('keydown-P', () => this.openPause());
      this.input.keyboard.on('keydown-ESC', () => this.openPause());
      this.input.keyboard.on('keydown-SPACE', () => this.useBomb());
      this.input.keyboard.on('keydown-B', () => this.useBomb());
    }

    const onVis = () => { if (document.hidden) this.openPause(); };
    const onResume = () => { this.drag = null; };
    document.addEventListener('visibilitychange', onVis);
    this.events.on('resume', onResume);
    this.events.once('shutdown', () => {
      document.removeEventListener('visibilitychange', onVis);
      this.events.off('resume', onResume);
    });

    this.buildHud();

    const banner = txt(this, W / 2, H / 2 - 60, mode === 'arcade' ? 'ARCADE MODE' : 'READY', 34, '#ffe066', { stroke: '#3a1d00', strokeThickness: 6 }).setDepth(40);
    const hint = txt(this, W / 2, H - 150, '드래그로 이동 · 위급할 땐 BOMB', 16, '#ffffff', { stroke: '#000000', strokeThickness: 4 }).setDepth(40);
    this.tweens.add({ targets: [banner, hint], alpha: 0, delay: 2200, duration: 600, onComplete: () => { banner.destroy(); hint.destroy(); } });
  }

  /* ------------------------- HUD ------------------------- */
  buildHud() {
    const W = GAME_W, H = GAME_H, s = this.state;
    this.add.image(0, 0, 'vgrad').setOrigin(0).setDisplaySize(W, 110).setDepth(49);
    this.add.text(16, 12, 'SCORE', { fontFamily: FONT, fontSize: '13px', color: '#9ec9ff' }).setDepth(50);
    this.scoreText = this.add.text(16, 28, '0', {
      fontFamily: FONT, fontSize: '26px', color: '#ffffff', stroke: '#000000', strokeThickness: 3
    }).setDepth(50);
    this.add.text(16, 62, 'BEST ' + fmt(s.best), { fontFamily: FONT, fontSize: '13px', color: '#ffd166' }).setDepth(50);

    // 일반: 하트 / 오락실: 남은 기체 아이콘 + 크레딧
    this.lifeIcons = [];
    const count = s.mode === 'arcade' ? ARCADE.lives : s.maxHp;
    for (let i = 0; i < count; i++) {
      const icon = s.mode === 'arcade'
        ? this.add.image(W - 76 - i * 27, 35, 'player').setScale(0.4)
        : this.add.image(W - 76 - i * 27, 35, 'heart');
      this.lifeIcons.push(icon.setDepth(50));
    }
    if (s.mode === 'arcade') {
      this.creditText = this.add.text(W - 16, 64, '', { fontFamily: FONT, fontSize: '12px', color: '#9ec9ff' }).setOrigin(1, 0).setDepth(50);
    }
    this.updateLifeUi();

    // 일시정지 버튼
    const pb = this.add.container(W - 32, 35).setDepth(60);
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.4); g.fillCircle(0, 0, 20);
    g.lineStyle(2, 0xffffff, 0.5); g.strokeCircle(0, 0, 20);
    g.fillStyle(0xffffff, 1); g.fillRoundedRect(-7, -8, 5, 16, 1.5); g.fillRoundedRect(2, -8, 5, 16, 1.5);
    pb.add(g);
    pb.setSize(52, 52).setInteractive({ useHandCursor: true });
    pb.on('pointerup', () => { Sound.click(); this.openPause(); });
    this.pauseBtn = pb;

    // 폭탄 버튼 (오른쪽 아래, 누르는 순간 발동)
    const bb = this.add.container(W - 60, H - 78).setDepth(60).setAlpha(0.9);
    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.35); bg.fillCircle(0, 4, 38);
    bg.fillStyle(0xd62839, 0.95); bg.fillCircle(0, 0, 36);
    bg.lineStyle(3, 0xffd0d5, 0.8); bg.strokeCircle(0, 0, 33);
    this.bombCount = txt(this, 0, 9, '', 26, '#ffffff');
    bb.add([bg, txt(this, 0, -14, 'BOMB', 12, '#ffe3e6'), this.bombCount]);
    bb.setSize(84, 84).setInteractive({ useHandCursor: true });
    bb.on('pointerdown', () => this.useBomb());
    this.bombBtn = bb;
    this.updateBombUi();

    this.comboText = txt(this, W / 2, 132, '', 30, '#ffe066', { stroke: '#3a1d00', strokeThickness: 6 }).setDepth(45).setAlpha(0);
  }

  updateLifeUi() {
    const s = this.state;
    if (s.mode === 'arcade') {
      this.lifeIcons.forEach((ic, i) => ic.setAlpha(i < s.lives ? 1 : 0.18));
      if (this.creditText) this.creditText.setText('CREDIT ' + s.credits);
    } else {
      this.lifeIcons.forEach((h, i) => h.setTexture(i < s.hp ? 'heart' : 'heart_e'));
    }
  }

  updateBombUi() {
    this.bombCount.setText(String(this.state.bombs));
    this.bombBtn.setAlpha(this.state.bombs > 0 ? 0.9 : 0.35);
  }

  addScore(n) {
    this.state.score += n;
    this.scoreText.setText(fmt(this.state.score));
  }

  showCombo(c) {
    const t = this.comboText;
    this.tweens.killTweensOf(t);
    t.setText(c + ' COMBO').setAlpha(1).setScale(1.4);
    this.tweens.add({ targets: t, scale: 1, duration: 150, ease: 'Back.out' });
    this.tweens.add({ targets: t, alpha: 0, delay: 900, duration: 300 });
  }

  floatText(x, y, str, color) {
    if (this.floatCount > 14) return;
    this.floatCount++;
    const t = txt(this, x, y, str, 15, color, { stroke: '#000000', strokeThickness: 3 }).setDepth(30);
    this.tweens.add({
      targets: t, y: y - 40, alpha: 0, duration: 650, ease: 'Cubic.out',
      onComplete: () => { t.destroy(); this.floatCount--; }
    });
  }

  /* ------------------------- 일시정지 ------------------------- */
  openPause() {
    if (!this.state || this.state.over || this.state.frozen) return;
    if (!this.scene.isActive() || this.scene.isPaused()) return;
    this.drag = null;
    this.scene.launch('Pause');
    this.scene.pause();
  }

  /* ------------------------- 터치 조작 -------------------------
   * 손가락을 움직인 '거리만큼' 기체가 움직이는 상대 조작.
   * 손가락은 기체 아래 아무 곳에나 둘 수 있어서 기체가 가려지지 않는다.
   * ----------------------------------------------------------- */
  onPointerDown(p, over) {
    if (over && over.length) return;          // 버튼 위 터치는 이동으로 쓰지 않음
    if (this.state.over || this.state.frozen) return;
    this.drag = { id: p.id, px: p.x, py: p.y, sx: this.target.x, sy: this.target.y };
  }

  onPointerMove(p) {
    const s = this.state;
    // 재출격 후에도 손가락을 떼지 않고 계속 움직이면 바로 이어서 조작
    if (!this.drag && p.isDown && !s.dead && !s.over && !s.frozen) {
      this.drag = { id: p.id, px: p.x, py: p.y, sx: this.target.x, sy: this.target.y };
      return;
    }
    const d = this.drag;
    if (!d || p.id !== d.id || s.over || s.dead) return;
    const SENS = 1.25;
    const rawX = d.sx + (p.x - d.px) * SENS;
    const rawY = d.sy + (p.y - d.py) * SENS;
    this.target.x = rawX; this.target.y = rawY;
    this.clampTarget();
    if (this.target.x !== rawX) { d.sx = this.target.x; d.px = p.x; }
    if (this.target.y !== rawY) { d.sy = this.target.y; d.py = p.y; }
  }

  onPointerUp(p) {
    if (this.drag && p.id === this.drag.id) this.drag = null;
  }

  clampTarget() {
    this.target.x = clamp(this.target.x, 24, GAME_W - 24);
    this.target.y = clamp(this.target.y, 100, GAME_H - 40);
  }

  /* ------------------------- 메인 루프 ------------------------- */
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;
    const s = this.state;

    if (this.trash.length) {
      this.trash.forEach((e) => this.removeEnemy(e));
      this.trash.length = 0;
    }

    this.scrollBackground(dt);
    if (s.frozen) return;                     // 이어하기 카운트다운 중엔 전투 정지

    if (!s.over) {
      s.elapsed += dt;
      if (!s.dead) {
        this.updatePlayer(dt);
        this.updateFiring(dt);
        this.spawnDirector(dt);               // 격추된 동안엔 새 적을 보내지 않음
      }
      this.updateCombo(dt);
    }
    if (this.bombT > 0) {                     // 폭탄 지속 중엔 새로 쏜 탄도 지운다
      this.bombT -= dt;
      this.clearBullets(0, 0, Infinity, false);
    }
    this.updateEnemies(dt);
    this.updateBullets();
  }

  scrollBackground(dt) {
    const H = GAME_H;
    this.sea.tilePositionY -= 60 * dt;
    this.glint.tilePositionY -= 85 * dt;
    this.scenery.getChildren().slice().forEach((o) => {
      o.y += o.speed * dt;
      if (o.y > H + 160) o.destroy();
    });
    this.islandT -= dt;
    if (this.islandT <= 0) { this.islandT = rand(7, 13); this.spawnIsland(-90); }
    this.cloudT -= dt;
    if (this.cloudT <= 0) { this.cloudT = rand(2.5, 5); this.spawnCloud(-70); }
  }

  spawnIsland(y) {
    const img = this.add.image(randInt(30, GAME_W - 30), y, 'island')
      .setDepth(1).setScale(rand(0.6, 1.3)).setRotation(rand(0, Math.PI * 2));
    img.speed = 60;
    this.scenery.add(img);
  }

  spawnCloud(y) {
    const img = this.add.image(randInt(-40, GAME_W + 40), y, 'cloud')
      .setDepth(3).setAlpha(0.28).setScale(rand(0.9, 1.8));
    img.speed = randInt(120, 170);
    this.scenery.add(img);
  }

  updatePlayer(dt) {
    const p = this.player;
    if (this.keys) {
      const k = this.keys;
      let vx = 0, vy = 0;
      if (k.LEFT.isDown || k.A.isDown) vx -= 1;
      if (k.RIGHT.isDown || k.D.isDown) vx += 1;
      if (k.UP.isDown || k.W.isDown) vy -= 1;
      if (k.DOWN.isDown || k.S.isDown) vy += 1;
      if (vx || vy) {
        const len = Math.hypot(vx, vy);
        this.target.x += (vx / len) * 380 * dt;
        this.target.y += (vy / len) * 380 * dt;
        this.clampTarget();
      }
    }
    const prevX = p.x;
    const f = Math.min(1, dt * 22);
    p.x += (this.target.x - p.x) * f;
    p.y += (this.target.y - p.y) * f;

    const tilt = clamp((p.x - prevX) / Math.max(dt, 0.001) * 0.0006, -0.22, 0.22);
    p.rotation += (tilt - p.rotation) * 0.2;

    this.flame.setPosition(p.x - Math.sin(p.rotation) * 26, p.y + Math.cos(p.rotation) * 26)
      .setRotation(p.rotation).setScale(0.9 + Math.random() * 0.2, 0.8 + Math.random() * 0.55);

    if (this.invuln > 0) {
      this.invuln -= dt;
      p.alpha = Math.floor(this.invuln * 14) % 2 ? 0.3 : 1;
      if (this.invuln <= 0) p.alpha = 1;
    }
  }

  /* ------------------------- 발사 ------------------------- */
  updateFiring(dt) {
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = Math.max(0, this.fireTimer + 0.1);   // 초당 10회 자동 발사
      const p = this.player;
      this.firePlayerBullet(p.x - 7, p.y - 22);
      this.firePlayerBullet(p.x + 7, p.y - 22);
      this.muzzle.setVisible(true).setPosition(p.x, p.y - 30).setScale(0.24 + Math.random() * 0.12);
      this.muzzleT = 0.04;
      Sound.shoot();
    }
    if (this.muzzleT > 0) {
      this.muzzleT -= dt;
      if (this.muzzleT <= 0) this.muzzle.setVisible(false);
    }
  }

  firePlayerBullet(x, y) {
    const b = this.pBullets.get(x, y, 'pb');
    if (!b) return;
    b.enableBody(true, x, y, true, true);
    b.setDepth(8);
    b.body.setSize(4, 18);
    b.setVelocity(0, -920);
  }

  // 적 탄: 판정 원은 그림보다 작게 잡아 억울한 피격을 줄인다
  fireEnemyBullet(x, y, angle, speed, big) {
    const s = this.state;
    if (s.over || s.dead || this.bombT > 0) return;
    if (this.eBullets.countActive(true) > 160) return;
    const key = big ? 'eb2' : 'eb';
    const b = this.eBullets.get(x, y, key);
    if (!b) return;
    b.setTexture(key);
    b.enableBody(true, x, y, true, true);
    b.setDepth(12);
    const half = big ? 11 : 7, r = big ? 6 : 4;
    b.body.setCircle(r, half - r, half - r);
    this.physics.velocityFromRotation(angle, speed * this.bulletMul(), b.body.velocity);
  }

  // 플레이어를 향한 부채꼴 탄 (너무 가까우면 쏘지 않아 피할 여유를 보장)
  fireFanAtPlayer(e, count, spread, speed, big) {
    const p = this.player;
    if (Math.abs(p.y - e.y) < 140 && Math.abs(p.x - e.x) < 140) return;
    const a = Phaser.Math.Angle.Between(e.x, e.y, p.x, p.y);
    for (let i = 0; i < count; i++) {
      this.fireEnemyBullet(e.x, e.y + 10, a + (i - (count - 1) / 2) * spread, speed, big);
    }
  }

  fireRing(x, y, n, speed) {
    const off = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) this.fireEnemyBullet(x, y, off + (i * Math.PI * 2) / n, speed, false);
  }

  updateBullets() {
    const W = GAME_W, H = GAME_H;
    this.pBullets.children.each((b) => {
      if (b.active && b.y < -30) b.disableBody(true, true);
    });
    this.eBullets.children.each((b) => {
      if (b.active && (b.y < -40 || b.y > H + 40 || b.x < -40 || b.x > W + 40)) b.disableBody(true, true);
    });
  }

  // 반경 r 안의 적 탄 제거 (r = Infinity면 전부)
  clearBullets(x, y, r, sparks) {
    this.eBullets.children.each((b) => {
      if (!b.active) return;
      if (r !== Infinity && Phaser.Math.Distance.Between(x, y, b.x, b.y) >= r) return;
      if (sparks) this.fxHit.explode(2, b.x, b.y);
      b.disableBody(true, true);
    });
  }

  /* ------------------------- 폭탄 -------------------------
   * 화면의 적 탄을 모두 지우고, 화면 안 적에게 큰 피해.
   * 발동 중 잠시 무적 + 진동.
   * ------------------------------------------------------- */
  useBomb() {
    const s = this.state;
    if (s.over || s.dead || s.frozen || s.bombs <= 0 || this.bombT > 0) return;
    if (!this.scene.isActive()) return;
    s.bombs--;
    this.updateBombUi();
    this.bombT = 1.0;
    this.invuln = Math.max(this.invuln, 1.4);
    Sound.unlock(); Sound.bomb();
    Haptics.vibrate([0, 220, 60, 120]);

    const p = this.player;
    this.clearBullets(0, 0, Infinity, true);
    this.cameras.main.flash(260, 255, 236, 190);
    this.cameras.main.shake(420, 0.012);

    const ring = this.add.circle(p.x, p.y, 12).setStrokeStyle(8, 0xfff1b8, 0.95).setDepth(16);
    this.tweens.add({ targets: ring, scale: 80, alpha: 0, duration: 700, ease: 'Cubic.out', onComplete: () => ring.destroy() });
    for (let i = 0; i < 9; i++) {
      this.time.delayedCall(i * 55, () => this.explode(randInt(30, GAME_W - 30), randInt(120, GAME_H - 220), 0, true));
    }
    this.time.delayedCall(150, () => {
      this.enemies.getChildren().slice().forEach((e) => {
        if (e.active && e.y > -20 && e.y < GAME_H) this.damageEnemy(e, 20);
      });
    });
  }

  /* ------------------------- 난이도 ------------------------- */
  difficulty() { return Math.min(1 + this.state.elapsed / 70, 3); }
  bulletMul() { return 1 + Math.min(this.state.elapsed / 200, 0.35); }

  /* ------------------------- 적 등장 ------------------------- */
  spawnDirector(dt) {
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    const t = this.state.elapsed, d = this.difficulty();
    this.spawnT = rand(1.7, 2.6) / d + 0.45;
    const alive = this.enemies.getChildren().filter((e) => e.active);
    const bombers = alive.filter((e) => e.etype === 'bomber').length;
    const helis = alive.filter((e) => e.etype === 'heli').length;
    const r = Math.random();
    if (t > 35 && bombers === 0 && r < 0.2) { this.spawnBomber(); this.spawnT += 2.5; }
    else if (t > 12 && helis < 1 + Math.floor(d) && r < 0.5) this.spawnHeli();
    else this.spawnFighterWave();
  }

  spawnEnemy(type, x, y, props) {
    const def = ENEMY[type];
    const e = this.enemies.create(x, y, def.key);
    e.setDepth(type === 'bomber' ? 4 : 5);
    e.body.moves = false;
    if (type === 'bomber') e.body.setSize(112, 46);
    else e.body.setCircle(def.radius, e.width / 2 - def.radius, e.height / 2 - def.radius);
    e.etype = type;
    e.hp = def.hp;
    e.maxHp = def.hp;
    e.score = def.score;
    e.t = 0;
    e.entered = false;
    Object.assign(e, props);
    if (type === 'heli') e.rotor = this.add.image(x, y, 'rotor').setDepth(6);
    if (type === 'bomber') e.hpBar = this.add.graphics().setDepth(7);
    return e;
  }

  spawnFighterWave() {
    const W = GAME_W, d = this.difficulty();
    const r = Math.random();
    if (r < 0.3) {                       // V자 편대
      const cx = randInt(90, W - 90);
      [[0, 0], [-38, -34], [38, -34], [-76, -68], [76, -68]].forEach(([dx, dy]) => {
        this.spawnEnemy('fighter', cx + dx, -40 + dy, {
          mode: 'dive', baseX: cx + dx, vy: 150 + 20 * d, amp: 0, freq: 0, phase: 0, fireAt: rand(0.6, 1.8)
        });
      });
    } else if (r < 0.6) {                // 세로 줄 + 지그재그
      const cx = randInt(90, W - 90), amp = randInt(40, 70);
      for (let i = 0; i < 4; i++) {
        this.spawnEnemy('fighter', cx, -40 - i * 60, {
          mode: 'dive', baseX: cx, vy: 170 + 20 * d, amp, freq: 3, phase: i * 0.6, fireAt: rand(0.5, 1.5)
        });
      }
    } else if (r < 0.85) {               // 옆에서 휘어 들어오기
      const dir = Math.random() < 0.5 ? 1 : -1;
      const sx = dir > 0 ? -30 : W + 30, sy = randInt(70, 200);
      for (let i = 0; i < 4; i++) {
        this.spawnEnemy('fighter', sx - dir * i * 48, sy - i * 14, {
          mode: 'swoop', vx: dir * (170 + 15 * d), vy: 30, fireAt: rand(0.4, 1.2)
        });
      }
    } else {                             // 빠른 단독기 2대
      for (let i = 0; i < 2; i++) {
        const x = randInt(40, W - 40);
        this.spawnEnemy('fighter', x, -40 - i * 90, {
          mode: 'dive', baseX: x, vy: 210 + 25 * d, amp: 20, freq: 2, phase: Math.random() * 6, fireAt: rand(0.3, 1.0)
        });
      }
    }
  }

  spawnHeli() {
    this.spawnEnemy('heli', randInt(60, GAME_W - 60), -50, {
      mode: 'enter', targetY: randInt(140, 300), fireCd: 0.8, modeT: 0, dir: 1
    });
  }

  spawnBomber() {
    this.spawnEnemy('bomber', randInt(110, GAME_W - 110), -60, { ringCd: 1.6, aimCd: 2.4 });
  }

  /* ------------------------- 적 행동 ------------------------- */
  updateEnemies(dt) {
    const W = GAME_W, H = GAME_H;
    const list = this.enemies.getChildren().slice();
    for (const e of list) {
      if (!e.active) continue;
      e.t += dt;
      if (e.etype === 'fighter') this.updateFighter(e, dt);
      else if (e.etype === 'heli') this.updateHeli(e, dt);
      else this.updateBomber(e, dt);

      if (e.rotor) { e.rotor.setPosition(e.x, e.y + 6); e.rotor.rotation += dt * 28; }
      if (e.hpBar) {
        e.hpBar.clear();
        if (e.hp < e.maxHp) {
          e.hpBar.fillStyle(0x000000, 0.6); e.hpBar.fillRect(e.x - 40, e.y - 54, 80, 6);
          e.hpBar.fillStyle(0xff5d6c, 1); e.hpBar.fillRect(e.x - 39, e.y - 53, 78 * (e.hp / e.maxHp), 4);
        }
      }

      if (e.x > -10 && e.x < W + 10 && e.y > -10 && e.y < H + 10) e.entered = true;
      const m = 90;
      const gone = e.entered && (e.y > H + m || e.y < -m - 60 || e.x < -m || e.x > W + m);
      if (gone || e.t > 40) this.removeEnemy(e);
    }
  }

  updateFighter(e, dt) {
    if (e.mode === 'dive') {
      e.y += e.vy * dt;
      e.x = e.baseX + Math.sin(e.t * e.freq + e.phase) * e.amp;
    } else {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vy += 90 * dt;
      e.rotation = Math.atan2(e.vy, e.vx) - Math.PI / 2;
    }
    if (!e.fired && e.y > 0 && e.x > 0 && e.x < GAME_W) {
      e.visT = (e.visT || 0) + dt;
      if (e.visT > e.fireAt) {
        e.fired = true;
        if (this.player.y - e.y > 160) this.fireFanAtPlayer(e, 1, 0, 210, false);
      }
    }
  }

  updateHeli(e, dt) {
    if (e.mode === 'enter') {
      e.y += Math.max(40, (e.targetY - e.y) * 2.2) * dt;
      if (e.y >= e.targetY - 2) { e.mode = 'hover'; e.modeT = 0; }
    } else if (e.mode === 'hover') {
      e.modeT += dt;
      e.x += clamp(this.player.x - e.x, -60, 60) * 0.5 * dt;
      e.y = e.targetY + Math.sin(e.t * 2) * 4;
      e.fireCd -= dt;
      if (e.fireCd <= 0) {
        e.fireCd = 1.5 / Math.min(1.5, 0.6 + this.difficulty() * 0.4);
        this.fireFanAtPlayer(e, 3, 0.26, 190, false);
      }
      if (e.modeT > 5) { e.mode = 'exit'; e.dir = e.x < GAME_W / 2 ? -1 : 1; }
    } else {
      e.x += e.dir * 150 * dt;
      e.y -= 20 * dt;
      e.rotation += (e.dir * 0.3 - e.rotation) * 0.1;
    }
  }

  updateBomber(e, dt) {
    if (e.t > 20) e.y += 70 * dt;
    else e.y += (e.y < 170 ? 45 : 10) * dt;
    if (e.y > 40 && e.t < 20) {
      e.ringCd -= dt; e.aimCd -= dt;
      if (e.ringCd <= 0) { e.ringCd = 2.8; this.fireRing(e.x, e.y + 20, 14, 120); }
      if (e.aimCd <= 0) { e.aimCd = 1.5; this.fireFanAtPlayer(e, 1, 0, 230, true); }
    }
  }

  /* ------------------------- 충돌 처리 ------------------------- */
  onBulletHitEnemy(b, e) {
    if (!b.active || !e.active) return;
    b.disableBody(true, true);
    this.fxHit.explode(4, b.x, b.y - 6);
    this.damageEnemy(e, 1);
  }

  onPlayerHitBullet(p, b) {
    if (!b.active || this.invuln > 0 || this.state.over || this.state.dead) return;
    b.disableBody(true, true);
    this.hurtPlayer();
  }

  onPlayerHitEnemy(p, e) {
    if (!e.active || this.invuln > 0 || this.state.over || this.state.dead) return;
    this.damageEnemy(e, e.etype === 'fighter' ? 99 : 4);
    this.hurtPlayer();
  }

  damageEnemy(e, dmg) {
    if (!e.active) return;
    e.hp -= dmg;
    if (e.hp <= 0) { this.killEnemy(e); return; }
    e.setTintFill(0xffffff);
    this.time.delayedCall(40, () => { if (e.active) e.clearTint(); });
    Sound.hit();
  }

  killEnemy(e) {
    const s = this.state;
    s.combo = s.comboTimer > 0 ? s.combo + 1 : 1;
    s.comboTimer = 2.0;
    const bonus = Math.floor(e.score * Math.min(s.combo - 1, 30) * 0.1);
    const pts = e.score + bonus;
    this.addScore(pts);
    this.floatText(e.x, e.y, '+' + fmt(pts), bonus > 0 ? '#ffe066' : '#ffffff');
    if (s.combo >= 3) this.showCombo(s.combo);
    s.kills++;

    if (e.etype === 'bomber') {
      this.bigExplosion(e.x, e.y);
      Haptics.vibrate([120, 60, 120, 60, 320]);   // 보스급 격파 진동
    } else {
      this.explode(e.x, e.y, ENEMY[e.etype].boom);
    }

    e.body.enable = false;
    e.setActive(false).setVisible(false);
    if (e.rotor) e.rotor.setVisible(false);
    if (e.hpBar) e.hpBar.clear();
    this.trash.push(e);
  }

  removeEnemy(e) {
    if (e.rotor) { e.rotor.destroy(); e.rotor = null; }
    if (e.hpBar) { e.hpBar.destroy(); e.hpBar = null; }
    e.destroy();
  }

  updateCombo(dt) {
    const s = this.state;
    if (s.comboTimer > 0) {
      s.comboTimer -= dt;
      if (s.comboTimer <= 0) s.combo = 0;
    }
  }

  /* ------------------------- 폭발 이펙트 ------------------------- */
  explode(x, y, size, noShake) {   // size: 0 소형, 1 중형, 2 대형
    const n = [10, 22, 42][size];
    this.fxFire.explode(n, x, y);
    this.fxSmoke.explode(Math.ceil(n / 3), x, y);
    const f = this.add.image(x, y, 'flash').setDepth(15).setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xffd27a).setScale(0.2 + size * 0.3);
    this.tweens.add({
      targets: f, scale: 0.9 + size * 0.9, alpha: 0, duration: 260 + size * 120,
      onComplete: () => f.destroy()
    });
    if (size >= 1 && !noShake) this.cameras.main.shake(90 + size * 70, 0.003 + size * 0.003);
    Sound.boom(size);
  }

  bigExplosion(x, y) {
    for (let i = 0; i < 5; i++) {
      this.time.delayedCall(i * 90, () => this.explode(x + rand(-48, 48), y + rand(-24, 24), 1));
    }
    this.time.delayedCall(500, () => this.explode(x, y, 2));
  }

  /* ------------------------- 피격 ------------------------- */
  hurtPlayer() {
    const s = this.state;
    Sound.hurt();
    this.cameras.main.shake(180, 0.012);
    this.clearBullets(this.player.x, this.player.y, 150, true);
    s.combo = 0; s.comboTimer = 0;

    if (s.mode === 'normal') {
      s.hp--;
      this.updateLifeUi();
      this.explode(this.player.x, this.player.y, 0);
      Haptics.vibrate(90);
      if (s.hp <= 0) { this.gameOver(); return; }
      this.invuln = 1.8;
    } else {
      s.lives--;
      this.updateLifeUi();
      this.playerDown();
    }
  }

  hidePlayer() {
    const p = this.player;
    p.setVisible(false);
    p.body.enable = false;
    this.flame.setVisible(false);
    this.muzzle.setVisible(false);
    this.drag = null;
  }

  // 오락실 모드: 한 번 맞으면 기체 1대 격추 → 다시 출격 또는 이어하기
  playerDown() {
    const s = this.state, p = this.player;
    s.dead = true;
    this.explode(p.x, p.y, 2);
    this.time.delayedCall(140, () => this.explode(p.x + 14, p.y - 10, 1));
    Haptics.vibrate([250, 80, 250]);
    this.hidePlayer();
    this.time.delayedCall(300, () => this.clearBullets(0, 0, Infinity, true));
    this.time.delayedCall(1400, () => {
      if (s.over) return;
      if (s.lives > 0) this.respawn();
      else this.showContinue();
    });
  }

  respawn() {
    const s = this.state, p = this.player;
    s.dead = false;
    s.bombs = ARCADE.bombsPerLife;           // 새 기체마다 폭탄 보충
    this.updateBombUi();
    p.setPosition(GAME_W / 2, GAME_H + 50).setRotation(0).setVisible(true);
    p.body.enable = true;
    this.flame.setVisible(true);
    this.target.x = GAME_W / 2; this.target.y = GAME_H - 170;
    this.invuln = 2.5;
    this.fireTimer = 0.4;
  }

  /* ------------------------- 이어하기 (CONTINUE?) ------------------------- */
  showContinue() {
    const s = this.state;
    if (s.credits <= 0) { this.finishGame(0); return; }
    s.frozen = true;
    this.physics.pause();
    this.pauseBtn.setVisible(false);

    const W = GAME_W, H = GAME_H;
    const c = this.add.container(0, 0).setDepth(200);
    c.add([
      this.add.rectangle(0, 0, W, H, 0x000814, 0.7).setOrigin(0).setInteractive(),
      drawPanel(this, 40, 250, W - 80, 380),
      txt(this, W / 2, 300, 'CONTINUE?', 40, '#ffe066', { stroke: '#3a1d00', strokeThickness: 6 })
    ]);
    let count = ARCADE.continueSec;
    const num = txt(this, W / 2, 385, String(count), 88, '#ffffff', { stroke: '#000000', strokeThickness: 6 });
    c.add([num, txt(this, W / 2, 450, '남은 크레딧 ' + s.credits + ' · 점수는 이어져요', 14, '#9ec9ff')]);

    const close = () => { if (this.contTimer) this.contTimer.remove(); this.contTimer = null; c.destroy(); };
    const yes = makeButton(this, W / 2, 510, 240, 60, '이어하기', () => {
      close();
      s.credits--; s.continues++;
      s.lives = ARCADE.lives;
      s.frozen = false;
      this.updateLifeUi();
      this.physics.resume();
      this.pauseBtn.setVisible(true);
      this.clearBullets(0, 0, Infinity, false);
      this.respawn();
    }, 'primary', 24);
    const no = makeButton(this, W / 2, 582, 240, 48, '그만하기', () => {
      close();
      this.finishGame(0);
    }, 'secondary', 18);
    c.add([yes, no]);
    yes.disableInteractive(); no.disableInteractive();
    this.time.delayedCall(400, () => { if (yes.scene) { yes.setInteractive(); no.setInteractive(); } });

    this.contTimer = this.time.addEvent({
      delay: 1000, repeat: ARCADE.continueSec - 1,
      callback: () => {
        count--;
        num.setText(String(count));
        num.setScale(1.3);
        this.tweens.add({ targets: num, scale: 1, duration: 200 });
        Sound.tick();
        if (count <= 0) { close(); this.finishGame(0); }
      }
    });
  }

  /* ------------------------- 게임 오버 ------------------------- */
  gameOver() {   // 일반 모드: 하트를 모두 잃음
    const p = this.player;
    this.explode(p.x, p.y, 2);
    this.time.delayedCall(160, () => this.explode(p.x + 16, p.y - 10, 1));
    Haptics.vibrate([250, 80, 250]);
    this.hidePlayer();
    this.finishGame(1300);
  }

  finishGame(delay) {
    const s = this.state;
    if (s.over) return;
    s.over = true;
    s.frozen = false;
    this.physics.resume();
    this.hidePlayer();
    this.pauseBtn.setVisible(false).disableInteractive();
    this.bombBtn.setVisible(false).disableInteractive();

    const isNew = s.score > s.best;
    if (isNew) Store.set('best_' + s.mode, s.score);
    this.time.delayedCall(delay, () => this.showGameOver(isNew));
  }

  showGameOver(isNew) {
    const W = GAME_W, H = GAME_H, s = this.state;
    const c = this.add.container(0, 0).setDepth(200).setAlpha(0);
    const sec = Math.floor(s.elapsed);
    const time = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    let stats = '격추 ' + s.kills + '  ·  생존 ' + time;
    if (s.mode === 'arcade') stats += '  ·  이어하기 ' + s.continues;
    c.add([
      this.add.rectangle(0, 0, W, H, 0x000814, 0.7).setOrigin(0).setInteractive(),
      drawPanel(this, 30, 190, W - 60, 520),
      txt(this, W / 2, 240, 'GAME OVER', 44, '#ff5d6c', { stroke: '#2a0008', strokeThickness: 6 }),
      txt(this, W / 2, 284, MODES[s.mode].label, 14, '#9ec9ff'),
      txt(this, W / 2, 318, 'SCORE', 15, '#9ec9ff'),
      txt(this, W / 2, 356, fmt(s.score), 44, '#ffffff'),
      txt(this, W / 2, 404, 'BEST  ' + fmt(Math.max(s.best, s.score)), 18, '#ffd166'),
      txt(this, W / 2, 466, stats, 14, '#cfe3ff')
    ]);
    if (isNew) {
      const nr = txt(this, W / 2, 435, 'NEW RECORD!', 20, '#ffe066', { stroke: '#3a1d00', strokeThickness: 4 });
      c.add(nr);
      this.tweens.add({ targets: nr, alpha: 0.3, duration: 400, yoyo: true, repeat: -1 });
    }

    // 랭킹 등록 (닉네임 입력 → 기기 저장 + 온라인 전송)
    let submitted = false;
    const rankBtn = makeButton(this, W / 2, 528, 240, 56, '랭킹 등록', () => {
      if (submitted) return;
      NameModal.open(MODES[s.mode].label + ' · ' + fmt(s.score) + '점').then(async (nick) => {
        if (!nick || !rankBtn.scene) return;
        submitted = true;
        rankBtn.label.setText('등록 중…');
        const res = await Ranking.submit({
          nickname: nick, score: s.score, mode: s.mode,
          plane: Store.get('plane', 'RAPTOR-X'), continues: s.continues
        });
        if (!rankBtn.scene) return;
        if (!res.online) rankBtn.label.setText('기기에 저장됨');
        else if (res.ok) rankBtn.label.setText('등록 완료!');
        else rankBtn.label.setText('기기에만 저장');
        rankBtn.setAlpha(0.7);
      });
    }, 'accent', 22);
    const retry = makeButton(this, W / 2, 598, 240, 56, 'RETRY', () => this.scene.restart(), 'primary', 24);
    const menu = makeButton(this, W / 2, 664, 240, 46, 'MENU', () => this.scene.start('Menu'), 'secondary', 18);
    c.add([rankBtn, retry, menu]);
    if (s.score <= 0) rankBtn.setVisible(false);
    // 드래그하던 손가락을 떼다가 버튼이 눌리지 않도록 잠깐 잠근다
    [rankBtn, retry, menu].forEach((b) => b.disableInteractive());
    this.time.delayedCall(600, () => [rankBtn, retry, menu].forEach((b) => b.setInteractive()));
    this.tweens.add({ targets: c, alpha: 1, duration: 300 });
  }
}

/* =====================================================================
 * Pause: 게임 위에 겹쳐 뜨는 일시정지 창
 * ===================================================================== */
class PauseScene extends Phaser.Scene {
  constructor() { super('Pause'); }

  create() {
    const W = GAME_W, H = GAME_H;
    this.add.rectangle(0, 0, W, H, 0x000814, 0.65).setOrigin(0).setInteractive();
    drawPanel(this, 40, 236, W - 80, 420);
    txt(this, W / 2, 288, 'PAUSED', 40, '#ffffff');

    const resume = () => { this.scene.stop(); this.scene.resume('Game'); };
    makeButton(this, W / 2, 368, 240, 62, 'RESUME', resume, 'primary', 26);
    makeButton(this, W / 2, 440, 240, 52, 'RESTART', () => {
      const game = this.scene.get('Game');
      this.scene.stop();
      game.scene.restart();
    }, 'secondary', 20);
    makeButton(this, W / 2, 504, 240, 52, 'MENU', () => {
      this.scene.stop('Game');
      this.scene.start('Menu');
    }, 'secondary', 20);
    const sBtn = makeButton(this, W / 2 - 62, 580, 116, 46, Sound.label(), () => sBtn.label.setText((Sound.toggle(), Sound.label())), 'secondary', 15);
    const vBtn = makeButton(this, W / 2 + 62, 580, 116, 46, Haptics.label(), () => vBtn.label.setText((Haptics.toggle(), Haptics.label())), 'secondary', 15);

    if (this.input.keyboard) {
      this.input.keyboard.on('keydown-P', resume);
      this.input.keyboard.on('keydown-ESC', resume);
    }
  }
}

/* =====================================================================
 * 시작
 * ===================================================================== */
// 모바일 브라우저의 스크롤·핀치 확대·더블탭 확대 방지 (닉네임 입력창은 예외)
['touchmove', 'gesturestart', 'gesturechange', 'dblclick', 'contextmenu'].forEach((ev) => {
  document.addEventListener(ev, (e) => {
    if (e.target && e.target.id === 'nm-input') return;
    e.preventDefault();
  }, { passive: false });
});

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0b1a2e',
  width: GAME_W,
  height: GAME_H,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: 'arcade', arcade: { debug: false } },
  input: { activePointers: 3 },      // 이동하면서 다른 손가락으로 폭탄 버튼 누르기
  audio: { noAudio: true },          // 소리는 위의 Sound(WebAudio)가 담당
  render: { antialias: true, powerPreference: 'high-performance' },
  fps: { target: 60 },
  scene: [BootScene, MenuScene, GameScene, PauseScene]
};

function startGame() { new Phaser.Game(config); }
if (document.fonts && document.fonts.load) {
  Promise.race([
    document.fonts.load("40px 'Russo One'"),
    new Promise((r) => setTimeout(r, 1500))
  ]).then(startGame, startGame);
} else {
  startGame();
}
