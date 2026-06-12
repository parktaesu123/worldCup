# 같이보기 World Cup Watch Party

공식 중계를 친구들과 같은 시점에 보며 채팅하는 작은 워치파티입니다.

이 앱은 경기 영상을 서버로 받아 재송출하지 않습니다. 각 브라우저가 허가받은
공식 중계 CDN에 직접 연결하고, 앱 서버는 방 참여자·채팅·재생 위치만
Socket.IO로 동기화합니다.

방장은 브라우저의 화면 공유 기능을 사용해 공유 권한이 있는 화면이나 자체
영상을 WebRTC로 참여자에게 직접 전송할 수도 있습니다. DRM으로 보호된 영상은
브라우저가 캡처를 차단하거나 검은 화면으로 표시할 수 있습니다.

## 실행

```bash
npm install
cp .env.example .env
npm run dev
```

`http://localhost:3000`에서 새 방을 만들고 생성된 `/r/{방코드}` 링크를
공유합니다.

중계 소스 없이 UI와 방 기능만 확인하려면 `.env`를 만들지 않고 실행해도
됩니다.

## 중계 연결

`.env`에는 직접 사용 권한이 있는 공식 소스만 설정하세요.

```dotenv
OFFICIAL_WATCH_URL=https://chzzk.naver.com/home/sports/fifa-worldcup-2026
OFFICIAL_WATCH_LABEL=치지직에서 무료 중계 보기

STREAM_TYPE=hls
STREAM_URL=https://stream.official-broadcaster.example/live/match.m3u8
ALLOWED_STREAM_ORIGINS=https://stream.official-broadcaster.example
STREAM_LABEL=공식 월드컵 중계
```

- `OFFICIAL_WATCH_URL`: 사용자가 공식 중계 페이지를 새 창으로 열 수 있게
  합니다. 스트림 주소를 추출하거나 재송출하지 않는 권장 방식입니다.
- `hls`: `.m3u8` 적응형 스트림. 방장이 재생·일시정지·탐색을 제어합니다.
- `video`: 허가받은 MP4/WebM 주소. HLS와 같은 방식으로 동기화합니다.
- `embed`: 공식 방송사의 iframe 주소. 브라우저 보안상 재생 제어는
  동기화할 수 없으며 방과 채팅만 공유됩니다.
- `ALLOWED_STREAM_ORIGINS`: 오용 방지를 위해 `STREAM_URL`의 정확한 origin을
  반드시 등록해야 합니다.

공식 방송사가 iframe 삽입이나 CORS 접근을 막아 둔 경우 이 앱에서 우회할 수
없습니다. 그때는 각 사용자가 공식 사이트에서 중계를 열고 이 앱은 채팅방으로
사용해야 합니다.

2026년 6월 기준 국내 온라인 전 경기 공식 중계는 네이버 치지직에서
제공됩니다. MBC는 이번 대회 중계사가 아니며, 무료로 볼 수 있는 방송도 외부
사이트에서 원본 스트림을 추출해 재생할 권한까지 제공하는 것은 아닙니다.

## 끊김을 줄이는 배포 구조

1. 앱 서버는 영상 프록시가 아니라 Socket.IO 상태 서버로만 운영합니다.
2. 영상은 공식 방송사/CDN의 HLS 적응형 비트레이트를 그대로 사용합니다.
3. HTTPS와 WebSocket을 지원하는 호스팅에 배포합니다.
4. 여러 서버 인스턴스를 쓸 때는 Socket.IO Redis adapter와 공용 room
   storage를 추가합니다. 현재 방 상태는 단일 프로세스 메모리에 저장됩니다.
5. 서로 다른 통신사나 회사 네트워크에서도 화면 공유 연결을 안정적으로
   성립시키려면 운영 환경에 TURN 서버를 추가해야 합니다.

```dotenv
RTC_ICE_SERVERS_JSON=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"watchparty","credential":"change-me"}]
```

채팅 메시지는 클라이언트와 서버 모두 최대 200자로 제한됩니다.

`끊김 없음`을 앱이 완전히 보장할 수는 없습니다. 사용자 회선, 공식 CDN,
브라우저 자동재생 정책의 영향을 받지만, 영상 트래픽을 앱 서버가 떠안지 않는
구조가 가장 안정적입니다.

## 검사

```bash
npm test
```

# worldCup
