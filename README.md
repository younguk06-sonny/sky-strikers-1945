# SKY STRIKERS 1945 (1차 버전)

모바일 세로 화면용 비행기 슈팅 웹게임. Phaser 3 + Canvas 그래픽, 외부 이미지 없음.

## 파일
- `index.html` – 페이지 뼈대, Phaser(CDN) 불러오기
- `style.css` – 전체화면, 스크롤·확대 방지
- `game.js` – 게임 전체 (Boot / Menu / Game / Pause 장면)

## 조작
- 모바일: 화면 아무 곳이나 드래그 → 손가락이 움직인 만큼 기체 이동, 자동 발사
- PC: 방향키 또는 WASD 이동, P 또는 ESC 일시정지

## GitHub Pages 배포
1. GitHub에서 새 저장소 생성 (예: `sky-strikers-1945`)
2. 이 폴더의 파일 3개(index.html, style.css, game.js)를 저장소 맨 위(루트)에 업로드
3. Settings → Pages → Source를 `Deploy from a branch`, Branch를 `main` / `(root)`로 저장
4. 1~2분 뒤 `https://<아이디>.github.io/sky-strikers-1945/` 로 접속

## 스마트폰 테스트
- 위 주소를 폰 브라우저로 열고, 공유 메뉴 → "홈 화면에 추가"하면 앱처럼 전체화면으로 실행
- 화면을 세로로 두고 플레이
- 코드 수정 후 반영이 안 보이면 새로고침(캐시) 한 번
