/* SKY STRIKERS 1945 — 오프라인 실행용 서비스 워커
 * 한 번 온라인으로 열면 게임 파일을 휴대폰에 저장해 두고,
 * 인터넷이 없을 때는 저장된 파일로 실행한다.
 * 인터넷이 있을 때는 항상 새 파일을 먼저 받아서 업데이트가 바로 반영된다. */
const CACHE = 'sky-strikers-v2';
const CORE = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './phaser.min.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 인터넷이 느리거나 끊겼을 때 오래 기다리지 않도록 3초 제한
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 글꼴: 저장된 것을 먼저 쓰고, 없으면 받아서 저장
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => {
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
        return r;
      })))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 게임 파일: 새 파일을 먼저 시도 → 실패하면 저장된 파일
  e.respondWith(
    fetchWithTimeout(req, 3000).then((r) => {
      if (r && r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return r;
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then((hit) =>
        hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())
      )
    )
  );
});
