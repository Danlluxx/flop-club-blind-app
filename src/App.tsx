import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blindStructures, type BlindLevel } from "./data/blindStructures";

const APP_BASE_URL = import.meta.env.BASE_URL;
const SOUND_URL = `${APP_BASE_URL}sounds/level-up.mp3`;
const TOURNAMENT_STATE_KEY = "poker-clock-tournament-state";
const BOT_BRIDGE_URL =
  import.meta.env.VITE_BOT_BRIDGE_URL ??
  (import.meta.env.DEV ? "http://127.0.0.1:8787" : APP_BASE_URL === "/" ? "" : APP_BASE_URL.replace(/\/$/, ""));

type AudioSettings = {
  soundEnabled: boolean;
  volume: number;
};

type TournamentState = {
  structureId: string;
  levelIndex: number;
  secondsLeft: number;
  isRunning: boolean;
  updatedAt: number;
};

type ParticipantsState = {
  count: number | null;
  entries: number | null;
  bonusChips: number;
  earlyBirdCount: number;
  capacity: number;
  tournamentTitle: string | null;
  updatedAt: number | null;
  error: string | null;
};

type BotCommand =
  | { type: "resume" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "level"; level: number };

type TableSettings = {
  startingStack: number;
};

const TABLE_SETTINGS_KEY = "poker-clock-table-settings";

const defaultTable: TableSettings = {
  startingStack: 30000,
};

// Falling Flop Club marks, alternating red and grey.
const markClass = (index: number) => (index % 4 === 1 || index % 4 === 2 ? "mark is-red" : "mark is-grey");

// Deterministic spread so the marks do not jump between renders.
const suitStyle = (index: number, total: number, size: [number, number], duration: [number, number]) =>
  ({
    "--mark": `url(${APP_BASE_URL}images/flop-mark.png)`,
    "--x": `${((index + 0.5) / total) * 100}%`,
    "--s": `${size[0] + ((index * 37) % 10) * ((size[1] - size[0]) / 10)}em`,
    "--d": `${duration[0] + ((index * 53) % 10) * ((duration[1] - duration[0]) / 10)}s`,
    "--delay": `${-((index * 29) % 17)}s`,
    "--r": `${index % 2 ? "" : "-"}${240 + ((index * 71) % 240)}deg`,
  }) as React.CSSProperties;

const defaultSettings: AudioSettings = {
  soundEnabled: true,
  volume: 85,
};

function formatTimer(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatLongTimer(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatChips(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function levelSeconds(level: BlindLevel) {
  return level.minutes * 60;
}

function isBreakLevel(level: BlindLevel) {
  return level.type === "break";
}

function maxTournamentLevel(levels: BlindLevel[]) {
  return Math.max(...levels.filter((level) => !isBreakLevel(level)).map((level) => level.level));
}

function formatLevelName(level: BlindLevel) {
  return isBreakLevel(level) ? (level.label ?? "ПЕРЕРЫВ") : String(level.level);
}

function formatBlinds(level: BlindLevel) {
  if (isBreakLevel(level)) {
    return level.label ?? "ПЕРЕРЫВ";
  }

  return `${formatChips(level.smallBlind)} / ${formatChips(level.bigBlind)} / ${formatChips(level.bigBlindAnte)}`;
}

function getStructure(structureId: string) {
  return blindStructures.find((item) => item.id === structureId) ?? blindStructures[0];
}

function secondsUntilNextBreak(levels: BlindLevel[], levelIndex: number, secondsLeft: number) {
  const nextBreakIndex = levels.findIndex((level, index) => index > levelIndex && isBreakLevel(level));
  if (nextBreakIndex < 0) return null;

  return levels.slice(levelIndex + 1, nextBreakIndex).reduce((total, level) => total + levelSeconds(level), secondsLeft);
}

// Tells "no connection" apart from "connected, but no tournament today".
function tournamentTitleFallback(participants: ParticipantsState) {
  if (participants.updatedAt === null) return "…";
  if (participants.error && participants.error !== "no_open_tournament") return "Нет связи с приложением";
  return "Турнир не выбран";
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }
}

function formatClock(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Long blind values get abbreviated (12K, 1.5M) so they stay big on the screen.
function compactChips(value: number) {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${+(value / 1000).toFixed(1)}K`;
  return formatChips(value);
}

// Rough text width in em (Unbounded digits ~0.76em) used to shrink blinds to the free space.
function blindsFontSize(values: string[]) {
  const width = values.reduce(
    (total, text) => total + [...text].reduce((sum, ch) => sum + (ch === "," || ch === "." ? 0.32 : /[KM]/.test(ch) ? 0.9 : 0.76), 0),
    0,
  );
  return Math.min(5.2, Math.max(2.4, 33 / width));
}

function readStoredTable(): TableSettings {
  try {
    const stored = localStorage.getItem(TABLE_SETTINGS_KEY);
    const parsed = stored ? (JSON.parse(stored) as Partial<TableSettings>) : {};
    const stack = Number(parsed.startingStack);
    return {
      startingStack: Number.isFinite(stack) && stack > 0 ? stack : defaultTable.startingStack,
    };
  } catch {
    return defaultTable;
  }
}

function readStoredSettings(): AudioSettings {
  try {
    const stored = localStorage.getItem("poker-clock-audio-settings");
    return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

function readStoredTournamentState(): TournamentState {
  const fallbackStructure = blindStructures[0];
  const fallbackLevel = fallbackStructure.levels[0];
  const fallback: TournamentState = {
    structureId: fallbackStructure.id,
    levelIndex: 0,
    secondsLeft: levelSeconds(fallbackLevel),
    isRunning: false,
    updatedAt: Date.now(),
  };

  try {
    const stored = localStorage.getItem(TOURNAMENT_STATE_KEY);
    if (!stored) return fallback;

    const parsed = JSON.parse(stored) as Partial<TournamentState>;
    const structure = getStructure(typeof parsed.structureId === "string" ? parsed.structureId : fallback.structureId);
    const maxLevelIndex = structure.levels.length - 1;
    const levelIndex = Math.min(Math.max(Number(parsed.levelIndex) || 0, 0), maxLevelIndex);
    const maxSeconds = levelSeconds(structure.levels[levelIndex]);
    const rawSeconds = Number(parsed.secondsLeft);
    const savedSeconds = Number.isFinite(rawSeconds) ? rawSeconds : maxSeconds;
    const updatedAt = Number(parsed.updatedAt) || Date.now();
    const elapsedSeconds = parsed.isRunning ? Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) : 0;

    return {
      structureId: structure.id,
      levelIndex,
      secondsLeft: Math.min(Math.max(savedSeconds - elapsedSeconds, 0), maxSeconds),
      isRunning: Boolean(parsed.isRunning),
      updatedAt: Date.now(),
    };
  } catch {
    return fallback;
  }
}

export default function App() {
  const initialTournamentState = useRef(readStoredTournamentState()).current;
  const [structureId, setStructureId] = useState(initialTournamentState.structureId);
  const structure = getStructure(structureId);
  const [levelIndex, setLevelIndex] = useState(initialTournamentState.levelIndex);
  const currentLevel = structure.levels[levelIndex];
  const nextLevel = structure.levels[levelIndex + 1] ?? currentLevel;
  const [secondsLeft, setSecondsLeft] = useState(initialTournamentState.secondsLeft);
  const [isRunning, setIsRunning] = useState(initialTournamentState.isRunning);
  const [showControls, setShowControls] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showLevelUp, setShowLevelUp] = useState(false);
  const [levelUpText, setLevelUpText] = useState("BLINDS UP");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [settings, setSettings] = useState<AudioSettings>(readStoredSettings);
  const [participants, setParticipants] = useState<ParticipantsState>({
    count: null,
    entries: null,
    bonusChips: 0,
    earlyBirdCount: 0,
    capacity: 50,
    tournamentTitle: null,
    updatedAt: null,
    error: null,
  });
  const [table, setTable] = useState<TableSettings>(readStoredTable);
  const [now, setNow] = useState(() => new Date());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const notificationTimerRef = useRef<number | null>(null);

  const canGoPrevious = levelIndex > 0;
  const canGoNext = levelIndex < structure.levels.length - 1;

  useEffect(() => {
    localStorage.setItem("poker-clock-audio-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(
      TOURNAMENT_STATE_KEY,
      JSON.stringify({
        structureId,
        levelIndex,
        secondsLeft,
        isRunning,
        updatedAt: Date.now(),
      } satisfies TournamentState),
    );
  }, [isRunning, levelIndex, secondsLeft, structureId]);

  useEffect(() => {
    localStorage.setItem(TABLE_SETTINGS_KEY, JSON.stringify(table));
  }, [table]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    audioRef.current = new Audio(SOUND_URL);
    audioRef.current.preload = "auto";
  }, []);

  const playSignal = useCallback(() => {
    if (!settings.soundEnabled || !audioRef.current) {
      return Promise.resolve();
    }

    const audio = audioRef.current;
    audio.pause();
    audio.currentTime = 0;
    audio.volume = settings.volume / 100;

    return audio.play().then(
      () =>
        new Promise<void>((resolve) => {
          const fallback = window.setTimeout(resolve, 1600);
          audio.onended = () => {
            window.clearTimeout(fallback);
            resolve();
          };
        }),
      () => undefined,
    );
  }, [settings.soundEnabled, settings.volume]);

  const showLevelUpNotification = useCallback((text = "BLINDS UP") => {
    setLevelUpText(text);
    setShowLevelUp(true);
    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
    }
    notificationTimerRef.current = window.setTimeout(() => setShowLevelUp(false), 2400);
  }, []);

  const goToLevel = useCallback((nextIndex: number) => {
    const boundedIndex = Math.min(Math.max(nextIndex, 0), structure.levels.length - 1);
    setLevelIndex(boundedIndex);
    setSecondsLeft(levelSeconds(structure.levels[boundedIndex]));
  }, [structure.levels]);

  const transitionToLevel = useCallback(async (nextIndex: number) => {
    if (isTransitioning) return;

    const boundedIndex = Math.min(Math.max(nextIndex, 0), structure.levels.length - 1);
    const targetLevel = structure.levels[boundedIndex];
    setIsTransitioning(true);
    setLevelIndex(boundedIndex);
    setSecondsLeft(levelSeconds(targetLevel));
    await playSignal();
    showLevelUpNotification(isBreakLevel(targetLevel) ? targetLevel.label : "BLINDS UP");
    setIsTransitioning(false);
  }, [isTransitioning, playSignal, showLevelUpNotification, structure.levels]);

  const nextLevelAction = useCallback(() => {
    if (canGoNext) {
      void transitionToLevel(levelIndex + 1);
    }
  }, [canGoNext, levelIndex, transitionToLevel]);

  const previousLevelAction = useCallback(() => {
    if (canGoPrevious) {
      goToLevel(levelIndex - 1);
    }
  }, [canGoPrevious, goToLevel, levelIndex]);

  const resetClock = useCallback(() => {
    setIsRunning(false);
    setIsTransitioning(false);
    goToLevel(0);
    setShowLevelUp(false);
  }, [goToLevel]);

  const applyBotCommand = useCallback((command: BotCommand) => {
    if (command.type === "resume") {
      setIsRunning(true);
      return;
    }

    if (command.type === "pause") {
      setIsRunning(false);
      return;
    }

    if (command.type === "reset") {
      resetClock();
      return;
    }

    if (command.type === "next") {
      nextLevelAction();
      return;
    }

    if (command.type === "previous") {
      previousLevelAction();
      return;
    }

    if (command.type === "level") {
      const targetIndex = structure.levels.findIndex((level) => level.level === command.level);
      if (targetIndex >= 0) {
        goToLevel(targetIndex);
      }
    }
  }, [goToLevel, nextLevelAction, previousLevelAction, resetClock, structure.levels]);

  useEffect(() => {
    if (!isRunning || isTransitioning) return;

    const intervalId = window.setInterval(() => {
      setSecondsLeft((value) => {
        if (value > 1) return value - 1;
        if (canGoNext) {
          void transitionToLevel(levelIndex + 1);
        } else {
          setIsRunning(false);
        }
        return 0;
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [canGoNext, isRunning, isTransitioning, levelIndex, transitionToLevel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowControls(false);
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea, button")) return;

      if (event.code === "Space") {
        event.preventDefault();
        setIsRunning((value) => !value);
      }
      if (event.key === "ArrowRight") nextLevelAction();
      if (event.key === "ArrowLeft") previousLevelAction();
      if (event.key.toLowerCase() === "r") resetClock();
      if (event.key.toLowerCase() === "h") setShowControls((value) => !value);
      if (event.key.toLowerCase() === "f" || event.key.toLowerCase() === "а") toggleFullscreen();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nextLevelAction, previousLevelAction, resetClock]);

  const statusLabel = useMemo(() => {
    if (isTransitioning) return "НОВЫЙ УРОВЕНЬ";
    if (isBreakLevel(currentLevel)) return "ПЕРЕРЫВ";
    if (isRunning) return "ИДЕТ ИГРА";
    return secondsLeft === levelSeconds(currentLevel) ? "ГОТОВО" : "ПАУЗА";
  }, [currentLevel, isRunning, isTransitioning, secondsLeft]);

  const nextBreakSeconds = useMemo(
    () => secondsUntilNextBreak(structure.levels, levelIndex, secondsLeft),
    [levelIndex, secondsLeft, structure.levels],
  );

  const playersLeft = participants.count;
  const entries = participants.entries ?? playersLeft;
  const totalChips = entries !== null ? entries * table.startingStack + participants.bonusChips : null;
  const averageStack =
    totalChips !== null && playersLeft ? Math.round(totalChips / playersLeft) : null;
  const averageBlinds =
    averageStack !== null && !isBreakLevel(currentLevel) && currentLevel.bigBlind > 0
      ? averageStack / currentLevel.bigBlind
      : null;
  const playableLevels = structure.levels.filter((level) => !isBreakLevel(level));
  const elapsedSeconds =
    structure.levels.slice(0, levelIndex).reduce((total, level) => total + levelSeconds(level), 0) +
    (levelSeconds(currentLevel) - secondsLeft);
  const levelProgress = 1 - secondsLeft / levelSeconds(currentLevel);
  const lastLevelNumber = maxTournamentLevel(structure.levels);
  const nextIsBreak = isBreakLevel(nextLevel) && nextLevel !== currentLevel;
  const hasNext = canGoNext;

  useEffect(() => {
    const events = new EventSource(`${BOT_BRIDGE_URL}/events`);
    events.onmessage = (event) => {
      try {
        applyBotCommand(JSON.parse(event.data) as BotCommand);
      } catch {
        // Ignore malformed local bridge messages.
      }
    };

    return () => events.close();
  }, [applyBotCommand]);

  useEffect(() => {
    let isMounted = true;

    const fetchParticipants = async () => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 1200);

      try {
        const response = await fetch(`${BOT_BRIDGE_URL}/participants`, { signal: controller.signal });
        const payload = await response.json();
        if (!isMounted) return;

        const count = Number(payload?.count);
        const capacity = Number(payload?.capacity);
        const entries = Number(payload?.entries);
        const bonusChips = Number(payload?.bonusChips);
        const earlyBirdCount = Number(payload?.earlyBirdCount);
        setParticipants({
          count: Number.isInteger(count) && count >= 0 ? count : null,
          entries: payload?.entries != null && Number.isInteger(entries) && entries >= 0 ? entries : null,
          bonusChips: Number.isInteger(bonusChips) && bonusChips > 0 ? bonusChips : 0,
          earlyBirdCount: Number.isInteger(earlyBirdCount) && earlyBirdCount > 0 ? earlyBirdCount : 0,
          capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : 50,
          tournamentTitle: typeof payload?.tournamentTitle === "string" ? payload.tournamentTitle : null,
          updatedAt: Number(payload?.updatedAt) || Date.now(),
          error: typeof payload?.error === "string" ? payload.error : null,
        });
      } catch {
        if (isMounted) {
          setParticipants((value) => ({ ...value, updatedAt: Date.now(), error: "offline" }));
        }
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    void fetchParticipants();
    const intervalId = window.setInterval(fetchParticipants, 10_000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 700);

    fetch(`${BOT_BRIDGE_URL}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structureId,
        structureName: structure.name,
        levelsCount: maxTournamentLevel(structure.levels),
        levelIndex,
        level: formatLevelName(currentLevel),
        isBreak: isBreakLevel(currentLevel),
        currentLabel: isBreakLevel(currentLevel) ? currentLevel.label : undefined,
        smallBlind: currentLevel.smallBlind,
        bigBlind: currentLevel.bigBlind,
        bigBlindAnte: currentLevel.bigBlindAnte,
        secondsLeft,
        isRunning,
        statusLabel,
        nextBreakSeconds,
        participantsCount: participants.count,
        participantsCapacity: participants.capacity,
      }),
      signal: controller.signal,
    }).catch(() => {
      // The Telegram bridge is optional; the clock must work without it.
    }).finally(() => {
      window.clearTimeout(timeoutId);
    });

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [currentLevel, isRunning, levelIndex, nextBreakSeconds, participants.capacity, participants.count, secondsLeft, statusLabel, structure.levels, structure.name, structureId]);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <div className="suit-field" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => (
          <span key={index} className={markClass(index)} style={suitStyle(index, 14, [3, 7], [22, 38])} />
        ))}
      </div>

      {showLevelUp && (
        <>
          <div className="level-up-alert">{levelUpText}</div>
          <div className="suit-rain" aria-hidden="true">
            {Array.from({ length: 36 }, (_, index) => (
              <span key={index} className={markClass(index)} style={suitStyle(index, 36, [3, 6], [2.2, 4])} />
            ))}
          </div>
        </>
      )}

      <section className="scoreboard" aria-live="polite">
        <header className="topbar">
          <div className="brand-mark" aria-label="FLOP CLUB">
            <img src={`${APP_BASE_URL}images/flop-wordmark.svg`} alt="FLOP CLUB" />
          </div>
          <div className="title-block">
            <h1 className="event-title" title={participants.tournamentTitle ?? undefined}>
              {participants.tournamentTitle ?? tournamentTitleFallback(participants)}
            </h1>
          </div>
          <div className="clock-box">
            <span className="chip round-chip">
              {isBreakLevel(currentLevel) ? "Перерыв" : `Раунд ${formatLevelName(currentLevel)}`}
              {!isBreakLevel(currentLevel) && <small>/ {lastLevelNumber}</small>}
            </span>
            <span className={`status-chip${isRunning ? " is-live" : ""}`}>{statusLabel}</span>
          </div>
        </header>

        <div className="table-wrap">
          <svg className="table-shape" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="tableFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#4a1722" />
                <stop offset="1" stopColor="#1b0a10" />
              </linearGradient>
            </defs>
            <path
              d="M 200 20 L 800 20 C 920 20 980 120 980 260 C 980 400 920 500 800 500 L 200 500 C 80 500 20 400 20 260 C 20 120 80 20 200 20 Z"
              fill="url(#tableFill)"
              stroke="#ff6f82"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <div className="stat stat-chips">
            <span className="stat-label">Фишек в игре</span>
            <strong>{totalChips !== null ? formatChips(totalChips) : "—"}</strong>
            {participants.earlyBirdCount > 0 && (
              <span className="stat-note">+10K до 19:10 · {participants.earlyBirdCount} игр.</span>
            )}
          </div>
          <div className="stat stat-players">
            <span className="stat-label">Игроки</span>
            <strong>
              {playersLeft ?? "…"}
              <small> / {participants.capacity}</small>
            </strong>
            <div className="bar" aria-hidden="true">
              <i style={{ width: `${Math.min(((playersLeft ?? 0) / participants.capacity) * 100, 100)}%` }} />
            </div>
          </div>

          <div className="center-stack">
            <span className="wall-clock">
              {now.toLocaleTimeString("ru-RU", { timeZone: "Asia/Barnaul", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <div
              className={`timer${isRunning && secondsLeft <= 60 ? " is-urgent" : ""}${isRunning && secondsLeft <= 10 ? " is-final" : ""}`}
              aria-label={formatTimer(secondsLeft)}
            >
              {formatTimer(secondsLeft).split("").map((char, index) => (
                <span key={index} className={char === ":" ? "colon" : "digit"}>{char}</span>
              ))}
            </div>
            <div className="bar level-bar" aria-hidden="true">
              <i style={{ width: `${Math.min(Math.max(levelProgress, 0), 1) * 100}%` }} />
            </div>
            <span className="break-countdown">
              {nextBreakSeconds !== null ? (
                <>Перерыв через <strong>{formatLongTimer(nextBreakSeconds)}</strong></>
              ) : (
                "Перерывов больше нет"
              )}
            </span>
          </div>

          <div className="stat stat-avg">
            <span className="stat-label">Средний стек</span>
            <strong>{averageStack !== null ? formatChips(averageStack) : "—"}</strong>
            {averageBlinds !== null && <em>{averageBlinds < 10 ? averageBlinds.toFixed(1) : Math.round(averageBlinds)} BB</em>}
          </div>

          {isBreakLevel(currentLevel) ? (
            <div className="blinds blinds-break">
              <strong>{formatBlinds(currentLevel)}</strong>
              {currentLevel.note && <span>{currentLevel.note}</span>}
            </div>
          ) : (
            <div
              className="blinds"
              style={{
                "--blind-size": `${blindsFontSize([
                  compactChips(currentLevel.smallBlind),
                  compactChips(currentLevel.bigBlind),
                  compactChips(currentLevel.bigBlindAnte),
                ])}em`,
              } as React.CSSProperties}
            >
              <div>
                <strong>{compactChips(currentLevel.smallBlind)}</strong>
                <span>SB</span>
              </div>
              <div>
                <strong>{compactChips(currentLevel.bigBlind)}</strong>
                <span>BB</span>
              </div>
              <div className="blind-ante">
                <strong>{compactChips(currentLevel.bigBlindAnte)}</strong>
                <span>АНТЕ</span>
              </div>
            </div>
          )}

          <div className="stat stat-next">
            <span className="stat-label">{hasNext ? "Следующий уровень" : "Финальный уровень"}</span>
            {hasNext && isBreakLevel(nextLevel) ? (
              <strong className="next-break">{nextLevel.label}</strong>
            ) : hasNext ? (
              <div className="next-blinds">
                <div>
                  <strong>{compactChips(nextLevel.smallBlind)}</strong>
                  <span>SB</span>
                </div>
                <div>
                  <strong>{compactChips(nextLevel.bigBlind)}</strong>
                  <span>BB</span>
                </div>
              </div>
            ) : (
              <strong>—</strong>
            )}
            {nextIsBreak && <em>сразу после этого</em>}
          </div>
        </div>

        <footer className="footbar">
          <div className="foot-item">
            <span>Время турнира</span>
            <strong>{formatLongTimer(elapsedSeconds)}</strong>
          </div>
          <div className="foot-item">
            <span>Уровней</span>
            <strong>{playableLevels.length}</strong>
          </div>
        </footer>
      </section>

      <button
        type="button"
        className="menu-trigger"
        aria-label={showControls ? "Закрыть управление" : "Открыть управление"}
        aria-expanded={showControls}
        onClick={() => setShowControls((value) => !value)}
      >
        <span aria-hidden="true">{showControls ? "✕" : "⋯"}</span>
      </button>

      {showControls && (
        <aside className="control-panel" aria-label="Управление турниром">
          <button
            type="button"
            className={`cp-play${isRunning ? " is-running" : ""}`}
            onClick={() => setIsRunning((value) => !value)}
          >
            {isRunning ? "❚❚  Пауза" : secondsLeft === levelSeconds(currentLevel) && levelIndex === 0 ? "▶  Старт" : "▶  Продолжить"}
          </button>

          <button type="button" className="cp-fullscreen" onClick={toggleFullscreen}>
            ⛶ На весь экран
          </button>

          <div className="cp-pair">
            <div className="cp-card">
              <span className="cp-label">{isBreakLevel(currentLevel) ? "Перерыв" : "Уровень"}</span>
              <div className="cp-stepper">
                <button type="button" onClick={previousLevelAction} disabled={!canGoPrevious} aria-label="Предыдущий уровень">‹</button>
                <strong>{isBreakLevel(currentLevel) ? "☕" : formatLevelName(currentLevel)}</strong>
                <button type="button" onClick={nextLevelAction} disabled={!canGoNext} aria-label="Следующий уровень">›</button>
              </div>
            </div>
          </div>

          <details className="cp-more">
            <summary>Настройки</summary>

            <label className="cp-field">
              <span>Структура блайндов</span>
              <select
                value={structureId}
                onChange={(event) => {
                  if (!window.confirm("Сменить структуру? Таймер сбросится на 1 уровень.")) return;
                  const nextStructure = getStructure(event.target.value);
                  setStructureId(nextStructure.id);
                  setLevelIndex(0);
                  setSecondsLeft(levelSeconds(nextStructure.levels[0]));
                  setIsRunning(false);
                }}
              >
                {blindStructures.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="cp-field">
              <span>Стартовый стек</span>
              <input
                type="number"
                min="1"
                step="1000"
                value={table.startingStack}
                onChange={(event) =>
                  setTable((value) => ({ ...value, startingStack: Math.max(1, Number(event.target.value) || 1) }))
                }
              />
            </label>

            <div className="cp-sound">
              <button
                type="button"
                className={`cp-toggle${settings.soundEnabled ? " is-on" : ""}`}
                aria-pressed={settings.soundEnabled}
                onClick={() => setSettings((value) => ({ ...value, soundEnabled: !value.soundEnabled }))}
              >
                {settings.soundEnabled ? "🔊" : "🔇"}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={settings.volume}
                disabled={!settings.soundEnabled}
                aria-label="Громкость"
                onChange={(event) => setSettings((value) => ({ ...value, volume: Number(event.target.value) }))}
              />
              <span className="cp-volume">{settings.volume}%</span>
            </div>

            <button
              type="button"
              className={`cp-reset${confirmReset ? " is-armed" : ""}`}
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  window.setTimeout(() => setConfirmReset(false), 4000);
                  return;
                }
                setConfirmReset(false);
                resetClock();
              }}
            >
              {confirmReset ? "Точно? Нажмите ещё раз" : "Сбросить турнир"}
            </button>

            <p className="cp-keys">Пробел — пауза · ← → — уровень · F — весь экран · H — меню</p>
          </details>
        </aside>
      )}
    </main>
  );
}
