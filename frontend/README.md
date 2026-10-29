# Love Toronto local web app

React 19 + TypeScript + Vite 기반의 한국어/영어 로컬 보관본입니다.
MUI는 사용하지 않습니다. 원본 HTML의 헤더·본문·푸터·문구·인라인 스타일을 유지하고,
원본 CSS를 공유하여 사이트의 디자인을 재현합니다.

## 실행

이 폴더에서:

```powershell
npm install
npm run dev
```

기본 주소는 `http://127.0.0.1:5173`입니다. HTTP 서버가 필요하며
`file://`로 직접 여는 방식은 지원하지 않습니다.

```powershell
npm run build
npm run preview
```

배포 시 `dist` 전체를 정적 HTTP 서버에 업로드하세요. 해시 라우팅을 사용하므로
페이지별 서버 rewrite 설정은 필요하지 않습니다.

## Docker

Docker Desktop 또는 Docker Engine과 Compose가 필요합니다. 상위 폴더
(`compose.yaml`이 있는 폴더)에서 실행하세요:

```powershell
docker compose up --build -d
```

`http://localhost:85`에서 열립니다. 호스트의 **85번 포트**를 컨테이너 내부의
비특권 Nginx **8080번 포트**에 연결합니다.

```powershell
docker compose ps
docker compose logs -f web
docker compose down
```

Node 24 빌드 단계에서 의존성 설치·콘텐츠 테스트·타입 검사·Vite 빌드를 실행합니다.
실행 이미지는 비특권 Nginx로 정적 결과물만 제공하며, 읽기 전용 파일시스템과
임시 `/tmp`를 사용합니다. 별도 WordPress·Node 서버·데이터베이스는 필요하지 않습니다.
헬스체크는 컨테이너의 8080 포트에서 홈페이지를 요청합니다.
없는 이미지·PDF·폰트 경로는 HTML로 대체하지 않고 404를 반환합니다.

## 원본 보존과 동작

- 보관된 HTML 574개 전체와 PDF 77개, 이미지·폰트 등 로컬 자산
- 원본 한국어/영어 전환 링크와 언어별 메뉴
- 원본 body HTML, 페이지 클래스, 인라인 스타일과 공유 CSS
- 원본 슬라이더 JSON에서 추출한 좌우 버튼 디자인, 9초 자동 전환, 마우스 오버 시 정지
- 배경의 600ms 페이드와 300ms 지연 후 1500ms 동안 위에서 등장하는 텍스트 효과
- 원본 easing 곡선을 샘플링한 네이티브 애니메이션, 법률 책자 CTA의 로컬 연결
- 키보드 버튼 조작, 비활성 슬라이드 포커스 차단, 동작 줄이기 설정 시 자동 전환·효과 중지
- 애니메이션은 hero와 FAQ 클릭 시 펼침·접힘에만 적용하며, 다른 영역의 CSS 애니메이션·전환·부드러운 스크롤은 비활성화
- FAQ는 원본 Bootstrap의 350ms 높이 전환과 같은 그룹 내 하나만 펼치는 동작을 복원하며, 동작 줄이기 설정 시 즉시 전환
- FAQ/탭, 모바일 메뉴, 갤러리·그리드의 로컬 표시
- 모바일 메뉴는 원본 Slimmenu HTML·CSS의 3줄/X 아이콘, 검은색 목록, 하위 메뉴를 재사용하며 991px 이하에서 표시
- 모바일 드롭다운은 아이콘 폭이 아닌 헤더 컨테이너를 기준으로 오른쪽 정렬하여 화면 밖으로 잘리지 않도록 배치
- iPhone 16 등 모바일에서는 히어로 사진이 전체 높이를 채우고, 문구·CTA·좌우 버튼과 상단 메뉴·문의 버튼이 겹치지 않도록 배치
- 원본 문서 아이콘을 유지한 PDF 기본 이미지 영역과 카드 하단 버튼 정렬
- 원본 YouTube URL·제목·16:9 비율 유지 및 referrer policy 보존

보관 HTML의 실행 스크립트와 이벤트 핸들러는 제거하고 DOMPurify로 정제합니다.
WordPress 및 Slider Revolution의 JavaScript 자체는 실행하지 않으며,
필요한 상호작용만 React에서 복원합니다. 원본 슬라이더에 별도 레이어 설정이 없는
슬라이드는 원본의 공통 텍스트·배경 애니메이션 설정을 상속합니다.

영문 페이지는 실제 보관된 원본 영문 내용을 사용하며 자동 번역하지 않습니다.
원본 서버에서 실제로 404였던 자료는 복구되지 않았다는 안내를 유지합니다.
문의·결제 양식은 원본 표시를 보존하되 로컬에서 전송되지 않도록 차단합니다.
YouTube 재생, 외부 사이트, 로그인·결제 등 서버 기능에는 인터넷과 해당 외부 서비스가
필요합니다. 서비스 워커나 외부 동영상의 오프라인 복사본은 제공하지 않습니다.

## 콘텐츠 구성

- `src/App.tsx`: 원본 페이지 로딩, 정제, 스타일 주입과 로컬 라우팅
- `src/HeroControls.tsx`: 원본 설정 기반 슬라이더 전환·애니메이션·접근성
- `src/site-runtime.css`: 기존 플러그인 없이 필요한 공통 레이아웃 보완
- `scripts/prepare-content.mjs`: 상위 폴더의 보관 HTML·manifest에서 콘텐츠 생성
- `scripts/layout.mjs`: 원본 CSS의 자산 경로 변경과 해시 기반 중복 제거
- `scripts/sliders.mjs`: 실행 없이 원본 슬라이더 JSON 설정 추출
- `public/content`: 페이지별 HTML JSON, 공유 CSS, 문구 검증 결과
- `public/archive`: 원본 이미지·PDF·폰트 등 로컬 복사본

이 폴더는 생성된 콘텐츠만으로 독립적으로 실행·빌드됩니다.
`src/generated`, `public/content`, `public/archive`는 필수 배포 입력이므로
저장소·복사본·Docker 빌드 컨텍스트에 함께 포함해야 합니다.

원본 보관 폴더가 따로 있을 때만 다음과 같이 다시 생성할 수 있습니다:

```powershell
$env:ARCHIVE_ROOT = "C:\path\to\downloaded-archive"
npm run content
```

이 경로에는 `offline-manifest.json`과 원본 HTML·자산이 있어야 합니다.
`dev`와 `build`는 상위 폴더의 원본을 읽거나 콘텐츠를 다시 다운로드하지 않습니다.

## 검증

```powershell
npm test
npm run build
```

전체 페이지 포함 여부, 내부 링크·자산, 언어 연결, PDF 크기·형식,
실행 코드 제거, 공유 스타일·슬라이더 설정 및 저장된 원본 문구·레이블 해시와의 일치를 검사합니다.
페이지별 근거는 `public/content/text-parity.json`입니다. 원본 파일을 제거한 독립형 모드에서는
원본 바이트 재비교 테스트를 명시적으로 건너뜁니다.
`ARCHIVE_ROOT`를 지정하면 원본 HTML·PDF 바이트와의 비교도 실행합니다.
현재 온라인 사이트와의 실시간 비교는 아닙니다.

개발 서버가 실행 중인 상태에서:

```powershell
npm run test:widgets
npm run test:browser
```

브라우저 테스트에는 Playwright Chromium이 필요합니다.
`test:widgets`는 데스크톱·모바일의 슬라이더 버튼, 반복·자동 전환, 애니메이션 시간과
정리, 정지 동작, CTA, 영상 비율과 PDF 기본 이미지 영역을 확인합니다.
iPhone 16(393×852)의 한국어·영어 히어로 전체 슬라이드와 모바일 메뉴의 펼침·접힘,
하위 메뉴, Escape·외부 클릭·페이지 이동 후 닫힘 및 320~1440px 반응형 배치도 검사합니다.
`test:browser`는 574개 페이지의 데스크톱·모바일 1,148개 조합을 렌더링하여
원본 문구 일치, 가로 넘침, JavaScript 오류를 검사합니다.
결과와 대표 화면은 `test-results`에 저장됩니다.
테스트에서는 외부 네트워크를 차단하므로 실제 YouTube 재생 성공까지 보증하지는 않습니다.
