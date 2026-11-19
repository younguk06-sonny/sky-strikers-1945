# SKY STRIKERS 1945 (1.1 버전)

모바일 세로 화면용 비행기 슈팅 웹게임. Phaser 3 + Canvas 그래픽, 외부 이미지 없음.

## 파일
- `index.html` – 페이지 뼈대, 닉네임 입력창, 오프라인용 서비스 워커 등록
- `style.css` – 전체화면, 스크롤·확대 방지, 입력창 디자인
- `phaser.min.js` – 게임 엔진 Phaser 3.80.1 (인터넷 없이 돌도록 함께 넣음)
- `sw.js` – 한 번 열면 파일을 휴대폰에 저장해 오프라인에서도 실행
- `game.js` – 게임 전체

## 조작
- 모바일: 화면 드래그로 이동, 자동 발사, 오른쪽 아래 BOMB 버튼
- PC: 방향키/WASD 이동, SPACE 폭탄, P/ESC 일시정지

## 모드
- 일반 모드: 하트 3개, 폭탄 3개
- 오락실 모드: 목숨 3 (한 번 맞으면 1대 격추), 목숨마다 폭탄 2개, 이어하기 3회(10초 카운트다운, 점수 유지)

---

## 오프라인 플레이
- 인터넷 될 때 한 번 열면, 그다음부터는 비행기 모드에서도 실행됩니다.
- 기록(랭킹)은 그 휴대폰에만 저장됩니다. 온라인 랭킹은 2026-11에 뺐습니다.

---

## GitHub Pages 배포
1. github.com → ＋ → New repository → 이름 `sky-strikers-1945` → Create repository
2. "uploading an existing file" → 저장소의 파일 전부 끌어다 놓기 → Commit changes
3. Settings → Pages → Branch를 `main` / `(root)` → Save
4. 1~2분 뒤 `https://<아이디>.github.io/sky-strikers-1945/` 접속

## 진동
- 안드로이드 크롬·삼성 인터넷에서 동작 (폭탄, 폭격기 격파, 피격 시)
- iPhone(Safari)은 웹 진동을 지원하지 않아 메뉴에 "진동 미지원"으로 표시됩니다.
