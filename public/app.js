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
  localCapturePlayer: document.querySelector("#localCapturePlayer"),
  embedPlayer: document.querySelector("#embedPlayer"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  officialWatchLink: document.querySelector("#officialWatchLink"),
  popoutWatchButton: document.querySelector("#popoutWatchButton"),
  playerLoading: document.querySelector("#playerLoading"),
  playerShell: document.querySelector("#playerShell"),
  syncStatus: document.querySelector("#syncStatus"),
  captureButton: document.querySelector("#captureButton"),
  readyButton: document.querySelector("#readyButton"),
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
let isReady = false;
let config = null;
let localCaptureStream = null;
let lastReadyCount = 0;
let lastReadyTotal = 0;
let toastTimer = null;

if (roomId) {
  elements.homeView.classList.add("hidden");
  elements.roomView.classList.remove("hidden");
  elements.roomIdLabel.textContent = roomId;
  elements.nicknameInput.value = localStorage.getItem("watch-party-nickname") ?? "";
  elements.nicknameDialog.showModal();
  loadWatchConfig();
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

elements.captureButton.addEventListener("click", async () => {
  if (localCaptureStream) {
    stopLocalCapture();
  } else {
    await startLocalCapture();
  }
});

elements.readyButton.addEventListener("click", () => {
  isReady = !isReady;
  socket.emit("watch-ready-state", { ready: isReady }, (result) => {
    if (!result?.ok) {
      isReady = !isReady;
      showToast("준비 상태를 바꾸지 못했습니다.");
    }
  });
  updateReadyButton();
});

elements.popoutWatchButton.addEventListener("click", () => {
  openOfficialWatchPage();
});

elements.officialWatchLink.addEventListener("click", () => {
  setSyncStatus("공식 중계 창을 열었습니다. 여기서는 채팅을 계속하세요.", true);
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
  elements.viewerCount.textContent = state.users.length;
  elements.peopleCount.textContent = state.users.length;
  renderPeople(state.users);

  const host = state.users.find((user) => user.isHost);
  const readyCount = state.users.filter((user) => user.ready).length;
  const readyTotal = state.users.length;
  lastReadyCount = readyCount;
  lastReadyTotal = readyTotal;
  elements.hostLabel.textContent =
    state.hostId === ownSocketId
      ? "내가 방장"
      : `${host?.nickname ?? "알 수 없음"}님`;
  updateStreamMode();

  const me = state.users.find((user) => user.id === ownSocketId);
  if (me) {
    isReady = Boolean(me.ready);
    updateReadyButton();
  }
});

socket.on("chat-message", (message) => appendMessage(message, false));
socket.on("system-message", (message) => appendMessage(message, true));

async function loadWatchConfig() {
  try {
    const response = await fetch("/api/config");
    config = await response.json();
    elements.streamLabel.textContent = config.label;
    updateStreamMode();

    if (config.officialWatchUrl) {
      setupOfficialWatch(config);
      return;
    }

    elements.emptyPlayer.classList.remove("hidden");
    elements.officialWatchLink.classList.add("hidden");
    elements.popoutWatchButton.classList.add("hidden");
    setSyncStatus("공식 시청 링크가 아직 설정되지 않았습니다.", false);
  } catch {
    elements.emptyPlayer.classList.remove("hidden");
    elements.streamModeLabel.textContent = "연결 실패";
    setSyncStatus("중계 설정을 불러오지 못함", false);
  }
}

function setupOfficialWatch(watchConfig) {
  elements.officialWatchLink.href = watchConfig.officialWatchUrl;
  elements.officialWatchLink.textContent = watchConfig.officialWatchLabel;
  elements.officialWatchLink.classList.remove("hidden");
  elements.popoutWatchButton.classList.remove("hidden");
  elements.emptyPlayer.classList.remove("hidden");

  if (watchConfig.embedUrl) {
    elements.playerLoading.classList.remove("hidden");
    elements.embedPlayer.src = watchConfig.embedUrl;
    elements.embedPlayer.classList.remove("hidden");
    elements.emptyPlayer.classList.add("hidden");
    elements.embedPlayer.addEventListener(
      "load",
      () => {
        elements.playerLoading.classList.add("hidden");
        setSyncStatus(
          "공식 페이지를 앱 안에 열었습니다. 재생은 각자 조작하세요.",
          true,
        );
      },
      { once: true },
    );
    return;
  }

  setSyncStatus("공식 중계를 새 창으로 열고 여기서 함께 채팅하세요.", true);
}

async function startLocalCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("이 브라우저는 화면 띄우기를 지원하지 않습니다.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
      },
      audio: true,
    });

    localCaptureStream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (localCaptureStream === stream) stopLocalCapture();
        },
        { once: true },
      );
    }

    elements.embedPlayer.classList.add("hidden");
    elements.emptyPlayer.classList.add("hidden");
    elements.playerLoading.classList.add("hidden");
    elements.localCapturePlayer.srcObject = stream;
    elements.localCapturePlayer.classList.remove("hidden");
    elements.localCapturePlayer.muted = true;
    elements.captureButton.textContent = "화면 내리기";
    elements.captureButton.classList.add("capturing");
    updateStreamMode();
    setSyncStatus("내 치지직 화면을 이 방에 띄웠습니다. 채팅은 계속 공유됩니다.", true);
    await elements.localCapturePlayer.play();
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      showToast("화면을 띄우지 못했습니다.");
    }
  }
}

function stopLocalCapture() {
  for (const track of localCaptureStream?.getTracks() ?? []) track.stop();
  localCaptureStream = null;
  elements.localCapturePlayer.pause();
  elements.localCapturePlayer.srcObject = null;
  elements.localCapturePlayer.classList.add("hidden");
  elements.captureButton.textContent = "내 화면 띄우기";
  elements.captureButton.classList.remove("capturing");

  if (config?.embedUrl) {
    elements.embedPlayer.classList.remove("hidden");
  } else {
    elements.emptyPlayer.classList.remove("hidden");
  }

  updateStreamMode();
  setSyncStatus("내 화면을 내렸습니다. 필요하면 다시 띄울 수 있습니다.", true);
}

function updateStreamMode() {
  const watchMode = localCaptureStream ? "내 화면 띄움" : "각자 화면 띄우기";
  elements.streamModeLabel.textContent = `${watchMode} · 준비 ${lastReadyCount}/${lastReadyTotal}`;
}

function openOfficialWatchPage() {
  if (!config?.officialWatchUrl) {
    showToast("공식 시청 링크가 설정되지 않았습니다.");
    return;
  }

  window.open(config.officialWatchUrl, "_blank", "noopener,noreferrer");
  setSyncStatus("공식 중계 창을 열었습니다. 여기서는 채팅을 계속하세요.", true);
}

function updateReadyButton() {
  elements.readyButton.textContent = isReady ? "준비 취소" : "시청 준비 완료";
  elements.readyButton.classList.toggle("ready", isReady);
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
      if (user.ready) {
        const readyBadge = document.createElement("span");
        readyBadge.className = "ready-badge";
        readyBadge.textContent = "READY";
        item.append(readyBadge);
      }
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
