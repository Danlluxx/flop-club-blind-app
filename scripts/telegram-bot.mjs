import http from "node:http";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(currentDir, "../dist");
loadEnvFile(path.resolve(currentDir, "../.env"));

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
const allowedUsernames = new Set(["flopclub", "danlluxx"]);
const bridgeCommandToken = process.env.BRIDGE_COMMAND_TOKEN ?? "";
const port = Number(process.env.PORT ?? process.env.BOT_BRIDGE_PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const serveStatic = process.env.SERVE_STATIC === "true";
const flopClubTgApiUrl = normalizeBaseUrl(process.env.FLOP_CLUB_TG_API_URL ?? "");
const flopClubTgParticipantsUrl = process.env.FLOP_CLUB_TG_PARTICIPANTS_URL ?? "";
let flopClubTgToken = process.env.FLOP_CLUB_TG_TOKEN ?? "";
const flopClubTgDevAuth = process.env.FLOP_CLUB_TG_DEV_AUTH === "true";
const flopClubTgTournamentId = process.env.FLOP_CLUB_TG_TOURNAMENT_ID ?? "";
const participantsCacheMs = Math.max(Number(process.env.PARTICIPANTS_CACHE_MS) || 10_000, 1_000);
const telegramApi = token ? `https://api.telegram.org/bot${token}` : "";

let clients = new Set();
let lastUpdateId = 0;
let lastState = null;
let lastStateLogged = false;
let participantsCache = {
  count: null,
  entries: null,
  bonusChips: 0,
  capacity: 50,
  tournamentId: null,
  tournamentTitle: null,
  updatedAt: 0,
  error: null,
};

function normalizeBaseUrl(value) {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function loadEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) continue;

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; production can provide real environment variables.
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function isCommandAuthorized(request) {
  if (!bridgeCommandToken) return true;
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token === bridgeCommandToken;
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
]);

async function serveStaticFile(requestPath, response) {
  const safePath = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const relativePath = safePath === "/" ? "/index.html" : safePath;
  const filePath = path.join(distDir, relativePath);

  if (!filePath.startsWith(distDir)) {
    sendJson(response, 403, { ok: false });
    return true;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error("Not a file");
    }
    const extension = path.extname(filePath);
    response.writeHead(200, {
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
    });
    response.end(await readFile(filePath));
    return true;
  } catch {
    const indexPath = path.join(distDir, "index.html");
    try {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(await readFile(indexPath));
      return true;
    } catch {
      sendJson(response, 404, { ok: false });
      return true;
    }
  }
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Body is too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function broadcast(command) {
  const event = `data: ${JSON.stringify(command)}\n\n`;
  console.log(`Broadcast command ${JSON.stringify(command)} to ${clients.size} clock tab(s).`);
  for (const client of clients) {
    client.write(event);
  }
}

function formatTimer(totalSeconds = 0) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatLongTimer(totalSeconds = 0) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatStatus(state) {
  const status = state.statusLabel ?? (state.isRunning ? "ИДЕТ ИГРА" : "ПАУЗА");
  return {
    RUNNING: "ИДЕТ ИГРА",
    READY: "ГОТОВО",
    PAUSED: "ПАУЗА",
    "LEVEL UP": "НОВЫЙ УРОВЕНЬ",
  }[status] ?? status;
}

function formatState() {
  if (!lastState) {
    return "Вкладка с часами пока не подключена. Открой турнирные часы в браузере.";
  }

  const state = lastState;
  const lines = [
    formatStatus(state),
    state.isBreak ? (state.currentLabel ?? "ПЕРЕРЫВ") : `Уровень ${state.level}`,
    ...(!state.isBreak ? [`Блайнды ${state.smallBlind} / ${state.bigBlind} / ${state.bigBlindAnte}`] : []),
    ...(Number.isInteger(state.nextBreakSeconds) ? [`До перерыва ${formatLongTimer(state.nextBreakSeconds)}`] : []),
    ...(Number.isInteger(state.participantsCount) ? [`Участники ${state.participantsCount}`] : []),
    `Таймер ${formatTimer(state.secondsLeft)}`,
    `${state.structureName}`,
  ];

  return lines.join("\n");
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function getParticipantCount(payload) {
  const directCount =
    numberOrNull(payload?.activeParticipantsCount) ??
    numberOrNull(payload?.activeSeatsCount) ??
    numberOrNull(payload?.participantsCount) ??
    numberOrNull(payload?.count);

  if (directCount !== null) return directCount;
  if (Array.isArray(payload?.inGame)) return payload.inGame.length;
  if (Array.isArray(payload?.participants)) return payload.participants.length;
  if (Array.isArray(payload?.registrations)) {
    return payload.registrations.filter((item) => item?.status !== "CANCELLED" && item?.liveStatus !== "ELIMINATED").length;
  }

  return null;
}

function getParticipantCapacity(payload) {
  return numberOrNull(payload?.maxParticipants) ?? numberOrNull(payload?.capacity) ?? 50;
}

// The club "day" runs 08:00 -> 08:00 Barnaul time (UTC+7, no DST): a tournament stays current
// after midnight and the next day's one takes over at 08:00. Same rule as flop-club-tg /api/clock.
function currentTournamentWindow() {
  const offset = 7 * 60 * 60 * 1000;
  const dayStart = 8 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const from = Math.floor((Date.now() + offset - dayStart) / day) * day + dayStart - offset;
  return {
    from: new Date(from).toISOString(),
    to: new Date(from + day).toISOString(),
  };
}

async function fetchFlopClubTg(pathname) {
  const accessToken = await getFlopClubTgToken();
  const response = await fetch(`${flopClubTgApiUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`flop-club-tg ${pathname} failed: ${response.status}`);
  }

  return response.json();
}

async function fetchFlopClubTgParticipantsUrl() {
  const accessToken = flopClubTgToken || (flopClubTgDevAuth ? await getFlopClubTgToken() : "");
  const response = await fetch(flopClubTgParticipantsUrl, {
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`flop-club-tg participants failed: ${response.status}`);
  }

  return response.json();
}

async function getFlopClubTgToken() {
  if (flopClubTgToken) return flopClubTgToken;
  if (!flopClubTgDevAuth) return "";

  const response = await fetch(`${flopClubTgApiUrl}/api/auth/telegram`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ initData: "dev" }),
  });

  if (!response.ok) {
    throw new Error(`flop-club-tg dev auth failed: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.token) {
    throw new Error("flop-club-tg dev auth did not return token");
  }

  flopClubTgToken = payload.token;
  return flopClubTgToken;
}

function pickCurrentTournament(tournaments) {
  const now = Date.now();
  const sorted = [...tournaments].sort((left, right) => {
    const leftTime = new Date(left.startsAt).getTime();
    const rightTime = new Date(right.startsAt).getTime();
    return Math.abs(leftTime - now) - Math.abs(rightTime - now);
  });

  const alreadyStarted = sorted
    .filter((tournament) => new Date(tournament.startsAt).getTime() <= now)
    .sort((left, right) => new Date(right.startsAt).getTime() - new Date(left.startsAt).getTime());

  return alreadyStarted[0] ?? sorted[0] ?? null;
}

async function refreshParticipants() {
  if (!flopClubTgParticipantsUrl && (!flopClubTgApiUrl || (!flopClubTgToken && !flopClubTgDevAuth))) {
    participantsCache = { ...participantsCache, count: null, capacity: 50, updatedAt: Date.now(), error: "not_configured" };
    return participantsCache;
  }

  try {
    if (flopClubTgParticipantsUrl) {
      const participants = await fetchFlopClubTgParticipantsUrl();
      participantsCache = {
        count: getParticipantCount(participants),
        entries: Number.isInteger(participants?.entries) ? participants.entries : null,
        bonusChips: Number.isInteger(participants?.bonusChips) ? participants.bonusChips : 0,
        capacity: getParticipantCapacity(participants),
        tournamentId: participants?.tournamentId ?? null,
        tournamentTitle: participants?.tournamentTitle ?? null,
        earlyBirdCount: Number.isInteger(participants?.earlyBirdCount) ? participants.earlyBirdCount : 0,
        startingStack: Number.isInteger(participants?.startingStack) ? participants.startingStack : null,
        blindStructure: typeof participants?.blindStructure === "string" ? participants.blindStructure : null,
        updatedAt: Date.now(),
        error: null,
      };
      return participantsCache;
    }

    if (flopClubTgTournamentId) {
      const liveState = await fetchFlopClubTg(`/api/admin/tournaments/${encodeURIComponent(flopClubTgTournamentId)}/live`);
      participantsCache = {
        count: getParticipantCount(liveState),
        capacity: getParticipantCapacity(liveState?.tournament),
        tournamentId: liveState?.tournament?.id ?? flopClubTgTournamentId,
        tournamentTitle: liveState?.tournament?.title ?? null,
        updatedAt: Date.now(),
        error: null,
      };
      return participantsCache;
    }

    const window = currentTournamentWindow();
    const query = new URLSearchParams({
      status: "OPEN",
      from: window.from,
      to: window.to,
    });
    const tournaments = await fetchFlopClubTg(`/api/tournaments?${query.toString()}`);
    const tournament = Array.isArray(tournaments) ? pickCurrentTournament(tournaments) : null;
    participantsCache = {
      count: tournament ? getParticipantCount(tournament) : null,
      capacity: tournament ? getParticipantCapacity(tournament) : 50,
      tournamentId: tournament?.id ?? null,
      tournamentTitle: tournament?.title ?? null,
      updatedAt: Date.now(),
      error: tournament ? null : "no_open_tournament",
    };
    return participantsCache;
  } catch (error) {
    participantsCache = {
      ...participantsCache,
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : "unknown_error",
    };
    return participantsCache;
  }
}

async function getParticipants() {
  const isFresh = Date.now() - participantsCache.updatedAt < participantsCacheMs;
  if (isFresh) return participantsCache;
  return refreshParticipants();
}

function isAllowedUser(user) {
  const username = user?.username?.toLowerCase();
  return Boolean(username && allowedUsernames.has(username));
}

function levelKeyboardRows() {
  const levelsCount = Math.max(1, Math.min(Number(lastState?.levelsCount) || 28, 40));
  const rows = [];
  for (let level = 1; level <= levelsCount; level += 4) {
    const row = [];
    for (let offset = 0; offset < 4; offset += 1) {
      const value = level + offset;
      if (value <= levelsCount) {
        row.push({ text: String(value), callback_data: `level:${value}` });
      }
    }
    rows.push(row);
  }
  return rows;
}

function controlsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Старт / продолжить", callback_data: "cmd:resume" },
        { text: "Пауза", callback_data: "cmd:pause" },
      ],
      [
        { text: "Предыдущий", callback_data: "cmd:previous" },
        { text: "Следующий", callback_data: "cmd:next" },
      ],
      [
        { text: "Сброс", callback_data: "cmd:reset" },
        { text: "Статус", callback_data: "cmd:status" },
      ],
      ...levelKeyboardRows(),
    ],
  };
}

function helpText() {
  return [
    "Управление турнирными часами:",
    "Используй кнопки ниже или текстовые команды:",
    "/pause, /resume, /reset, /next, /prev, /level 5, /status",
  ].join("\n");
}

function parseCommand(text = "") {
  const [rawCommand, rawArg] = text.trim().split(/\s+/, 2);
  const command = rawCommand.toLowerCase().split("@")[0];

  if (command === "/start" || command === "/help" || command === "/menu") {
    return {
      reply: helpText(),
      keyboard: true,
    };
  }

  if (command === "/status") {
    return { reply: formatState() };
  }

  if (command === "/start_timer" || command === "/resume") {
    return { command: { type: "resume" }, reply: "Таймер запущен." };
  }

  if (command === "/pause" || command === "/stop") {
    return { command: { type: "pause" }, reply: "Таймер остановлен." };
  }

  if (command === "/reset") {
    return { command: { type: "reset" }, reply: "Турнир сброшен." };
  }

  if (command === "/next") {
    return { command: { type: "next" }, reply: "Следующий уровень." };
  }

  if (command === "/prev" || command === "/previous") {
    return { command: { type: "previous" }, reply: "Предыдущий уровень." };
  }

  if (command === "/level") {
    const level = Number(rawArg);
    if (!Number.isInteger(level) || level < 1) {
      return { reply: "Используй /level 5, где 5 - номер уровня." };
    }
    return { command: { type: "level", level }, reply: `Переключаю на уровень ${level}.` };
  }

  return { reply: "Неизвестная команда. Используй /help." };
}

function parseCallback(data = "") {
  if (data === "cmd:status") {
    return { reply: formatState(), callbackReply: "Статус отправлен.", keyboard: true };
  }

  if (data.startsWith("cmd:")) {
    const type = data.slice(4);
    if (["resume", "pause", "reset", "next", "previous"].includes(type)) {
      return {
        command: { type },
        reply: {
          resume: "Таймер запущен.",
          pause: "Таймер остановлен.",
          reset: "Турнир сброшен.",
          next: "Следующий уровень.",
          previous: "Предыдущий уровень.",
        }[type],
        keyboard: true,
      };
    }
  }

  if (data.startsWith("level:")) {
    const level = Number(data.slice(6));
    if (Number.isInteger(level) && level > 0) {
      return {
        command: { type: "level", level },
        reply: `Переключаю на уровень ${level}.`,
        keyboard: true,
      };
    }
  }

  return { reply: "Неизвестная кнопка. Используй /menu.", keyboard: true };
}

async function telegram(method, payload) {
  const response = await fetch(`${telegramApi}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`${method} failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function sendMessage(chatId, text, keyboard = false) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(keyboard ? { reply_markup: controlsKeyboard() } : {}),
  });
}

async function answerCallback(callbackQueryId, text) {
  await telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function pollTelegram() {
  if (!token) return;

  while (true) {
    try {
      const result = await telegram("getUpdates", {
        timeout: 25,
        offset: lastUpdateId + 1,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of result.result ?? []) {
        lastUpdateId = update.update_id;
        const callbackQuery = update.callback_query;
        const message = update.message ?? callbackQuery?.message;
        const chatId = message?.chat?.id;
        const user = update.message?.from ?? callbackQuery?.from;
        const text = update.message?.text;
        const callbackData = callbackQuery?.data;
        if (!chatId || (!text && !callbackData)) continue;

        console.log(
          `Telegram update from @${user?.username ?? "no_username"} chat=${chatId}: ${text ?? callbackData}`,
        );

        if (allowedChatId && String(chatId) !== allowedChatId) {
          console.log(`Rejected chat ${chatId}: TELEGRAM_ALLOWED_CHAT_ID=${allowedChatId}.`);
          await sendMessage(chatId, "Этот бот не включен для этого чата.");
          continue;
        }

        if (!isAllowedUser(user)) {
          console.log(`Rejected user @${user?.username ?? "no_username"}.`);
          if (callbackQuery?.id) {
            await answerCallback(callbackQuery.id, "Доступ запрещен.");
          }
          await sendMessage(chatId, "Доступ разрешен только @flopclub и @danlluxx.");
          continue;
        }

        const parsed = callbackData ? parseCallback(callbackData) : parseCommand(text);
        if (parsed.command) {
          broadcast(parsed.command);
        }
        if (callbackQuery?.id) {
          await answerCallback(callbackQuery.id, parsed.callbackReply ?? parsed.reply);
        }
        await sendMessage(chatId, parsed.reply, Boolean(parsed.keyboard));
      }
    } catch (error) {
      console.error(error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
    });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
    });
    response.write("event: ready\ndata: {}\n\n");
    clients.add(response);
    console.log(`Clock tab connected. Active clock tabs: ${clients.size}.`);
    request.on("close", () => {
      clients.delete(response);
      console.log(`Clock tab disconnected. Active clock tabs: ${clients.size}.`);
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/state") {
    try {
      lastState = await parseBody(request);
      if (!lastStateLogged) {
        console.log("Clock state received. Telegram /status is ready.");
        lastStateLogged = true;
      }
      sendJson(response, 200, { ok: true });
    } catch {
      sendJson(response, 400, { ok: false });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/command") {
    if (!isCommandAuthorized(request)) {
      sendJson(response, 401, { ok: false });
      return;
    }

    try {
      const command = await parseBody(request);
      broadcast(command);
      sendJson(response, 200, { ok: true });
    } catch {
      sendJson(response, 400, { ok: false });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/participants") {
    const participants = await getParticipants();
    sendJson(response, 200, {
      ok: !participants.error,
      count: participants.count,
      entries: participants.entries,
      bonusChips: participants.bonusChips,
      capacity: participants.capacity,
      tournamentId: participants.tournamentId,
      tournamentTitle: participants.tournamentTitle,
      updatedAt: participants.updatedAt,
      error: participants.error,
    });
    return;
  }

  if (request.method === "GET" && serveStatic) {
    await serveStaticFile(url.pathname, response);
    return;
  }

  sendJson(response, 404, { ok: false });
});

server.listen(port, host, () => {
  console.log(`Telegram bridge listening on http://${host}:${port}`);
  if (serveStatic) {
    console.log(`Serving built app from ${distDir}`);
  }
  console.log(`Allowed usernames: @${[...allowedUsernames].join(", @")}`);
  if (!token) {
    console.log("Set TELEGRAM_BOT_TOKEN to enable Telegram polling.");
  } else {
    console.log("Telegram polling enabled.");
  }
  if (!flopClubTgParticipantsUrl && (!flopClubTgApiUrl || (!flopClubTgToken && !flopClubTgDevAuth))) {
    console.log("Set FLOP_CLUB_TG_PARTICIPANTS_URL or FLOP_CLUB_TG_API_URL and FLOP_CLUB_TG_TOKEN to show live participants.");
  } else {
    console.log(`Live participants source: ${flopClubTgParticipantsUrl || flopClubTgApiUrl}`);
  }
});

void pollTelegram();
