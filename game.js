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

const GAME_H = 844;
// 폰 화면 비율에 맞춰 가로 폭을 390~480 사이에서 정한다 → 양옆 빈 공간 최소화
const GAME_W = Math.round(Math.min(480, Math.max(390, GAME_H * (window.innerWidth / Math.max(1, window.innerHeight)))));
// 화면을 2배 해상도로 그려서 폰에서도 선명하게 (게임 좌표는 그대로, 카메라만 2배 확대)
const ZOOM = (window.devicePixelRatio || 1) >= 1.5 ? 2 : 1;
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

// 난이도: 탄속·보스 연사 간격·적 체력·아이템·점수 배율
const DIFFS = {
  easy:   { key: 'easy',   label: '쉬움',   tag: 'EZ', desc: '탄 느림 · 적 약함 · 하트·크레딧 +1~2 · 점수 ×0.8',
            bullet: 0.85, fire: 1.25, skip: 0.15, hp: 0.75, drop: 1.4, score: 0.8, hearts: 1, credits: 2, inv: 0.5 },
  normal: { key: 'normal', label: '보통',   tag: '',   desc: '기본 난이도',
            bullet: 1, fire: 1, skip: 0, hp: 1, drop: 1, score: 1, hearts: 0, credits: 0, inv: 0 },
  hard:   { key: 'hard',   label: '어려움', tag: 'HD', desc: '탄 빠름 · 적 단단함 · 크레딧 -1 · 점수 ×1.3',
            bullet: 1.15, fire: 0.82, skip: 0, hp: 1.25, drop: 0.75, score: 1.3, hearts: 0, credits: -1, inv: 0 }
};
const DIFF_ORDER = ['easy', 'normal', 'hard'];
const getDiff = () => (DIFFS[Store.get('diff', 'normal')] ? Store.get('diff', 'normal') : 'normal');
// 최고 점수는 모드·난이도별로 따로 (보통 난이도는 예전 기록을 그대로 이어받음)
const getBest = (mode, diff) => {
  diff = diff || getDiff();
  const legacy = Store.get('best_' + mode, mode === 'normal' ? Store.get('best', 0) : 0);
  return Store.get('best_' + mode + '_' + diff, diff === 'normal' ? legacy : 0);
};

/* ---------------------------------------------------------------------
 * 조작 감도: 1~10단계 (기본 5). 손가락을 움직인 거리 대비 기체 이동량과
 * 최고 이동속도에 함께 반영된다.
 * ------------------------------------------------------------------- */
const Sens = {
  level: Math.min(10, Math.max(1, Math.round(Store.get('sens', 5)) || 5)),
  value() { return 0.6 + (this.level - 1) * 0.18; },      // 드래그 배율 (5단계 ≈ 1.32)
  speedMul() { return Math.max(0.5, this.value() / 1.32); }, // 최고속도 배율 (5단계 = 1)
  set(l) { this.level = Math.min(10, Math.max(1, l)); Store.set('sens', this.level); },
  word() { return this.level <= 3 ? '느리게' : this.level >= 8 ? '빠르게' : '보통'; }
};

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
      continues: rec.continues | 0,
      stage: rec.stage || 1,
      diff: rec.diff || 'normal'
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
      const url = this.base() + '?select=nickname,score,continues,stage,diff,created_at&mode=eq.' +
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
// 전투기 4종: hp(일반 모드 하트), armor(오락실 모드 목숨마다 방어막), speed(최고 이동속도), inv(피격 후 무적시간)
const PLANES = [
  { id: 'RAPTOR-X',  key: 'player',        type: '균형형',   atk: 3, spd: 3, def: 3,
    desc: '쌍발 기관포 + 유도미사일', note: '미사일이 알아서 적을 쫓아가요', bomb: '폭탄: 아군 폭격기 편대의 융단 폭격', hp: 3, armor: 0, speed: 950, inv: 1.8 },
  { id: 'PHANTOM-Z', key: 'plane_phantom', type: '고속형',   atk: 3, spd: 5, def: 2,
    desc: '적을 꿰뚫는 관통 레이저', note: '가장 빠른 기체 · 일렬로 선 적에 강함', bomb: '폭탄: 화면을 쓸고 올라가는 플라즈마 벽', hp: 3, armor: 0, speed: 1400, inv: 1.5 },
  { id: 'THUNDER-A', key: 'plane_thunder', type: '중장갑형', atk: 4, spd: 2, def: 5,
    desc: '5갈래 확산탄', note: '일반: 하트 4개 · 오락실: 목숨마다 방어막', bomb: '폭탄: 3초간 탄을 막는 거대 방어막', hp: 4, armor: 1, speed: 680, inv: 2.2 },
  { id: 'BLAZE-F',   key: 'plane_blaze',   type: '공격형',   atk: 5, spd: 3, def: 2,
    desc: '맞으면 터지는 폭발탄', note: '폭발이 주변 적까지 함께 피해', bomb: '폭탄: 화면 곳곳에 화염 폭격 9연발', hp: 3, armor: 0, speed: 950, inv: 1.5 }
];
// 조종사 (모두 이 게임을 위해 만든 가상의 인물)
const PILOTS = {
  'RAPTOR-X':  { name: '한서진', en: 'HAN SEO-JIN', nation: '대한민국', flag: 'flag_kr', face: 'pilot_han', age: 27,
                 role: '편대장 · 침착한 전략가', quote: '"하늘은 우리가 지킨다."' },
  'PHANTOM-Z': { name: '클레르 뒤부아', en: 'CLAIRE DUBOIS', nation: '프랑스', flag: 'flag_fr', face: 'pilot_claire', age: 24,
                 role: '최연소 에이스 · 스피드광', quote: '"따라올 수 있으면 따라와 봐!"' },
  'THUNDER-A': { name: '잭 카터', en: 'JACK CARTER', nation: '미국', flag: 'flag_us', face: 'pilot_jack', age: 38,
                 role: '베테랑 · 편대의 방패', quote: '"뒤는 맡겨, 꼬맹이들."' },
  'BLAZE-F':   { name: '올리버 브룩스', en: 'OLIVER BROOKS', nation: '영국', flag: 'flag_uk', face: 'pilot_oliver', age: 31,
                 role: '폭격 전문가 · 홍차 마니아', quote: '"티타임 전에 끝내자고."' }
};
PLANES.forEach((p) => { p.pilot = PILOTS[p.id]; });

const getPlane = () => PLANES.find((p) => p.id === Store.get('plane', 'RAPTOR-X')) || PLANES[0];

// 적 3종: 체력·점수·충돌 반경·폭발 크기 (폭격기는 지금 단계의 중간 보스)
const ENEMY = {
  fighter: { key: 'e_fighter', hp: 0.5, score: 100,  radius: 15, boom: 0 },
  heli:    { key: 'e_heli',    hp: 6,  score: 400,  radius: 20, boom: 1 },
  bomber:  { key: 'e_bomber',  hp: 34, score: 2000, radius: 0,  boom: 2 },
  ship:    { key: 'g_ship',    hp: 14, score: 800,  radius: 0,  boom: 1, ground: true },   // 해상 구축함
  tank:    { key: 'g_tank',    hp: 4,  score: 300,  radius: 16, boom: 0, ground: true }    // 지상 전차
};

// 중간보스 3종: 차례로 등장하고, 한 바퀴 돌 때마다 체력·점수가 35%씩 올라간다
const MIDBOSS = {
  gunship:  { key: 'mb_gunship',  name: '공격 헬기',  hp: 320, score: 5000, y: 190, radius: 44 },
  fortress: { key: 'mb_fortress', name: '하늘 요새',  hp: 420, score: 7000, y: 170, size: [180, 60] },
  ace:      { key: 'mb_ace',      name: '붉은 에이스', hp: 260, score: 6000, y: 200, radius: 26 }
};
const CHARGE = { passive: 1.0, perDamage: 0.09 };
// 파워 1~7단계: 단계별 연사 간격 배율·피해 배율 (1단계가 가장 약함)
const POWER = { max: 7, rateMul: [1.4, 1.3, 1.2, 1.1, 1.0, 0.95, 0.88], dps: [14, 18, 22, 27, 32, 38, 45] };
// 격추 시 P 아이템이 떨어질 확률 (폭격기는 반드시, 중간보스는 B+P)
const DROP = { fighter: 0.025, heli: 0.1, bomber: 0.4, ship: 0.15, tank: 0.06, pity: 40 };

// 5개 스테이지: 배경·지상(해상) 적·중간보스·최종 보스가 각각 다름
const STAGES = [
  { name: 'OCEAN STRIKE',  kr: '바다 위 전투', tile: 'sea',         glint: true,  scenery: null,   ground: 'ship', mid: 'gunship',  boss: 'kraken' },
  { name: 'DESERT STORM',  kr: '사막 기지',    tile: 'tile_desert', glint: false, scenery: 'dune',     ground: 'tank', mid: 'ace',      boss: 'titan' },
  { name: 'CITY DEFENSE',  kr: '도시 방어전',  tile: 'tile_city',   glint: false, scenery: 'building', ground: 'tank', mid: 'fortress', boss: 'ironbird' },
  { name: 'SKY FORTRESS',  kr: '공중 요새',    tile: 'tile_sky',    glint: false, scenery: 'cloud',    ground: null,   mid: 'ace',      boss: 'airship' },
  { name: 'FINAL ASSAULT', kr: '최종 결전',    tile: 'tile_final',  glint: false, scenery: 'debris',   ground: null,   mid: 'gunship',  boss: 'omega' }
];
const STAGE_TIME = { mid: 38, boss: 80 };   // 스테이지 시작 후 중간보스·보스 등장 시각(초)

// 스테이지 보스: 체력 66%·33%에서 공격 패턴이 바뀌는 3단계
// guns = 보스 중심 기준 포구 위치, phases = 단계별 공격 목록
const BOSSES = {
  kraken: { key: 'b_kraken', name: '강철 전함 크라켄', hp: 1300, y: 175, size: [140, 220],
    guns: [[-48, -70], [48, -70], [0, 0], [-44, 70], [44, 70]],
    phases: [
      [{ p: 'guns', every: 1.5, speed: 190 }, { p: 'ring', every: 3.2, n: 16, speed: 110, gun: 2 }],
      [{ p: 'fan', every: 1.5, n: 5, spread: 0.16, speed: 210, gun: 2 }, { p: 'spiral', every: 0.07, arms: 2, step: 0.27, speed: 150, gun: 2, dur: 2.0, rest: 1.6 }],
      [{ p: 'guns', every: 1.0, speed: 220 }, { p: 'spiral', every: 0.06, arms: 3, step: 0.23, speed: 155, gun: 2, dur: 2.4, rest: 1.3 }, { p: 'big', every: 2.4, n: 3, speed: 230, gun: 4 }]
    ] },
  titan: { key: 'b_titan', name: '사막의 거인 타이탄', hp: 1700, y: 170, size: [200, 160],
    guns: [[-80, -40], [80, -40], [-80, 50], [80, 50], [0, 0]],
    phases: [
      [{ p: 'guns', every: 1.3, speed: 185 }, { p: 'curtain', every: 3.0, n: 7, speed: 135 }],
      [{ p: 'ring', every: 2.2, n: 20, speed: 120, gun: 4 }, { p: 'fan', every: 1.6, n: 7, spread: 0.15, speed: 200, gun: 4 }],
      [{ p: 'spiral', every: 0.085, arms: 4, step: 0.2, speed: 145, gun: 4, dur: 2.4, rest: 1.4 }, { p: 'big', every: 2.4, n: 3, speed: 230, gun: 2 }, { p: 'curtain', every: 3.4, n: 9, speed: 140 }]
    ] },
  ironbird: { key: 'b_ironbird', name: '초대형 폭격기 아이언버드', hp: 2100, y: 160, size: [240, 70],
    guns: [[-100, 10], [100, 10], [-50, 20], [50, 20], [0, 40]],
    phases: [
      [{ p: 'fan', every: 2.0, n: 3, spread: 0.2, speed: 190, gun: 0 }, { p: 'fan', every: 2.0, n: 3, spread: 0.2, speed: 190, gun: 1 }, { p: 'curtain', every: 3.4, n: 9, speed: 130 }],
      [{ p: 'guns', every: 0.8, speed: 220, only: [2, 3] }, { p: 'ring', every: 2.4, n: 22, speed: 120, gun: 4 }],
      [{ p: 'spiral', every: 0.07, arms: 2, step: 0.31, speed: 160, gun: 4, dur: 2.0, rest: 1.3 }, { p: 'curtain', every: 3.0, n: 9, speed: 140 }, { p: 'big', every: 2.6, n: 3, speed: 230, gun: 4 }]
    ] },
  airship: { key: 'b_airship', name: '공중 요새 발할라', hp: 2500, y: 170, size: [220, 140],
    guns: [[-95, 30], [95, 30], [0, 70], [-40, -50], [40, -50]],
    phases: [
      [{ p: 'ring', every: 2.2, n: 20, speed: 105, gun: 2 }, { p: 'guns', every: 1.5, speed: 200, only: [0, 1] }],
      [{ p: 'spiral', every: 0.06, arms: 3, step: 0.25, speed: 150, gun: 2, dur: 2.4, rest: 1.2 }, { p: 'fan', every: 1.7, n: 7, spread: 0.15, speed: 205, gun: 2 }],
      [{ p: 'ring', every: 1.5, n: 26, speed: 115, gun: 2 }, { p: 'spiral', every: 0.07, arms: 2, step: -0.28, speed: 165, gun: 3, dur: 2.0, rest: 1.0 }, { p: 'big', every: 2.0, n: 3, speed: 240, gun: 2 }]
    ] },
  omega: { key: 'b_omega', name: '최종 병기 오메가', hp: 3200, y: 160, size: [250, 100],
    guns: [[-110, 20], [110, 20], [-55, 30], [55, 30], [0, 50]],
    phases: [
      [{ p: 'fan', every: 1.4, n: 7, spread: 0.14, speed: 210, gun: 4 }, { p: 'guns', every: 1.2, speed: 210, only: [0, 1] }],
      [{ p: 'spiral', every: 0.09, arms: 4, step: 0.22, speed: 150, gun: 4, dur: 2.2, rest: 1.4 }, { p: 'curtain', every: 3.2, n: 9, speed: 140 }],
      [{ p: 'spiral', every: 0.1, arms: 5, step: 0.19, speed: 150, gun: 4, dur: 2.6, rest: 1.3 }, { p: 'ring', every: 2.6, n: 20, speed: 120, gun: 4 }, { p: 'big', every: 2.2, n: 3, speed: 235, gun: 4 }, { p: 'guns', every: 1.6, speed: 205, only: [2, 3] }]
    ] }
};

/* ---------------------------------------------------------------------
 * 공통 UI 도우미
 * ------------------------------------------------------------------- */
function txt(scene, x, y, str, size, color, extra) {
  return scene.add.text(x, y, str, Object.assign({
    fontFamily: FONT, resolution: ZOOM, fontSize: size + 'px', color, padding: { x: 2, y: 2 }
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
  const n = labels.length, cw = w / n, cx = (i) => -w / 2 + cw * (i + 0.5);
  const texts = labels.map((l, i) => txt(scene, cx(i), 0, l, 16, '#cfe3ff'));
  const draw = () => {
    g.clear();
    g.fillStyle(0x0b1a2e, 0.85); g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(1.5, 0x5fa8ff, 0.6); g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.fillStyle(0xffc93c, 1); g.fillRoundedRect(-w / 2 + 3 + idx * cw, -h / 2 + 3, cw - 6, h - 6, (h - 6) / 2);
    texts.forEach((t, i) => t.setColor(i === idx ? '#3a2000' : '#cfe3ff'));
  };
  c.add([g].concat(texts));
  labels.forEach((l, i) => {
    const z = scene.add.zone(cx(i), 0, cw, h).setInteractive({ useHandCursor: true });
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

// 조작 감도 조절: [−] ■■■■■□□□□□ [+]
function makeSensControl(scene, x, y) {
  const c = scene.add.container(x, y);
  const label = txt(scene, 0, -12, '', 13, '#cfe3ff');
  const bar = scene.add.graphics();
  const draw = () => {
    label.setText('조작 감도  ' + Sens.level + '  (' + Sens.word() + ')');
    bar.clear();
    for (let i = 0; i < 10; i++) {
      bar.fillStyle(i < Sens.level ? 0x5fd3ff : 0x23405f, 1);
      bar.fillRoundedRect(-79 + i * 16, 4, 13, 10, 3);
    }
  };
  const mk = (dx, sign) => {
    const b = scene.add.container(dx, 0);
    const g = scene.add.graphics();
    g.fillStyle(0x24456e, 1); g.fillCircle(0, 0, 19);
    g.lineStyle(2, 0x6fb3ff, 0.7); g.strokeCircle(0, 0, 18);
    b.add([g, txt(scene, 0, -1, sign > 0 ? '+' : '−', 22, '#ffffff')]);
    b.setSize(46, 46).setInteractive({ useHandCursor: true });
    b.on('pointerdown', () => { Sound.unlock(); Sound.click(); Sens.set(Sens.level + sign); draw(); b.setScale(0.9); });
    b.on('pointerup', () => b.setScale(1));
    b.on('pointerout', () => b.setScale(1));
    return b;
  };
  c.add([label, bar, mk(-112, -1), mk(112, 1)]);
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
 * 움직이는 배경 셰이더 (WebGL): 0 바다 · 1 사막 · 2 도시(타일 사용) · 3 하늘 · 4 최종전
 * ------------------------------------------------------------------- */
const BG_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uT;
uniform float uMode;
uniform float uAspect;
varying vec2 outTexCoord;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
float fbm3(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
void main() {
  vec2 uv = outTexCoord;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  vec3 col = vec3(0.3);
  if (uMode < 0.5) {
    vec2 q = p * 8.0 + vec2(0.0, uT * 0.57);
    float w = sin(q.x * 0.9 + q.y * 2.1 + fbm3(q * 0.5) * 3.0 - uT * 1.1);
    w += sin(-q.x * 1.7 + q.y * 1.3 + fbm3(q * 0.7 + 3.0) * 3.0 - uT * 1.4) * 0.7;
    w += sin(q.x * 2.9 + q.y * 3.7 + noise(q * 1.5) * 2.0 - uT * 2.0) * 0.4;
    w /= 2.1;
    float big = fbm3(q * 0.22 + vec2(uT * 0.03, 0.0));
    float crest = smoothstep(0.45, 0.95, w);
    vec3 deep = vec3(0.020, 0.075, 0.140);
    vec3 mid = vec3(0.050, 0.190, 0.300);
    vec3 lite = vec3(0.200, 0.420, 0.560);
    col = mix(deep, mid, smoothstep(-0.6, 0.6, w));
    col = mix(col, lite, crest * 0.55);
    col *= 0.70 + 0.55 * big;
    float foam = crest * smoothstep(0.42, 0.72, noise(q * 5.0 + vec2(0.0, uT * 0.9)));
    foam += smoothstep(0.80, 0.95, w) * 0.5;
    col = mix(col, vec3(0.84, 0.92, 0.96), clamp(foam, 0.0, 1.0) * 0.75);
    float sp = noise(q * 16.0 + vec2(uT * 3.0, uT * 1.3));
    col += vec3(0.9, 0.95, 1.0) * step(0.93, sp) * crest * 0.6;
    col *= 0.88 + 0.22 * uv.y;
  } else if (uMode < 1.5) {
    vec2 q = p * 2.6 + vec2(0.0, uT * 0.19);
    float d = fbm(q * 0.8);
    float rip = sin(q.y * 18.0 + d * 9.0 + q.x * 3.0) * 0.5 + 0.5;
    float dune = sin(q.y * 3.0 + fbm3(q * 0.5) * 6.0) * 0.5 + 0.5;
    col = mix(vec3(0.60, 0.43, 0.25), vec3(0.94, 0.80, 0.56), dune * 0.6 + rip * 0.15 + d * 0.3);
    float rock = smoothstep(0.64, 0.69, fbm3(q * 1.4 + 7.0));
    col = mix(col, vec3(0.36, 0.28, 0.21), rock * 0.85);
    col *= 0.88 + 0.16 * rip;
  } else if (uMode < 2.5) {
    col = vec3(0.3, 0.32, 0.35);
  } else if (uMode < 3.5) {
    vec2 q = p * 1.6 + vec2(0.0, uT * 0.16);
    vec3 sky = mix(vec3(0.30, 0.55, 0.85), vec3(0.62, 0.80, 0.96), uv.y);
    float c1 = fbm(q);
    float c2 = fbm3(q * 2.0 + vec2(5.0, uT * 0.1));
    float cl = smoothstep(0.46, 0.76, c1 * 0.7 + c2 * 0.3);
    float sh = smoothstep(0.46, 0.9, fbm3(q + vec2(0.05, -0.07)) * 0.7 + c2 * 0.3);
    vec3 cloudCol = mix(vec3(1.0), vec3(0.70, 0.76, 0.88), sh * 0.8);
    col = mix(sky, cloudCol, cl * 0.92);
  } else {
    vec2 q = p * 2.0 + vec2(0.0, uT * 0.08);
    float neb = fbm(q * 1.2 + vec2(uT * 0.02, 0.0));
    float neb2 = fbm3(q * 2.5 - vec2(0.0, uT * 0.05));
    col = vec3(0.03, 0.005, 0.05);
    col += vec3(0.38, 0.04, 0.26) * smoothstep(0.35, 0.85, neb);
    col += vec3(0.60, 0.08, 0.10) * smoothstep(0.55, 0.95, neb2) * 0.7;
    vec2 sp = (p + vec2(0.0, uT * 0.05)) * 70.0;
    vec2 sf = fract(sp) - 0.5;
    float st = hash(floor(sp));
    col += vec3(1.0) * smoothstep(0.2, 0.0, length(sf)) * step(0.985, st) * (0.6 + 0.4 * sin(uT * 3.0 + st * 40.0));
    float crack = 1.0 - smoothstep(0.0, 0.03, abs(neb - 0.55));
    col += vec3(1.0, 0.25, 0.2) * crack * 0.25;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function makeBgShader(scene, mode) {
  if (scene.sys.game.renderer.type !== Phaser.WEBGL || !scene.cache.shader.has('bg')) return null;
  try {
    const sh = scene.add.shader('bg', 0, 0, GAME_W, GAME_H).setOrigin(0).setDepth(0.1);
    sh.setUniform('uMode.value', mode);
    sh.setUniform('uAspect.value', GAME_W / GAME_H);
    return sh;
  } catch (e) { return null; }
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

function drawPhantom(g) { // 보라색 삼각날개 고속기
  const c = 0x7b4fd6, dark = 0x4e2f99, light = 0xa98bf0;
  g.fillStyle(dark, 1); g.fillTriangle(28, 14, 3, 46, 53, 46);
  g.fillStyle(c, 1); g.fillTriangle(28, 11, 4, 43, 52, 43);
  g.fillStyle(light, 1); g.fillTriangle(28, 20, 14, 40, 18, 40); g.fillTriangle(28, 20, 42, 40, 38, 40);
  g.fillStyle(dark, 1); g.fillTriangle(22, 42, 27, 34, 25, 54); g.fillTriangle(34, 42, 29, 34, 31, 54);
  g.fillStyle(0xcfd6e0, 1); g.fillRoundedRect(24, 3, 8, 48, 4);
  g.fillStyle(0x5fd3ff, 1); g.fillTriangle(24, 9, 32, 9, 28, 0);
  g.fillStyle(0x1d2f45, 1); g.fillEllipse(28, 21, 5, 11);
  g.fillStyle(0x8fd3ff, 1); g.fillEllipse(27, 19, 2, 4);
  g.fillStyle(0x5fd3ff, 0.9); g.fillRect(9, 41, 6, 2); g.fillRect(41, 41, 6, 2);
}

function drawThunder(g) { // 초록색 쌍동 중장갑기
  const c = 0x5d8a3c, dark = 0x3c5c26, light = 0x86b562;
  g.fillStyle(dark, 1); g.fillRoundedRect(1, 26, 54, 13, 5);
  g.fillStyle(c, 1); g.fillRoundedRect(1, 24, 54, 12, 5);
  g.fillStyle(light, 1); g.fillRect(5, 25, 46, 2);
  g.fillStyle(dark, 1); g.fillRoundedRect(9, 10, 10, 42, 5); g.fillRoundedRect(37, 10, 10, 42, 5);
  g.fillStyle(c, 1); g.fillRoundedRect(10, 11, 8, 38, 4); g.fillRoundedRect(38, 11, 8, 38, 4);
  g.fillStyle(dark, 1); g.fillRoundedRect(9, 46, 38, 7, 3);
  g.fillStyle(0xf2c14e, 1); g.fillCircle(14, 11, 3.5); g.fillCircle(42, 11, 3.5);
  g.fillStyle(0x1b1b1b, 0.75); g.fillRect(6, 8, 16, 2); g.fillRect(34, 8, 16, 2);
  g.fillStyle(0xaab4bf, 1); g.fillRoundedRect(22, 13, 12, 26, 6);
  g.fillStyle(0x1d2f45, 1); g.fillEllipse(28, 22, 6, 11);
  g.fillStyle(0x8fd3ff, 1); g.fillEllipse(27, 20, 2.5, 4);
  g.fillStyle(0xffffff, 1); g.fillCircle(14, 34, 3); g.fillCircle(42, 34, 3);
  g.fillStyle(0xe63946, 1); g.fillCircle(14, 34, 1.5); g.fillCircle(42, 34, 1.5);
}

function drawBlaze(g) { // 주황·빨강 공격기
  const c = 0xd9482b, dark = 0x96301b;
  g.fillStyle(dark, 1); g.fillPoints([{ x: 2, y: 37 }, { x: 20, y: 25 }, { x: 36, y: 25 }, { x: 54, y: 37 }, { x: 54, y: 42 }, { x: 2, y: 42 }], true);
  g.fillStyle(c, 1); g.fillPoints([{ x: 2, y: 35 }, { x: 20, y: 23 }, { x: 36, y: 23 }, { x: 54, y: 35 }, { x: 54, y: 39 }, { x: 2, y: 39 }], true);
  g.fillStyle(0xffc93c, 1); g.fillTriangle(7, 37, 17, 28, 21, 37); g.fillTriangle(49, 37, 39, 28, 35, 37);
  g.fillStyle(dark, 1); g.fillRoundedRect(16, 45, 24, 7, 3);
  g.fillStyle(0x3a3f47, 1); g.fillRoundedRect(22, 5, 12, 47, 6);
  g.fillStyle(0x5a616b, 1); g.fillRoundedRect(24, 6, 6, 42, 3);
  g.fillStyle(c, 1); g.fillTriangle(22, 12, 34, 12, 28, 2);
  g.fillStyle(0x1b1b1b, 0.75); g.fillRect(17, 3, 22, 2);
  g.fillStyle(0x1d2f45, 1); g.fillEllipse(28, 22, 7, 11);
  g.fillStyle(0xffb347, 1); g.fillEllipse(27, 20, 2.5, 4);
}

/* ---------- 제트 전투기 (캔버스 2D, 그라데이션·광택) ---------- */
function cPoly(x, pts, fill) {
  x.beginPath(); x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
  x.closePath(); x.fillStyle = fill; x.fill();
}
function cLin(x, x0, y0, x1, y1, stops) {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}
const cMirror = (pts, W) => pts.map(([a, b]) => [W - a, b]);
function cCanopy(x, cx, cy, rx, ry, tint) {
  x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  x.fillStyle = cLin(x, cx - rx, cy - ry, cx + rx, cy + ry, [[0, tint[0]], [0.45, tint[1]], [1, tint[2]]]); x.fill();
  x.beginPath(); x.ellipse(cx - rx * 0.35, cy - ry * 0.3, rx * 0.3, ry * 0.4, 0, 0, Math.PI * 2);
  x.fillStyle = 'rgba(255,255,255,0.85)'; x.fill();
}
function cFuselage(x, pts, x0, x1, dark, light) {
  cPoly(x, pts, cLin(x, x0, 0, x1, 0, [[0, dark], [0.42, light], [0.58, light], [1, dark]]));
  x.strokeStyle = 'rgba(0,0,0,0.35)'; x.lineWidth = 0.5; x.stroke();
}
function cLines(x, segs, a) {
  x.strokeStyle = 'rgba(0,0,0,' + (a || 0.25) + ')'; x.lineWidth = 0.45; x.beginPath();
  segs.forEach(([a1, b1, a2, b2]) => { x.moveTo(a1, b1); x.lineTo(a2, b2); }); x.stroke();
}
function cNozzle(x, cx, y, w) {
  x.fillStyle = '#1b1f26'; x.fillRect(cx - w / 2, y, w, 5);
  x.fillStyle = 'rgba(255,170,80,0.9)'; x.fillRect(cx - w / 2 + 0.7, y + 3.4, w - 1.4, 1.6);
}

function jetRaptor(x) {        // 56×56 쌍수직꼬리 스텔스기 (파랑)
  const W = 56;
  const stab = [[30, 41], [46, 51], [45, 54.5], [31, 52]];
  const sg = cLin(x, 30, 41, 46, 54, [[0, '#6b88aa'], [1, '#2a3b50']]);
  cPoly(x, stab, sg); cPoly(x, cMirror(stab, W), sg);
  const wing = [[28, 14], [53.5, 37], [52.5, 41.5], [33, 41.5], [28, 40], [23, 41.5], [3.5, 41.5], [2.5, 37]];
  cPoly(x, wing, cLin(x, 6, 14, 50, 42, [[0, '#a9c6e8'], [0.45, '#4f7cb0'], [1, '#22395a']]));
  x.strokeStyle = 'rgba(255,255,255,0.45)'; x.lineWidth = 0.7; x.beginPath(); x.moveTo(28, 14.5); x.lineTo(53, 37); x.moveTo(28, 14.5); x.lineTo(3, 37); x.stroke();
  cPoly(x, [[47, 36], [53.5, 37], [52.5, 41.5], [48, 41.5]], '#ffc93c'); cPoly(x, [[9, 36], [2.5, 37], [3.5, 41.5], [8, 41.5]], '#ffc93c');
  cPoly(x, [[19.5, 35], [22.5, 33], [22, 47], [18.5, 48.5]], '#2b394a'); cPoly(x, cMirror([[19.5, 35], [22.5, 33], [22, 47], [18.5, 48.5]], W), '#2b394a');
  cFuselage(x, [[28, 1], [31, 8], [33.2, 22], [34.2, 40], [32.5, 52], [23.5, 52], [21.8, 40], [22.8, 22], [25, 8]], 22, 34, '#3a4a5c', '#dfe8f1');
  cNozzle(x, 25.7, 50, 3.6); cNozzle(x, 30.3, 50, 3.6);
  cCanopy(x, 28, 17, 2.9, 6.6, ['#fff1b8', '#c98f2c', '#3a2a10']);
  cLines(x, [[23, 26, 33, 26], [22.5, 33, 33.5, 33], [12, 33, 22, 33], [34, 33, 44, 33]]);
}

function jetPhantom(x) {       // 56×56 카나드 델타 고속기 (보라·흰색)
  const W = 56;
  const wing = [[28, 11], [53, 45], [50, 48], [6, 48], [3, 45]];
  cPoly(x, wing, cLin(x, 8, 12, 50, 48, [[0, '#e8dcff'], [0.4, '#8a5ce0'], [1, '#3a1f78']]));
  x.strokeStyle = 'rgba(255,255,255,0.5)'; x.lineWidth = 0.7; x.beginPath(); x.moveTo(28, 11.5); x.lineTo(52.5, 45); x.moveTo(28, 11.5); x.lineTo(3.5, 45); x.stroke();
  cPoly(x, [[40, 44], [53, 45], [50, 48], [42, 48]], '#5fd3ff'); cPoly(x, [[16, 44], [3, 45], [6, 48], [14, 48]], '#5fd3ff');
  const can = [[31, 15], [40, 21], [39, 23], [31, 21]];
  cPoly(x, can, '#6d45c0'); cPoly(x, cMirror(can, W), '#6d45c0');
  cFuselage(x, [[28, 0.5], [30.5, 7], [32, 20], [32.5, 44], [31, 53], [25, 53], [23.5, 44], [24, 20], [25.5, 7]], 23.5, 32.5, '#4b3a6e', '#f4f0ff');
  cPoly(x, [[27.2, 30], [28.8, 30], [29.5, 50], [26.5, 50]], '#2a1d48');
  cNozzle(x, 28, 51, 5);
  cCanopy(x, 28, 16, 2.4, 6, ['#d8f6ff', '#3fa7d6', '#0b2a40']);
  cLines(x, [[24, 28, 32, 28], [14, 40, 42, 40]]);
}

function jetThunder(x) {       // 56×56 쌍발 중장갑 공격기 (위장 녹색)
  const W = 56;
  const wing = [[3, 24], [53, 24], [54.5, 27], [53, 33], [3, 33], [1.5, 27]];
  cPoly(x, wing, cLin(x, 0, 22, 0, 34, [[0, '#a4c27e'], [0.5, '#5d8a3c'], [1, '#2f4a1e']]));
  x.fillStyle = 'rgba(40,60,25,0.55)'; [[10, 27, 6, 2.5], [40, 29, 7, 2.5], [22, 30, 5, 2]].forEach(([a, b, c, d]) => { x.beginPath(); x.ellipse(a, b, c, d, 0.3, 0, Math.PI * 2); x.fill(); });
  const tail = [[10, 45], [46, 45], [47, 50], [9, 50]];
  cPoly(x, tail, cLin(x, 0, 45, 0, 50, [[0, '#7da05a'], [1, '#2f4a1e']]));
  cPoly(x, [[9, 41], [12, 41], [12.5, 53], [8.5, 53]], '#2f4a1e'); cPoly(x, cMirror([[9, 41], [12, 41], [12.5, 53], [8.5, 53]], W), '#2f4a1e');
  cFuselage(x, [[28, 2], [31, 7], [33, 20], [33, 44], [31, 52], [25, 52], [23, 44], [23, 20], [25, 7]], 23, 33, '#3c4a30', '#c9d4bc');
  [[18.5, 33], [37.5, 33]].forEach(([cx, cy]) => {
    x.beginPath(); x.ellipse(cx, cy + 5, 4.2, 8, 0, 0, Math.PI * 2);
    x.fillStyle = cLin(x, cx - 4, 0, cx + 4, 0, [[0, '#2b3324'], [0.5, '#9aa58c'], [1, '#2b3324']]); x.fill();
    x.fillStyle = '#15181c'; x.beginPath(); x.arc(cx, cy - 1.5, 2.6, 0, Math.PI * 2); x.fill();
  });
  cNozzle(x, 18.5, 45, 4.2); cNozzle(x, 37.5, 45, 4.2);
  cCanopy(x, 28, 14, 3.2, 5.5, ['#e6f7ff', '#5aa0c8', '#123045']);
  x.fillStyle = '#ffffff'; x.beginPath(); x.arc(9, 28.5, 2.4, 0, Math.PI * 2); x.arc(47, 28.5, 2.4, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#e63946'; x.beginPath(); x.arc(9, 28.5, 1.1, 0, Math.PI * 2); x.arc(47, 28.5, 1.1, 0, Math.PI * 2); x.fill();
  cLines(x, [[23, 22, 33, 22], [23, 36, 33, 36]]);
}

function jetBlaze(x) {         // 56×56 전진익 공격기 (빨강·검정)
  const W = 56;
  const wing = [[31, 26], [49, 19], [53, 22], [52, 26.5], [33, 43]];
  const wg = cLin(x, 30, 20, 52, 44, [[0, '#ff8a5c'], [0.5, '#c8321e'], [1, '#5a120a']]);
  cPoly(x, wing, wg); cPoly(x, cMirror(wing, W), wg);
  cPoly(x, [[46, 20.5], [49, 19], [53, 22], [52, 26.5], [47, 25]], '#1d1f24'); cPoly(x, cMirror([[46, 20.5], [49, 19], [53, 22], [52, 26.5], [47, 25]], W), '#1d1f24');
  const can = [[31, 13], [39, 18], [38, 20], [31, 19]];
  cPoly(x, can, '#b02a1a'); cPoly(x, cMirror(can, W), '#b02a1a');
  const stab = [[31, 46], [42, 52], [41, 55], [31, 53]];
  cPoly(x, stab, '#2a2d34'); cPoly(x, cMirror(stab, W), '#2a2d34');
  cFuselage(x, [[28, 0.5], [31, 7], [33, 22], [33.5, 44], [32, 53], [24, 53], [22.5, 44], [23, 22], [25, 7]], 22.5, 33.5, '#1e2228', '#8e98a6');
  cPoly(x, [[26.5, 24], [29.5, 24], [30.5, 46], [25.5, 46]], '#d9482b');
  cPoly(x, [[27.2, 24], [28.8, 24], [29.2, 40], [26.8, 40]], '#ffc93c');
  cNozzle(x, 28, 51, 5.5);
  cCanopy(x, 28, 15.5, 2.7, 6, ['#ffe6c8', '#e0702c', '#3a1408']);
}

function jetEnemy(x) {         // 44×44 적 제트기 (아래를 향함, 회색·적색)
  x.save(); x.translate(22, 22); x.rotate(Math.PI); x.translate(-22, -22);
  const W = 44;
  const wing = [[22, 13], [41, 31], [40, 34], [26, 32], [22, 31], [18, 32], [4, 34], [3, 31]];
  cPoly(x, wing, cLin(x, 4, 13, 40, 34, [[0, '#c9ced6'], [0.5, '#7a8290'], [1, '#353b45']]));
  cPoly(x, [[36, 29], [41, 31], [40, 34], [36, 33]], '#d23b3b'); cPoly(x, [[8, 29], [3, 31], [4, 34], [8, 33]], '#d23b3b');
  const st = [[24, 34], [34, 40], [33, 42.5], [24, 41]];
  cPoly(x, st, '#4a515c'); cPoly(x, cMirror(st, W), '#4a515c');
  cPoly(x, [[21.2, 28], [22.8, 28], [23, 42], [21, 42]], '#8e1f1f');
  cFuselage(x, [[22, 1], [24.5, 8], [26, 20], [26, 34], [24.5, 42], [19.5, 42], [18, 34], [18, 20], [19.5, 8]], 18, 26, '#3a3f48', '#d5dae2');
  cNozzle(x, 22, 40, 4.4);
  cCanopy(x, 22, 13, 2.3, 5, ['#ffd6d6', '#c03030', '#3a0a0a']);
  x.restore();
}

/* ---------- 조종사 얼굴 (64×64) ---------- */
function drawPilotHan(g) {          // 한서진: 검은 포니테일, 빨간 머플러, 이마 위 고글
  g.fillStyle(0x1d3d66, 1); g.fillCircle(32, 32, 32);
  g.fillStyle(0x161616, 1); g.fillEllipse(32, 27, 40, 40); g.fillEllipse(52, 40, 10, 22);
  g.fillStyle(0x3b5b7a, 1); g.fillEllipse(32, 64, 54, 26);
  g.fillStyle(0xf1c6a5, 1); g.fillRect(27, 43, 10, 10);
  g.fillStyle(0xe63946, 1); g.fillEllipse(32, 53, 28, 9); g.fillTriangle(38, 53, 46, 62, 41, 52);
  g.fillStyle(0xf3cfb0, 1); g.fillEllipse(32, 33, 26, 30);
  g.fillStyle(0x161616, 1); g.fillEllipse(27, 21, 24, 11); g.fillTriangle(19, 22, 31, 17, 21, 31); g.fillEllipse(42, 22, 10, 9);
  g.fillStyle(0x8a5a2b, 1); g.fillRect(17, 15, 30, 5);
  g.fillStyle(0x7fd3ff, 1); g.fillCircle(25, 17, 4); g.fillCircle(39, 17, 4);
  g.fillStyle(0xffffff, 0.8); g.fillCircle(24, 16, 1.2); g.fillCircle(38, 16, 1.2);
  g.fillStyle(0x1a1a1a, 1); g.fillEllipse(27, 33, 3.2, 4); g.fillEllipse(37, 33, 3.2, 4);
  g.fillRect(24, 28.5, 6, 1.3); g.fillRect(34, 28.5, 6, 1.3);
  g.fillStyle(0xf2a99a, 0.6); g.fillCircle(24, 38, 2.5); g.fillCircle(40, 38, 2.5);
  g.fillStyle(0xc0565a, 1); g.fillRoundedRect(29.5, 41, 5, 1.8, 0.9);
}

function drawPilotClaire(g) {       // 클레르: 금발 단발, 파란 머플러, 윙크
  g.fillStyle(0x2a2f6e, 1); g.fillCircle(32, 32, 32);
  g.fillStyle(0xe8bf5a, 1); g.fillEllipse(32, 31, 42, 40);
  g.fillStyle(0x6e5a3a, 1); g.fillEllipse(32, 64, 52, 26);
  g.fillStyle(0xf7d9c4, 1); g.fillRect(27, 43, 10, 10);
  g.fillStyle(0x3a7bd5, 1); g.fillEllipse(32, 53, 28, 9); g.fillTriangle(24, 53, 16, 62, 22, 52);
  g.fillStyle(0xf7d9c4, 1); g.fillEllipse(32, 34, 25, 28);
  g.fillStyle(0xf4d27a, 1); g.fillEllipse(32, 21, 30, 13); g.fillTriangle(20, 22, 34, 18, 22, 32);
  g.fillStyle(0x444b55, 1); g.fillRect(16, 13, 32, 4);
  g.fillStyle(0xffd27a, 1); g.fillCircle(25, 15, 3.5); g.fillCircle(39, 15, 3.5);
  g.fillStyle(0x2b5fa8, 1); g.fillEllipse(27, 34, 3.4, 4.2);
  g.fillStyle(0x1a1a1a, 1); g.fillRect(34.5, 34, 5, 1.4);
  g.fillStyle(0xf2a99a, 0.6); g.fillCircle(24, 39, 2.4); g.fillCircle(40, 39, 2.4);
  g.fillStyle(0xc0565a, 1); g.fillTriangle(29, 41, 36, 41, 33, 43.5);
}

function drawPilotJack(g) {         // 잭: 가죽 비행모, 선글라스, 수염
  g.fillStyle(0x5c2a2a, 1); g.fillCircle(32, 32, 32);
  g.fillStyle(0x5d6b3a, 1); g.fillEllipse(32, 64, 62, 30);
  g.fillStyle(0x8d5a3b, 1); g.fillRect(25, 42, 14, 12);
  g.fillStyle(0xf2f2f2, 1); g.fillEllipse(32, 53, 30, 9);
  g.fillStyle(0x8d5a3b, 1); g.fillEllipse(32, 33, 30, 32);
  g.fillStyle(0x2b1d14, 1); g.fillEllipse(32, 42, 26, 16);
  g.fillStyle(0x8d5a3b, 1); g.fillEllipse(32, 38, 22, 10);
  g.fillStyle(0x2b1d14, 1); g.fillRoundedRect(26, 37, 12, 3, 1.5);
  g.fillStyle(0x6b4a2b, 1); g.fillEllipse(32, 21, 34, 20); g.fillRoundedRect(15, 20, 7, 18, 3); g.fillRoundedRect(42, 20, 7, 18, 3);
  g.fillStyle(0x4a3220, 1); g.fillRect(17, 24, 30, 2.5);
  g.fillStyle(0x111111, 1); g.fillRoundedRect(20, 28, 11, 7, 3); g.fillRoundedRect(33, 28, 11, 7, 3); g.fillRect(30, 30, 4, 1.5);
  g.fillStyle(0xffffff, 0.35); g.fillRect(22, 29, 4, 1.5); g.fillRect(35, 29, 4, 1.5);
  g.fillStyle(0xd48a8a, 1); g.fillRoundedRect(29, 43, 6, 1.6, 0.8);
}

function drawPilotOliver(g) {       // 올리버: 붉은 머리, 가죽 헬멧, 콧수염
  g.fillStyle(0x2f4a3a, 1); g.fillCircle(32, 32, 32);
  g.fillStyle(0x7a5230, 1); g.fillEllipse(32, 64, 54, 26);
  g.fillStyle(0xf2c9a8, 1); g.fillRect(27, 43, 10, 10);
  g.fillStyle(0xe8dcc0, 1); g.fillEllipse(32, 53, 28, 9);
  g.fillStyle(0xf2c9a8, 1); g.fillEllipse(32, 34, 26, 29);
  g.fillStyle(0xc8642c, 1); g.fillEllipse(32, 24, 28, 12);
  g.fillStyle(0x7a5230, 1); g.fillEllipse(32, 18, 34, 18); g.fillRoundedRect(16, 18, 7, 20, 3); g.fillRoundedRect(41, 18, 7, 20, 3);
  g.fillStyle(0x555b63, 1); g.fillRect(17, 16, 30, 4);
  g.fillStyle(0x9ad9c0, 1); g.fillCircle(25, 18, 3.5); g.fillCircle(39, 18, 3.5);
  g.fillStyle(0x1a1a1a, 1); g.fillEllipse(27, 32, 3, 3.6); g.fillEllipse(37, 32, 3, 3.6);
  g.fillStyle(0xb5561f, 1); g.fillEllipse(28, 39, 9, 3.2); g.fillEllipse(36, 39, 9, 3.2);
  g.fillStyle(0xc0565a, 1); g.fillRoundedRect(30, 42.5, 4, 1.4, 0.7);
}

/* ---------- 국기 (54×36) ---------- */
function trigram(g, cx, cy, ang, pattern) {   // 태극기 괘: pattern = 안쪽→바깥 [막대가 이어졌는지]
  const len = 9, th = 1.8, gap = 1.4;
  const ux = Math.cos(ang), uy = Math.sin(ang), px = -uy, py = ux;
  pattern.forEach((solid, i) => {
    const off = (i - 1) * (th + gap);
    const bx = cx + ux * off, by = cy + uy * off;
    const segs = solid ? [[-len / 2, len / 2]] : [[-len / 2, -0.9], [0.9, len / 2]];
    segs.forEach(([a, b]) => {
      g.fillPoints([[a, -th / 2], [b, -th / 2], [b, th / 2], [a, th / 2]]
        .map(([sx, tt]) => ({ x: bx + px * sx + ux * tt, y: by + py * sx + uy * tt })), true);
    });
  });
}

function drawFlagKR(g) {
  g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 54, 36);
  g.lineStyle(1, 0xcccccc, 1); g.strokeRect(0.5, 0.5, 53, 35);
  const cx = 27, cy = 18, r = 7.5;
  g.fillStyle(0x0047a0, 1); g.fillCircle(cx, cy, r);
  g.fillStyle(0xcd2e3a, 1); g.slice(cx, cy, r, Math.PI, Math.PI * 2, false); g.fillPath();
  g.fillStyle(0xcd2e3a, 1); g.fillCircle(cx - r / 2, cy, r / 2);
  g.fillStyle(0x0047a0, 1); g.fillCircle(cx + r / 2, cy, r / 2);
  g.fillStyle(0x111111, 1);
  const d = (x, y) => Math.atan2(y - cy, x - cx);
  trigram(g, 11, 7.5, d(11, 7.5), [true, true, true]);      // 건 ☰
  trigram(g, 43, 7.5, d(43, 7.5), [false, true, false]);    // 감 ☵
  trigram(g, 11, 28.5, d(11, 28.5), [true, false, true]);   // 리 ☲
  trigram(g, 43, 28.5, d(43, 28.5), [false, false, false]); // 곤 ☷
}

function drawFlagFR(g) {
  g.fillStyle(0x0055a4, 1); g.fillRect(0, 0, 18, 36);
  g.fillStyle(0xffffff, 1); g.fillRect(18, 0, 18, 36);
  g.fillStyle(0xef4135, 1); g.fillRect(36, 0, 18, 36);
}

function drawFlagUS(g) {
  const sh = 36 / 13;
  for (let i = 0; i < 13; i++) { g.fillStyle(i % 2 ? 0xffffff : 0xb22234, 1); g.fillRect(0, i * sh, 54, sh + 0.2); }
  g.fillStyle(0x3c3b6e, 1); g.fillRect(0, 0, 23, sh * 7);
  g.fillStyle(0xffffff, 1);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) g.fillCircle(2.8 + c * 4.4 + (r % 2) * 2.2, 2.8 + r * 4.6, 0.9);
}

function drawFlagUK(g) {
  g.fillStyle(0x012169, 1); g.fillRect(0, 0, 54, 36);
  g.lineStyle(7, 0xffffff, 1); g.lineBetween(0, 0, 54, 36); g.lineBetween(54, 0, 0, 36);
  g.lineStyle(2.4, 0xc8102e, 1); g.lineBetween(0, 0, 54, 36); g.lineBetween(54, 0, 0, 36);
  g.fillStyle(0xffffff, 1); g.fillRect(22, 0, 10, 36); g.fillRect(0, 13, 54, 10);
  g.fillStyle(0xc8102e, 1); g.fillRect(24, 0, 6, 36); g.fillRect(0, 15, 54, 6);
}

/* ---------- 스테이지 배경 타일 (128×128, 가장자리는 이어지게) ---------- */
function makeRnd(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }

function drawTileDesert(g) {
  const r = makeRnd(23);
  g.fillStyle(0xd9b77e, 1); g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 18; i++) { g.fillStyle(0xc49a5e, 0.55); g.fillRoundedRect(4 + r() * 96, 4 + r() * 118, 14 + r() * 18, 3, 1.5); }
  for (let i = 0; i < 12; i++) { g.fillStyle(0xa98250, 0.6); g.fillCircle(6 + r() * 116, 6 + r() * 116, 1.2 + r() * 1.6); }
}

function drawTileCity(g) {
  const r = makeRnd(41);
  g.fillStyle(0x50565f, 1); g.fillRect(0, 0, 128, 128);
  g.fillStyle(0x6a7079, 1); g.fillRect(48, 0, 32, 128); g.fillRect(0, 48, 128, 32);
  g.fillStyle(0x2f333a, 1); g.fillRect(52, 0, 24, 128); g.fillRect(0, 52, 128, 24);
  g.fillStyle(0xe8c547, 1);
  for (let y = 0; y < 128; y += 16) if (y < 46 || y > 78) g.fillRect(63, y + 3, 2, 8);
  for (let x = 0; x < 128; x += 16) if (x < 46 || x > 78) g.fillRect(x + 3, 63, 8, 2);
  [[4, 4], [84, 4], [4, 84], [84, 84]].forEach(([qx, qy]) => {
    const roof = [0x7d838c, 0x8a6f5a, 0x5e6b7a, 0x6f7a62][Math.floor(r() * 4)];
    g.fillStyle(0x000000, 0.25); g.fillRect(qx + 4, qy + 4, 40, 40);
    g.fillStyle(roof, 1); g.fillRoundedRect(qx, qy, 40, 40, 3);
    g.fillStyle(0x000000, 0.15); g.fillRect(qx + 4, qy + 4, 14, 10);
    g.fillStyle(0xbfc5cc, 1); g.fillRect(qx + 24, qy + 24, 8, 8);
  });
}

function drawTileSky(g) {
  const r = makeRnd(57);
  g.fillStyle(0x86bde8, 1); g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 7; i++) { g.fillStyle(0xffffff, 0.12); g.fillEllipse(24 + r() * 80, 20 + r() * 88, 30 + r() * 24, 12 + r() * 8); }
  for (let i = 0; i < 10; i++) { g.fillStyle(0xffffff, 0.25); g.fillRoundedRect(6 + r() * 100, 6 + r() * 116, 10 + r() * 14, 2, 1); }
}

function drawTileFinal(g) {
  const r = makeRnd(77);
  g.fillStyle(0x1f0b24, 1); g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 5; i++) { g.fillStyle(0x4a1240, 0.35); g.fillEllipse(26 + r() * 76, 26 + r() * 76, 40 + r() * 30, 20 + r() * 16); }
  for (let i = 0; i < 16; i++) { g.fillStyle(0xffffff, 0.35 + r() * 0.4); g.fillCircle(6 + r() * 116, 6 + r() * 116, 0.7 + r() * 0.8); }
  for (let i = 0; i < 4; i++) { g.fillStyle(0xff3b4e, 0.3); g.fillCircle(10 + r() * 108, 10 + r() * 108, 1.5); }
}

function drawDune(g) {     // 160×90 모래 언덕
  g.fillStyle(0xa88350, 0.6); g.fillEllipse(84, 52, 150, 70);
  g.fillStyle(0xc9a46a, 1); g.fillEllipse(78, 46, 146, 66);
  g.fillStyle(0xe6c993, 1); g.fillEllipse(64, 38, 90, 34);
}

function drawBuilding(g) { // 96×96 고층 빌딩 (위에서 본 모습)
  g.fillStyle(0x000000, 0.32); g.fillRect(16, 16, 76, 76);
  g.fillStyle(0x9aa3ad, 1); g.fillRect(6, 6, 76, 76);
  g.fillStyle(0xb8c0c9, 1); g.fillRect(10, 10, 68, 68);
  g.fillStyle(0x6b737d, 1); g.fillCircle(44, 44, 18);
  g.fillStyle(0xe8c547, 1); g.fillRect(36, 42, 16, 4); g.fillRect(36, 34, 4, 20); g.fillRect(48, 34, 4, 20);
  g.fillStyle(0xd23b3b, 1); g.fillCircle(14, 14, 3); g.fillCircle(74, 74, 3);
}

function drawDebris(g) {   // 110×80 떠다니는 잔해
  g.fillStyle(0x2a1a2a, 1);
  g.fillPoints([{ x: 10, y: 40 }, { x: 34, y: 10 }, { x: 70, y: 14 }, { x: 100, y: 36 }, { x: 88, y: 66 }, { x: 42, y: 72 }], true);
  g.fillStyle(0x3d2840, 1); g.fillPoints([{ x: 24, y: 40 }, { x: 40, y: 22 }, { x: 66, y: 26 }, { x: 82, y: 42 }, { x: 60, y: 56 }], true);
  g.lineStyle(2, 0xff4d4d, 0.85); g.lineBetween(30, 44, 52, 34); g.lineBetween(52, 34, 70, 48);
}

/* ---------- 지상·해상 적 ---------- */
function drawShip(g) {     // 44×110 구축함 (뱃머리 아래)
  g.fillStyle(0x5b636e, 1);
  g.fillPoints([{ x: 22, y: 108 }, { x: 40, y: 80 }, { x: 40, y: 14 }, { x: 30, y: 2 }, { x: 14, y: 2 }, { x: 4, y: 14 }, { x: 4, y: 80 }], true);
  g.fillStyle(0x8a93a0, 1);
  g.fillPoints([{ x: 22, y: 100 }, { x: 35, y: 78 }, { x: 35, y: 16 }, { x: 28, y: 7 }, { x: 16, y: 7 }, { x: 9, y: 16 }, { x: 9, y: 78 }], true);
  g.fillStyle(0x4a525c, 1); g.fillRoundedRect(13, 40, 18, 22, 3);
  g.fillStyle(0x9ed8ff, 0.6); g.fillRect(15, 56, 14, 3);
  [[22, 24], [22, 84]].forEach(([x, y]) => {
    g.fillStyle(0x3a4048, 1); g.fillCircle(x, y, 7);
    g.fillStyle(0x222222, 1); g.fillRect(x - 1, y, 2, 10);
  });
}

function drawTank(g) {     // 38×44 전차 차체
  g.fillStyle(0x2f3324, 1); g.fillRoundedRect(1, 3, 10, 38, 3); g.fillRoundedRect(27, 3, 10, 38, 3);
  g.fillStyle(0x4a5036, 1); for (let y = 6; y < 40; y += 6) { g.fillRect(2, y, 8, 2); g.fillRect(28, y, 8, 2); }
  g.fillStyle(0x6b7a3a, 1); g.fillRoundedRect(8, 6, 22, 32, 4);
  g.fillStyle(0x8a9a52, 1); g.fillRect(11, 9, 16, 4);
}

function drawTurret(g) {   // 30×30 전차 포탑 (오른쪽을 향함 → 회전해서 조준)
  g.fillStyle(0x222222, 1); g.fillRect(15, 13, 15, 4);
  g.fillStyle(0x55632e, 1); g.fillCircle(15, 15, 9);
  g.fillStyle(0x7d8c48, 1); g.fillCircle(13, 13, 3);
}

/* ---------- 스테이지 보스 ---------- */
function bossGun(g, x, y, r, core) {
  g.fillStyle(0x22272e, 1); g.fillCircle(x, y, r);
  g.fillStyle(0x111111, 1); g.fillRect(x - 2, y, 4, r + 6);
  g.fillStyle(core, 1); g.fillCircle(x, y, r * 0.4);
}

function drawKraken(g) {   // 160×250 전함
  g.fillStyle(0x3c444e, 1);
  g.fillPoints([{ x: 80, y: 248 }, { x: 150, y: 190 }, { x: 156, y: 60 }, { x: 120, y: 4 }, { x: 40, y: 4 }, { x: 4, y: 60 }, { x: 10, y: 190 }], true);
  g.fillStyle(0x6e7884, 1);
  g.fillPoints([{ x: 80, y: 232 }, { x: 138, y: 184 }, { x: 142, y: 64 }, { x: 112, y: 16 }, { x: 48, y: 16 }, { x: 18, y: 64 }, { x: 22, y: 184 }], true);
  g.fillStyle(0xb83232, 1); g.fillRect(6, 58, 148, 4);
  g.fillStyle(0x5a636e, 1); g.fillRect(28, 100, 104, 3); g.fillRect(28, 160, 104, 3);
  g.fillStyle(0x3a424c, 1); g.fillRoundedRect(56, 94, 48, 62, 6);
  g.fillStyle(0x9ed8ff, 0.6); g.fillRect(62, 142, 36, 6);
  [[32, 55], [128, 55], [80, 125], [36, 195], [124, 195]].forEach(([x, y]) => bossGun(g, x, y, 13, 0xd23b3b));
}

function drawTitan(g) {    // 230×190 육상 요새 전차
  g.fillStyle(0x2f2a22, 1); g.fillRoundedRect(4, 10, 44, 170, 10); g.fillRoundedRect(182, 10, 44, 170, 10);
  g.fillStyle(0x4a4236, 1); for (let y = 16; y < 176; y += 12) { g.fillRect(8, y, 36, 4); g.fillRect(186, y, 36, 4); }
  g.fillStyle(0x7a6a46, 1); g.fillRoundedRect(36, 20, 158, 150, 16);
  g.fillStyle(0xa8966a, 1); g.fillRoundedRect(46, 30, 138, 130, 12);
  g.fillStyle(0x6e6142, 1); g.fillCircle(115, 95, 38);
  g.fillStyle(0x8a7a52, 1); g.fillCircle(110, 90, 24);
  [[35, 55], [195, 55], [35, 145], [195, 145]].forEach(([x, y]) => bossGun(g, x, y, 14, 0xff9a3d));
  bossGun(g, 115, 95, 16, 0xc0392b);
}

function drawIronbird(g) { // 270×150 초대형 폭격기
  g.fillStyle(0x3a2f33, 1); g.fillRoundedRect(2, 50, 266, 40, 14);
  g.fillStyle(0x6b2f36, 1); g.fillRoundedRect(2, 46, 266, 36, 14);
  g.fillStyle(0xd4a03a, 1); g.fillRect(10, 60, 250, 4);
  [20, 48, 76, 104, 166, 194, 222, 250].forEach((x) => {
    g.fillStyle(0x2a2226, 1); g.fillRoundedRect(x - 7, 56, 14, 30, 5);
    g.fillStyle(0xff8a3d, 0.8); g.fillRect(x - 4, 86, 8, 3);
  });
  g.fillStyle(0x2a2226, 1); g.fillRoundedRect(95, 2, 80, 16, 6);
  g.fillStyle(0x2a2226, 1); g.fillRoundedRect(115, 0, 40, 148, 18);
  g.fillStyle(0x7a3640, 1); g.fillRoundedRect(119, 4, 32, 138, 15);
  g.fillStyle(0x1e2c33, 1); g.fillEllipse(135, 140, 24, 16);
  g.fillStyle(0x9ed8ff, 0.7); g.fillEllipse(131, 138, 8, 5);
  [[35, 85], [235, 85], [85, 95], [185, 95], [135, 115]].forEach(([x, y]) => bossGun(g, x, y, 9, 0xffd166));
}

function drawAirship(g) {  // 250×180 공중 요새 비행선
  g.fillStyle(0x3d444d, 1); g.fillTriangle(100, 2, 150, 2, 125, 34); g.fillTriangle(20, 40, 50, 20, 52, 60); g.fillTriangle(230, 40, 200, 20, 198, 60);
  g.fillStyle(0x5b6470, 1); g.fillEllipse(125, 82, 240, 150);
  g.fillStyle(0x7a8592, 1); g.fillEllipse(118, 72, 200, 108);
  g.fillStyle(0x4a525c, 1); g.fillRect(12, 80, 226, 3); g.fillRect(40, 40, 170, 2); g.fillRect(40, 120, 170, 2);
  g.fillStyle(0xc0392b, 1); g.fillCircle(125, 60, 11);
  g.fillStyle(0x2f353d, 1); g.fillRoundedRect(85, 130, 80, 46, 10);
  g.fillStyle(0xffd27a, 1); for (let x = 94; x < 160; x += 14) g.fillRect(x, 140, 8, 5);
  g.fillStyle(0x2f353d, 1); g.fillRoundedRect(14, 98, 34, 30, 8); g.fillRoundedRect(202, 98, 34, 30, 8);
  [[30, 120], [220, 120], [125, 160], [85, 40], [165, 40]].forEach(([x, y]) => bossGun(g, x, y, 10, 0xff5d6c));
}

function drawOmega(g) {    // 290×170 최종 병기 (검은 전익기)
  g.fillStyle(0x15151c, 1);
  g.fillPoints([{ x: 145, y: 168 }, { x: 288, y: 70 }, { x: 270, y: 40 }, { x: 145, y: 8 }, { x: 20, y: 40 }, { x: 2, y: 70 }], true);
  g.fillStyle(0x2a2a38, 1);
  g.fillPoints([{ x: 145, y: 150 }, { x: 262, y: 70 }, { x: 248, y: 50 }, { x: 145, y: 24 }, { x: 42, y: 50 }, { x: 28, y: 70 }], true);
  g.lineStyle(2, 0xff3b4e, 0.85); g.lineBetween(145, 30, 145, 150); g.lineBetween(50, 64, 120, 80); g.lineBetween(240, 64, 170, 80);
  g.fillStyle(0x7a0010, 1); g.fillCircle(145, 85, 26);
  g.fillStyle(0xff3b4e, 1); g.fillCircle(145, 85, 16);
  g.fillStyle(0xffd0d5, 1); g.fillCircle(145, 85, 6);
  [[35, 105], [255, 105], [90, 115], [200, 115], [145, 135]].forEach(([x, y]) => bossGun(g, x, y, 9, 0xff3b4e));
}

function drawGunship(g) { // 120×116 대형 공격 헬기 (기수 아래)
  g.fillStyle(0x2f4430, 1); g.fillRoundedRect(55, 2, 10, 50, 4);
  g.fillStyle(0x223322, 1); g.fillRect(40, 2, 40, 7);
  g.fillStyle(0x223322, 1); g.fillRect(6, 56, 108, 9);
  g.fillStyle(0x3a3a3a, 1); g.fillRoundedRect(4, 52, 18, 24, 4); g.fillRoundedRect(98, 52, 18, 24, 4);
  g.fillStyle(0xff5d5d, 1); g.fillCircle(9, 75, 2.5); g.fillCircle(17, 75, 2.5); g.fillCircle(103, 75, 2.5); g.fillCircle(111, 75, 2.5);
  g.fillStyle(0x3d5a3a, 1); g.fillEllipse(60, 66, 56, 80);
  g.fillStyle(0x56794f, 1); g.fillEllipse(52, 58, 18, 40);
  g.fillStyle(0xc23b3b, 1); g.fillRect(45, 40, 30, 4);
  g.fillStyle(0x1e2c33, 1); g.fillEllipse(60, 96, 30, 22);
  g.fillStyle(0x9ed8ff, 0.8); g.fillEllipse(55, 94, 10, 7);
  g.fillStyle(0x222222, 1); g.fillRect(57, 104, 6, 11);
}

function drawFortress(g) { // 200×124 하늘 요새 (6발 대형 폭격기)
  const b = 0x4a5563, d = 0x2f3742, l = 0x6f7d8d;
  g.fillStyle(d, 1); g.fillRoundedRect(66, 2, 68, 14, 5);
  g.fillStyle(d, 1); g.fillRoundedRect(2, 44, 196, 28, 10);
  g.fillStyle(b, 1); g.fillRoundedRect(2, 40, 196, 26, 10);
  g.fillStyle(l, 1); g.fillRect(10, 43, 180, 3);
  [22, 50, 78, 122, 150, 178].forEach((x) => {
    g.fillStyle(d, 1); g.fillRoundedRect(x - 7, 50, 14, 26, 5);
    g.fillStyle(0xff8a3d, 0.8); g.fillRect(x - 4, 76, 8, 3);
  });
  g.fillStyle(d, 1); g.fillRoundedRect(84, 0, 32, 118, 14);
  g.fillStyle(b, 1); g.fillRoundedRect(87, 3, 26, 110, 12);
  g.fillStyle(0xd23b3b, 1); g.fillRect(90, 22, 20, 5);
  g.fillStyle(0x1e2c33, 1); g.fillEllipse(100, 112, 22, 18);
  g.fillStyle(0x9ed8ff, 0.7); g.fillEllipse(96, 110, 7, 6);
  [[30, 58], [170, 58], [100, 62]].forEach(([x, y]) => {
    g.fillStyle(0x22272e, 1); g.fillCircle(x, y, 8);
    g.fillStyle(0xd23b3b, 1); g.fillCircle(x, y, 3);
  });
}

function drawAce(g) { // 76×76 붉은 에이스기 (기수 아래)
  g.fillStyle(0x5a1010, 1); g.fillRoundedRect(24, 2, 28, 9, 4);
  g.fillStyle(0x2a0a0a, 1); g.fillRoundedRect(2, 26, 72, 17, 7);
  g.fillStyle(0xb81d24, 1); g.fillRoundedRect(2, 24, 72, 15, 7);
  g.fillStyle(0xffc93c, 1); g.fillRect(6, 34, 64, 3);
  g.fillStyle(0x1a1a1a, 1); g.fillRoundedRect(30, 2, 16, 66, 8);
  g.fillStyle(0xc0272d, 1); g.fillRoundedRect(32, 4, 12, 58, 6);
  g.fillStyle(0xffc93c, 1); g.fillTriangle(30, 60, 46, 60, 38, 74);
  g.fillStyle(0x111111, 0.8); g.fillRect(26, 72, 24, 2);
  g.fillStyle(0x222b33, 1); g.fillEllipse(38, 42, 9, 14);
  g.fillStyle(0xffc93c, 1); g.fillCircle(14, 31, 4); g.fillCircle(62, 31, 4);
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
    // WebGL이면 모든 그림을 2배 크기로 그린 뒤 표시 크기만 원래대로 줄여 선명하게
    const HD = this.sys.game.renderer.type === Phaser.WEBGL ? 2 : 1;
    const NO_HD = new Set(['sea', 'glint', 'tile_desert', 'tile_city', 'tile_sky', 'tile_final']);
    const hdKeys = [];
    const tex = (key, w, h, fn) => {
      const sc = NO_HD.has(key) ? 1 : HD;
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      if (sc !== 1) g.scaleCanvas(sc, sc);
      fn(g);
      g.generateTexture(key, w * sc, h * sc);
      g.destroy();
      if (sc !== 1) hdKeys.push([key, sc]);
    };
    // 캔버스 2D로 직접 그리는 텍스처 (그라데이션·글로우용)
    const ctex = (key, w, h, draw, hd = true) => {
      const sc = hd ? HD : 1;
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * sc); c.height = Math.ceil(h * sc);
      const x = c.getContext('2d');
      x.scale(sc, sc);
      draw(x, w, h);
      if (this.textures.exists(key)) this.textures.remove(key);
      this.textures.addCanvas(key, c);
      if (sc !== 1) hdKeys.push([key, sc]);
    };
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    ctex('player', 56, 56, jetRaptor);
    ctex('plane_phantom', 56, 56, jetPhantom);
    ctex('plane_thunder', 56, 56, jetThunder);
    ctex('plane_blaze', 56, 56, jetBlaze);
    tex('missile', 8, 22, (g) => {
      g.fillStyle(0xffa63d, 0.9); g.fillEllipse(4, 18, 4, 8);
      g.fillStyle(0x8c99a8, 1); g.fillTriangle(0, 14, 4, 9, 4, 15); g.fillTriangle(8, 14, 4, 9, 4, 15);
      g.fillStyle(0xe8eef4, 1); g.fillRoundedRect(2, 0, 4, 15, 2);
      g.fillStyle(0xe63946, 1); g.fillRect(2, 1, 4, 2);
    });
    tex('shield', 72, 72, (g) => {
      g.fillStyle(0x7fe3ff, 0.12); g.fillCircle(36, 36, 33);
      g.lineStyle(3, 0x7fe3ff, 0.85); g.strokeCircle(36, 36, 32);
    });
    ctex('e_fighter', 44, 44, jetEnemy);
    tex('e_heli', 52, 64, drawHeli);
    tex('rotor', 72, 72, drawRotor);
    tex('e_bomber', 128, 88, drawBomber);
    tex('mb_gunship', 120, 116, drawGunship);
    tex('mb_fortress', 200, 124, drawFortress);
    tex('mb_ace', 76, 76, drawAce);
    tex('tile_desert', 128, 128, drawTileDesert);
    tex('tile_city', 128, 128, drawTileCity);
    tex('tile_sky', 128, 128, drawTileSky);
    tex('tile_final', 128, 128, drawTileFinal);
    tex('dune', 160, 90, drawDune);
    tex('building', 96, 96, drawBuilding);
    tex('debris', 110, 80, drawDebris);
    tex('g_ship', 44, 110, drawShip);
    tex('g_tank', 38, 44, drawTank);
    tex('g_turret', 30, 30, drawTurret);
    tex('b_kraken', 160, 250, drawKraken);
    tex('b_titan', 230, 190, drawTitan);
    tex('b_ironbird', 270, 150, drawIronbird);
    tex('b_airship', 250, 180, drawAirship);
    tex('b_omega', 290, 170, drawOmega);
    tex('pilot_han', 64, 64, drawPilotHan);
    tex('pilot_claire', 64, 64, drawPilotClaire);
    tex('pilot_jack', 64, 64, drawPilotJack);
    tex('pilot_oliver', 64, 64, drawPilotOliver);
    tex('flag_kr', 54, 36, drawFlagKR);
    tex('flag_fr', 54, 36, drawFlagFR);
    tex('flag_us', 54, 36, drawFlagUS);
    tex('flag_uk', 54, 36, drawFlagUK);

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

    // ---------- 글로우 텍스처 (캔버스 그라데이션) ----------
    const radial = (x, cx, cy, r, stops) => {
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      stops.forEach(([o, c]) => g.addColorStop(o, c));
      x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    };
    ctex('eb', 18, 18, (x) => radial(x, 9, 9, 9, [[0, '#ffffff'], [0.32, '#ffe1ec'], [0.5, '#ff4f8b'], [0.78, 'rgba(255,40,110,0.55)'], [1, 'rgba(255,40,110,0)']]));
    ctex('eb2', 26, 26, (x) => radial(x, 13, 13, 13, [[0, '#ffffff'], [0.3, '#fff0c8'], [0.5, '#ffa62e'], [0.78, 'rgba(255,120,0,0.5)'], [1, 'rgba(255,120,0,0)']]));
    ctex('pb', 10, 30, (x) => {
      const g = x.createLinearGradient(0, 0, 10, 0);
      g.addColorStop(0, 'rgba(255,170,30,0)'); g.addColorStop(0.32, 'rgba(255,190,60,0.55)');
      g.addColorStop(0.5, '#ffffff'); g.addColorStop(0.68, 'rgba(255,190,60,0.55)'); g.addColorStop(1, 'rgba(255,170,30,0)');
      x.fillStyle = g; x.beginPath(); x.ellipse(5, 15, 5, 15, 0, 0, Math.PI * 2); x.fill();
      const v = x.createLinearGradient(0, 0, 0, 30);
      v.addColorStop(0, 'rgba(255,255,255,0)'); v.addColorStop(0.25, 'rgba(255,255,255,0.9)'); v.addColorStop(1, 'rgba(255,220,120,0)');
      x.fillStyle = v; x.fillRect(4, 0, 2, 30);
    });
    ctex('laser', 14, 40, (x) => {
      const g = x.createLinearGradient(0, 0, 14, 0);
      g.addColorStop(0, 'rgba(60,190,255,0)'); g.addColorStop(0.25, 'rgba(80,200,255,0.6)');
      g.addColorStop(0.5, '#f2fdff'); g.addColorStop(0.75, 'rgba(80,200,255,0.6)'); g.addColorStop(1, 'rgba(60,190,255,0)');
      x.fillStyle = g; x.beginPath(); x.ellipse(7, 20, 7, 20, 0, 0, Math.PI * 2); x.fill();
    });
    ctex('shell', 18, 18, (x) => radial(x, 9, 9, 9, [[0, '#ffffff'], [0.3, '#ffe2a8'], [0.55, '#ff8a2a'], [1, 'rgba(255,90,20,0)']]));
    ctex('flame', 16, 30, (x) => {
      const g = x.createLinearGradient(0, 0, 0, 30);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(160,230,255,0.95)');
      g.addColorStop(0.6, 'rgba(80,140,255,0.6)'); g.addColorStop(1, 'rgba(60,80,255,0)');
      x.fillStyle = g; x.beginPath(); x.ellipse(8, 15, 6, 15, 0, 0, Math.PI * 2); x.fill();
      radial(x, 8, 6, 6, [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
    });
    ctex('flash', 64, 64, (x) => radial(x, 32, 32, 32, [[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,246,200,0.95)'], [0.45, 'rgba(255,170,60,0.6)'], [0.75, 'rgba(255,80,20,0.2)'], [1, 'rgba(255,60,0,0)']]));
    ctex('ring', 128, 128, (x) => radial(x, 64, 64, 64, [[0, 'rgba(255,220,150,0)'], [0.62, 'rgba(255,220,150,0)'], [0.8, 'rgba(255,240,200,0.85)'], [0.9, 'rgba(255,160,80,0.4)'], [1, 'rgba(255,120,40,0)']]));
    ctex('spark', 12, 12, (x) => radial(x, 6, 6, 6, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]), false);
    ctex('smoke', 32, 32, (x) => radial(x, 16, 16, 16, [[0, 'rgba(90,90,95,0.55)'], [0.6, 'rgba(70,70,75,0.3)'], [1, 'rgba(60,60,65,0)']]), false);
    ctex('cloud', 240, 140, (x) => {     // 부드러운 뭉게구름 (아래쪽은 살짝 그늘)
      [[70, 80, 46], [118, 60, 56], [170, 74, 48], [200, 92, 34], [42, 96, 32], [120, 96, 50]].forEach(([cx, cy, r]) =>
        radial(x, cx, cy, r, [[0, 'rgba(255,255,255,0.95)'], [0.65, 'rgba(240,245,250,0.75)'], [1, 'rgba(230,236,245,0)']]));
      x.globalCompositeOperation = 'source-atop';
      const g = x.createLinearGradient(0, 40, 0, 140);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(120,135,160,0.45)');
      x.fillStyle = g; x.fillRect(0, 0, 240, 140);
      x.globalCompositeOperation = 'source-over';
    }, false);
    ctex('vignette', 200, 400, (x) => {
      const g = x.createRadialGradient(100, 200, 60, 100, 200, 230);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.7, 'rgba(0,5,15,0.25)'); g.addColorStop(1, 'rgba(0,5,15,0.75)');
      x.fillStyle = g; x.fillRect(0, 0, 200, 400);
    }, false);

    // 아이템 배지 (P: 파워업, B: 폭탄)
    const mkItem = (key, letter, c1, c2) => ctex(key, 34, 34, (x) => {
      radial(x, 17, 17, 17, [[0, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
      const rg = x.createRadialGradient(13, 11, 3, 17, 17, 15);
      rg.addColorStop(0, c1); rg.addColorStop(1, c2);
      x.fillStyle = rg; x.beginPath(); x.arc(17, 17, 13.5, 0, Math.PI * 2); x.fill();
      x.lineWidth = 2.2; x.strokeStyle = '#ffffff'; x.stroke();
      x.fillStyle = '#ffffff'; x.font = 'bold 18px Arial, sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(letter, 17, 18);
    });
    mkItem('item_p', 'P', '#ffb0a8', '#c81d25');
    mkItem('item_b', 'B', '#b4dcff', '#1d5fc8');

    const ct = this.textures.createCanvas('vgrad', 4, 256);
    const ctx = ct.getContext();
    const gr = ctx.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, 'rgba(0,8,20,0.85)');
    gr.addColorStop(1, 'rgba(0,8,20,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 4, 256);
    ct.refresh();

    // ---------- 명암·광택 패스: 기체·적·보스에 입체감 ----------
    const SHADE = ['e_heli', 'e_bomber',
      'mb_gunship', 'mb_fortress', 'mb_ace', 'b_kraken', 'b_titan', 'b_ironbird', 'b_airship', 'b_omega',
      'g_ship', 'g_tank', 'g_turret', 'missile', 'island', 'building', 'dune', 'debris'];
    SHADE.forEach((key) => {
      if (!this.textures.exists(key)) return;
      const src = this.textures.get(key).getSourceImage();
      const Wd = src.width, Hd = src.height;
      const c = document.createElement('canvas');
      c.width = Wd; c.height = Hd;
      const x = c.getContext('2d');
      x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = Math.max(2, Wd * 0.025);
      x.drawImage(src, 0, 0);
      x.shadowBlur = 0; x.shadowColor = 'rgba(0,0,0,0)';
      x.globalCompositeOperation = 'source-atop';
      const lg = x.createLinearGradient(0, 0, Wd, Hd);                 // 왼쪽 위에서 비추는 빛
      lg.addColorStop(0, 'rgba(255,255,255,0.32)'); lg.addColorStop(0.45, 'rgba(255,255,255,0)');
      lg.addColorStop(1, 'rgba(0,0,0,0.42)');
      x.fillStyle = lg; x.fillRect(0, 0, Wd, Hd);
      const sg = x.createRadialGradient(Wd * 0.38, Hd * 0.3, 0, Wd * 0.38, Hd * 0.3, Math.max(Wd, Hd) * 0.45);
      sg.addColorStop(0, 'rgba(255,255,255,0.22)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = sg; x.fillRect(0, 0, Wd, Hd);
      x.globalCompositeOperation = 'source-over';
      this.textures.remove(key);
      this.textures.addCanvas(key, c);
    });

    // 2배로 그린 텍스처는 표시 크기만 원래대로 (UV는 전체 그대로 → 선명)
    hdKeys.forEach(([key, sc]) => {
      const f = this.textures.get(key).get();
      const w = f.width / sc, h = f.height / sc;
      f.cutWidth = w; f.cutHeight = h; f.width = w; f.height = h;
      f.halfWidth = w / 2; f.halfHeight = h / 2; f.centerX = Math.floor(w / 2); f.centerY = Math.floor(h / 2);
      f.data.cut.w = w; f.data.cut.h = h;
      f.data.sourceSize.w = w; f.data.sourceSize.h = h;
      f.data.spriteSourceSize.w = w; f.data.spriteSourceSize.h = h;
      f.data.radius = 0.5 * Math.sqrt(w * w + h * h);
    });

    if (HD > 1) {
      try {
        this.cache.shader.add('bg', new Phaser.Display.BaseShader('bg', BG_FRAG, undefined, {
          uT: { type: '1f', value: 0 }, uMode: { type: '1f', value: 0 }, uAspect: { type: '1f', value: GAME_W / GAME_H }
        }));
      } catch (e) { /* 셰이더를 못 쓰면 타일 배경 */ }
    }

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
    this.cameras.main.setOrigin(0, 0).setZoom(ZOOM);

    // 배경 (WebGL이면 움직이는 셰이더 바다, 아니면 타일)
    this.sea = this.add.tileSprite(0, 0, W, H, 'sea').setOrigin(0);
    this.glint = this.add.tileSprite(0, 0, W, H, 'glint').setOrigin(0);
    this.bg = makeBgShader(this, 0);
    if (this.bg) { this.sea.setVisible(false); this.glint.setVisible(false); }
    this.bgT = 0;
    this.island = this.add.image(randInt(60, W - 60), randInt(100, H - 200), 'island').setScale(1.2);
    this.clouds = [];
    for (let i = 0; i < 5; i++) {
      const c = this.add.image(randInt(0, W), randInt(0, H), 'cloud').setAlpha(0.32).setScale(rand(0.8, 1.6)).setDepth(3);
      c.speed = randInt(50, 90);
      this.clouds.push(c);
    }
    this.fly = this.add.image(W * 0.3, H + 80, getPlane().key).setDepth(5).setScale(1.15);
    this.flyFlame = this.add.image(0, 0, 'flame').setOrigin(0.5, 0.1).setDepth(4).setScale(1.15).setBlendMode(Phaser.BlendModes.ADD);
    this.flyShadow = this.add.image(0, 0, getPlane().key).setTintFill(0x000000).setAlpha(0.28).setScale(1.0).setDepth(2);
    this.flyEnemies = [];
    for (let i = 0; i < 3; i++) this.flyEnemies.push(this.add.image(70 + i * 125, -80 - i * 170, 'e_fighter').setDepth(5));
    this.add.image(0, 0, 'vgrad').setOrigin(0).setDisplaySize(W, 430).setDepth(8);
    this.add.image(0, H - 470, 'vgrad').setOrigin(0).setFlipY(true).setDisplaySize(W, 470).setDepth(8);

    // 로고
    const logo = this.add.container(W / 2, 180).setDepth(10);
    const sky = txt(this, 0, -52, 'SKY STRIKERS', 40, '#ffffff', { stroke: '#0b2545', strokeThickness: 8 });
    sky.setShadow(0, 4, '#000000', 6, true, true);
    const year = txt(this, 0, 28, '1945', 96, '#ffc93c', { stroke: '#3a1d00', strokeThickness: 10 });
    const grd = year.context.createLinearGradient(0, 0, 0, year.height);
    grd.addColorStop(0, '#fff4c2'); grd.addColorStop(0.5, '#ffc93c'); grd.addColorStop(1, '#ff7b1c');
    year.setFill(grd);
    year.setShadow(0, 6, '#000000', 8, true, true);
    const sub = txt(this, 0, 100, '— ARCADE SHOOTER —', 15, '#9ec9ff');
    logo.add([sky, year, sub]);
    this.tweens.add({ targets: logo, y: 186, duration: 1800, yoyo: true, repeat: -1, ease: 'Sine.inOut' });

    // 최고 점수 · 선택 기체
    this.mode = getMode();
    const pill = this.add.graphics().setDepth(10);
    pill.fillStyle(0x000814, 0.55); pill.fillRoundedRect(W / 2 - 130, 308, 260, 66, 18);
    pill.lineStyle(1.5, 0xffd166, 0.5); pill.strokeRoundedRect(W / 2 - 130, 308, 260, 66, 18);
    this.bestLabel = txt(this, W / 2, 329, '', 21, '#ffd166').setDepth(11);
    this.planeLabel = txt(this, W / 2, 356, '', 14, '#cfe3ff').setDepth(11);
    this.planeLabel.setText(getPlane().id + '  ·  ' + getPlane().pilot.name + ' (' + getPlane().pilot.nation + ')');

    // 모드 선택
    this.diff = getDiff();
    makeToggle(this, W / 2, 404, 300, 42, [MODES.normal.label, MODES.arcade.label], this.mode === 'arcade' ? 1 : 0, (i) => {
      this.mode = i === 1 ? 'arcade' : 'normal';
      Store.set('mode', this.mode);
      this.refreshModeInfo();
    }).setDepth(20);
    // 난이도 선택
    makeToggle(this, W / 2, 454, 300, 40, DIFF_ORDER.map((k) => DIFFS[k].label), DIFF_ORDER.indexOf(this.diff), (i) => {
      this.diff = DIFF_ORDER[i];
      Store.set('diff', this.diff);
      this.refreshModeInfo();
    }).setDepth(20);
    this.modeDesc = txt(this, W / 2, 490, '', 13, '#9ec9ff').setDepth(20);
    this.diffDesc = txt(this, W / 2, 509, '', 12, '#ffd166').setDepth(20);
    this.refreshModeInfo();

    // 버튼
    // GAME START → 조종사 선택 화면 → 출격하면 게임 시작
    const start = makeButton(this, W / 2, 568, 260, 66, 'GAME START', () => this.openOverlay(this.hangar), 'primary', 28).setDepth(20);
    this.tweens.add({ targets: start, scale: 1.04, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
    makeButton(this, W / 2, 642, 256, 48, '랭킹', () => this.openRanking(), 'accent', 20).setDepth(20);
    const sBtn = makeButton(this, W / 2 - 66, 700, 124, 42, Sound.label(), () => sBtn.label.setText((Sound.toggle(), Sound.label())), 'secondary', 15).setDepth(20);
    const vBtn = makeButton(this, W / 2 + 66, 700, 124, 42, Haptics.label(), () => vBtn.label.setText((Haptics.toggle(), Haptics.label())), 'secondary', 15).setDepth(20);

    makeSensControl(this, W / 2, 754).setDepth(20);

    txt(this, W / 2, 798, '드래그 이동 · 자동 발사 · CHARGE · BOMB', 13, '#9ec9ff').setDepth(20);
    txt(this, W / 2, 817, 'PC: 방향키·WASD · C 차지 · SPACE 폭탄 · P 정지', 11.5, '#6f8fb5').setDepth(20);

    this.hangar = this.buildHangar();
    this.ranking = this.buildRanking();
  }

  refreshModeInfo() {
    this.bestLabel.setText('BEST  ' + fmt(getBest(this.mode, this.diff)));
    this.modeDesc.setText(MODES[this.mode].desc);
    this.diffDesc.setText(DIFFS[this.diff].label + ' · ' + DIFFS[this.diff].desc);
  }

  openOverlay(c) { c.setVisible(true); setInputEnabled(c, true); }
  closeOverlay(c) { c.setVisible(false); setInputEnabled(c, false); }

  // 기체 선택 창: 4종 카드(기체 + 조종사) 중 하나를 눌러 고르고 '확인'
  buildHangar() {
    const W = GAME_W, H = GAME_H;
    const c = this.add.container(0, 0).setDepth(100);
    const dim = this.add.rectangle(0, 0, W, H, 0x000814, 0.88).setOrigin(0).setInteractive();
    c.add([dim, drawPanel(this, 16, 40, W - 32, 790),
      txt(this, W / 2, 74, 'HANGAR', 28, '#ffffff'),
      txt(this, W / 2, 104, '조종사를 고르고 출격하세요', 13, '#9ec9ff')]);

    let sel = PLANES.indexOf(getPlane());
    const cw = Math.min(176, (W - 76) / 2), ch = 150;
    const cards = [];
    PLANES.forEach((pl, i) => {
      const cx = W / 2 + (i % 2 === 0 ? -1 : 1) * (cw / 2 + 5);
      const cy = 200 + Math.floor(i / 2) * (ch + 10);
      const g = this.add.graphics();
      const img = this.add.image(cx + 14, cy - 14, pl.key);
      const face = this.add.image(cx - cw / 2 + 26, cy - ch / 2 + 26, pl.pilot.face).setScale(0.62);
      const flag = this.add.image(cx + cw / 2 - 22, cy - ch / 2 + 16, pl.pilot.flag).setScale(0.5);
      const z = this.add.zone(cx, cy, cw, ch).setInteractive({ useHandCursor: true });
      z.on('pointerup', () => { sel = i; Sound.unlock(); Sound.click(); refresh(); });
      cards.push({ g, img, cx, cy });
      c.add([g, img, face, flag,
        txt(this, cx, cy + 40, pl.id, 15, '#ffffff'),
        txt(this, cx, cy + 60, pl.pilot.name, 13, '#ffd166'), z]);
    });

    // 상세: 조종사 프로필 + 기체 성능
    const top = 446;
    const box = this.add.graphics();
    box.fillStyle(0x0b1a2e, 0.75); box.fillRoundedRect(30, top, W - 60, 304, 14);
    const face = this.add.image(78, top + 52, PLANES[sel].pilot.face).setScale(1.1);
    const ring = this.add.graphics();
    ring.lineStyle(3, 0xffc93c, 1); ring.strokeCircle(78, top + 52, 36);
    const pName = this.add.text(126, top + 20, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '19px', color: '#ffffff' });
    const pEn = this.add.text(126, top + 44, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '11px', color: '#6f8fb5' });
    const pFlag = this.add.image(140, top + 72, 'flag_kr').setScale(0.5);
    const pNation = this.add.text(158, top + 72, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '13px', color: '#cfe3ff' }).setOrigin(0, 0.5);
    const pRole = txt(this, W / 2, top + 106, '', 13, '#ffd166');
    const pQuote = txt(this, W / 2, top + 126, '', 13, '#e8f1ff', { fontStyle: 'italic' });

    const line = this.add.graphics();
    line.lineStyle(1, 0x35567e, 1); line.lineBetween(46, top + 145, W - 46, top + 145);
    const dTitle = txt(this, W / 2, top + 164, '', 16, '#ffffff');
    const bars = this.add.graphics();
    const statLabels = ['공격력', '속도', '방어력'].map((l, k) =>
      this.add.text(W / 2 - 105, top + 190 + k * 22, l, { fontFamily: FONT, resolution: ZOOM, fontSize: '13px', color: '#cfe3ff' }).setOrigin(0, 0.5));
    const dDesc = txt(this, W / 2, top + 254, '', 13, '#e8f1ff');
    const dNote = txt(this, W / 2, top + 272, '', 12, '#9ec9ff');
    const dBomb = txt(this, W / 2, top + 290, '', 12, '#ffb3b8');
    c.add([box, face, ring, pName, pEn, pFlag, pNation, pRole, pQuote, line, dTitle, bars, dDesc, dNote, dBomb].concat(statLabels));

    const refresh = () => {
      cards.forEach((cd, i) => {
        const on = i === sel;
        cd.g.clear();
        cd.g.fillStyle(on ? 0x1d3d66 : 0x112238, 1);
        cd.g.fillRoundedRect(cd.cx - cw / 2, cd.cy - ch / 2, cw, ch, 14);
        cd.g.lineStyle(on ? 3 : 1.5, on ? 0xffc93c : 0x35567e, 1);
        cd.g.strokeRoundedRect(cd.cx - cw / 2, cd.cy - ch / 2, cw, ch, 14);
        cd.img.setScale(on ? 1.3 : 1.05).setAlpha(on ? 1 : 0.75);
      });
      const p = PLANES[sel], pi = p.pilot;
      face.setTexture(pi.face);
      pName.setText(pi.name + '  ' + pi.age + '세');
      pEn.setText(pi.en);
      pFlag.setTexture(pi.flag);
      pNation.setText(pi.nation);
      pRole.setText(pi.role);
      pQuote.setText(pi.quote);
      dTitle.setText(p.id + '  ·  ' + p.type);
      bars.clear();
      [p.atk, p.spd, p.def].forEach((v, k) => {
        for (let n = 0; n < 5; n++) {
          bars.fillStyle(n < v ? 0x5fd3ff : 0x23405f, 1);
          bars.fillRoundedRect(W / 2 - 35 + n * 24, top + 184 + k * 22, 20, 11, 3);
        }
      });
      dDesc.setText(p.desc);
      dNote.setText(p.note);
      dBomb.setText(p.bomb);
    };
    refresh();

    c.add(makeButton(this, W / 2 - 98, 780, 96, 52, '뒤로', () => this.closeOverlay(c), 'secondary', 18));
    c.add(makeButton(this, W / 2 + 52, 780, 184, 52, '출격!', () => {
      Store.set('plane', PLANES[sel].id);
      this.scene.start('Game');
    }, 'primary', 24));
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
      const nick = this.add.text(84, y, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '15px', color: '#ffffff' }).setOrigin(0, 0.5);
      const sc = this.add.text(W - 52, y, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '17px', color: '#ffffff' }).setOrigin(1, 0.5);
      const tag = this.add.text(0, y, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '11px', color: '#9ec9ff' }).setOrigin(1, 0.5);
      c.add([rk, nick, sc, tag]);
      this.rankRows.push({ rk, nick, sc, tag });
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
    this.rankRows.forEach((r) => { r.rk.setText(''); r.nick.setText(''); r.sc.setText(''); r.tag.setText(''); });
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
      if (name.length > 7) name = name.slice(0, 7) + '…';
      row.rk.setText(String(i + 1)).setColor(medal[i] || '#cfe3ff');
      row.nick.setText(name).setColor(i < 3 ? medal[i] : '#ffffff');
      row.sc.setText(fmt(r.score));
      // 도달 스테이지(ALL = 전부 클리어) · 오락실 이어하기 횟수
      let tag = (r.stage || 1) >= 6 ? 'ALL' : 'ST' + (r.stage || 1);
      const dtag = (DIFFS[r.diff] || DIFFS.normal).tag;      // 난이도 표시 (EZ 쉬움 · HD 어려움)
      if (dtag) tag = dtag + ' ' + tag;
      if (mode === 'arcade' && r.continues > 0) tag += ' C' + r.continues;
      row.tag.setText(tag).setColor((r.stage || 1) >= 6 ? '#ffd166' : '#9ec9ff').setX(row.sc.x - row.sc.width - 8);
    });
  }

  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;
    const W = GAME_W, H = GAME_H;
    this.sea.tilePositionY -= 40 * dt;
    this.glint.tilePositionY -= 60 * dt;
    this.bgT += dt;
    if (this.bg) this.bg.setUniform('uT.value', this.bgT * 0.7);
    if (this.flyShadow) this.flyShadow.setPosition(this.fly.x + 20, this.fly.y + 30).setTexture(this.fly.texture.key);
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
    this.cameras.main.setOrigin(0, 0).setZoom(ZOOM);
    const mode = getMode();
    const plane = (this.plane = getPlane());
    const D = (this.diff = DIFFS[getDiff()]);

    // ---- 상태 초기화 (재시작 때마다 새로 만든다) ----
    this.state = {
      mode,
      score: 0, combo: 0, comboTimer: 0, elapsed: 0, kills: 0,
      hp: plane.hp + D.hearts, maxHp: plane.hp + D.hearts,     // 일반 모드 (기체·난이도마다 하트 수 다름)
      armor: mode === 'arcade' ? plane.armor : 0,              // 오락실 모드 방어막 (THUNDER-A)
      lives: ARCADE.lives, credits: ARCADE.credits + D.credits, continues: 0, // 오락실 모드
      bombs: mode === 'arcade' ? ARCADE.bombsPerLife : NORMAL.bombs,
      dead: false,     // 오락실 모드에서 격추되어 다시 나오기 전
      frozen: false,   // 이어하기 카운트다운 중
      over: false,
      best: getBest(mode, D.key),
      charge: 0,       // 차지 게이지 0~100
      power: 1         // 파워 단계 1~7 (1단계로 시작)
    };
    this.fireTimer = 0;
    this.muzzleT = 0;
    this.missileT = 0.5;
    this.bombT = 0;
    this.specialActive = false;
    this.carpet = null;      // RAPTOR-X 융단 폭격
    this.wall = null;        // PHANTOM-Z 플라즈마 벽
    this.barrier = null;     // THUNDER-A 방어막
    this.beamT = 0;
    this.beamGfx = null;     // 재시작 시 예전 그래픽 참조가 남지 않게
    this.wingT = 0;
    this.wingmen = [];
    this.fireball = null;
    this.stageIdx = 0;       // 0~4 (스테이지 1~5)
    this.stage = { t: 0, phase: 'intro', midDone: false, wait: 0 };
    this.stageBoss = null;
    this.safe = false;       // 스테이지 클리어 연출 중엔 피격 무시
    this.items = [];         // 떠다니는 P/B 아이템
    this.pityKills = 0;      // 한동안 P가 안 나오면 보장
    this.midBoss = null;
    this.warningOn = false;
    this.spawnT = 1.6;
    this.islandT = 3;
    this.cloudT = 1;
    this.invuln = 1.5;
    this.drag = null;
    this.trash = [];
    this.floatCount = 0;

    // ---- 배경 ----
    this.sea = this.add.tileSprite(0, 0, W, H, STAGES[0].tile).setOrigin(0).setDepth(0);
    this.glint = this.add.tileSprite(0, 0, W, H, 'glint').setOrigin(0).setDepth(0.5);
    this.bg = makeBgShader(this, 0);
    this.bgT = 0;
    this.hiCloudT = 4;
    if (this.bg) {
      this.time.delayedCall(4000, () => {
        if (this.bg && this.game.loop.actualFps < 40) {
          this.bg.destroy(); this.bg = null;
          const st = STAGES[this.stageIdx];
          this.sea.setTexture(st.tile).setVisible(true);
          this.glint.setVisible(!!st.glint);
        }
      });
    }
    this.add.image(0, 0, 'vignette').setOrigin(0).setDisplaySize(W, H).setDepth(44).setAlpha(0.7);
    this.scenery = this.add.group();
    this.spawnScenery(randInt(80, H - 300));
    if (this.bg) { this.sea.setVisible(false); this.glint.setVisible(false); }
    for (let i = 0; i < 3; i++) this.spawnCloud(randInt(0, H));

    // ---- 플레이어 ----
    this.player = this.physics.add.sprite(W / 2, H - 170, plane.key).setDepth(10).setScale(1.15);
    this.player.body.moves = false;
    this.player.body.setCircle(7, 21, 15);   // 판정은 조종석 주변의 작은 원
    this.flame = this.add.image(0, 0, 'flame').setOrigin(0.5, 0.1).setDepth(9).setBlendMode(Phaser.BlendModes.ADD);
    this.playerShadow = this.add.image(0, 0, plane.key).setTintFill(0x000000).setAlpha(0.3).setScale(0.95).setDepth(1.6);
    // 엔진 불꽃 꼬리
    this.trail = this.add.particles(0, 0, 'spark', {
      follow: this.player, followOffset: { x: 0, y: 32 },
      speedY: { min: 160, max: 260 }, speedX: { min: -18, max: 18 }, lifespan: 230,
      scale: { start: 0.9, end: 0 }, alpha: { start: 0.85, end: 0 },
      tint: [0x9fdcff, 0xffffff, 0x6fb8ff], blendMode: 'ADD', frequency: 18
    }).setDepth(8.5);
    this.muzzle = this.add.image(0, 0, 'flash').setDepth(11).setScale(0.3)
      .setTint(0xffe27a).setBlendMode(Phaser.BlendModes.ADD).setVisible(false);
    this.shield = this.add.image(0, 0, 'shield').setDepth(11).setVisible(false);
    this.shieldBreaking = false;
    this.target = { x: this.player.x, y: this.player.y };

    // ---- 오브젝트 그룹 (탄은 재사용 풀) ----
    this.pBullets = this.physics.add.group({ maxSize: 140 });
    this.eBullets = this.physics.add.group({ maxSize: 340 });
    this.enemies = this.physics.add.group();

    // ---- 파티클 ----
    this.fxDebris = this.add.particles(0, 0, 'spark', {
      speed: { min: 120, max: 420 }, lifespan: { min: 300, max: 750 }, gravityY: 260,
      scale: { start: 0.65, end: 0 }, tint: [0xffd27a, 0xff8a3d, 0xffffff], blendMode: 'ADD', emitting: false
    }).setDepth(14);
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
    this.physics.add.overlap(this.player, this.enemies, this.onPlayerHitEnemy, (pl, e) => !e.ground, this);

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
      this.input.keyboard.on('keydown-C', () => this.useSpecial());
      this.input.keyboard.on('keydown-X', () => this.useSpecial());
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

    this.showStageTitle();
    const banner = txt(this, W / 2, H / 2 - 160, mode === 'arcade' ? 'ARCADE MODE' : 'NORMAL MODE', 16, '#9ec9ff', { stroke: '#000000', strokeThickness: 4 }).setDepth(40);
    const pilotFace = this.add.image(W / 2 - 70, H / 2 + 10, plane.pilot.face).setScale(0.8).setDepth(40);
    const pilotLine = this.add.text(W / 2 - 38, H / 2 + 10, plane.pilot.name + '\n' + plane.pilot.quote, {
      fontFamily: FONT, resolution: ZOOM, fontSize: '14px', color: '#ffffff', stroke: '#000000', strokeThickness: 4, lineSpacing: 4
    }).setOrigin(0, 0.5).setDepth(40);
    this.tweens.add({ targets: [pilotFace, pilotLine], alpha: 0, delay: 2200, duration: 600, onComplete: () => { pilotFace.destroy(); pilotLine.destroy(); } });
    const hint = txt(this, W / 2, H - 150, 'P를 모으면 파워업 (최대 7단계)', 16, '#ffffff', { stroke: '#000000', strokeThickness: 4 }).setDepth(40);
    this.tweens.add({ targets: [banner, hint], alpha: 0, delay: 2200, duration: 600, onComplete: () => { banner.destroy(); hint.destroy(); } });
  }

  /* ------------------------- HUD ------------------------- */
  buildHud() {
    const W = GAME_W, H = GAME_H, s = this.state;
    this.add.image(0, 0, 'vgrad').setOrigin(0).setDisplaySize(W, 110).setDepth(49);
    this.add.text(16, 12, 'SCORE', { fontFamily: FONT, resolution: ZOOM, fontSize: '13px', color: '#9ec9ff' }).setDepth(50);
    this.scoreText = this.add.text(16, 28, '0', {
      fontFamily: FONT, resolution: ZOOM, fontSize: '26px', color: '#ffffff', stroke: '#000000', strokeThickness: 3
    }).setDepth(50);
    this.add.text(16, 62, 'BEST ' + fmt(s.best), { fontFamily: FONT, resolution: ZOOM, fontSize: '13px', color: '#ffd166' }).setDepth(50);
    this.stageLabel = txt(this, W / 2, 22, 'STAGE 1' + (this.diff.tag ? ' · ' + this.diff.label : ''), 14, '#cfe3ff', { stroke: '#000000', strokeThickness: 3 }).setDepth(50);
    this.add.text(16, 80, 'POWER', { fontFamily: FONT, resolution: ZOOM, fontSize: '11px', color: '#ff9a9a' }).setDepth(50);
    this.powerGfx = this.add.graphics().setDepth(50);
    this.updatePowerUi();

    // 일반: 하트 / 오락실: 남은 기체 아이콘 + 크레딧
    this.lifeIcons = [];
    const count = s.mode === 'arcade' ? ARCADE.lives : s.maxHp;
    for (let i = 0; i < count; i++) {
      const icon = s.mode === 'arcade'
        ? this.add.image(W - 76 - i * 27, 35, this.plane.key).setScale(0.4)
        : this.add.image(W - 76 - i * 27, 35, 'heart');
      this.lifeIcons.push(icon.setDepth(50));
    }
    if (s.mode === 'arcade') {
      this.creditText = this.add.text(W - 16, 64, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '12px', color: '#9ec9ff' }).setOrigin(1, 0).setDepth(50);
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

    // 차지 버튼 (왼쪽 아래): 게이지가 다 차면 빛나고, 누르면 기체별 특수 공격
    const cb = this.add.container(60, H - 78).setDepth(60);
    this.chargeGfx = this.add.graphics();
    this.chargeLabel = txt(this, 0, -12, 'CHARGE', 11, '#cfe3ff');
    this.chargeValue = txt(this, 0, 9, '0%', 18, '#ffffff');
    cb.add([this.chargeGfx, this.chargeLabel, this.chargeValue]);
    cb.setSize(84, 84).setInteractive({ useHandCursor: true });
    cb.on('pointerdown', () => this.useSpecial());
    this.chargeBtn = cb;
    this.updateChargeUi();

    // 중간보스 체력바 (화면 위쪽)
    this.bossBar = this.add.container(0, 0).setDepth(55).setVisible(false);
    this.bossBarGfx = this.add.graphics();
    this.bossBarName = this.add.text(20, 102, '', { fontFamily: FONT, resolution: ZOOM, fontSize: '13px', color: '#ffb3b8', stroke: '#000000', strokeThickness: 3 });
    this.bossBar.add([this.bossBarGfx, this.bossBarName]);

    this.comboText = txt(this, W / 2, 168, '', 30, '#ffe066', { stroke: '#3a1d00', strokeThickness: 6 }).setDepth(45).setAlpha(0);
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
    this.state.score += Math.round(n * this.diff.score);
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
    this.drag = { id: p.id, px: p.x / ZOOM, py: p.y / ZOOM, sx: this.target.x, sy: this.target.y };
  }

  onPointerMove(p) {
    const s = this.state;
    // 재출격 후에도 손가락을 떼지 않고 계속 움직이면 바로 이어서 조작
    if (!this.drag && p.isDown && !s.dead && !s.over && !s.frozen) {
      this.drag = { id: p.id, px: p.x / ZOOM, py: p.y / ZOOM, sx: this.target.x, sy: this.target.y };
      return;
    }
    const d = this.drag;
    if (!d || p.id !== d.id || s.over || s.dead) return;
    const SENS = Sens.value();
    const px = p.x / ZOOM, py = p.y / ZOOM;
    const rawX = d.sx + (px - d.px) * SENS;
    const rawY = d.sy + (py - d.py) * SENS;
    this.target.x = rawX; this.target.y = rawY;
    this.clampTarget();
    if (this.target.x !== rawX) { d.sx = this.target.x; d.px = px; }
    if (this.target.y !== rawY) { d.sy = this.target.y; d.py = py; }
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
        this.updateStage(dt);                 // 격추된 동안엔 스테이지 진행 멈춤
        this.addCharge(CHARGE.passive * dt);
      }
      this.updateCombo(dt);
    }
    this.updateSpecial(dt);
    this.updateBossBar();
    if (this.bombT > 0) this.bombT -= dt;
    this.updateBomb(dt);
    this.updateItems(dt);
    this.updateEnemies(dt);
    this.updateBullets(dt);
  }

  scrollBackground(dt) {
    const H = GAME_H;
    this.sea.tilePositionY -= 60 * dt;
    this.glint.tilePositionY -= 85 * dt;
    this.bgT += dt;
    if (this.bg) this.bg.setUniform('uT.value', this.bgT);
    this.hiCloudT -= dt;
    if (this.hiCloudT <= 0) { this.hiCloudT = rand(5, 9); this.spawnCloud(-90, true); }
    this.scenery.getChildren().slice().forEach((o) => {
      o.y += o.speed * dt;
      if (o.y > H + 160) o.destroy();
    });
    this.islandT -= dt;
    if (this.islandT <= 0) {
      const st = STAGES[this.stageIdx];
      this.islandT = st.scenery === 'building' ? rand(3, 6) : st.scenery === 'cloud' ? rand(2, 4) : rand(6, 11);
      this.spawnScenery(-100);
    }
    this.cloudT -= dt;
    if (this.cloudT <= 0) { this.cloudT = rand(2.5, 5); this.spawnCloud(-70); }
  }

  // 스테이지별 지형 (섬·모래언덕·빌딩·뭉게구름·잔해)
  spawnScenery(y) {
    const key = STAGES[this.stageIdx].scenery;
    if (!key) return;
    const img = this.add.image(randInt(30, GAME_W - 30), y, key).setDepth(1);
    img.speed = 60;
    if (key === 'cloud') { img.setAlpha(0.6).setScale(rand(1.6, 2.6)); img.speed = rand(90, 120); }
    else if (key === 'building') img.setScale(rand(0.8, 1.2));
    else img.setScale(rand(0.6, 1.3)).setRotation(rand(0, Math.PI * 2));
    this.scenery.add(img);
  }

  // high = 기체보다 위를 빠르게 지나가는 옅은 구름 (깊이감)
  spawnCloud(y, high) {
    const img = this.add.image(randInt(-40, GAME_W + 40), y, 'cloud')
      .setDepth(high ? 21 : 3).setAlpha(high ? 0.18 : 0.5).setScale(high ? rand(1.6, 2.4) : rand(0.8, 1.5));
    if (this.stageIdx === 4) img.setTint(0x664466);
    else img.setBlendMode(Phaser.BlendModes.SCREEN);
    img.speed = high ? randInt(230, 290) : randInt(120, 170);
    this.scenery.add(img);
  }

  applyStageVisuals() {
    const st = STAGES[this.stageIdx];
    this.sea.setTexture(st.tile);
    this.glint.setVisible(!!st.glint);
    if (this.bg) {
      const m = { sea: 0, tile_desert: 1, tile_city: 2, tile_sky: 3, tile_final: 4 }[st.tile];
      this.bg.setUniform('uMode.value', m);
      this.bg.setVisible(m !== 2);
      this.sea.setVisible(m === 2);
      this.glint.setVisible(false);
    }
    this.scenery.clear(true, true);
    this.spawnScenery(randInt(120, GAME_H - 300));
    this.spawnScenery(randInt(-60, 100));
    for (let i = 0; i < 2; i++) this.spawnCloud(randInt(0, GAME_H));
    if (this.stageLabel) this.stageLabel.setText('STAGE ' + (this.stageIdx + 1) + (this.diff.tag ? ' · ' + this.diff.label : ''));
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
        const kv = 380 * (this.plane.speed / 950) * Sens.speedMul();
        this.target.x += (vx / len) * kv * dt;
        this.target.y += (vy / len) * kv * dt;
        this.clampTarget();
      }
    }
    const prevX = p.x;
    const f = Math.min(1, dt * 22);
    let mx = (this.target.x - p.x) * f, my = (this.target.y - p.y) * f;
    const maxStep = this.plane.speed * Sens.speedMul() * dt, mlen = Math.hypot(mx, my);   // 기체별 최고 속도 제한
    if (mlen > maxStep) { mx *= maxStep / mlen; my *= maxStep / mlen; }
    p.x += mx; p.y += my;

    const tilt = clamp((p.x - prevX) / Math.max(dt, 0.001) * 0.0006, -0.22, 0.22);
    p.rotation += (tilt - p.rotation) * 0.2;

    this.playerShadow.setPosition(p.x + 18, p.y + 28).setRotation(p.rotation);
    this.flame.setPosition(p.x - Math.sin(p.rotation) * 30, p.y + Math.cos(p.rotation) * 30)
      .setRotation(p.rotation).setScale(0.9 + Math.random() * 0.2, 0.8 + Math.random() * 0.55);

    if (!this.shieldBreaking) {
      const on = this.state.armor > 0;
      this.shield.setVisible(on);
      if (on) this.shield.setPosition(p.x, p.y).setAlpha(0.65 + Math.sin(this.state.elapsed * 6) * 0.25);
    }

    if (this.invuln > 0) {
      this.invuln -= dt;
      p.alpha = Math.floor(this.invuln * 14) % 2 ? 0.3 : 1;
      if (this.invuln <= 0) p.alpha = 1;
    }
  }

  /* ------------------------- 발사 ------------------------- */
  // 기체별 무기 (파워 1~7단계에 따라 탄 수·연사·피해가 늘어남)
  updateFiring(dt) {
    const p = this.player, id = this.plane.id, L = this.state.power, i = L - 1;
    const rm = POWER.rateMul[i], dps = POWER.dps[i];
    const base = { 'RAPTOR-X': 0.1, 'PHANTOM-Z': 0.065, 'THUNDER-A': 0.15, 'BLAZE-F': 0.17 }[id];
    const rate = base * rm;
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = Math.max(0, this.fireTimer + rate);
      if (id === 'PHANTOM-Z') {                       // 레이저: 1줄 → 2줄(3단계) → 3줄(5단계), 7단계 굵게
        const xs = L >= 5 ? [-12, 0, 12] : L >= 3 ? [-7, 7] : [0];
        xs.forEach((ox) => this.firePlayerBullet(p.x + ox, p.y - 32, { kind: 'laser', vy: -1300, dmg: dps * rate / xs.length, pierce: true, scale: L >= 7 ? 1.3 : 1 }));
      } else if (id === 'THUNDER-A') {                // 확산탄: 2발 → 3갈래 → 5갈래 → 7갈래
        const ways = [2, 3, 3, 5, 5, 7, 7][i], step = L >= 6 ? 0.13 : 0.16;
        const dm = dps * rate / Math.max(1.8, ways * 0.55);
        if (ways === 2) [-6, 6].forEach((ox) => this.firePlayerBullet(p.x + ox, p.y - 22, { kind: 'pb', vy: -840, dmg: dm }));
        else for (let k = 0; k < ways; k++) {
          const a = (k - (ways - 1) / 2) * step;
          this.firePlayerBullet(p.x + a * 30, p.y - 22, { kind: 'pb', angle: a, speed: 840, dmg: dm });
        }
      } else if (id === 'BLAZE-F') {                  // 폭발탄: 1발 → 2발 → 3발 → 4발
        const n = [1, 2, 2, 3, 3, 4, 4][i];
        const offs = n === 1 ? [0] : n === 2 ? [-8, 8] : n === 3 ? [-12, 0, 12] : [-18, -6, 6, 18];
        offs.forEach((ox) => this.firePlayerBullet(p.x + ox, p.y - 22, { kind: 'shell', angle: ox * 0.006, speed: 720, dmg: dps * 0.95 * rate / n, splash: true }));
      } else {                                        // 기관포: 2발 → 5발, 5단계부터 양옆 사선탄
        const n = [2, 2, 3, 3, 4, 4, 5][i], dm = dps * 0.85 * rate / n;
        for (let k = 0; k < n; k++) this.firePlayerBullet(p.x + (k - (n - 1) / 2) * 9, p.y - 22, { kind: 'pb', vy: -920, dmg: dm });
        if (L >= 6) [-1, 1].forEach((sd) => this.firePlayerBullet(p.x + sd * 14, p.y - 16, { kind: 'pb', angle: sd * 0.22, speed: 900, dmg: dm }));
      }
      this.muzzle.setVisible(true).setPosition(p.x, p.y - 30).setScale(0.24 + Math.random() * 0.12);
      this.muzzleT = 0.04;
      Sound.shoot();
    }
    // RAPTOR-X 유도미사일: 3단계부터 1발, 5단계 2발, 7단계 4발
    if (id === 'RAPTOR-X') {
      const mc = [0, 0, 1, 1, 2, 2, 4][i];
      this.missileT -= dt;
      if (mc && this.missileT <= 0) {
        this.missileT = 0.75;
        this.missileSide = -(this.missileSide || 1);
        for (let k = 0; k < mc; k++) {
          const sd = (k % 2 === 0 ? 1 : -1) * this.missileSide, wide = 1 + Math.floor(k / 2) * 0.7;
          this.firePlayerBullet(p.x + sd * 18, p.y - 4, { kind: 'missile', vx: sd * 160 * wide, vy: -260, dmg: Math.max(1.2, dps * 0.2 * 0.75 / mc) });
        }
      }
    }
    if (this.muzzleT > 0) {
      this.muzzleT -= dt;
      if (this.muzzleT <= 0) this.muzzle.setVisible(false);
    }
  }

  /* ------------------------- 아이템 (P 파워업 / B 폭탄) ------------------------- */
  updatePowerUi() {
    const g = this.powerGfx, L = this.state.power, max = L >= POWER.max;
    g.clear();
    for (let k = 0; k < POWER.max; k++) {
      g.fillStyle(k < L ? (max ? 0xffd166 : 0xff5d5d) : 0x2b3a4f, 1);
      g.fillRoundedRect(64 + k * 13, 82, 10, 9, 2);
    }
  }

  dropItem(type, x, y) {
    const it = this.add.image(clamp(x, 20, GAME_W - 20), clamp(y, 120, GAME_H - 80), type === 'P' ? 'item_p' : 'item_b').setDepth(9);
    it.itype = type;
    it.vx = (Math.random() < 0.5 ? -1 : 1) * rand(50, 80);
    it.vy = rand(40, 70);
    it.t = 0;
    this.items.push(it);
  }

  // 일반 적 격추 시 확률적으로 P 드롭 (한동안 안 나오면 보장)
  maybeDropPower(e) {
    if (e.etype === 'bomber') { this.dropItem('P', e.x, e.y); return; }
    this.pityKills++;
    let chance = (DROP[e.etype] || 0) * this.diff.drop;
    if (this.items.some((it) => it.itype === 'P')) chance *= 0.3;   // 화면에 이미 있으면 덜 나오게
    if (this.state.power >= POWER.max) chance *= 0.5;
    if (Math.random() < chance || this.pityKills >= DROP.pity / this.diff.drop) {
      this.pityKills = 0;
      this.dropItem('P', e.x, e.y);
    }
  }

  // 아이템은 화면 안을 천천히 튕겨 다니다가 9초 뒤 아래로 사라짐 (끝나기 2초 전 깜빡임)
  updateItems(dt) {
    if (!this.items.length) return;
    const W = GAME_W, H = GAME_H, s = this.state, p = this.player;
    this.items = this.items.filter((it) => {
      it.t += dt;
      it.x += it.vx * dt; it.y += it.vy * dt;
      if (it.x < 16) { it.x = 16; it.vx = Math.abs(it.vx); }
      if (it.x > W - 16) { it.x = W - 16; it.vx = -Math.abs(it.vx); }
      if (it.t < 9) {
        if (it.y < 110) { it.y = 110; it.vy = Math.abs(it.vy); }
        if (it.y > H - 60) { it.y = H - 60; it.vy = -Math.abs(it.vy); }
      }
      it.setAlpha(it.t > 7 ? (Math.floor(it.t * 10) % 2 ? 0.35 : 1) : 1).setScale(1 + Math.sin(it.t * 6) * 0.07);
      if (!s.dead && !s.over && Phaser.Math.Distance.Between(it.x, it.y, p.x, p.y) < 34) {
        this.collectItem(it);
        it.destroy();
        return false;
      }
      if (it.y > H + 30) { it.destroy(); return false; }
      return true;
    });
  }

  collectItem(it) {
    const s = this.state;
    let msg, color;
    if (it.itype === 'P') {
      if (s.power < POWER.max) {
        s.power++;
        msg = s.power >= POWER.max ? 'MAX POWER!' : 'POWER UP!  Lv.' + s.power;
        color = s.power >= POWER.max ? '#ffd166' : '#ff9a9a';
      } else {
        this.addScore(1000);
        msg = 'MAX BONUS +1,000'; color = '#ffd166';
      }
      this.updatePowerUi();
    } else {
      s.bombs = Math.min(s.bombs + 1, 6);
      this.updateBombUi();
      msg = 'BOMB +1'; color = '#9ad0ff';
    }
    [660, 880, 1320].forEach((f, k) => this.time.delayedCall(k * 60, () => Sound.tone(f, 0.09, 'square', 0.04)));
    Haptics.vibrate(25);
    this.fxHit.explode(10, it.x, it.y);
    const t = txt(this, this.player.x, this.player.y - 50, msg, 18, color, { stroke: '#000000', strokeThickness: 4 }).setDepth(30);
    this.tweens.add({ targets: t, y: t.y - 40, alpha: 0, duration: 900, ease: 'Cubic.out', onComplete: () => t.destroy() });
  }

  firePlayerBullet(x, y, o) {
    const b = this.pBullets.get(x, y, o.kind);
    if (!b) return;
    b.setTexture(o.kind === 'pb' ? 'pb' : o.kind);
    b.enableBody(true, x, y, true, true);
    b.setDepth(8).setScale(o.scale || 1).setBlendMode(o.kind === 'missile' ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.ADD);
    b.kind = o.kind;
    b.dmg = o.dmg;
    b.pierce = !!o.pierce;
    b.splash = !!o.splash;
    b.life = 0;
    b.target = null;
    if (b.pierce) { if (b.hits) b.hits.clear(); else b.hits = new Set(); }
    const size = { pb: [4, 18], laser: [6, 32], shell: [10, 10], missile: [6, 14] }[o.kind];
    b.body.setSize(size[0], size[1]);
    if (o.angle !== undefined) {
      b.setRotation(o.angle);
      b.setVelocity(Math.sin(o.angle) * o.speed, -Math.cos(o.angle) * o.speed);
    } else {
      b.setRotation(o.vx ? Math.atan2(o.vx, -o.vy) : 0);
      b.setVelocity(o.vx || 0, o.vy);
    }
  }

  nearestEnemy(x, y) {
    let best = null, bd = Infinity;
    this.enemies.getChildren().forEach((e) => {
      if (!e.active || e.y < 0 || e.y > GAME_H) return;
      const d = Phaser.Math.Distance.Squared(x, y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    });
    return best;
  }

  // 적 탄: 판정 원은 그림보다 작게 잡아 억울한 피격을 줄인다
  fireEnemyBullet(x, y, angle, speed, big) {
    const s = this.state;
    if (s.over || s.dead) return;
    if (this.diff.skip && Math.random() < this.diff.skip) return;
    if (this.eBullets.countActive(true) > 220) return;
    const key = big ? 'eb2' : 'eb';
    const b = this.eBullets.get(x, y, key);
    if (!b) return;
    b.setTexture(key);
    b.enableBody(true, x, y, true, true);
    b.setDepth(12);
    const half = big ? 13 : 9, r = big ? 6 : 4;
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

  updateBullets(dt) {
    const W = GAME_W, H = GAME_H;
    this.pBullets.children.each((b) => {
      if (!b.active) return;
      if (b.kind === 'missile') {
        b.life += dt;
        if (!b.target || !b.target.active) b.target = this.nearestEnemy(b.x, b.y);
        const v = b.body.velocity;
        let ang = Math.atan2(v.y, v.x);
        const spd = Math.min(650, Math.hypot(v.x, v.y) + 900 * dt);
        const want = b.target && b.life > 0.12 ? Phaser.Math.Angle.Between(b.x, b.y, b.target.x, b.target.y) : -Math.PI / 2;
        ang = Phaser.Math.Angle.RotateTo(ang, want, 6 * dt);
        this.physics.velocityFromRotation(ang, spd, v);
        b.setRotation(ang + Math.PI / 2);
        if (b.life > 3) { b.disableBody(true, true); return; }
      }
      if (b.y < -40 || b.y > H + 40 || b.x < -40 || b.x > W + 40) b.disableBody(true, true);
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
   * 기체마다 다른 폭탄. 공통: 쓰는 순간 주변 적 탄을 지우고
   * 폭탄이 끝날 때까지 무적이라 위기 탈출용으로 쓸 수 있다.
   * ------------------------------------------------------- */
  useBomb() {
    const s = this.state;
    if (s.over || s.dead || s.frozen || s.bombs <= 0 || this.bombT > 0) return;
    if (!this.scene.isActive()) return;
    const p = this.player, id = this.plane.id;
    const dur = { 'RAPTOR-X': 1.9, 'PHANTOM-Z': 1.2, 'THUNDER-A': 3.0, 'BLAZE-F': 1.5 }[id];
    s.bombs--;
    this.updateBombUi();
    this.bombT = dur;
    this.invuln = Math.max(this.invuln, dur + 0.3);
    Sound.unlock(); Sound.bomb();
    Haptics.vibrate([0, 220, 60, 120]);
    this.clearBullets(p.x, p.y, 170, true);
    this.cameras.main.shake(300, 0.008);

    const name = { 'RAPTOR-X': 'CARPET BOMBING', 'PHANTOM-Z': 'PLASMA WALL', 'THUNDER-A': 'IRON BARRIER', 'BLAZE-F': 'FIRE STORM' }[id];
    const cut = txt(this, GAME_W / 2, GAME_H / 2 - 160, name, 30, '#ffd0d5', { stroke: '#4a0010', strokeThickness: 6 }).setDepth(46);
    this.tweens.add({ targets: cut, alpha: 0, y: cut.y - 30, delay: 600, duration: 400, onComplete: () => cut.destroy() });

    if (id === 'RAPTOR-X') {
      // 아군 폭격기 3대가 아래에서 위로 지나가며 폭탄을 줄줄이 떨어뜨림
      const xs = [GAME_W * 0.2, GAME_W * 0.5, GAME_W * 0.8];
      const planes = xs.map((x, i) => {
        const b = this.add.image(x, GAME_H + 70 + (i === 1 ? 0 : 50), 'e_bomber')
          .setFlipY(true).setTint(0x9cc4ff).setScale(0.75).setDepth(13);
        this.tweens.add({ targets: b, y: -140, duration: 1800, ease: 'Linear', onComplete: () => b.destroy() });
        return b;
      });
      this.carpet = { planes, dropT: 0, t: 0 };
    } else if (id === 'PHANTOM-Z') {
      // 화면 폭 전체의 에너지 벽이 기체 앞에서 위로 쓸고 올라감
      this.wall = { y: p.y - 30, hit: new Set(), g: this.add.graphics().setDepth(13).setBlendMode(Phaser.BlendModes.ADD) };
      this.cameras.main.flash(160, 160, 230, 255);
    } else if (id === 'THUNDER-A') {
      // 기체 주위 거대 방어막: 닿는 탄은 지워지고, 안쪽 적은 지속 피해
      const img = this.add.image(p.x, p.y, 'shield').setScale(3.6).setDepth(11).setTint(0xb8ffcf);
      this.barrier = { t: dur, img };
    } else {
      // 적 위치를 노려 화염 폭격 9연발
      for (let i = 0; i < 9; i++) {
        this.time.delayedCall(120 + i * 140, () => {
          if (this.state.over) return;
          const alive = this.enemies.getChildren().filter((e) => e.active && e.y > 40 && e.y < GAME_H - 160);
          let x = randInt(50, GAME_W - 50), y = randInt(130, Math.floor(GAME_H * 0.6));
          if (alive.length && Math.random() < 0.65) {
            const e = Phaser.Utils.Array.GetRandom(alive);
            x = e.x + rand(-20, 20); y = e.y + rand(-20, 20);
          }
          this.napalm(x, y);
        });
      }
    }
  }

  // BLAZE-F 화염 폭격 한 발
  napalm(x, y) {
    this.explode(x, y, 1, true);
    const ring = this.add.circle(x, y, 14).setStrokeStyle(8, 0xff7b1c, 0.9).setDepth(16);
    this.tweens.add({ targets: ring, scale: 6.5, alpha: 0, duration: 380, onComplete: () => ring.destroy() });
    this.cameras.main.shake(120, 0.006);
    this.clearBullets(x, y, 110, true);
    this.enemies.getChildren().slice().forEach((e) => {
      if (e.active && Phaser.Math.Distance.Between(x, y, e.x, e.y) < 95 + e.displayWidth * 0.2) this.damageEnemy(e, 16);
    });
  }

  updateBomb(dt) {
    const p = this.player;
    // RAPTOR-X 융단 폭격
    if (this.carpet) {
      const c = this.carpet;
      c.t += dt; c.dropT -= dt;
      if (c.dropT <= 0) {
        c.dropT = 0.11;
        c.planes.forEach((b) => {
          if (!b.active || b.y > GAME_H - 20 || b.y < 0) return;
          const x = b.x + rand(-34, 34), y = b.y - 30;
          this.explode(x, y, 0, true);
          this.clearBullets(x, y, 75, false);
          this.enemies.getChildren().slice().forEach((e) => {
            if (e.active && Phaser.Math.Distance.Between(x, y, e.x, e.y) < 64 + e.displayWidth * 0.25) this.damageEnemy(e, 5);
          });
        });
      }
      if (c.t > 1.9) this.carpet = null;
    }
    // PHANTOM-Z 플라즈마 벽
    if (this.wall) {
      const w = this.wall;
      w.y -= 950 * dt;
      w.g.clear();
      if (w.y < -40) {
        w.g.destroy();
        this.wall = null;
      } else {
        w.g.fillStyle(0x5fd3ff, 0.3); w.g.fillRect(0, w.y - 26, GAME_W, 52);
        w.g.fillStyle(0xbff4ff, 0.7); w.g.fillRect(0, w.y - 9, GAME_W, 18);
        w.g.fillStyle(0xffffff, 1); w.g.fillRect(0, w.y - 2, GAME_W, 4);
        this.eBullets.children.each((b) => { if (b.active && Math.abs(b.y - w.y) < 34) b.disableBody(true, true); });
        this.enemies.getChildren().slice().forEach((e) => {
          if (!e.active || w.hit.has(e)) return;
          if (Math.abs(e.y - w.y) < 26 + e.displayHeight * 0.4) {
            w.hit.add(e);
            this.fxHit.explode(8, e.x, e.y);
            this.damageEnemy(e, 26);
          }
        });
      }
    }
    // THUNDER-A 방어막
    if (this.barrier) {
      const b = this.barrier;
      b.t -= dt;
      if (b.t <= 0 || this.state.dead || this.state.over) {
        this.tweens.add({ targets: b.img, scale: 5, alpha: 0, duration: 250, onComplete: () => b.img.destroy() });
        this.barrier = null;
      } else {
        const r = 122;
        b.img.setPosition(p.x, p.y).setAngle(b.img.angle + 120 * dt)
          .setAlpha(b.t < 0.6 ? 0.4 + Math.sin(b.t * 40) * 0.3 : 0.75 + Math.sin(b.t * 8) * 0.2);
        this.clearBullets(p.x, p.y, r, Math.random() < 0.3);
        this.enemies.getChildren().slice().forEach((e) => {
          if (e.active && Phaser.Math.Distance.Between(p.x, p.y, e.x, e.y) < r + e.displayWidth * 0.3) this.damageEnemy(e, 20 * dt);
        });
      }
    }
  }

  /* ------------------------- 차지 게이지 -------------------------
   * 시간이 지나거나 적에게 피해를 주면 자동으로 차오른다.
   * 100%가 되면 CHARGE 버튼이 빛나고, 누르면 기체별 특수 공격.
   * ------------------------------------------------------------- */
  addCharge(v, force) {
    const s = this.state;
    if (s.over || s.charge >= 100 || (this.specialActive && !force)) return;
    const before = s.charge;
    s.charge = Math.min(100, s.charge + v);
    if (Math.floor(before) !== Math.floor(s.charge)) this.updateChargeUi();
    if (s.charge >= 100) {
      Sound.tone(880, 0.12, 'square', 0.05, 1320);
      Haptics.vibrate(30);
    }
  }

  updateChargeUi() {
    const g = this.chargeGfx, v = this.state.charge, full = v >= 100;
    g.clear();
    g.fillStyle(0x000000, 0.35); g.fillCircle(0, 4, 38);
    g.fillStyle(full ? 0xff9f1c : 0x1d3557, 0.95); g.fillCircle(0, 0, 36);
    g.lineStyle(5, 0x0b1a2e, 0.9); g.strokeCircle(0, 0, 31);
    if (v > 0) {
      g.lineStyle(5, full ? 0xfff1b8 : 0x5fd3ff, 1);
      g.beginPath();
      g.arc(0, 0, 31, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (v / 100), false);
      g.strokePath();
    }
    this.chargeValue.setText(full ? 'GO!' : Math.floor(v) + '%').setColor(full ? '#3a1d00' : '#ffffff');
    this.chargeLabel.setColor(full ? '#3a1d00' : '#cfe3ff');
  }

  useSpecial() {
    const s = this.state;
    if (s.over || s.dead || s.frozen || this.specialActive || s.charge < 100) return;
    if (!this.scene.isActive()) return;
    s.charge = 0;
    this.updateChargeUi();
    this.chargeBtn.setScale(1);
    this.specialActive = true;
    Sound.unlock();
    Sound.tone(300, 0.5, 'sawtooth', 0.06, 1200);
    Haptics.vibrate(120);
    const p = this.player, id = this.plane.id;
    const cut = txt(this, GAME_W / 2, GAME_H / 2 - 120, id === 'RAPTOR-X' ? 'MISSILE STORM' : id === 'PHANTOM-Z' ? 'HYPER BEAM'
      : id === 'THUNDER-A' ? 'SQUADRON CALL' : 'NAPALM BLAST', 30, '#fff1b8', { stroke: '#3a1d00', strokeThickness: 6 }).setDepth(46);
    this.tweens.add({ targets: cut, alpha: 0, y: cut.y - 30, delay: 500, duration: 400, onComplete: () => cut.destroy() });

    if (id === 'RAPTOR-X') {                 // 유도미사일 14발 일제 사격
      for (let i = 0; i < 14; i++) {
        this.time.delayedCall(i * 35, () => {
          if (this.state.dead || this.state.over) return;
          const a = -Math.PI + (i + 0.5) * (Math.PI / 14);
          this.firePlayerBullet(this.player.x, this.player.y - 6, { kind: 'missile', vx: Math.cos(a) * 280, vy: Math.sin(a) * 280, dmg: 6, scale: 1.3 });
        });
      }
      this.time.delayedCall(800, () => { this.specialActive = false; });
    } else if (id === 'PHANTOM-Z') {         // 거대 관통 빔
      this.beamT = 1.7;
      if (!this.beamGfx) this.beamGfx = this.add.graphics().setDepth(9).setBlendMode(Phaser.BlendModes.ADD);
      Sound.noise(1.6, 0.12, 3000);
    } else if (id === 'THUNDER-A') {         // 지원 편대 3대
      this.wingT = 7;
      this.wingmen = [[-52, 18], [52, 18], [0, 52]].map(([ox, oy], i) => {
        const w = this.add.image(p.x + ox, GAME_H + 60 + i * 30, 'plane_thunder').setScale(0.62).setDepth(10);
        w.ox = ox; w.oy = oy; w.fireT = i * 0.04;
        return w;
      });
    } else {                                 // 거대 화염탄
      this.fireball = this.add.image(p.x, p.y - 34, 'shell').setScale(3.4).setDepth(12);
      this.tweens.add({ targets: this.fireball, angle: 360, duration: 600, repeat: -1 });
    }
  }

  updateSpecial(dt) {
    const p = this.player, s = this.state;
    // 게이지가 가득 차면 버튼이 두근두근
    if (s.charge >= 100 && !s.over) this.chargeBtn.setScale(1 + Math.sin(s.elapsed * 10) * 0.07);

    // PHANTOM-Z 빔
    if (this.beamT > 0 && this.beamGfx) {
      this.beamT -= dt;
      const g = this.beamGfx;
      g.clear();
      if (this.beamT <= 0 || s.dead || s.over) {
        this.beamT = 0;
        this.specialActive = false;
      } else {
        const top = 0, bottom = p.y - 28, w = 40 + Math.random() * 10;
        g.fillStyle(0x5fd3ff, 0.35); g.fillRect(p.x - w / 2 - 10, top, w + 20, bottom - top);
        g.fillStyle(0x9feaff, 0.6); g.fillRect(p.x - w / 2, top, w, bottom - top);
        g.fillStyle(0xffffff, 0.95); g.fillRect(p.x - 7, top, 14, bottom - top);
        g.fillStyle(0xffffff, 0.8); g.fillCircle(p.x, bottom, 16);
        this.enemies.getChildren().slice().forEach((e) => {
          if (!e.active || e.y > bottom || e.y < -40) return;
          if (Math.abs(e.x - p.x) < w / 2 + e.displayWidth * 0.35) this.damageEnemy(e, 50 * dt);
        });
        this.eBullets.children.each((b) => {
          if (b.active && b.y < bottom && Math.abs(b.x - p.x) < w / 2 + 6) b.disableBody(true, true);
        });
        if (Math.random() < 0.5) this.fxHit.explode(2, p.x + rand(-w / 2, w / 2), rand(top, bottom));
      }
    }

    // THUNDER-A 지원 편대
    if (this.wingmen.length) {
      this.wingT -= dt;
      const leaving = this.wingT <= 0 || s.over;
      this.wingmen.forEach((w) => {
        if (leaving) { w.y -= 520 * dt; return; }
        const tx = clamp(p.x + w.ox, 20, GAME_W - 20), ty = p.y + w.oy;
        w.x += (tx - w.x) * Math.min(1, dt * 8);
        w.y += (ty - w.y) * Math.min(1, dt * 8);
        w.fireT -= dt;
        if (w.fireT <= 0 && !s.dead) {
          w.fireT = 0.12;
          this.firePlayerBullet(w.x, w.y - 16, { kind: 'pb', vy: -920, dmg: 0.5 });
        }
      });
      if (leaving && this.wingmen.every((w) => w.y < -60)) {
        this.wingmen.forEach((w) => w.destroy());
        this.wingmen = [];
        this.specialActive = false;
      }
    }

    // BLAZE-F 화염탄
    if (this.fireball) {
      const f = this.fireball;
      f.y -= 460 * dt;
      this.fxFire.explode(1, f.x + rand(-8, 8), f.y + 18);
      const hit = this.enemies.getChildren().some((e) => e.active && e.y > 0 &&
        Phaser.Math.Distance.Between(f.x, f.y, e.x, e.y) < 30 + e.displayWidth * 0.4);
      if (hit || f.y < 150) this.detonateFireball();
    }
  }

  detonateFireball() {
    const f = this.fireball, x = f.x, y = f.y;
    this.fireball = null;
    f.destroy();
    this.explode(x, y, 2);
    const ring = this.add.circle(x, y, 20).setStrokeStyle(10, 0xffb347, 0.9).setDepth(16);
    this.tweens.add({ targets: ring, scale: 9, alpha: 0, duration: 450, onComplete: () => ring.destroy() });
    for (let i = 0; i < 6; i++) this.time.delayedCall(i * 60, () => this.explode(x + rand(-110, 110), y + rand(-90, 90), 1, true));
    this.cameras.main.shake(300, 0.012);
    Haptics.vibrate([0, 160, 50, 100]);
    this.clearBullets(x, y, 200, true);
    this.time.delayedCall(80, () => {
      this.enemies.getChildren().slice().forEach((e) => {
        if (e.active && Phaser.Math.Distance.Between(x, y, e.x, e.y) < 175) this.damageEnemy(e, 60);
      });
      this.specialActive = false;
    });
  }

  /* ------------------------- 중간보스 -------------------------
   * 약 40초마다 WARNING 경고 → 중간보스 등장. 체력이 절반 아래로
   * 떨어지면 공격이 거세진다. 격파 보상: 폭탄 +1, 차지 +50%.
   * ----------------------------------------------------------- */
  startWarning(kind) {
    const W = GAME_W, H = GAME_H;
    this.warningOn = true;
    const band = this.add.rectangle(0, H / 2 - 70, W, 110, 0xb00020, 0.35).setOrigin(0, 0.5).setDepth(44);
    const t1 = txt(this, W / 2, H / 2 - 88, 'WARNING', 46, '#ff3b4e', { stroke: '#2a0008', strokeThickness: 7 }).setDepth(45);
    const t2 = txt(this, W / 2, H / 2 - 42, '중간보스 접근 · ' + MIDBOSS[kind].name, 16, '#ffffff', { stroke: '#000000', strokeThickness: 4 }).setDepth(45);
    this.tweens.add({ targets: [band, t1], alpha: 0.25, duration: 260, yoyo: true, repeat: 3 });
    for (let i = 0; i < 3; i++) this.time.delayedCall(i * 600, () => Sound.tone(520, 0.45, 'sawtooth', 0.06, 260));
    Haptics.vibrate([90, 90, 90, 90, 90]);
    this.time.delayedCall(2200, () => {
      band.destroy(); t1.destroy(); t2.destroy();
      this.warningOn = false;
      if (!this.state.over) this.spawnMidBoss(kind);
    });
  }

  spawnMidBoss(kind) {
    const def = MIDBOSS[kind];
    const k = 1 + this.stageIdx * 0.3;          // 뒤 스테이지일수록 단단함
    const e = this.enemies.create(GAME_W / 2, -70, def.key);
    e.setDepth(4);
    e.body.moves = false;
    if (def.size) e.body.setSize(def.size[0], def.size[1]);
    else e.body.setCircle(def.radius, e.width / 2 - def.radius, e.height / 2 - def.radius);
    Object.assign(e, {
      etype: 'mboss', kind, name: def.name,
      hp: Math.round(def.hp * k * this.diff.hp), maxHp: Math.round(def.hp * k * this.diff.hp), score: Math.round(def.score * k),
      t: 0, entered: false, mode: 'enter', targetY: def.y, maxLife: 80,
      cdA: 1.2, cdB: 2.2, cdC: 0, spiralLeft: 0, spiralAng: 0, dest: null, destT: 0, burst: 0, burstCd: 0
    });
    if (kind === 'gunship') e.rotor = this.add.image(e.x, e.y, 'rotor').setScale(1.9).setDepth(6);
    this.addShadow(e, true);
    this.midBoss = e;
    this.bossBarName.setText('중간보스 · ' + def.name);
    this.bossBar.setVisible(true);
  }

  updateMidBoss(e, dt) {
    const W = GAME_W;
    const ph2 = e.hp < e.maxHp * 0.5;
    const fdt = dt / this.diff.fire;   // 난이도별 공격 간격
    if (e.mode === 'enter') {
      e.y += Math.max(50, (e.targetY - e.y) * 2) * dt;
      if (e.y >= e.targetY - 2) e.mode = 'fight';
      return;
    }
    if (e.mode === 'leave') { e.y -= 90 * dt; return; }
    if (e.t > 52) { e.mode = 'leave'; return; }   // 너무 오래 끌면 퇴장

    // 이동
    if (e.kind === 'ace') {
      if (!e.dest || e.destT <= 0) {
        e.dest = { x: rand(60, W - 60), y: rand(110, 330) };
        e.destT = ph2 ? 1.1 : 1.6;
        e.burst = ph2 ? 7 : 5;
        e.burstCd = 0.35;
      }
      e.destT -= dt;
      const ax = (e.dest.x - e.x) * Math.min(1, dt * 3.5);
      e.x += ax;
      e.y += (e.dest.y - e.y) * Math.min(1, dt * 3.5);
      e.rotation += (clamp(ax * 0.25, -0.4, 0.4) - e.rotation) * 0.2;
    } else {
      const amp = W / 2 - (e.kind === 'fortress' ? 110 : 80);
      e.x = W / 2 + Math.sin(e.t * (e.kind === 'fortress' ? 0.5 : 0.8)) * amp;
      e.y = e.targetY + Math.sin(e.t * 1.3) * 8;
    }

    // 공격
    if (e.kind === 'gunship') {
      e.cdA -= fdt;
      if (e.cdA <= 0) { e.cdA = ph2 ? 1.2 : 1.7; this.fireFanAtPlayer(e, ph2 ? 7 : 5, 0.17, 210, false); }
      e.cdB -= fdt;
      if (e.cdB <= 0) { e.cdB = ph2 ? 2.4 : 3.2; e.spiralLeft = ph2 ? 28 : 18; }
      if (e.spiralLeft > 0) {
        e.cdC -= fdt;
        if (e.cdC <= 0) {
          e.cdC = 0.05; e.spiralLeft--; e.spiralAng += 0.35;
          this.fireEnemyBullet(e.x, e.y + 24, e.spiralAng, 170, false);
          if (ph2) this.fireEnemyBullet(e.x, e.y + 24, e.spiralAng + Math.PI, 170, false);
        }
      }
    } else if (e.kind === 'fortress') {
      e.cdA -= fdt;
      if (e.cdA <= 0) {
        e.cdA = ph2 ? 1.9 : 2.5;
        this.fireRing(e.x, e.y + 10, ph2 ? 22 : 18, 115);
        if (ph2) this.time.delayedCall(260, () => { if (e.active) this.fireRing(e.x, e.y + 10, 22, 140); });
      }
      e.cdB -= fdt;
      if (e.cdB <= 0) {
        e.cdB = ph2 ? 0.7 : 1.0;
        [-70, 70].forEach((ox) => this.fireFanAtPlayer({ x: e.x + ox, y: e.y }, 1, 0, 230, true));
      }
    } else if (e.burst > 0) {
      e.burstCd -= fdt;
      if (e.burstCd <= 0) {
        e.burstCd = 0.08; e.burst--;
        this.fireFanAtPlayer(e, ph2 ? 3 : 1, 0.24, 245, false);
      }
    }
  }

  endMidBoss(killed, e) {
    this.midBoss = null;
    this.bossBar.setVisible(false);
    if (!killed || this.state.over) return;
    // 격파 보상: B(폭탄)·P(파워업) 아이템 + 차지 게이지 50%
    const x = e ? e.x : GAME_W / 2, y = e ? e.y : 200;
    this.time.delayedCall(700, () => { this.dropItem('B', x - 24, y); this.dropItem('P', x + 24, y); });
    this.addCharge(50, true);
    const t = txt(this, GAME_W / 2, GAME_H / 2 - 40, 'MID BOSS DOWN!\nB·P 아이템을 챙기세요', 22, '#ffe066',
      { stroke: '#3a1d00', strokeThickness: 5, align: 'center' }).setDepth(46);
    this.tweens.add({ targets: t, alpha: 0, y: t.y - 40, delay: 1400, duration: 500, onComplete: () => t.destroy() });
  }

  bossExplosion(e) {
    const x = e.x, y = e.y, w = e.displayWidth * 0.4, h = e.displayHeight * 0.35;
    for (let i = 0; i < 8; i++) {
      this.time.delayedCall(i * 85, () => this.explode(x + rand(-w, w), y + rand(-h, h), 1, i % 2 === 1));
    }
    this.time.delayedCall(720, () => { this.explode(x, y, 2); this.explode(x + 20, y - 15, 2, true); });
  }

  updateBossBar() {
    const e = this.stageBoss || this.midBoss;
    if (!e || !e.active) return;
    const g = this.bossBarGfx, W = GAME_W;
    g.clear();
    g.fillStyle(0x000000, 0.6); g.fillRoundedRect(16, 120, W - 32, 10, 4);
    if (e.etype === 'sboss') {                     // 보스: 단계 구분선 표시
      g.fillStyle([0xff8a3d, 0xff5d3d, 0xff1f4e][e.phase - 1], 1);
      g.fillRoundedRect(18, 122, (W - 36) * clamp(e.hp / e.maxHp, 0, 1), 6, 3);
      g.fillStyle(0xffffff, 0.7); g.fillRect(18 + (W - 36) * 0.33, 121, 2, 8); g.fillRect(18 + (W - 36) * 0.66, 121, 2, 8);
      return;
    }
    g.fillStyle(e.hp < e.maxHp * 0.5 ? 0xff3b4e : 0xff8a3d, 1);
    g.fillRoundedRect(18, 122, (W - 36) * clamp(e.hp / e.maxHp, 0, 1), 6, 3);
  }

  /* ------------------------- 난이도 ------------------------- */
  difficulty() { return Math.min(1 + this.stageIdx * 0.45 + this.stage.t / 110, 3.6); }
  bulletMul() { return (1 + Math.min(this.stageIdx * 0.07 + this.stage.t / 350, 0.36)) * this.diff.bullet; }

  /* ------------------------- 적 등장 ------------------------- */
  spawnDirector(dt) {
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    const st = STAGES[this.stageIdx], t = this.stage.t, d = this.difficulty();
    this.spawnT = rand(1.7, 2.6) / d + 0.45;
    const alive = this.enemies.getChildren().filter((e) => e.active);
    const bombers = alive.filter((e) => e.etype === 'bomber').length;
    const helis = alive.filter((e) => e.etype === 'heli').length;
    const grounds = alive.filter((e) => e.ground).length;
    const r = Math.random();
    if (this.midBoss || this.warningOn) {     // 중간보스전: 잡몹은 가끔 전투기만
      this.spawnT *= 1.8;
      if (r < 0.6) this.spawnFighterWave();
      return;
    }
    if (st.ground && grounds < 2 && r < 0.2) { this.spawnGround(st.ground); return; }
    if (t > 20 && bombers === 0 && r < 0.18 + this.stageIdx * 0.03) { this.spawnBomber(); this.spawnT += 2.5; return; }
    if (t > 8 && helis < 1 + Math.floor(d) && r < 0.5) { this.spawnHeli(); return; }
    this.spawnFighterWave();
  }

  spawnGround(type) {
    const x = randInt(50, GAME_W - 50);
    if (type === 'ship') {
      this.spawnEnemy('ship', x, -70, { fireCd: 1.6, drift: rand(-12, 12) });
    } else {
      const e = this.spawnEnemy('tank', x, -40, { fireCd: 1.3, drift: rand(-20, 20) });
      e.turret = this.add.image(x, -40, 'g_turret').setDepth(2.5);
    }
  }

  // 지상·해상 적: 배경과 함께 내려오며 조준 사격 (몸통 충돌 없음)
  updateGround(e, dt) {
    e.y += (60 + (e.etype === 'ship' ? 15 : 20)) * dt;
    e.x = clamp(e.x + e.drift * dt, 20, GAME_W - 20);
    const p = this.player;
    if (e.turret) e.turret.setPosition(e.x, e.y + 2).setRotation(Phaser.Math.Angle.Between(e.x, e.y, p.x, p.y));
    e.fireCd -= dt;
    if (e.fireCd <= 0 && e.y > 30 && e.y < GAME_H - 220) {
      e.fireCd = e.etype === 'ship' ? 2.0 : 2.4;
      if (e.etype === 'ship') this.fireFanAtPlayer(e, 2, 0.2, 180, true);
      else this.fireFanAtPlayer(e, 1, 0, 200, false);
    }
  }

  /* ------------------------- 스테이지 진행 -------------------------
   * intro(3초) → waves(잡몹, 38초쯤 중간보스) → 80초 이후 보스 대기
   * → 보스 경고 → boss → clear(정산) → 다음 스테이지 / 5스테이지면 엔딩
   * ------------------------------------------------------------- */
  updateStage(dt) {
    const st = this.stage;
    st.t += dt;
    if (st.phase === 'intro') { if (st.t > 3) st.phase = 'waves'; return; }
    if (st.phase === 'waves') {
      this.spawnDirector(dt);
      if (!st.midDone && !this.midBoss && !this.warningOn && st.t > STAGE_TIME.mid) {
        st.midDone = true;
        this.startWarning(STAGES[this.stageIdx].mid);
      }
      if (st.midDone && !this.midBoss && !this.warningOn && st.t > STAGE_TIME.boss) { st.phase = 'preboss'; st.wait = 0; }
      return;
    }
    if (st.phase === 'preboss') {               // 남은 잡몹이 정리되면 보스 등장
      st.wait += dt;
      const left = this.enemies.getChildren().filter((e) => e.active).length;
      if ((left === 0 && st.wait > 1.5) || st.wait > 7) { st.phase = 'bosswarn'; this.startBossWarning(); }
    }
  }

  showStageTitle() {
    const W = GAME_W, H = GAME_H, st = STAGES[this.stageIdx];
    const t1 = txt(this, W / 2, H / 2 - 120, 'STAGE ' + (this.stageIdx + 1), 44, '#ffe066', { stroke: '#3a1d00', strokeThickness: 7 }).setDepth(41);
    const t2 = txt(this, W / 2, H / 2 - 76, st.name, 24, '#ffffff', { stroke: '#000000', strokeThickness: 5 }).setDepth(41);
    const t3 = txt(this, W / 2, H / 2 - 48, st.kr, 15, '#cfe3ff', { stroke: '#000000', strokeThickness: 4 }).setDepth(41);
    [t1, t2, t3].forEach((t, i) => { t.setAlpha(0); this.tweens.add({ targets: t, alpha: 1, delay: i * 150, duration: 300 }); });
    this.tweens.add({ targets: [t1, t2, t3], alpha: 0, delay: 2600, duration: 500, onComplete: () => { t1.destroy(); t2.destroy(); t3.destroy(); } });
  }

  startBossWarning() {
    const W = GAME_W, H = GAME_H, id = STAGES[this.stageIdx].boss, def = BOSSES[id];
    this.warningOn = true;
    const band = this.add.rectangle(0, H / 2 - 80, W, 140, 0xb00020, 0.4).setOrigin(0, 0.5).setDepth(44);
    const t1 = txt(this, W / 2, H / 2 - 104, 'WARNING!!', 50, '#ff3b4e', { stroke: '#2a0008', strokeThickness: 8 }).setDepth(45);
    const t2 = txt(this, W / 2, H / 2 - 56, 'STAGE BOSS · ' + def.name, 17, '#ffffff', { stroke: '#000000', strokeThickness: 4 }).setDepth(45);
    this.tweens.add({ targets: [band, t1], alpha: 0.2, duration: 240, yoyo: true, repeat: 5 });
    for (let i = 0; i < 4; i++) this.time.delayedCall(i * 650, () => Sound.tone(440, 0.55, 'sawtooth', 0.07, 220));
    Haptics.vibrate([120, 100, 120, 100, 300]);
    this.time.delayedCall(2800, () => {
      band.destroy(); t1.destroy(); t2.destroy();
      this.warningOn = false;
      if (!this.state.over) { this.spawnStageBoss(id); this.stage.phase = 'boss'; }
    });
  }

  spawnStageBoss(id) {
    const def = BOSSES[id];
    const e = this.enemies.create(GAME_W / 2, -200, def.key);
    e.y = -e.height / 2 - 10;
    e.setDepth(4);
    e.body.moves = false;
    e.body.setSize(def.size[0], def.size[1]);
    Object.assign(e, {
      etype: 'sboss', bid: id, name: def.name, hp: Math.round(def.hp * this.diff.hp), maxHp: Math.round(def.hp * this.diff.hp), score: 0,
      t: 0, entered: false, mode: 'enter', targetY: def.y, maxLife: Infinity, phase: 1,
      pat: def.phases.map((ph) => ph.map(() => ({ cd: rand(2.0, 2.8), t: 0, on: true, ang: Math.random() * 6 })))
    });
    this.addShadow(e, true);
    this.stageBoss = e;
    this.bossBarName.setText('STAGE BOSS · ' + def.name);
    this.bossBar.setVisible(true);
  }

  updateStageBoss(e, dt) {
    const W = GAME_W, def = BOSSES[e.bid];
    if (e.mode === 'enter') {
      e.y += Math.max(40, (e.targetY - e.y) * 1.5) * dt;
      if (e.y >= e.targetY - 2) e.mode = 'fight';
      return;
    }
    const ratio = e.hp / e.maxHp;
    const phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
    if (phase !== e.phase) { e.phase = phase; this.onBossPhase(e); }
    const amp = Math.max(0, W / 2 - e.displayWidth / 2 - 8);
    e.x = W / 2 + Math.sin(e.t * (phase === 3 ? 0.85 : 0.6)) * amp;
    e.y = e.targetY + Math.sin(e.t * 1.1) * 10;
    def.phases[phase - 1].forEach((pt, k) => this.runPattern(e, def, pt, e.pat[phase - 1][k], dt));
  }

  // 보스 공격 패턴 실행기
  runPattern(e, def, pt, ps, dt) {
    const gun = (gi) => { const g = def.guns[gi || 0] || [0, 0]; return { x: e.x + g[0], y: e.y + g[1] }; };
    if (pt.p === 'spiral') {                       // 회오리: dur초 쏘고 rest초 쉼
      ps.t += dt;
      if (ps.on && ps.t > (pt.dur || 2)) { ps.on = false; ps.t = 0; }
      else if (!ps.on && ps.t > (pt.rest || 1.5)) { ps.on = true; ps.t = 0; }
      if (!ps.on) return;
      ps.cd -= dt;
      if (ps.cd > 0) return;
      ps.cd = pt.every * this.diff.fire;
      ps.ang += pt.step;
      const o = gun(pt.gun);
      for (let a = 0; a < pt.arms; a++) this.fireEnemyBullet(o.x, o.y, ps.ang + (a * Math.PI * 2) / pt.arms, pt.speed, false);
      return;
    }
    ps.cd -= dt;
    if (ps.cd > 0) return;
    ps.cd = pt.every * this.diff.fire;
    if (pt.p === 'fan') this.fireFanAtPlayer(gun(pt.gun), pt.n, pt.spread, pt.speed, false);
    else if (pt.p === 'ring') { const o = gun(pt.gun); this.fireRing(o.x, o.y, pt.n, pt.speed); }
    else if (pt.p === 'big') this.fireFanAtPlayer(gun(pt.gun), pt.n, 0.14, pt.speed, true);
    else if (pt.p === 'guns') {
      ps.alt = !ps.alt;
      def.guns.forEach((g, gi) => {
        if (pt.only ? !pt.only.includes(gi) : (gi % 2 === 0) !== ps.alt) return;
        this.fireFanAtPlayer({ x: e.x + g[0], y: e.y + g[1] }, 1, 0, pt.speed, false);
      });
    } else if (pt.p === 'curtain') {               // 아래로 쏟아지는 탄 커튼 (사이사이 빈틈)
      const w = e.displayWidth * 0.8;
      ps.ang = (ps.ang | 0) + 1;
      for (let k = 0; k < pt.n; k++) {
        const x = e.x - w / 2 + (w * k) / (pt.n - 1);
        this.fireEnemyBullet(x, e.y + 30, Math.PI / 2 + ((k + ps.ang) % 2 ? 0.13 : -0.13), pt.speed, false);
      }
    }
  }

  onBossPhase(e) {
    this.cameras.main.shake(260, 0.01);
    Haptics.vibrate(90);
    for (let i = 0; i < 3; i++) {
      this.time.delayedCall(i * 120, () => this.explode(e.x + rand(-e.displayWidth * 0.35, e.displayWidth * 0.35), e.y + rand(-30, 30), 1, true));
    }
    const t = txt(this, GAME_W / 2, 210, e.phase === 3 ? '!! 보스가 폭주한다 !!' : '! 보스 공격 패턴 변화 !', 18, '#ff8a8a', { stroke: '#000000', strokeThickness: 4 }).setDepth(46);
    this.tweens.add({ targets: t, alpha: 0, delay: 1000, duration: 400, onComplete: () => t.destroy() });
  }

  // 보스 격파 → 연쇄 폭발 → 스테이지 클리어
  onStageBossDown(e) {
    const s = this.state;
    this.stage.phase = 'clear';
    this.stageBoss = null;
    this.bossBar.setVisible(false);
    this.safe = true;
    this.clearBullets(0, 0, Infinity, true);
    e.body.enable = false;
    e.setActive(false);
    const w = e.displayWidth * 0.42, h = e.displayHeight * 0.38;
    for (let i = 0; i < 14; i++) {
      this.time.delayedCall(i * 100, () => {
        this.explode(e.x + rand(-w, w), e.y + rand(-h, h), i % 3 === 0 ? 2 : 1, i % 2 === 1);
        e.setTintFill(i % 2 ? 0xffffff : 0xff8a3d);
      });
    }
    this.time.delayedCall(1450, () => {
      this.explode(e.x, e.y, 2); this.explode(e.x - 40, e.y + 20, 2, true); this.explode(e.x + 40, e.y - 20, 2, true);
      this.cameras.main.flash(300, 255, 240, 200);
      this.removeEnemy(e);
    });
    Haptics.vibrate([200, 80, 200, 80, 600]);
    s.kills++;
    const bonus = 10000 * (this.stageIdx + 1);
    this.addScore(bonus);
    this.time.delayedCall(2300, () => this.stageClear(bonus));
  }

  stageClear(bonus) {
    if (this.state.over) return;
    const s = this.state;
    let reward;
    if (s.mode === 'normal' && s.hp < s.maxHp) { s.hp++; this.updateLifeUi(); reward = '하트 +1 회복'; }
    else { s.bombs = Math.min(s.bombs + 1, 6); this.updateBombUi(); reward = '폭탄 +1'; }
    const W = GAME_W, H = GAME_H, pl = this.plane.pilot;
    const c = this.add.container(0, 0).setDepth(150).setAlpha(0);
    c.add([
      this.add.rectangle(0, H / 2 - 60, W, 230, 0x000814, 0.6).setOrigin(0, 0.5),
      txt(this, W / 2, H / 2 - 140, 'STAGE ' + (this.stageIdx + 1) + ' CLEAR!', 38, '#ffe066', { stroke: '#3a1d00', strokeThickness: 7 }),
      txt(this, W / 2, H / 2 - 96, 'BOSS BONUS  +' + fmt(bonus) + '   ·   ' + reward, 16, '#ffffff', { stroke: '#000000', strokeThickness: 4 }),
      this.add.image(W / 2 - 100, H / 2 - 30, pl.face).setScale(0.85),
      this.add.text(W / 2 - 66, H / 2 - 30, pl.name + '\n' + pl.quote, { fontFamily: FONT, resolution: ZOOM, fontSize: '14px', color: '#ffffff', lineSpacing: 4 }).setOrigin(0, 0.5)
    ]);
    this.tweens.add({ targets: c, alpha: 1, duration: 300 });
    [523, 659, 784, 1046].forEach((f, k) => this.time.delayedCall(k * 120, () => Sound.tone(f, 0.18, 'square', 0.05)));
    this.time.delayedCall(3400, () => {
      this.tweens.add({ targets: c, alpha: 0, duration: 300, onComplete: () => c.destroy() });
      if (this.stageIdx >= STAGES.length - 1) this.allClear();
      else this.nextStage();
    });
  }

  nextStage() {
    const cam = this.cameras.main;
    cam.fadeOut(450, 0, 0, 0);
    cam.once('camerafadeoutcomplete', () => {
      if (this.state.over) return;
      this.stageIdx++;
      this.enemies.getChildren().slice().forEach((e) => this.removeEnemy(e));
      this.clearBullets(0, 0, Infinity, false);
      this.applyStageVisuals();
      this.stage = { t: 0, phase: 'intro', midDone: false, wait: 0 };
      this.spawnT = 2;
      this.safe = false;
      this.invuln = 2.5;
      cam.fadeIn(500, 0, 0, 0);
      this.showStageTitle();
    });
  }

  // 5스테이지 보스까지 격파 → 엔딩 보너스 후 결과 화면
  allClear() {
    const s = this.state;
    s.cleared = true;
    const left = s.mode === 'normal' ? s.hp : s.lives;
    const bonus = 30000 + left * 10000 + s.bombs * 3000;
    this.addScore(bonus);
    s.clearBonus = bonus;
    Haptics.vibrate([100, 60, 100, 60, 100, 60, 400]);
    this.finishGame(600);
  }

  spawnEnemy(type, x, y, props) {
    const def = ENEMY[type];
    const e = this.enemies.create(x, y, def.key);
    e.setDepth(def.ground ? 2 : type === 'bomber' ? 4 : 5);
    e.body.moves = false;
    e.ground = !!def.ground;
    if (type === 'bomber') e.body.setSize(112, 46);
    else if (type === 'ship') e.body.setSize(32, 96);
    else e.body.setCircle(def.radius, e.width / 2 - def.radius, e.height / 2 - def.radius);
    e.etype = type;
    e.hp = type === 'fighter' ? def.hp : def.hp * this.diff.hp;
    e.maxHp = e.hp;
    e.score = def.score;
    e.t = 0;
    e.entered = false;
    Object.assign(e, props);
    if (!def.ground) this.addShadow(e, false);
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
      else if (e.etype === 'mboss') this.updateMidBoss(e, dt);
      else if (e.etype === 'sboss') this.updateStageBoss(e, dt);
      else if (e.ground) this.updateGround(e, dt);
      else this.updateBomber(e, dt);

      if (e.rotor) { e.rotor.setPosition(e.x, e.y + 6); e.rotor.rotation += dt * 28; }
      if (e.shadow) e.shadow.setPosition(e.x + e.sdx, e.y + e.sdy).setRotation(e.rotation);
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
      if (gone || e.t > (e.maxLife || 40)) this.removeEnemy(e);
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
        e.shots = (e.shots || 0) + 1;
        e.fired = e.shots >= (this.stageIdx >= 2 ? 2 : 1);
        e.visT = e.fireAt - 0.5;
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
    if (b.pierce) {                       // 관통 레이저: 같은 적은 한 번만
      if (b.hits.has(e)) return;
      b.hits.add(e);
    } else {
      b.disableBody(true, true);
    }
    this.fxHit.explode(b.pierce ? 2 : 4, b.x, b.y - 6);
    if (b.splash) this.splashDamage(b.x, b.y, e);
    this.damageEnemy(e, b.dmg || 1);
  }

  // 폭발탄: 주변 적에게도 피해
  splashDamage(x, y, hitEnemy) {
    this.fxFire.explode(6, x, y);
    const f = this.add.image(x, y, 'flash').setDepth(15).setBlendMode(Phaser.BlendModes.ADD).setTint(0xff9a3d).setScale(0.3);
    this.tweens.add({ targets: f, scale: 1.1, alpha: 0, duration: 180, onComplete: () => f.destroy() });
    this.enemies.getChildren().slice().forEach((o) => {
      if (o !== hitEnemy && o.active && Phaser.Math.Distance.Between(x, y, o.x, o.y) < 52) this.damageEnemy(o, 1);
    });
  }

  onPlayerHitBullet(p, b) {
    if (!b.active) return;
    if (this.safe) { b.disableBody(true, true); return; }
    if (this.invuln > 0 || this.state.over || this.state.dead) return;
    b.disableBody(true, true);
    this.hurtPlayer();
  }

  onPlayerHitEnemy(p, e) {
    if (!e.active || this.safe || this.invuln > 0 || this.state.over || this.state.dead) return;
    this.damageEnemy(e, e.etype === 'fighter' ? 99 : 4);
    this.hurtPlayer();
  }

  damageEnemy(e, dmg) {
    if (!e.active) return;
    e.hp -= dmg;
    this.addCharge(Math.min(dmg, e.hp + dmg) * CHARGE.perDamage);
    if (e.hp <= 0) { this.killEnemy(e); return; }
    const now = this.time.now;
    if (!e.flashAt || now - e.flashAt > 110) {
      e.flashAt = now;
      if (e.etype === 'sboss' || e.etype === 'mboss') e.setTint(0xffb0a0);
      else e.setTintFill(0xffffff);
      this.time.delayedCall(45, () => { if (e.active) e.clearTint(); });
    }
    Sound.hit();
  }

  killEnemy(e) {
    const s = this.state;
    if (e.etype === 'sboss') { this.onStageBossDown(e); return; }
    s.combo = s.comboTimer > 0 ? s.combo + 1 : 1;
    s.comboTimer = 2.0;
    const bonus = Math.floor(e.score * Math.min(s.combo - 1, 30) * 0.1);
    const pts = e.score + bonus;
    this.addScore(pts);
    this.floatText(e.x, e.y, '+' + fmt(pts), bonus > 0 ? '#ffe066' : '#ffffff');
    if (s.combo >= 3) this.showCombo(s.combo);
    s.kills++;

    if (e.etype === 'mboss') {
      this.bossExplosion(e);
      Haptics.vibrate([150, 60, 150, 60, 450]);
      this.endMidBoss(true, e);
    } else if (e.etype === 'bomber') {
      this.bigExplosion(e.x, e.y);
      Haptics.vibrate([120, 60, 120, 60, 320]);   // 보스급 격파 진동
    } else {
      this.explode(e.x, e.y, ENEMY[e.etype].boom);
    }
    if (e.etype !== 'mboss') this.maybeDropPower(e);

    e.body.enable = false;
    e.setActive(false).setVisible(false);
    if (e.rotor) e.rotor.setVisible(false);
    if (e.turret) e.turret.setVisible(false);
    if (e.shadow) e.shadow.setVisible(false);
    if (e.hpBar) e.hpBar.clear();
    this.trash.push(e);
  }

  removeEnemy(e) {
    if (e.etype === 'mboss' && this.midBoss === e) this.endMidBoss(false);   // 격파 못 하고 도망감
    if (e.rotor) { e.rotor.destroy(); e.rotor = null; }
    if (e.turret) { e.turret.destroy(); e.turret = null; }
    if (e.shadow) { e.shadow.destroy(); e.shadow = null; }
    if (this.stageBoss === e) this.stageBoss = null;
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
  // 비행기 그림자: 왼쪽 위에서 빛이 오므로 오른쪽 아래로 떨어짐 (높이 날수록 멀리)
  addShadow(e, big) {
    e.shadow = this.add.image(e.x, e.y, e.texture.key).setTintFill(0x000000)
      .setAlpha(big ? 0.32 : 0.26).setScale(0.82).setDepth(1.6).setFlipY(e.flipY);
    e.sdx = big ? 30 : 12 + e.width * 0.06;
    e.sdy = big ? 44 : 18 + e.height * 0.08;
  }

  explode(x, y, size, noShake) {   // size: 0 소형, 1 중형, 2 대형
    const n = [12, 26, 46][size];
    this.fxFire.explode(n, x, y);
    this.fxSmoke.explode(Math.ceil(n / 2), x, y);
    this.fxDebris.explode([4, 10, 18][size], x, y);
    const rg = this.add.image(x, y, 'ring').setDepth(15).setBlendMode(Phaser.BlendModes.ADD).setScale(0.15 + size * 0.12);
    this.tweens.add({ targets: rg, scale: 0.7 + size * 0.8, alpha: 0, duration: 320 + size * 120, onComplete: () => rg.destroy() });
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
    if (s.mode === 'arcade' && s.armor > 0) { s.armor--; this.breakShield(); return; }
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
      this.invuln = this.plane.inv + this.diff.inv;
    } else {
      s.lives--;
      this.updateLifeUi();
      this.playerDown();
    }
  }

  // THUNDER-A 방어막: 한 번 막아 주고 깨짐
  breakShield() {
    const p = this.player;
    Sound.hit(); Sound.tone(520, 0.25, 'triangle', 0.08, 180);
    Haptics.vibrate(60);
    this.fxHit.explode(14, p.x, p.y);
    this.clearBullets(p.x, p.y, 130, true);
    this.invuln = 1.2;
    this.shieldBreaking = true;
    this.shield.setVisible(true).setPosition(p.x, p.y).setAlpha(1).setScale(1);
    this.tweens.add({
      targets: this.shield, scale: 1.8, alpha: 0, duration: 300,
      onComplete: () => { this.shield.setScale(1); this.shieldBreaking = false; }
    });
  }

  hidePlayer() {
    const p = this.player;
    p.setVisible(false);
    p.body.enable = false;
    this.flame.setVisible(false);
    this.muzzle.setVisible(false);
    this.shield.setVisible(false);
    this.playerShadow.setVisible(false);
    this.trail.stop();
    this.beamT = 0;
    this.drag = null;
  }

  // 오락실 모드: 한 번 맞으면 기체 1대 격추 → 다시 출격 또는 이어하기
  playerDown() {
    const s = this.state, p = this.player;
    s.dead = true;
    if (s.power > 1) {                       // 원작처럼 격추되면 파워가 떨어지고 P를 흘림
      s.power = Math.max(1, s.power - 2);
      this.updatePowerUi();
      this.time.delayedCall(500, () => this.dropItem('P', p.x, p.y - 40));
    }
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
    s.armor = this.plane.armor;              // 방어막도 다시
    this.updateBombUi();
    p.setPosition(GAME_W / 2, GAME_H + 50).setRotation(0).setVisible(true);
    p.body.enable = true;
    this.flame.setVisible(true);
    this.playerShadow.setVisible(true);
    this.trail.start();
    this.target.x = GAME_W / 2; this.target.y = GAME_H - 170;
    this.invuln = 3.2;
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
    const yes = this.contYes = makeButton(this, W / 2, 510, 240, 60, '이어하기', () => {
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
    this.chargeBtn.setVisible(false).disableInteractive();
    this.bossBar.setVisible(false);

    const isNew = s.score > s.best;
    if (isNew) Store.set('best_' + s.mode + '_' + this.diff.key, s.score);
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
      s.cleared
        ? txt(this, W / 2, 240, 'ALL CLEAR!', 44, '#ffe066', { stroke: '#3a1d00', strokeThickness: 6 })
        : txt(this, W / 2, 240, 'GAME OVER', 44, '#ff5d6c', { stroke: '#2a0008', strokeThickness: 6 }),
      txt(this, W / 2, 284, MODES[s.mode].label + '  ·  ' + this.diff.label + '  ·  ' + (s.cleared ? 'ALL CLEAR' : 'STAGE ' + (this.stageIdx + 1) + ' 도달'), 14, '#9ec9ff'),
      txt(this, W / 2, 318, 'SCORE', 15, '#9ec9ff'),
      txt(this, W / 2, 356, fmt(s.score), 44, '#ffffff'),
      txt(this, W / 2, 404, 'BEST  ' + fmt(Math.max(s.best, s.score)), 18, '#ffd166'),
      txt(this, W / 2, 466, stats, 14, '#cfe3ff')
    ]);
    if (s.cleared) c.add(txt(this, W / 2, 487, '클리어 보너스 +' + fmt(s.clearBonus), 13, '#ffd166'));
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
          plane: Store.get('plane', 'RAPTOR-X'), continues: s.continues,
          stage: s.cleared ? 6 : this.stageIdx + 1, diff: this.diff.key
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
    this.cameras.main.setOrigin(0, 0).setZoom(ZOOM);
    this.add.rectangle(0, 0, W, H, 0x000814, 0.65).setOrigin(0).setInteractive();
    drawPanel(this, 40, 236, W - 80, 452);
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
    makeSensControl(this, W / 2, 640);

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
  width: GAME_W * ZOOM,
  height: GAME_H * ZOOM,
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
