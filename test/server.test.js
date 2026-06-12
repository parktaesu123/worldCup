import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { io as createClient } from "socket.io-client";

process.env.NODE_ENV = "test";

const {
  normalizeNickname,
  normalizeRoomId,
  parseRtcIceServers,
  parseStreamConfig,
  server,
} = await import("../server.js");

test("normalizes safe room ids", () => {
  assert.equal(normalizeRoomId(" ABCD-1234 "), "abcd-1234");
  assert.equal(normalizeRoomId("../secret"), null);
  assert.equal(normalizeRoomId("abc"), null);
});

test("normalizes nicknames and limits their length", () => {
  assert.equal(normalizeNickname("  붉은   악마  "), "붉은 악마");
  assert.equal(normalizeNickname(""), null);
  assert.equal(normalizeNickname("a".repeat(21)), null);
});

test("requires the configured stream origin to be allowlisted", () => {
  assert.throws(
    () =>
      parseStreamConfig({
        STREAM_TYPE: "hls",
        STREAM_URL: "https://media.example/live.m3u8",
        ALLOWED_STREAM_ORIGINS: "https://other.example",
      }),
    /not in ALLOWED_STREAM_ORIGINS/,
  );
});

test("accepts an allowlisted licensed stream", () => {
  assert.deepEqual(
    parseStreamConfig({
      STREAM_TYPE: "hls",
      STREAM_URL: "https://media.example/live.m3u8",
      ALLOWED_STREAM_ORIGINS: "https://media.example",
      STREAM_LABEL: "결승전",
    }),
    {
      configured: true,
      type: "hls",
      url: "https://media.example/live.m3u8",
      label: "결승전",
      officialWatchUrl: null,
      officialWatchLabel: "공식 중계 보러 가기",
    },
  );
});

test("accepts a separate official viewing page without a stream", () => {
  assert.deepEqual(
    parseStreamConfig({
      OFFICIAL_WATCH_URL:
        "https://chzzk.naver.com/home/sports/fifa-worldcup-2026",
      OFFICIAL_WATCH_LABEL: "치지직에서 보기",
      STREAM_LABEL: "월드컵",
    }),
    {
      configured: false,
      type: null,
      url: null,
      label: "월드컵",
      officialWatchUrl:
        "https://chzzk.naver.com/home/sports/fifa-worldcup-2026",
      officialWatchLabel: "치지직에서 보기",
    },
  );
});

test("validates WebRTC STUN and TURN configuration", () => {
  assert.deepEqual(
    parseRtcIceServers(
      '[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]',
    ),
    [
      { urls: "stun:stun.example.com:3478" },
      {
        urls: "turn:turn.example.com:3478",
        username: "user",
        credential: "secret",
      },
    ],
  );
  assert.throws(
    () => parseRtcIceServers('[{"urls":"https://example.com"}]'),
    /stun, turn, or turns/,
  );
});

test("shares room membership and chat between clients", async (context) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const host = createClient(url, { forceNew: true, transports: ["websocket"] });
  const guest = createClient(url, { forceNew: true, transports: ["websocket"] });

  context.after(async () => {
    host.disconnect();
    guest.disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  await Promise.all([once(host, "connect"), once(guest, "connect")]);

  const initialState = once(host, "room-state");
  const hostJoin = await host.emitWithAck("join-room", {
    roomId: "final-2026",
    nickname: "Host",
  });
  assert.equal(hostJoin.ok, true);
  assert.equal((await initialState)[0].users.length, 1);

  const twoUserState = new Promise((resolve) => {
    host.on("room-state", (state) => {
      if (state.users.length === 2) resolve(state);
    });
  });
  const guestJoin = await guest.emitWithAck("join-room", {
    roomId: "final-2026",
    nickname: "Guest",
  });
  assert.equal(guestJoin.ok, true);
  assert.equal((await twoUserState).users.length, 2);

  const receivedChat = once(host, "chat-message");
  const longMessage = "가".repeat(250);
  const chatResult = await guest.emitWithAck("chat-message", {
    text: longMessage,
  });
  assert.equal(chatResult.ok, true);
  assert.equal((await receivedChat)[0].text, "가".repeat(200));

  const broadcastStarted = once(guest, "broadcast-started");
  const broadcastResult = await host.emitWithAck("broadcast-start", null);
  assert.equal(broadcastResult.ok, true);
  await broadcastStarted;

  const viewerReady = once(host, "viewer-ready");
  guest.emit("viewer-ready");
  assert.equal((await viewerReady)[0].viewerId, guest.id);

  const offerReceived = once(guest, "webrtc-offer");
  host.emit("webrtc-offer", {
    targetId: guest.id,
    description: { type: "offer", sdp: "test-offer" },
  });
  assert.deepEqual((await offerReceived)[0].description, {
    type: "offer",
    sdp: "test-offer",
  });
});
