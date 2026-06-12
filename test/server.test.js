import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { io as createClient } from "socket.io-client";

process.env.NODE_ENV = "test";

const {
  normalizeNickname,
  normalizeRoomId,
  parseWatchConfig,
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

test("accepts official watch page configuration", () => {
  assert.deepEqual(
    parseWatchConfig({
      OFFICIAL_WATCH_URL:
        "https://chzzk.naver.com/home/sports/fifa-worldcup-2026",
      OFFICIAL_WATCH_LABEL: "치지직에서 보기",
      STREAM_LABEL: "월드컵",
    }),
    {
      label: "월드컵",
      officialWatchUrl:
        "https://chzzk.naver.com/home/sports/fifa-worldcup-2026",
      officialWatchLabel: "치지직에서 보기",
      embedUrl: null,
    },
  );
});

test("rejects invalid official watch URLs", () => {
  assert.throws(
    () => parseWatchConfig({ OFFICIAL_WATCH_URL: "ftp://example.com/live" }),
    /OFFICIAL_WATCH_URL must use http or https/,
  );
  assert.throws(
    () => parseWatchConfig({ OFFICIAL_EMBED_URL: "not a url" }),
    /OFFICIAL_EMBED_URL must be a valid absolute URL/,
  );
});

test("shares room membership, ready state, and chat between clients", async (context) => {
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
  const firstState = (await initialState)[0];
  assert.equal(firstState.users.length, 1);
  assert.equal(firstState.users[0].ready, false);

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

  const readyState = new Promise((resolve) => {
    host.on("room-state", (state) => {
      const guestUser = state.users.find((user) => user.id === guest.id);
      if (guestUser?.ready) resolve(state);
    });
  });
  const readyResult = await guest.emitWithAck("watch-ready-state", {
    ready: true,
  });
  assert.equal(readyResult.ok, true);
  const readyUsers = (await readyState).users;
  assert.equal(readyUsers.find((user) => user.id === guest.id).ready, true);

  const receivedChat = once(host, "chat-message");
  const longMessage = "가".repeat(250);
  const chatResult = await guest.emitWithAck("chat-message", {
    text: longMessage,
  });
  assert.equal(chatResult.ok, true);
  assert.equal((await receivedChat)[0].text, "가".repeat(200));

  const hostPromotion = new Promise((resolve) => {
    guest.on("room-state", (state) => {
      if (state.hostId === guest.id) resolve(state);
    });
  });
  host.disconnect();
  const promotedState = await hostPromotion;
  assert.equal(promotedState.hostId, guest.id);
  assert.equal(promotedState.users.length, 1);
});
