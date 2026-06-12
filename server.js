import "dotenv/config";

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const rooms = new Map();

export function parseStreamConfig(env = process.env) {
  const type = (env.STREAM_TYPE ?? "").trim().toLowerCase();
  const url = (env.STREAM_URL ?? "").trim();
  const label = (env.STREAM_LABEL ?? "공식 중계").trim().slice(0, 80);
  const officialWatchUrl = parseOptionalHttpUrl(
    env.OFFICIAL_WATCH_URL,
    "OFFICIAL_WATCH_URL",
  );
  const officialWatchLabel = (
    env.OFFICIAL_WATCH_LABEL ?? "공식 중계 보러 가기"
  )
    .trim()
    .slice(0, 40);
  const allowedOrigins = new Set(
    (env.ALLOWED_STREAM_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  if (!url) {
    return {
      configured: false,
      type: null,
      url: null,
      label,
      officialWatchUrl,
      officialWatchLabel,
    };
  }

  if (!["hls", "video", "embed"].includes(type)) {
    throw new Error("STREAM_TYPE must be hls, video, or embed.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("STREAM_URL must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("STREAM_URL must use http or https.");
  }

  if (!allowedOrigins.has(parsedUrl.origin)) {
    throw new Error(
      `STREAM_URL origin ${parsedUrl.origin} is not in ALLOWED_STREAM_ORIGINS.`,
    );
  }

  return {
    configured: true,
    type,
    url,
    label,
    officialWatchUrl,
    officialWatchLabel,
  };
}

function parseOptionalHttpUrl(value, name) {
  const url = String(value ?? "").trim();
  if (!url) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }

  return parsedUrl.toString();
}

export function parseRtcIceServers(value) {
  if (!value) {
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
  }

  let servers;
  try {
    servers = JSON.parse(value);
  } catch {
    throw new Error("RTC_ICE_SERVERS_JSON must be valid JSON.");
  }

  if (!Array.isArray(servers) || servers.length === 0 || servers.length > 10) {
    throw new Error("RTC_ICE_SERVERS_JSON must be a non-empty array.");
  }

  return servers.map((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    if (
      urls.some(
        (url) =>
          typeof url !== "string" || !/^(stun|turn|turns):/i.test(url),
      )
    ) {
      throw new Error("RTC ICE server URLs must use stun, turn, or turns.");
    }

    return {
      urls: Array.isArray(server.urls) ? urls : urls[0],
      ...(server.username ? { username: String(server.username) } : {}),
      ...(server.credential ? { credential: String(server.credential) } : {}),
    };
  });
}

export function normalizeRoomId(value) {
  const roomId = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{4,32}$/.test(roomId) ? roomId : null;
}

export function normalizeNickname(value) {
  const nickname = String(value ?? "").trim().replace(/\s+/g, " ");
  return nickname.length >= 1 && nickname.length <= 20 ? nickname : null;
}

function currentMediaState(media, now = Date.now()) {
  const elapsed = media.paused ? 0 : Math.max(0, now - media.updatedAt) / 1000;
  return {
    paused: media.paused,
    currentTime: Math.max(0, media.currentTime + elapsed * media.playbackRate),
    playbackRate: media.playbackRate,
    updatedAt: now,
  };
}

function publicRoomState(room) {
  return {
    hostId: room.hostId,
    broadcasting: room.broadcasting,
    media: currentMediaState(room.media),
    users: [...room.users].map(([id, user]) => ({
      id,
      nickname: user.nickname,
      isHost: id === room.hostId,
    })),
  };
}

function createRoom() {
  return {
    hostId: null,
    broadcasting: false,
    media: {
      paused: true,
      currentTime: 0,
      playbackRate: 1,
      updatedAt: Date.now(),
    },
    users: new Map(),
  };
}

const streamConfig = parseStreamConfig();
const rtcIceServers = parseRtcIceServers(process.env.RTC_ICE_SERVERS_JSON);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16_384,
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/vendor/hls.min.js",
  express.static(path.join(__dirname, "node_modules/hls.js/dist/hls.min.js")),
);

app.get("/api/config", (_request, response) => {
  response.json({
    ...streamConfig,
    rtcIceServers,
    syncAvailable:
      streamConfig.configured && ["hls", "video"].includes(streamConfig.type),
  });
});

app.post("/api/rooms", (_request, response) => {
  response.status(201).json({ roomId: crypto.randomBytes(4).toString("hex") });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size });
});

app.get("/r/:roomId", (_request, response) => {
  response.sendFile(path.join(__dirname, "public/index.html"));
});

io.on("connection", (socket) => {
  socket.on("join-room", (payload, acknowledge = () => {}) => {
    const roomId = normalizeRoomId(payload?.roomId);
    const nickname = normalizeNickname(payload?.nickname);

    if (!roomId || !nickname) {
      acknowledge({ ok: false, message: "방 코드 또는 닉네임이 올바르지 않습니다." });
      return;
    }

    leaveCurrentRoom(socket);

    const room = rooms.get(roomId) ?? createRoom();
    rooms.set(roomId, room);
    room.users.set(socket.id, { nickname });
    room.hostId ??= socket.id;
    socket.data.roomId = roomId;
    socket.join(roomId);

    acknowledge({ ok: true, socketId: socket.id });
    io.to(roomId).emit("room-state", publicRoomState(room));
    io.to(roomId).emit("system-message", {
      id: crypto.randomUUID(),
      text: `${nickname}님이 입장했습니다.`,
      createdAt: Date.now(),
    });
  });

  socket.on("media-state", (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);

    if (!room || room.hostId !== socket.id) return;

    const currentTime = Number(payload?.currentTime);
    const playbackRate = Number(payload?.playbackRate);
    if (
      !Number.isFinite(currentTime) ||
      currentTime < 0 ||
      currentTime > 86_400 ||
      !Number.isFinite(playbackRate) ||
      playbackRate < 0.25 ||
      playbackRate > 4
    ) {
      return;
    }

    room.media = {
      paused: Boolean(payload?.paused),
      currentTime,
      playbackRate,
      updatedAt: Date.now(),
    };
    socket.to(roomId).emit("media-state", currentMediaState(room.media));
  });

  socket.on("broadcast-start", (_payload, acknowledge = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);

    if (!room || room.hostId !== socket.id) {
      acknowledge({ ok: false });
      return;
    }

    room.broadcasting = true;
    acknowledge({ ok: true });
    socket.to(roomId).emit("broadcast-started");
    io.to(roomId).emit("room-state", publicRoomState(room));
  });

  socket.on("broadcast-stop", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    room.broadcasting = false;
    socket.to(roomId).emit("broadcast-stopped");
    io.to(roomId).emit("room-state", publicRoomState(room));
  });

  socket.on("viewer-ready", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.broadcasting || room.hostId === socket.id) return;

    io.to(room.hostId).emit("viewer-ready", { viewerId: socket.id });
  });

  socket.on("webrtc-offer", (payload) => {
    relayWebRtcSignal(socket, payload, "webrtc-offer", true);
  });

  socket.on("webrtc-answer", (payload) => {
    relayWebRtcSignal(socket, payload, "webrtc-answer");
  });

  socket.on("webrtc-ice-candidate", (payload) => {
    relayWebRtcSignal(socket, payload, "webrtc-ice-candidate");
  });

  socket.on("chat-message", (payload, acknowledge = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    const user = room?.users.get(socket.id);
    const text = String(payload?.text ?? "").trim().slice(0, 200);

    if (!room || !user || !text) {
      acknowledge({ ok: false });
      return;
    }

    io.to(roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      nickname: user.nickname,
      text,
      createdAt: Date.now(),
    });
    acknowledge({ ok: true });
  });

  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

function relayWebRtcSignal(socket, payload, eventName, hostOnly = false) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  const targetId = String(payload?.targetId ?? "");

  if (
    !room ||
    !room.broadcasting ||
    !room.users.has(targetId) ||
    targetId === socket.id ||
    (hostOnly && room.hostId !== socket.id)
  ) {
    return;
  }

  io.to(targetId).emit(eventName, {
    senderId: socket.id,
    description: payload?.description,
    candidate: payload?.candidate,
  });
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room) return;

  const nickname = room.users.get(socket.id)?.nickname;
  room.users.delete(socket.id);
  socket.leave(roomId);
  delete socket.data.roomId;

  if (room.users.size === 0) {
    rooms.delete(roomId);
    return;
  }

  if (room.hostId === socket.id) {
    room.broadcasting = false;
    socket.to(roomId).emit("broadcast-stopped");
    room.hostId = room.users.keys().next().value;
  } else if (room.broadcasting) {
    io.to(room.hostId).emit("viewer-left", { viewerId: socket.id });
  }

  io.to(roomId).emit("room-state", publicRoomState(room));
  if (nickname) {
    io.to(roomId).emit("system-message", {
      id: crypto.randomUUID(),
      text: `${nickname}님이 나갔습니다.`,
      createdAt: Date.now(),
    });
  }
}

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`World Cup watch party: http://localhost:${port}`);
    if (!streamConfig.configured) {
      console.log(
        streamConfig.officialWatchUrl
          ? `Official viewing page: ${streamConfig.officialWatchUrl}`
          : "No stream configured. Copy .env.example to .env and add a licensed source.",
      );
    }
  });
}

export { app, server };
