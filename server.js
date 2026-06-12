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

export function parseWatchConfig(env = process.env) {
  const label = (env.STREAM_LABEL ?? "공식 중계").trim().slice(0, 80);
  const officialWatchUrl = parseOptionalHttpUrl(
    env.OFFICIAL_WATCH_URL,
    "OFFICIAL_WATCH_URL",
  );
  const officialWatchLabel = (
    env.OFFICIAL_WATCH_LABEL ?? "치지직에서 보기"
  )
    .trim()
    .slice(0, 40);
  const embedUrl = parseOptionalHttpUrl(env.OFFICIAL_EMBED_URL, "OFFICIAL_EMBED_URL");

  return {
    label,
    officialWatchUrl,
    officialWatchLabel,
    embedUrl,
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

export function normalizeRoomId(value) {
  const roomId = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{4,32}$/.test(roomId) ? roomId : null;
}

export function normalizeNickname(value) {
  const nickname = String(value ?? "").trim().replace(/\s+/g, " ");
  return nickname.length >= 1 && nickname.length <= 20 ? nickname : null;
}

function publicRoomState(room) {
  return {
    hostId: room.hostId,
    users: [...room.users].map(([id, user]) => ({
      id,
      nickname: user.nickname,
      ready: user.ready,
      isHost: id === room.hostId,
    })),
  };
}

function createRoom() {
  return {
    hostId: null,
    users: new Map(),
  };
}

const watchConfig = parseWatchConfig();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16_384,
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_request, response) => {
  response.json(watchConfig);
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
    room.users.set(socket.id, { nickname, ready: false });
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

  socket.on("watch-ready-state", (payload, acknowledge = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    const user = room?.users.get(socket.id);

    if (!room || !user) {
      acknowledge({ ok: false });
      return;
    }

    user.ready = Boolean(payload?.ready);
    acknowledge({ ok: true });
    io.to(roomId).emit("room-state", publicRoomState(room));
    socket.to(roomId).emit("system-message", {
      id: crypto.randomUUID(),
      text: `${user.nickname}님이 ${user.ready ? "시청 준비를 완료했습니다" : "준비를 취소했습니다"}.`,
      createdAt: Date.now(),
    });
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
    room.hostId = room.users.keys().next().value;
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
    console.log(
      watchConfig.officialWatchUrl
        ? `Official viewing page: ${watchConfig.officialWatchUrl}`
        : "No official watch URL configured. Set OFFICIAL_WATCH_URL in .env.",
    );
  });
}

export { app, server };
