# SKY STRIKERS 1945 (1.1 버전)

모바일 세로 화면용 비행기 슈팅 웹게임. Phaser 3 + Canvas 그래픽, 외부 이미지 없음.

## 파일
- `index.html` – 페이지 뼈대, 닉네임 입력창, Phaser(CDN) 불러오기
- `style.css` – 전체화면, 스크롤·확대 방지, 입력창 디자인
- `config.js` – 온라인 랭킹(Supabase) 주소·키 넣는 곳
- `game.js` – 게임 전체

## 조작
- 모바일: 화면 드래그로 이동, 자동 발사, 오른쪽 아래 BOMB 버튼
- PC: 방향키/WASD 이동, SPACE 폭탄, P/ESC 일시정지

## 모드
- 일반 모드: 하트 3개, 폭탄 3개
- 오락실 모드: 목숨 3 (한 번 맞으면 1대 격추), 목숨마다 폭탄 2개, 이어하기 3회(10초 카운트다운, 점수 유지)

---

## 온라인 랭킹 연결 (Supabase, 무료) — 처음 한 번만

### 1) 가입하고 프로젝트 만들기
1. https://supabase.com 접속 → **Start your project** → GitHub 계정으로 로그인
2. **New project** → 이름 `sky-strikers` / 비밀번호 아무거나(따로 적어 두기) / Region은 `Northeast Asia (Seoul)` → **Create new project**
3. 1~2분 기다리면 준비 완료

### 2) 점수 표 만들기
1. 왼쪽 메뉴 **SQL Editor** → **New query**
2. 아래 내용을 통째로 붙여 넣고 **Run** 클릭 ("Success" 나오면 끝)

```sql
create table scores (
  id bigint generated always as identity primary key,
  nickname text not null check (char_length(nickname) between 1 and 12),
  score integer not null check (score >= 0 and score < 100000000),
  mode text not null check (mode in ('normal', 'arcade')),
  plane text,
  continues integer not null default 0,
  created_at timestamptz not null default now()
);

alter table scores enable row level security;

create policy "누구나 랭킹 보기" on scores for select using (true);
create policy "누구나 점수 등록" on scores for insert with check (true);
```

### 3) 키 2개 복사해서 config.js에 넣기
1. 왼쪽 아래 톱니바퀴 **Project Settings** → **API** (또는 **Data API / API Keys**)
2. **Project URL** 복사 → `config.js`의 `supabaseUrl: ''` 따옴표 안에 붙여 넣기
3. **anon public** 키 복사 → `supabaseKey: ''` 따옴표 안에 붙여 넣기
   - `service_role` 키는 절대 넣지 마세요 (관리자용 비밀 키)
4. 수정한 `config.js`를 GitHub 저장소에 다시 올리기 (Add file → Upload files → Commit changes)

### 확인
- 게임 메뉴 → **랭킹** 화면 위에 "온라인 랭킹 · 닉네임별 최고 점수"가 보이면 연결 성공
- "온라인 랭킹 미연결"이면 config.js 키가 비어 있는 것, "온라인 연결 실패"면 주소·키 오타 확인

### 참고
- 친구끼리 즐기는 용도의 간단한 구조라서, 마음먹으면 가짜 점수를 넣을 수 있습니다.
- 이상한 기록은 Supabase **Table Editor → scores**에서 줄을 골라 삭제하면 됩니다.

---

## GitHub Pages 배포
1. github.com → ＋ → New repository → 이름 `sky-strikers-1945` → Create repository
2. "uploading an existing file" → 파일 4개(index.html, style.css, config.js, game.js) 끌어다 놓기 → Commit changes
3. Settings → Pages → Branch를 `main` / `(root)` → Save
4. 1~2분 뒤 `https://<아이디>.github.io/sky-strikers-1945/` 접속

## 진동
- 안드로이드 크롬·삼성 인터넷에서 동작 (폭탄, 폭격기 격파, 피격 시)
- iPhone(Safari)은 웹 진동을 지원하지 않아 메뉴에 "진동 미지원"으로 표시됩니다.
