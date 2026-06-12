const socket = io();

const elements = {
  homeView: document.querySelector("#homeView"),
  roomView: document.querySelector("#roomView"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinCodeForm: document.querySelector("#joinCodeForm"),
  roomCode: document.querySelector("#roomCode"),
  nicknameDialog: document.querySelector("#nicknameDialog"),
  nicknameForm: document.querySelector("#nicknameForm"),
  nicknameInput: document.querySelector("#nicknameInput"),
  joinError: document.querySelector("#joinError"),
  streamLabel: document.querySelector("#streamLabel"),
  viewerCount: document.querySelector("#viewerCount"),
  peopleCount: document.querySelector("#peopleCount"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  roomIdLabel: document.querySelector("#roomIdLabel"),
  hostLabel: document.querySelector("#hostLabel"),
  streamModeLabel: document.querySelector("#streamModeLabel"),
  videoPlayer: document.querySelector("#videoPlayer"),
  embedPlayer: document.querySelector("#embedPlayer"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  officialWatchLink: document.querySelector("#officialWatchLink"),
  playerLoading: document.querySelector("#playerLoading"),
  playerShell: document.querySelector("#playerShell"),
  syncStatus: document.querySelector("#syncStatus"),
  broadcastButton: document.querySelector("#broadcastButton"),
  muteButton: document.querySelector("#muteButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  messageList: document.querySelector("#messageList"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  peopleList: document.querySelector("#peopleList"),
  peopleTab: document.querySelector("#peopleTab"),
  chatTab: document.querySelector("#chatTab"),
  sideTabs: document.querySelectorAll(".side-tabs button"),
  toast: document.querySelector("#toast"),
};

const roomId = getRoomId();
let ownSocketId = null;
let isHost = false;
let applyingRemoteState = false;
let config = null;
let hls = null;
let toastTimer = null;
let roomBroadcasting = false;
let localBroadcastStream = null;
let remoteBroadcastStream = null;
let remotePeerConnection = null;
let viewerRequested = false;
const hostPeerConnections = new Map();
const pendingIceCandidates = new Map();
let rtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

if (roomId) {
  elements.homeView.classList.add("hidden");
  elements.roomView.classList.remove("hidden");
  elements.roomIdLabel.textContent = roomId;
  elements.nicknameInput.value = localStorage.getItem("watch-party-nickname") ?? "";
  elements.nicknameDialog.showModal();
  loadPlayer();
}

elements.createRoomButton.addEventListener("click", async () => {
  elements.createRoomButton.disabled = true;
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    const data = await response.json();
    window.location.href = `/r/${data.roomId}`;
  } catch {
    showToast("방을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
    elements.createRoomButton.disabled = false;
  }
});

elements.joinCodeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = elements.roomCode.value.trim().toLowerCase();
  if (/^[a-z0-9-]{4,32}$/.test(code)) {
    window.location.href = `/r/${code}`;
  }
});

elements.nicknameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nickname = elements.nicknameInput.value.trim();
  elements.joinError.textContent = "";

  socket.emit("join-room", { roomId, nickname }, (result) => {
    if (!result?.ok) {
      elements.joinError.textContent =
        result?.message ?? "방에 입장하지 못했습니다.";
      return;
    }

    ownSocketId = result.socketId;
    localStorage.setItem("watch-party-nickname", nickname);
    elements.nicknameDialog.close();
    elements.chatInput.focus();
  });
});

elements.copyLinkButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(window.location.href);
  showToast("초대 링크를 복사했습니다.");
});

elements.broadcastButton.addEventListener("click", async () => {
  if (localBroadcastStream) {
    stopBroadcast();
  } else {
    await startBroadcast();
  }
});

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text) return;

  socket.emit("chat-message", { text }, (result) => {
    if (result?.ok) elements.chatInput.value = "";
  });
});

for (const tabButton of elements.sideTabs) {
  tabButton.addEventListener("click", () => {
    for (const button of elements.sideTabs) button.classList.remove("active");
    tabButton.classList.add("active");
    const showChat = tabButton.dataset.tab === "chat";
    elements.chatTab.classList.toggle("hidden", !showChat);
    elements.peopleTab.classList.toggle("hidden", showChat);
  });
}

elements.muteButton.addEventListener("click", () => {
  if (elements.videoPlayer.srcObject) {
    if (isHost && localBroadcastStream) {
      showToast("내 공유 미리보기는 에코 방지를 위해 음소거됩니다.");
      return;
    }

    elements.videoPlayer.muted = !elements.videoPlayer.muted;
    elements.muteButton.textContent = elements.videoPlayer.muted
      ? "소리 켜기"
      : "음소거";
    elements.videoPlayer.play().catch(() => {
      showToast("재생 버튼을 한 번 더 눌러 주세요.");
    });
    return;
  }

  if (!config || config.type === "embed" || !config.configured) {
    showToast("임베드 플레이어 안에서 소리를 조절해 주세요.");
    return;
  }

  elements.videoPlayer.muted = !elements.videoPlayer.muted;
  elements.muteButton.textContent = elements.videoPlayer.muted
    ? "소리 켜기"
    : "음소거";
});

elements.fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await elements.playerShell.requestFullscreen();
  }
});

socket.on("connect", () => {
  setSyncStatus("서버 연결됨", true);
});

socket.on("disconnect", () => {
  setSyncStatus("연결 재시도 중", false);
});

socket.on("room-state", (state) => {
  const wasHost = isHost;
  isHost = state.hostId === ownSocketId;
  roomBroadcasting = state.broadcasting;
  elements.viewerCount.textContent = state.users.length;
  elements.peopleCount.textContent = state.users.length;
  renderPeople(state.users);
  elements.broadcastButton.classList.toggle("hidden", !isHost);

  const host = state.users.find((user) => user.isHost);
  elements.hostLabel.textContent = isHost
    ? "내가 방장"
    : `${host?.nickname ?? "알 수 없음"}님`;

  if (wasHost && !isHost && localBroadcastStream) {
    stopBroadcast(false);
  }

  if (roomBroadcasting) {
    elements.streamModeLabel.textContent = "화면 공유";
    if (isHost && localBroadcastStream) {
      setSyncStatus("내 화면 송출 중", true);
    } else if (!isHost && !remoteBroadcastStream && !viewerRequested) {
      requestBroadcast();
    }
    return;
  }

  if (remotePeerConnection || remoteBroadcastStream) {
    stopRemoteBroadcast();
  }

  if (config?.syncAvailable) {
    elements.videoPlayer.controls = isHost;
    setSyncStatus(isHost ? "내 재생 화면을 공유 중" : "방장 화면과 동기화됨", true);
    if (!wasHost || !isHost) applyMediaState(state.media);
  } else if (config?.officialWatchUrl) {
    setSyncStatus("채팅 연결됨", true);
  }
});

socket.on("media-state", (mediaState) => {
  if (!isHost) applyMediaState(mediaState);
});

socket.on("broadcast-started", () => {
  roomBroadcasting = true;
  requestBroadcast();
});

socket.on("broadcast-stopped", () => {
  roomBroadcasting = false;
  stopRemoteBroadcast();
});

socket.on("viewer-ready", async ({ viewerId }) => {
  if (!isHost || !localBroadcastStream) return;
  await createOfferForViewer(viewerId);
});

socket.on("viewer-left", ({ viewerId }) => {
  closeHostPeer(viewerId);
});

socket.on("webrtc-offer", async ({ senderId, description }) => {
  if (isHost || !roomBroadcasting) return;
  await acceptBroadcastOffer(senderId, description);
});

socket.on("webrtc-answer", async ({ senderId, description }) => {
  const peer = hostPeerConnections.get(senderId);
  if (!peer || !description) return;

  await peer.setRemoteDescription(description);
  await flushPendingIce(senderId, peer);
});

socket.on("webrtc-ice-candidate", async ({ senderId, candidate }) => {
  if (!candidate) return;

  const peer = isHost
    ? hostPeerConnections.get(senderId)
    : remotePeerConnection;
  if (!peer || !peer.remoteDescription) {
    const queue = pendingIceCandidates.get(senderId) ?? [];
    queue.push(candidate);
    pendingIceCandidates.set(senderId, queue);
    return;
  }

  await peer.addIceCandidate(candidate).catch(() => {});
});

socket.on("chat-message", (message) => appendMessage(message, false));
socket.on("system-message", (message) => appendMessage(message, true));

window.addEventListener("beforeunload", () => {
  if (localBroadcastStream) stopBroadcast(false);
});

async function loadPlayer() {
  try {
    const response = await fetch("/api/config");
    config = await response.json();
    if (Array.isArray(config.rtcIceServers)) {
      rtcConfiguration = { iceServers: config.rtcIceServers };
    }
    elements.streamLabel.textContent = config.label;
    if (config.officialWatchUrl) {
      elements.officialWatchLink.href = config.officialWatchUrl;
      elements.officialWatchLink.textContent = config.officialWatchLabel;
      elements.officialWatchLink.classList.remove("hidden");
    }

    if (!config.configured) {
      elements.emptyPlayer.classList.remove("hidden");
      elements.streamModeLabel.textContent = config.officialWatchUrl
        ? "공식 사이트"
        : "설정 필요";
      setSyncStatus(
        config.officialWatchUrl ? "채팅 연결됨" : "중계 소스 미설정",
        Boolean(config.officialWatchUrl),
      );
      return;
    }

    if (config.type === "embed") {
      elements.embedPlayer.src = config.url;
      elements.embedPlayer.classList.remove("hidden");
      elements.streamModeLabel.textContent = "공식 임베드";
      elements.muteButton.textContent = "플레이어에서 조절";
      setSyncStatus("채팅만 동기화됨", true);
      return;
    }

    elements.videoPlayer.classList.remove("hidden");
    elements.playerLoading.classList.remove("hidden");
    elements.streamModeLabel.textContent =
      config.type === "hls" ? "적응형 HLS" : "직접 영상";
    attachVideoEvents();

    if (config.type === "hls" && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        maxBufferLength: 30,
      });
      hls.loadSource(config.url);
      hls.attachMedia(elements.videoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, hidePlayerLoading);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) handleFatalHlsError(data);
      });
    } else {
      elements.videoPlayer.src = config.url;
      elements.videoPlayer.addEventListener("loadedmetadata", hidePlayerLoading, {
        once: true,
      });
    }
  } catch {
    elements.emptyPlayer.classList.remove("hidden");
    elements.streamModeLabel.textContent = "연결 실패";
    setSyncStatus("중계 설정을 불러오지 못함", false);
  }
}

function attachVideoEvents() {
  const broadcast = () => {
    if (!isHost || applyingRemoteState) return;
    socket.emit("media-state", {
      paused: elements.videoPlayer.paused,
      currentTime: elements.videoPlayer.currentTime,
      playbackRate: elements.videoPlayer.playbackRate,
    });
  };

  for (const eventName of ["play", "pause", "seeked", "ratechange"]) {
    elements.videoPlayer.addEventListener(eventName, broadcast);
  }
  window.setInterval(broadcast, 5_000);
}

async function startBroadcast() {
  if (!isHost) {
    showToast("방장만 화면을 공유할 수 있습니다.");
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("이 브라우저는 화면 공유를 지원하지 않습니다.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
      },
      audio: true,
    });

    localBroadcastStream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (localBroadcastStream === stream) stopBroadcast();
        },
        { once: true },
      );
    }

    showBroadcastStream(stream, true);
    socket.emit("broadcast-start", null, (result) => {
      if (!result?.ok) {
        stopBroadcast(false);
        showToast("화면 공유를 시작하지 못했습니다.");
      }
    });
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      showToast("화면 공유를 시작하지 못했습니다.");
    }
  }
}

function stopBroadcast(notifyServer = true) {
  const stream = localBroadcastStream;
  localBroadcastStream = null;

  for (const track of stream?.getTracks() ?? []) track.stop();
  for (const viewerId of hostPeerConnections.keys()) closeHostPeer(viewerId);

  roomBroadcasting = false;
  elements.broadcastButton.textContent = "화면 공유";
  elements.broadcastButton.classList.remove("broadcasting");
  if (notifyServer) socket.emit("broadcast-stop");
  restoreConfiguredPlayer();
}

function requestBroadcast() {
  if (isHost || viewerRequested || remoteBroadcastStream) return;
  viewerRequested = true;
  elements.streamModeLabel.textContent = "화면 공유";
  setSyncStatus("방장 화면 연결 중", false);
  socket.emit("viewer-ready");
}

async function createOfferForViewer(viewerId) {
  closeHostPeer(viewerId);
  const peer = createPeerConnection(viewerId, false);
  hostPeerConnections.set(viewerId, peer);

  for (const track of localBroadcastStream.getTracks()) {
    peer.addTrack(track, localBroadcastStream);
  }

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  socket.emit("webrtc-offer", {
    targetId: viewerId,
    description: peer.localDescription,
  });
}

async function acceptBroadcastOffer(hostId, description) {
  if (!description) return;

  if (remotePeerConnection) remotePeerConnection.close();
  remotePeerConnection = createPeerConnection(hostId, true);
  viewerRequested = false;

  await remotePeerConnection.setRemoteDescription(description);
  await flushPendingIce(hostId, remotePeerConnection);
  const answer = await remotePeerConnection.createAnswer();
  await remotePeerConnection.setLocalDescription(answer);
  socket.emit("webrtc-answer", {
    targetId: hostId,
    description: remotePeerConnection.localDescription,
  });
}

function createPeerConnection(remoteId, receiveBroadcast) {
  const peer = new RTCPeerConnection(rtcConfiguration);

  peer.addEventListener("icecandidate", ({ candidate }) => {
    if (!candidate) return;
    socket.emit("webrtc-ice-candidate", {
      targetId: remoteId,
      candidate,
    });
  });

  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "connected") {
      setSyncStatus(
        receiveBroadcast ? "방장 화면 시청 중" : "화면 송출 중",
        true,
      );
    }

    if (peer.connectionState === "failed") {
      if (receiveBroadcast && roomBroadcasting) {
        stopRemoteBroadcast();
        window.setTimeout(requestBroadcast, 700);
      } else if (!receiveBroadcast) {
        closeHostPeer(remoteId);
      }
    }
  });

  if (receiveBroadcast) {
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (stream) showBroadcastStream(stream, false);
    });
  }

  return peer;
}

function showBroadcastStream(stream, localPreview) {
  if (!localPreview) remoteBroadcastStream = stream;

  elements.emptyPlayer.classList.add("hidden");
  elements.embedPlayer.classList.add("hidden");
  elements.playerLoading.classList.add("hidden");
  elements.videoPlayer.classList.remove("hidden");
  elements.videoPlayer.srcObject = stream;
  elements.videoPlayer.controls = !localPreview;
  elements.videoPlayer.muted = true;
  elements.muteButton.textContent = "소리 켜기";
  elements.streamModeLabel.textContent = "화면 공유";

  if (localPreview) {
    elements.broadcastButton.textContent = "공유 중지";
    elements.broadcastButton.classList.add("broadcasting");
    setSyncStatus("내 화면 송출 중", true);
  } else {
    setSyncStatus("방장 화면 시청 중", true);
  }

  elements.videoPlayer.play().catch(() => {
    setSyncStatus("재생 버튼을 눌러 주세요", false);
  });
}

function stopRemoteBroadcast() {
  viewerRequested = false;
  remoteBroadcastStream = null;
  pendingIceCandidates.clear();
  if (remotePeerConnection) remotePeerConnection.close();
  remotePeerConnection = null;
  restoreConfiguredPlayer();
}

function closeHostPeer(viewerId) {
  const peer = hostPeerConnections.get(viewerId);
  if (peer) peer.close();
  hostPeerConnections.delete(viewerId);
  pendingIceCandidates.delete(viewerId);
}

async function flushPendingIce(remoteId, peer) {
  const candidates = pendingIceCandidates.get(remoteId) ?? [];
  pendingIceCandidates.delete(remoteId);
  for (const candidate of candidates) {
    await peer.addIceCandidate(candidate).catch(() => {});
  }
}

function restoreConfiguredPlayer() {
  elements.videoPlayer.srcObject = null;
  elements.videoPlayer.controls = isHost;

  if (config?.configured && config.type === "embed") {
    elements.videoPlayer.classList.add("hidden");
    elements.embedPlayer.classList.remove("hidden");
    elements.streamModeLabel.textContent = "공식 임베드";
    setSyncStatus("채팅만 동기화됨", true);
    return;
  }

  if (config?.configured) {
    elements.videoPlayer.classList.remove("hidden");
    elements.streamModeLabel.textContent =
      config.type === "hls" ? "적응형 HLS" : "직접 영상";
    setSyncStatus("플레이어 준비됨", true);
    return;
  }

  elements.videoPlayer.classList.add("hidden");
  elements.emptyPlayer.classList.remove("hidden");
  elements.streamModeLabel.textContent = config?.officialWatchUrl
    ? "공식 사이트"
    : "설정 필요";
  setSyncStatus(
    config?.officialWatchUrl ? "채팅 연결됨" : "중계 소스 미설정",
    Boolean(config?.officialWatchUrl),
  );
}

async function applyMediaState(mediaState) {
  if (!config?.syncAvailable || !mediaState) return;

  const video = elements.videoPlayer;
  const elapsed = mediaState.paused
    ? 0
    : Math.max(0, Date.now() - mediaState.updatedAt) / 1000;
  const targetTime =
    mediaState.currentTime + elapsed * mediaState.playbackRate;
  const drift = targetTime - video.currentTime;

  applyingRemoteState = true;
  try {
    if (Math.abs(drift) > 2.5 && Number.isFinite(targetTime)) {
      video.currentTime = targetTime;
    }

    if (mediaState.paused) {
      video.pause();
      video.playbackRate = mediaState.playbackRate;
    } else {
      video.playbackRate =
        Math.abs(drift) > 0.35 && Math.abs(drift) <= 2.5
          ? mediaState.playbackRate + Math.sign(drift) * 0.05
          : mediaState.playbackRate;
      try {
        await video.play();
      } catch {
        showToast("브라우저 재생 버튼을 한 번 눌러 주세요.");
      }
    }
  } finally {
    window.setTimeout(() => {
      applyingRemoteState = false;
      if (!mediaState.paused) video.playbackRate = mediaState.playbackRate;
    }, 500);
  }
}

function handleFatalHlsError(data) {
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    setSyncStatus("네트워크 복구 중", false);
    hls.startLoad();
    return;
  }

  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    setSyncStatus("플레이어 복구 중", false);
    hls.recoverMediaError();
    return;
  }

  hls.destroy();
  elements.playerLoading.classList.add("hidden");
  setSyncStatus("중계를 재생할 수 없음", false);
  showToast("공식 중계 주소와 CORS 설정을 확인해 주세요.");
}

function hidePlayerLoading() {
  elements.playerLoading.classList.add("hidden");
}

function renderPeople(users) {
  elements.peopleList.replaceChildren(
    ...users.map((user) => {
      const item = document.createElement("li");
      item.className = "person";

      const avatar = document.createElement("span");
      avatar.className = "person-avatar";
      avatar.textContent = user.nickname.slice(0, 1).toUpperCase();

      const name = document.createElement("span");
      name.textContent = user.id === ownSocketId ? `${user.nickname} (나)` : user.nickname;

      item.append(avatar, name);
      if (user.isHost) {
        const badge = document.createElement("span");
        badge.className = "host-badge";
        badge.textContent = "HOST";
        item.append(badge);
      }
      return item;
    }),
  );
}

function appendMessage(message, system) {
  const item = document.createElement("li");
  item.className = `message${system ? " system" : ""}`;

  if (!system) {
    const head = document.createElement("div");
    head.className = "message-head";
    const nickname = document.createElement("strong");
    nickname.textContent = message.nickname;
    const time = document.createElement("time");
    time.textContent = formatTime(message.createdAt);
    head.append(nickname, time);
    item.append(head);
  }

  const text = document.createElement("p");
  text.textContent = message.text;
  item.append(text);
  elements.messageList.append(item);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function setSyncStatus(text, connected) {
  elements.syncStatus.lastChild.textContent = ` ${text}`;
  elements.syncStatus.classList.toggle("connected", connected);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = window.setTimeout(
    () => elements.toast.classList.remove("show"),
    2_500,
  );
}

function getRoomId() {
  const match = window.location.pathname.match(/^\/r\/([a-z0-9-]{4,32})\/?$/i);
  return match?.[1].toLowerCase() ?? null;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
