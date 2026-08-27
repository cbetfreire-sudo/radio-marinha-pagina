import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  createStreamPositionZeroAt,
  estimateStreamStartupDelay,
  estimateLyricsDuration,
  findActiveLyricIndex,
  getTrackTransitionDelay,
  parseLyrics,
  projectAudibleTrackElapsed,
  projectBroadcastElapsed,
  reconcileBroadcastClock
} from "./lyricsSync.js";

const STREAM_URL = "https://stm0.inovativa.net/listen/radiomarinha/radio.mp3";
const FALLBACK_COVER = "/imagens/radio_gif.gif";
const TIMER_OPTIONS = [15, 30, 45, 60, 90];
const DAYS = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"];
const DAY_KEYS = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"];
const WEEKDAY_PROGRAMS = [
  ["00:00 – 02:00", "ONBOARD", "Jazz e Blues"],
  ["02:00 – 06:00", "Brisa Marinha", "MPB"],
  ["06:00 – 08:00", "Alvorada", "Nacionais e internacionais"],
  ["08:00 – 19:00", "Portos e Costas", "MPB"],
  ["19:00 – 22:00", "Bons Ventos", "Baladas dos anos 80 e 90"],
  ["22:00 – 24:00", "Mares Tranquilos", "Internacionais românticas"]
];
const WEEKEND_PROGRAMS = {
  5: [["00:00 – 04:00", "ONBOARD", "Jazz e Blues"], ["04:00 – 06:00", "Brisa Marinha", "MPB"], ["06:00 – 08:00", "Alvorada", "Nacionais e internacionais"], ["08:00 – 17:00", "Portos e Costas", "MPB"], ["17:00 – 18:00", "MPB à Bordo", "Músicas brasileiras a bordo"], ["18:00 – 24:00", "Bons Ventos", "Baladas dos anos 80 e 90"]],
  6: [["00:00 – 04:00", "ONBOARD", "Jazz e Blues"], ["04:00 – 06:00", "Brisa Marinha", "MPB"], ["06:00 – 08:00", "Alvorada", "Nacionais e internacionais"], ["08:00 – 18:00", "Portos e Costas", "MPB"], ["18:00 – 24:00", "Bons Ventos", "Baladas dos anos 80 e 90"]]
};
const DEFAULT_SCHEDULE = DAY_KEYS.map((_, dayIndex) => WEEKEND_PROGRAMS[dayIndex] || WEEKDAY_PROGRAMS);

const BRAZILIAN_CAPITALS = [
  { name: "Brasília", state: "DF" },
  { name: "Rio de Janeiro", state: "RJ" },
  { name: "São Paulo", state: "SP" },
  { name: "Salvador", state: "BA" },
  { name: "Belo Horizonte", state: "MG" },
  { name: "Curitiba", state: "PR" },
  { name: "Recife", state: "PE" },
  { name: "Porto Alegre", state: "RS" },
  { name: "Fortaleza", state: "CE" },
  { name: "Manaus", state: "AM" },
  { name: "Goiânia", state: "GO" },
  { name: "Belém", state: "PA" },
  { name: "Florianópolis", state: "SC" },
  { name: "Vitória", state: "ES" },
  { name: "Natal", state: "RN" },
  { name: "Maceió", state: "AL" },
  { name: "João Pessoa", state: "PB" },
  { name: "Cuiabá", state: "MT" },
  { name: "Campo Grande", state: "MS" }
];

function formatRelativeTime(dateString) {
  try {
    const d = new Date(dateString);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffMin < 1) return "agora mesmo";
    if (diffMin < 60) return `há ${diffMin} min`;
    if (diffHours < 24) return `há ${diffHours} h`;
    if (diffDays === 1) return "ontem";
    if (diffDays < 7) return `há ${diffDays} dias`;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  } catch {
    return "";
  }
}

const initialTrack = {
  title: "Rádio Marinha",
  artist: "Programação ao vivo",
  album: "Rádio Marinha Online",
  cover: FALLBACK_COVER,
  elapsed: 0,
  duration: 0,
  durationReliable: false,
  syncAllowed: false,
  playbackId: null,
  playedAt: null,
  playbackSampledAt: 0,
  updatedAt: null
};

function readBufferedAhead(audio, mediaTime) {
  try {
    const ranges = audio?.buffered;
    for (let index = (ranges?.length || 0) - 1; index >= 0; index -= 1) {
      const rangeStart = ranges.start(index);
      const rangeEnd = ranges.end(index);
      if (mediaTime >= rangeStart - .25 && mediaTime <= rangeEnd + .25) {
        const measured = rangeEnd - mediaTime;
        return Number.isFinite(measured) && measured > .05 ? measured : null;
      }
    }
  } catch {
    // Alguns players não expõem TimeRanges durante a reconexão do stream.
  }
  return null;
}

const useFallbackCover = (event) => {
  const image = event.currentTarget;
  const fallbackUrl = new URL(FALLBACK_COVER, window.location.href).href;
  if (image.src !== fallbackUrl) image.src = FALLBACK_COVER;
};

const Icon = ({ children }) => <span aria-hidden="true">{children}</span>;
const ActionIcon = ({ name }) => {
  const paths = {
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.7 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />,
    share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5" /></>,
    timer: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.8 1.8M9 2h6" /></>,
    radio: <><rect x="3" y="7" width="18" height="13" rx="3" /><path d="m7 7 10-4M8 12h5M8 16h3" /><circle cx="17" cy="14" r="2.2" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>,
    history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
    next: <><polygon points="5 4 15 12 5 20 5 4" fill="currentColor" /><line x1="19" y1="5" x2="19" y2="19" strokeWidth="2.2" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
    news: <><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><path d="M18 14h-8M15 18h-5M10 6h8v4h-8V6Z" /></>,
    ticket: <><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M13 5v2M13 11v2M13 17v2" /></>,
    location: <><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>,
    external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>,
    refresh: <><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" /></>,
    chevronDown: <polyline points="6 9 12 15 18 9" />
  };
  return <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

function CoverProgress({ cover, duration, elapsed, playbackSampledAt, title, trackKey, onError }) {
  const frameRef = useRef(null);
  const animationFrameRef = useRef(0);
  const hasDuration = Number.isFinite(duration) && duration > 0;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;

    cancelAnimationFrame(animationFrameRef.current);
    const safeDuration = Math.max(0, Number(duration) || 0);
    const anchorElapsed = Math.max(0, Number(elapsed) || 0);
    const anchorSampledAt = Number(playbackSampledAt) || performance.now();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let previousPaint = 0;

    const updateProgress = (now) => {
      if (!safeDuration) {
        frame.style.setProperty("--cover-progress", "0deg");
        frame.style.setProperty("--cover-pulse", "0deg");
        frame.style.setProperty("--cover-pulse-soft", "0");
        frame.style.setProperty("--cover-pulse-medium", "0");
        frame.style.setProperty("--cover-pulse-strong", "0");
        frame.style.setProperty("--cover-progress-ratio", "0");
        return;
      }

      if (now - previousPaint >= 40) {
        previousPaint = now;
        const liveElapsed = anchorElapsed + Math.max(0, now - anchorSampledAt) / 1000;
        const progress = Math.min(1, Math.max(0, liveElapsed / safeDuration));
        const pulsePhase = reduceMotion ? 1 : (now % 5600) / 5600;
        const pulseCycle = .5 - Math.cos(Math.PI * pulsePhase) / 2;
        const pulseVisibility = reduceMotion
          ? .5
          : Math.max(0, Math.min(1, pulsePhase / .18, (1 - pulsePhase) / .22));
        frame.style.setProperty("--cover-progress", `${progress * 360}deg`);
        frame.style.setProperty("--cover-pulse", `${progress * pulseCycle * 360}deg`);
        frame.style.setProperty("--cover-pulse-soft", String(pulseVisibility * .08));
        frame.style.setProperty("--cover-pulse-medium", String(pulseVisibility * .22));
        frame.style.setProperty("--cover-pulse-strong", String(pulseVisibility * .52));
        frame.style.setProperty("--cover-progress-ratio", String(progress));
        frame.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
      }
      animationFrameRef.current = requestAnimationFrame(updateProgress);
    };

    animationFrameRef.current = requestAnimationFrame(updateProgress);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [duration, elapsed, playbackSampledAt, trackKey]);

  return (
    <div
      ref={frameRef}
      className={`cover-progress${hasDuration ? " has-duration" : " is-static"}`}
      role={hasDuration ? "progressbar" : undefined}
      aria-label={hasDuration ? `Progresso de ${title}` : undefined}
      aria-valuemin={hasDuration ? 0 : undefined}
      aria-valuemax={hasDuration ? 100 : undefined}
    >
      <span className="cover-progress-glass" aria-hidden="true" />
      <img className="cover" src={cover} alt={`Capa de ${title}`} onError={onError} />
    </div>
  );
}

function AutoScrollingLyrics({ audioClockReady, audioPlaying, audioRef, duration, elapsed, lyrics, playbackSampledAt, streamPositionZeroAt, trackKey, title }) {
  const parsedLyrics = useMemo(() => parseLyrics(lyrics), [lyrics]);
  const scrollRef = useRef(null);
  const animationFrameRef = useRef(0);
  const activeLineRef = useRef(-1);
  const lineRefs = useRef([]);
  const pointerStartRef = useRef(null);
  const needsSnapRef = useRef(true);
  const reduceMotionRef = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const playbackRef = useRef({
    clockMode: null,
    correction: 0,
    elapsed: 0,
    lastKaraokeElapsed: -1,
    sampledAt: performance.now(),
    trackKey: null
  });
  const [activeLine, setActiveLine] = useState(-1);
  const [manualPause, setManualPause] = useState(false);
  const [timingAdjustment, setTimingAdjustment] = useState(0);
  const [followEnabled, setFollowEnabled] = useState(() => {
    const storedPreference = getStored("radio-lyrics-follow", null);
    if (typeof storedPreference === "boolean") return storedPreference;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const previousPlayback = playbackRef.current;
    const reconciledClock = reconcileBroadcastClock(previousPlayback, {
      elapsed,
      sampledAt: playbackSampledAt,
      trackKey
    });
    const changedTrack = reconciledClock.changedTrack;
    playbackRef.current = {
      ...previousPlayback,
      ...reconciledClock,
      clockMode: changedTrack ? null : previousPlayback.clockMode,
      lastKaraokeElapsed: changedTrack ? -1 : previousPlayback.lastKaraokeElapsed
    };
  }, [elapsed, playbackSampledAt, trackKey]);

  useEffect(() => {
    cancelAnimationFrame(animationFrameRef.current);
    activeLineRef.current = -1;
    setActiveLine(-1);
    setManualPause(false);
    setTimingAdjustment(0);
    lineRefs.current = [];
    needsSnapRef.current = true;
    const animationFrame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [lyrics, trackKey]);

  const following = followEnabled && !manualPause;

  useEffect(() => {
    if (following) needsSnapRef.current = true;
  }, [following, trackKey]);

  useEffect(() => {
    const requestSnap = () => {
      if (!document.hidden) needsSnapRef.current = true;
    };
    document.addEventListener("visibilitychange", requestSnap);
    window.addEventListener("pageshow", requestSnap);
    return () => {
      document.removeEventListener("visibilitychange", requestSnap);
      window.removeEventListener("pageshow", requestSnap);
    };
  }, []);

  useEffect(() => {
    playbackRef.current.lastKaraokeElapsed = -1;
    needsSnapRef.current = true;
  }, [streamPositionZeroAt]);

  useEffect(() => {
    cancelAnimationFrame(animationFrameRef.current);
    if (!parsedLyrics.rows.length) return undefined;

    let previousFrame = performance.now();
    const updateScroll = (now) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const frameGap = Math.max(0, now - previousFrame);
      const delta = Math.min(64, frameGap);
      if (frameGap > 250) needsSnapRef.current = true;
      previousFrame = now;
      const playback = playbackRef.current;
      const serverElapsed = projectBroadcastElapsed(playback, now);
      const audio = audioRef.current;
      const mediaTime = audio?.currentTime;
      const canUseMediaClock = Boolean(
        audioClockReady
        && audioPlaying
        && audio
        && !audio.paused
        && !audio.ended
        && Number.isFinite(mediaTime)
        && mediaTime >= 0
        && Number.isFinite(streamPositionZeroAt)
      );
      const mediaElapsed = canUseMediaClock
        ? projectAudibleTrackElapsed({
            mediaTime,
            streamPositionZeroAt,
            trackElapsed: playback.elapsed,
            trackSampledAt: playback.sampledAt
          })
        : null;
      const hasMediaClock = Number.isFinite(mediaElapsed);
      const clockMode = hasMediaClock ? "media" : "broadcast";
      if (playback.clockMode !== clockMode) {
        playback.clockMode = clockMode;
        playback.lastKaraokeElapsed = -1;
      }
      const audibleElapsed = hasMediaClock ? mediaElapsed : serverElapsed;
      const monotonicElapsed = playback.lastKaraokeElapsed < 0
        ? audibleElapsed
        : Math.max(audibleElapsed, playback.lastKaraokeElapsed);
      playback.lastKaraokeElapsed = monotonicElapsed;
      const currentElapsed = Math.max(0, monotonicElapsed + timingAdjustment);
      const maximumScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      let targetScroll = scroller.scrollTop;

      if (parsedLyrics.synced) {
        const currentIndex = findActiveLyricIndex(parsedLyrics.rows, currentElapsed);
        if (currentIndex !== activeLineRef.current) {
          activeLineRef.current = currentIndex;
          setActiveLine(currentIndex);
        }
        if (currentIndex >= 0) {
          const line = lineRefs.current[currentIndex];
          if (line) targetScroll = line.offsetTop - scroller.clientHeight * .38 + line.offsetHeight / 2;
        } else {
          targetScroll = 0;
        }
      } else {
        if (activeLineRef.current !== -1) {
          activeLineRef.current = -1;
          setActiveLine(-1);
        }
        const estimatedDuration = Math.max(1, Number(duration) || estimateLyricsDuration(parsedLyrics.rows));
        const introduction = Math.min(12, estimatedDuration * .06);
        const scrollingDuration = Math.max(1, estimatedDuration - introduction);
        const progress = Math.max(0, Math.min(1, (currentElapsed - introduction) / scrollingDuration));
        targetScroll = maximumScroll * progress * .96;
      }

      if (following) {
        targetScroll = Math.max(0, Math.min(maximumScroll, targetScroll));
        if (needsSnapRef.current || reduceMotionRef.current) {
          scroller.scrollTop = targetScroll;
          needsSnapRef.current = false;
        } else {
          const easingDuration = parsedLyrics.synced ? 260 : 720;
          const easing = 1 - Math.exp(-delta / easingDuration);
          scroller.scrollTop += (targetScroll - scroller.scrollTop) * easing;
        }
      }
      animationFrameRef.current = requestAnimationFrame(updateScroll);
    };

    animationFrameRef.current = requestAnimationFrame(updateScroll);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [audioClockReady, audioPlaying, audioRef, duration, following, parsedLyrics, streamPositionZeroAt, timingAdjustment, trackKey]);

  const pauseForInteraction = () => {
    if (!manualPause) setManualPause(true);
  };

  const toggleFollowing = () => {
    if (manualPause) {
      needsSnapRef.current = true;
      setFollowEnabled(true);
      localStorage.setItem("radio-lyrics-follow", JSON.stringify(true));
      setManualPause(false);
      return;
    }
    setFollowEnabled((current) => {
      const next = !current;
      localStorage.setItem("radio-lyrics-follow", JSON.stringify(next));
      return next;
    });
  };

  const adjustTiming = (seconds) => {
    setTimingAdjustment((current) => Math.max(-30, Math.min(30, current + seconds)));
  };

  const controlLabel = manualPause
    ? "Voltar à linha atual"
    : followEnabled
      ? "Pausar rolagem"
      : "Acompanhar letra";
  const controlClass = following ? "active" : "";
  const controlSymbol = following ? "Ⅱ" : "▶";
  const activeTimestamp = activeLine >= 0 ? parsedLyrics.rows[activeLine]?.time : null;
  const nextTimestamp = activeTimestamp === null || activeTimestamp === undefined
    ? null
    : parsedLyrics.rows.find((candidate, candidateIndex) => (
        candidateIndex > activeLine
        && !candidate.blank
        && candidate.time > activeTimestamp + .025
      ))?.time;

  return (
    <div className="lyrics-view">
      <div className="lyrics-toolbar">
        <span className="lyrics-sync-status" role="status" aria-live="polite">
          {manualPause ? "Rolagem pausada" : parsedLyrics.synced ? "Ao vivo · Sincronizada" : "Ao vivo · Acompanhamento aproximado"}
          <i aria-hidden="true" />
        </span>
        <div className="lyrics-toolbar-actions">
          <div className="lyrics-timing" role="group" aria-label="Ajustar a sincronia da letra">
            <span className="lyrics-timing-value" role="status" aria-live="polite">
              {timingAdjustment === 0
                ? "Ajuste"
                : `${timingAdjustment > 0 ? "+" : ""}${timingAdjustment} s`}
            </span>
            <button
              type="button"
              aria-label="Atrasar a letra em 1 segundo"
              title="Atrasar a letra em 1 segundo"
              onClick={() => adjustTiming(-1)}
            >
              −1 s
            </button>
            <button
              type="button"
              aria-label="Zerar ajuste da letra"
              title="Zerar ajuste"
              disabled={timingAdjustment === 0}
              onClick={() => setTimingAdjustment(0)}
            >
              0
            </button>
            <button
              type="button"
              aria-label="Adiantar a letra em 1 segundo"
              title="Adiantar a letra em 1 segundo"
              onClick={() => adjustTiming(1)}
            >
              +1 s
            </button>
          </div>
          <button
            type="button"
            className={`lyrics-follow ${controlClass}`}
            aria-label={controlLabel}
            aria-pressed={followEnabled && !manualPause}
            onClick={toggleFollowing}
          >
            <span aria-hidden="true">{controlSymbol}</span>
            {controlLabel}
          </button>
        </div>
      </div>
      <div className="lyrics-scroll-shell">
        <div
          ref={scrollRef}
          className={`lyrics-scroll${following ? " is-following" : ""}`}
          tabIndex="0"
          aria-label={`Letra original de ${title}`}
          onWheel={pauseForInteraction}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) pauseForInteraction();
          }}
          onPointerDown={(event) => {
            pointerStartRef.current = { x: event.clientX, y: event.clientY };
            pauseForInteraction();
          }}
          onPointerMove={(event) => {
            const start = pointerStartRef.current;
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
              pointerStartRef.current = null;
              pauseForInteraction();
            }
          }}
          onPointerUp={() => { pointerStartRef.current = null; }}
          onPointerCancel={() => {
            if (pointerStartRef.current) pauseForInteraction();
            pointerStartRef.current = null;
          }}
        >
          {parsedLyrics.rows.map((row, index) => {
            if (row.blank) return <span className="lyric-break" key={row.id} aria-hidden="true" />;
            const isCurrent = Boolean(
              parsedLyrics.synced
              && activeTimestamp !== null
              && activeTimestamp !== undefined
              && Math.abs(row.time - activeTimestamp) < .025
            );
            const isNext = Boolean(
              parsedLyrics.synced
              && nextTimestamp !== null
              && nextTimestamp !== undefined
              && Math.abs(row.time - nextTimestamp) < .025
            );
            const lineDistance = activeLine >= 0 ? Math.abs(index - activeLine) : 0;
            const emphasisClass = isCurrent
              ? "is-current"
              : isNext
                ? "is-next"
                : parsedLyrics.synced && activeLine >= 0 && lineDistance >= 4
                  ? "is-distant"
                  : parsedLyrics.synced && activeLine >= 0
                    ? "is-nearby"
                    : "";
            return (
              <p
                ref={(element) => { lineRefs.current[index] = element; }}
                className={`lyric-line ${emphasisClass}`}
                aria-current={parsedLyrics.synced && index === activeLine ? "true" : undefined}
                key={row.id}
              >
                <span className="lyric-original" dir="auto">{row.text}</span>
              </p>
            );
          })}
        </div>
        {manualPause && (
          <button
            type="button"
            className="lyrics-return-current"
            onClick={toggleFollowing}
          >
            <span aria-hidden="true">↥</span>
            Voltar à linha atual
          </button>
        )}
      </div>
    </div>
  );
}

function SloganOceanWave({ active }) {
  const canvasRef = useRef(null);
  const navigationTargetRef = useRef(active);
  navigationTargetRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let animationFrame = 0;
    let previousFrame = performance.now();
    let previousRender = previousFrame;
    let simulationTime = 0;
    let previousImpact = -1;
    let lastSplashTime = -Infinity;
    let isIntersecting = true;
    let particles = [];
    let gradients = {};
    let shipHeave = null;
    let shipHeaveVelocity = 0;
    let shipPitch = 0;
    let shipPitchVelocity = 0;
    let shipSurge = 0;
    let shipSurgeVelocity = 0;
    let shipImpact = 0;
    let previousBowWater = null;
    let shipReady = false;
    let seaEnergy = navigationTargetRef.current ? 1 : 0;
    let anchorProgress = navigationTargetRef.current ? 1 : 0;
    let pendulumTime = 0;
    const shipImage = new Image();
    shipImage.decoding = "async";
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduceMotion = reducedMotionQuery.matches;
    const minimumFrameTime = coarsePointer ? 1000 / 30 : 0;
    const waterlineRatio = .37;

    const smoothstep = (value) => value * value * (3 - 2 * value);
    const navigationStrength = () => smoothstep(seaEnergy);
    const waveAmplitude = () => .12 + navigationStrength() * .88;
    const waveScale = () => Math.max(.78, Math.min(1.45, height / 30));
    const vesselWidth = () => Math.max(112, Math.min(156, width * .62));
    const obstacleX = () => Math.max(
      12,
      Math.min(width * .42, width - vesselWidth() - 20)
    );
    const surfaceY = (x, time) => {
      const scale = waveScale();
      const baseline = height * waterlineRatio;
      const amplitude = waveAmplitude();
      const swellPhase = x * .017 - time * .69 + 2.1;
      const primaryPhase = x * .034 - time * 1.52;
      const chopPhase = x * .086 - time * 2.48 + .85;
      const crossSeaPhase = x * .052 + time * .94 + 1.7;
      const groupEnergy = 1 + Math.sin(x * .006 - time * .2 + .4) * .1;
      const directWave = baseline
        - (Math.sin(primaryPhase) + Math.sin(primaryPhase * 2 + .38) * .2) * 3.75 * scale * amplitude * groupEnergy
        - Math.sin(chopPhase) * 1.28 * scale * amplitude
        - Math.sin(swellPhase) * .9 * scale * amplitude
        - Math.sin(crossSeaPhase) * .52 * scale * amplitude;
      const distanceToObstacle = obstacleX() - x;
      if (distanceToObstacle <= 0) return directWave;
      const reflectionFalloff = Math.exp(-distanceToObstacle / Math.max(46, width * .25));
      const reflectedWave = Math.sin((obstacleX() * 2 - x) * .047 - time * 1.18 + .4) * .72 * scale * reflectionFalloff * amplitude;
      return directWave - reflectedWave;
    };
    const surfaceX = (x, time) => {
      if (x <= 0 || x >= width) return x;
      const scale = waveScale();
      const amplitude = waveAmplitude();
      return x
        + Math.cos(x * .034 - time * 1.52) * .88 * scale * amplitude
        + Math.cos(x * .068 - time * 3.04 + .38) * .18 * scale * amplitude
        + Math.cos(x * .086 - time * 2.48 + .85) * .24 * scale * amplitude
        - Math.cos(x * .052 + time * .94 + 1.7) * .1 * scale * amplitude;
    };
    const deepY = (x, time) => {
      const scale = waveScale();
      const amplitude = waveAmplitude();
      return height * .495
        - Math.sin(x * .025 - time * .78 + 1.45) * 2.65 * scale * amplitude
        - Math.sin(x * .054 - time * 1.1) * .78 * scale * amplitude;
    };
    const middleY = (x, time) => {
      const scale = waveScale();
      const amplitude = waveAmplitude();
      return height * .435
        - Math.sin(x * .03 - time * 1.02 + .7) * 2.9 * scale * amplitude
        - Math.sin(x * .071 - time * 1.74 + 2.35) * .82 * scale * amplitude;
    };

    const createGradients = () => {
      const deepFill = context.createLinearGradient(0, height * .35, 0, height * .55);
      deepFill.addColorStop(0, "rgba(20, 126, 167, .18)");
      deepFill.addColorStop(1, "rgba(4, 50, 78, 0)");
      const middleFill = context.createLinearGradient(0, height * .38, 0, height * .55);
      middleFill.addColorStop(0, "rgba(24, 145, 184, .2)");
      middleFill.addColorStop(1, "rgba(4, 50, 78, .015)");
      const waterFill = context.createLinearGradient(0, height * waterlineRatio, 0, height * .55);
      waterFill.addColorStop(0, "rgba(54, 198, 226, .42)");
      waterFill.addColorStop(.5, "rgba(12, 112, 157, .29)");
      waterFill.addColorStop(1, "rgba(4, 49, 76, .03)");
      const surfaceStroke = context.createLinearGradient(0, 0, width, 0);
      surfaceStroke.addColorStop(0, "#117ca9");
      surfaceStroke.addColorStop(.48, "#55d1ed");
      surfaceStroke.addColorStop(1, "#1786b3");
      gradients = { deepFill, middleFill, waterFill, surfaceStroke };
    };

    const traceSurface = (waveFunction, time, horizontalDisplacement) => {
      context.beginPath();
      context.moveTo(horizontalDisplacement ? horizontalDisplacement(0, time) : 0, waveFunction(0, time));
      for (let x = 2; x <= width + 2; x += 2) {
        context.lineTo(horizontalDisplacement ? horizontalDisplacement(x, time) : x, waveFunction(x, time));
      }
    };

    const drawWaveLayer = (waveFunction, time, fillStyle, strokeStyle, lineWidth, horizontalDisplacement) => {
      traceSurface(waveFunction, time, horizontalDisplacement);
      const waterFloor = height * .55;
      context.lineTo(width + 2, waterFloor);
      context.lineTo(0, waterFloor);
      context.closePath();
      context.fillStyle = fillStyle;
      context.fill();
      traceSurface(waveFunction, time, horizontalDisplacement);
      context.strokeStyle = strokeStyle;
      context.lineWidth = lineWidth;
      context.lineCap = "round";
      context.stroke();
    };

    const drawCrestFoam = (time) => {
      const scale = waveScale();
      const amplitude = waveAmplitude();
      const threshold = height * waterlineRatio - 2.7 * scale * amplitude;
      let drawing = false;
      context.beginPath();
      for (let x = 0; x <= width + 2; x += 1.5) {
        const y = surfaceY(x, time);
        const previousY = surfaceY(x - 1.5, time);
        const nextY = surfaceY(x + 1.5, time);
        const slope = (nextY - previousY) * .5;
        const curvature = previousY + nextY - y * 2;
        const isCrest = y < threshold && Math.abs(slope) < .7 * scale && curvature > -.04 * scale;
        if (isCrest && !drawing) {
          context.moveTo(surfaceX(x, time), y - .3);
          drawing = true;
        } else if (isCrest) {
          context.lineTo(surfaceX(x, time), y - .3);
        } else {
          drawing = false;
        }
      }
      context.strokeStyle = "rgba(221, 248, 255, .78)";
      context.lineWidth = Math.max(.75, 1.05 * scale);
      context.lineCap = "round";
      context.shadowColor = "rgba(96, 215, 240, .55)";
      context.shadowBlur = 2.5 * scale;
      context.stroke();
      context.shadowBlur = 0;

      context.beginPath();
      for (let x = 5; x <= width; x += 9) {
        const y = surfaceY(x, time);
        if (y < threshold - .45 * scale && Math.sin(x * .41 + time * 1.7) > -.1) {
          context.moveTo(surfaceX(x, time) - 1.3 * scale, y + .7 * scale);
          context.quadraticCurveTo(surfaceX(x, time), y - .15 * scale, surfaceX(x, time) + 1.8 * scale, y + .45 * scale);
        }
      }
      context.strokeStyle = "rgba(229, 251, 255, .48)";
      context.lineWidth = Math.max(.55, .68 * scale);
      context.stroke();
    };

    const spawnImpact = (x, y) => {
      const scale = waveScale();
      const amount = width < 170 ? 11 : 17;
      for (let index = 0; index < amount; index += 1) {
        const life = .58 + Math.random() * .4;
        particles.push({
          x: x - 1,
          y: y - 1,
          vx: -(7 + Math.random() * 23) * scale + (Math.random() - .5) * 4,
          vy: -(23 + Math.random() * 27) * scale,
          gravity: (55 + Math.random() * 24) * scale,
          radius: (.55 + Math.random() * .65) * scale,
          life,
          maxLife: life,
          mist: index % 4 === 0
        });
      }
      particles = particles.slice(-34);
    };

    const updateAndDrawParticles = (deltaTime) => {
      context.save();
      context.globalCompositeOperation = "screen";
      particles = particles.filter((particle) => {
        particle.life -= deltaTime;
        if (particle.life <= 0) return false;
        particle.vy += particle.gravity * deltaTime;
        particle.x += particle.vx * deltaTime;
        particle.y += particle.vy * deltaTime;
        const opacity = Math.min(1, particle.life / particle.maxLife) * (particle.mist ? .42 : .9);
        if (particle.mist) {
          context.fillStyle = `rgba(188, 237, 249, ${opacity})`;
          context.beginPath();
          context.arc(particle.x, particle.y, particle.radius * 1.35, 0, Math.PI * 2);
          context.fill();
        } else {
          context.strokeStyle = `rgba(224, 250, 255, ${opacity})`;
          context.lineWidth = Math.max(.75, particle.radius);
          context.lineCap = "round";
          context.beginPath();
          context.moveTo(particle.x, particle.y);
          context.lineTo(particle.x - particle.vx * .03, particle.y - particle.vy * .03);
          context.stroke();
        }
        return true;
      });
      context.restore();
    };

    const updateSpring = (value, velocity, target, frequency, damping, deltaTime) => {
      if (!Number.isFinite(value) || deltaTime <= 0) return [target, 0];
      const omega = Math.PI * 2 * frequency;
      const f = 1 + 2 * deltaTime * damping * omega;
      const omegaSquared = omega * omega;
      const stepOmega = deltaTime * omegaSquared;
      const stepSquaredOmega = deltaTime * stepOmega;
      const inverse = 1 / (f + stepSquaredOmega);
      const nextValue = (f * value + deltaTime * velocity + stepSquaredOmega * target) * inverse;
      const nextVelocity = (velocity + stepOmega * (target - value)) * inverse;
      return [nextValue, nextVelocity];
    };

    const drawShip = (time, deltaTime) => {
      const scale = waveScale();
      const fallbackX = obstacleX();
      const fallbackY = surfaceY(fallbackX, time);
      if (!shipReady) return { x: fallbackX, y: fallbackY, impactStrength: 0 };

      const renderedWidth = vesselWidth();
      const aspectRatio = shipImage.naturalWidth / shipImage.naturalHeight || 3.86;
      const renderedHeight = renderedWidth / aspectRatio;
      const isStaticFrame = deltaTime <= 0;

      const surgeTarget = (
        Math.sin(time * .48 + .65) * 1.08
        + Math.sin(time * .21 + 2.25) * .46
      ) * scale * navigationStrength();
      [shipSurge, shipSurgeVelocity] = updateSpring(shipSurge, shipSurgeVelocity, surgeTarget, .28, .92, deltaTime);

      const x = obstacleX() + shipSurge;
      const waterSamples = [[.08, .1], [.27, .22], [.5, .36], [.73, .22], [.92, .1]];
      const sampledHeave = waterSamples.reduce(
        (sum, [position, weight]) => sum + surfaceY(x + renderedWidth * position, time) * weight,
        0
      ) - .2 * scale;
      const heaveBaseline = height * waterlineRatio - .2 * scale;
      const heaveTarget = Math.max(
        heaveBaseline - 4.35 * scale * waveAmplitude(),
        Math.min(heaveBaseline + 4.35 * scale * waveAmplitude(), sampledHeave)
      );
      [shipHeave, shipHeaveVelocity] = updateSpring(shipHeave, shipHeaveVelocity, heaveTarget, .74, .78, deltaTime);

      const bowWaterY = (
        surfaceY(x + renderedWidth * .07, time)
        + surfaceY(x + renderedWidth * .17, time)
      ) * .5;
      const sternWaterY = (
        surfaceY(x + renderedWidth * .83, time)
        + surfaceY(x + renderedWidth * .93, time)
      ) * .5;

      const pitchTarget = Math.max(
        -.068,
        Math.min(.068, Math.atan2(sternWaterY - bowWaterY, renderedWidth * .76) * 1.06)
      );
      [shipPitch, shipPitchVelocity] = updateSpring(shipPitch, shipPitchVelocity, pitchTarget, .66, .8, deltaTime);

      const waveVelocity = !isStaticFrame && previousBowWater !== null ? (bowWaterY - previousBowWater) / deltaTime : 0;
      const closingVelocity = shipHeaveVelocity - waveVelocity;
      const crestFactor = Math.max(0, Math.min(1, (height * waterlineRatio - bowWaterY - scale) / (3.8 * scale)));
      const rawImpact = Math.max(0, Math.min(1, crestFactor * .62 + Math.max(0, closingVelocity) * .035)) * navigationStrength();
      const impactResponse = rawImpact > shipImpact ? .07 : .24;
      const impactBlend = !isStaticFrame ? 1 - Math.exp(-deltaTime / impactResponse) : 0;
      shipImpact += (rawImpact - shipImpact) * impactBlend;
      if (!isStaticFrame) previousBowWater = bowWaterY;
      const impactStrength = isStaticFrame ? 0 : shipImpact;
      const sternX = x + renderedWidth * .96;

      // Duas trilhas segmentadas na popa, dissipando em vez de formar uma linha decorativa.
      const wakeLength = Math.max(0, Math.min(width - sternX + 1, Math.max(18, Math.min(27, renderedWidth * .27))));
      if (navigationStrength() > .04 && wakeLength > 5) {
        const wakeY = surfaceY(sternX, time) + .7 * scale;
        const wakeSegments = Math.max(7, Math.round(wakeLength / 1.8));
        const drawWakeTrail = (offset, amplitude, lineWidth, opacity, phase) => {
          for (let index = 0; index < wakeSegments; index += 1) {
            const startProgress = index / wakeSegments;
            const endProgress = (index + 1) / wakeSegments;
            const startX = sternX - 1 + wakeLength * startProgress;
            const endX = sternX - 1 + wakeLength * endProgress;
            const startY = wakeY + offset + Math.sin(startProgress * Math.PI * 3 - time * 2.8 + phase) * amplitude;
            const endY = wakeY + offset + Math.sin(endProgress * Math.PI * 3 - time * 2.8 + phase) * amplitude;
            const segmentOpacity = opacity * Math.pow(1 - startProgress, 1.6);
            context.strokeStyle = `rgba(211, 246, 253, ${segmentOpacity})`;
            context.lineWidth = lineWidth;
            context.beginPath();
            context.moveTo(startX, startY);
            context.quadraticCurveTo((startX + endX) * .5, (startY + endY) * .5 - .18 * scale, endX, endY);
            context.stroke();
          }
        };
        context.save();
        context.globalCompositeOperation = "screen";
        context.lineCap = "round";
        drawWakeTrail(0, .55 * scale, Math.max(.78, 1.05 * scale), .56 * navigationStrength(), 0);
        drawWakeTrail(1.05 * scale, 1.05 * scale, Math.max(.5, .65 * scale), .34 * navigationStrength(), 1.1);
        context.restore();
      }

      if (impactStrength > .04) {
        const y = bowWaterY;
        const plumeHeight = (3.4 + impactStrength * 5.4) * scale;
        const plumeReach = (5.2 + impactStrength * 4.2) * scale;
        context.save();
        context.globalCompositeOperation = "screen";
        context.beginPath();
        context.moveTo(x - 2.8 * scale, y + .7 * scale);
        context.bezierCurveTo(
          x - plumeReach,
          y - plumeHeight * .28,
          x - plumeReach * .72,
          y - plumeHeight,
          x - 1.25 * scale,
          y - plumeHeight * .78
        );
        context.bezierCurveTo(
          x - 3.3 * scale,
          y - plumeHeight * .55,
          x - 2.8 * scale,
          y - 1.1 * scale,
          x - .4 * scale,
          y + .35 * scale
        );
        context.closePath();
        context.fillStyle = `rgba(87, 199, 225, ${.07 + impactStrength * .13})`;
        context.fill();
        context.strokeStyle = `rgba(226, 250, 255, ${.24 + impactStrength * .58})`;
        context.lineWidth = Math.max(.72, scale * .9);
        context.lineJoin = "round";
        context.stroke();

        const beadOpacity = .18 + impactStrength * .66;
        [[-.35, -.98, .64], [-.72, -.78, .46], [-.9, -.45, .34]].forEach(([offsetX, offsetY, radius]) => {
          context.beginPath();
          context.arc(x + plumeReach * offsetX, y + plumeHeight * offsetY, radius * scale, 0, Math.PI * 2);
          context.fillStyle = `rgba(231, 251, 255, ${beadOpacity})`;
          context.fill();
        });

        context.beginPath();
        context.arc(x - 1.5 * scale, y + .6 * scale, (3.4 + impactStrength * 2.2) * scale, Math.PI * 1.06, Math.PI * 1.82);
        context.strokeStyle = `rgba(218, 248, 255, ${.16 + impactStrength * .42})`;
        context.lineWidth = Math.max(.65, scale);
        context.lineCap = "round";
        context.stroke();
        context.restore();
      }

      const shipCenterX = x + renderedWidth * .5;
      const crispCenterX = Math.round(shipCenterX * pixelRatio) / pixelRatio;
      const crispHeave = Math.round(shipHeave * pixelRatio) / pixelRatio;
      context.save();
      context.translate(crispCenterX, crispHeave);
      context.rotate(shipPitch);

      // Sombra estreita sob o casco para integrar o recorte ao mar.
      context.beginPath();
      context.ellipse(0, 1.9, renderedWidth * .43, 1.25 * scale, 0, 0, Math.PI * 2);
      context.fillStyle = "rgba(1, 20, 33, .3)";
      context.fill();

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.shadowColor = "rgba(0, 8, 16, .3)";
      context.shadowBlur = 1.15 * scale;
      context.shadowOffsetY = .7 * scale;
      context.drawImage(shipImage, -renderedWidth * .5, -renderedHeight * .88, renderedWidth, renderedHeight);

      // A âncora pertence ao navio: fundeada na proa quando a rádio está
      // parada e recolhida suavemente antes de o navio voltar a navegar.
      const anchorTravel = smoothstep(anchorProgress);
      const anchorOpacity = .8 + (1 - anchorTravel) * .2;
      if (anchorOpacity > .01) {
        const detailScale = Math.max(.85, Math.min(1.22, width / 190));
        const bowX = -renderedWidth * .39;
        const hawseY = -renderedHeight * .16;
        const deployedChainLength = Math.max(34, Math.min(50, height * .42));
        const chainLength = (deployedChainLength * (1 - anchorTravel) + 1.5 * anchorTravel) * detailScale;
        const anchorSize = (9.2 * (1 - anchorTravel) + 2.5 * anchorTravel) * detailScale;
        const deployedAmount = 1 - anchorTravel;
        const pendulumOffset = (
          Math.sin(pendulumTime * .78)
          + Math.sin(pendulumTime * 1.31 + .9) * .28
        ) * 1.9 * detailScale * (.04 + deployedAmount * .96);
        const stowedOffsetX = anchorTravel * 2.2 * detailScale;
        const chainEndX = bowX - .4 * scale + pendulumOffset + stowedOffsetX;
        const pendulumAngle = pendulumOffset / Math.max(20, chainLength) * .72;
        context.save();
        context.globalAlpha = anchorOpacity;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.shadowColor = "rgba(0, 7, 13, .62)";
        context.shadowBlur = 2 * scale;

        // Corrente de aço, com uma base escura para continuar legível sobre a água.
        context.globalAlpha = anchorOpacity * (.06 + deployedAmount * .94);
        context.setLineDash([1.35 * scale, 1.2 * scale]);
        context.beginPath();
        context.moveTo(bowX, hawseY);
        context.quadraticCurveTo(
          bowX + pendulumOffset * .28,
          hawseY + chainLength * .46,
          chainEndX,
          hawseY + chainLength
        );
        context.strokeStyle = "#38454e";
        context.lineWidth = Math.max(1.5, 1.45 * scale);
        context.stroke();
        context.strokeStyle = "#e8eff4";
        context.lineWidth = Math.max(.8, .75 * scale);
        context.stroke();
        context.setLineDash([]);

        // A âncora reduz pela perspectiva e termina apoiada no escovém da proa.
        context.globalAlpha = anchorOpacity;
        context.translate(chainEndX, hawseY + chainLength + anchorSize * .72);
        context.rotate(pendulumAngle);

        const steel = context.createLinearGradient(-anchorSize, 0, anchorSize, 0);
        steel.addColorStop(0, "#66737c");
        steel.addColorStop(.24, "#d7e0e5");
        steel.addColorStop(.46, "#f2f6f8");
        steel.addColorStop(.7, "#9ca8b0");
        steel.addColorStop(1, "#56636c");
        context.fillStyle = steel;
        context.strokeStyle = "#46535c";
        context.lineWidth = Math.max(.58, anchorSize * .12);

        // Stockless anchor: haste sem cepo, coroa articulada e patas largas.
        context.beginPath();
        context.arc(0, -anchorSize * .79, anchorSize * .27, 0, Math.PI * 2);
        context.fill();
        context.stroke();

        context.beginPath();
        context.arc(0, -anchorSize * .79, anchorSize * .11, 0, Math.PI * 2);
        context.fillStyle = "#26343e";
        context.fill();

        context.fillStyle = steel;
        context.beginPath();
        context.moveTo(-anchorSize * .16, -anchorSize * .55);
        context.lineTo(anchorSize * .16, -anchorSize * .55);
        context.lineTo(anchorSize * .2, anchorSize * .48);
        context.lineTo(anchorSize * .38, anchorSize * .68);
        context.lineTo(-anchorSize * .38, anchorSize * .68);
        context.lineTo(-anchorSize * .2, anchorSize * .48);
        context.closePath();
        context.fill();
        context.stroke();

        // Patas móveis e largas, características da âncora sem cepo.
        context.beginPath();
        context.moveTo(-anchorSize * .08, anchorSize * .53);
        context.lineTo(-anchorSize * .7, anchorSize * .58);
        context.lineTo(-anchorSize * 1.02, anchorSize * .08);
        context.lineTo(-anchorSize * .52, anchorSize * .25);
        context.lineTo(-anchorSize * .31, anchorSize * .48);
        context.closePath();
        context.moveTo(anchorSize * .08, anchorSize * .53);
        context.lineTo(anchorSize * .7, anchorSize * .58);
        context.lineTo(anchorSize * 1.02, anchorSize * .08);
        context.lineTo(anchorSize * .52, anchorSize * .25);
        context.lineTo(anchorSize * .31, anchorSize * .48);
        context.closePath();
        context.fill();
        context.stroke();

        context.beginPath();
        context.ellipse(0, anchorSize * .62, anchorSize * .35, anchorSize * .17, 0, 0, Math.PI * 2);
        context.fill();
        context.stroke();

        // Reflexo central curto para sugerir metal polido sem perder o desenho.
        context.beginPath();
        context.moveTo(-anchorSize * .055, -anchorSize * .43);
        context.lineTo(-anchorSize * .035, anchorSize * .34);
        context.strokeStyle = "rgba(255,255,255,.72)";
        context.lineWidth = Math.max(.4, anchorSize * .055);
        context.stroke();
        context.restore();
      }
      context.restore();

      // A superfície passa na frente da parte inferior do casco.
      context.save();
      context.globalCompositeOperation = "screen";
      context.beginPath();
      for (let waterX = x - 1; waterX <= sternX + 1; waterX += 2) {
        const waterY = surfaceY(waterX, time) + .55 * scale;
        if (waterX === x - 1) context.moveTo(surfaceX(waterX, time), waterY);
        else context.lineTo(surfaceX(waterX, time), waterY);
      }
      context.strokeStyle = "rgba(212, 247, 253, .72)";
      context.lineWidth = Math.max(.68, scale * .72);
      context.lineCap = "round";
      context.stroke();
      context.restore();

      return { x, y: bowWaterY, impactStrength };
    };

    const drawFrame = (elapsed, deltaTime, isStatic = false) => {
      context.clearRect(0, 0, width, height);
      drawWaveLayer(deepY, elapsed, gradients.deepFill, "rgba(52, 148, 186, .34)", Math.max(.65, waveScale() * .75));
      drawWaveLayer(middleY, elapsed, gradients.middleFill, "rgba(63, 174, 207, .28)", Math.max(.58, waveScale() * .65));
      drawWaveLayer(surfaceY, elapsed, gradients.waterFill, gradients.surfaceStroke, Math.max(1.15, waveScale() * 1.55), surfaceX);
      drawCrestFoam(elapsed);

      const impactPoint = drawShip(elapsed, isStatic ? 0 : deltaTime);
      const impactStrength = impactPoint.impactStrength;
      if (navigationStrength() > .45 && shipReady && !isStatic && impactStrength > .38 && previousImpact <= .38 && elapsed - lastSplashTime > 1.1) {
        spawnImpact(impactPoint.x, impactPoint.y);
        lastSplashTime = elapsed;
      }
      previousImpact = impactStrength;
      updateAndDrawParticles(isStatic ? 0 : deltaTime);
    };

    const render = (now) => {
      if (minimumFrameTime && now - previousRender < minimumFrameTime) {
        animationFrame = requestAnimationFrame(render);
        return;
      }
      const deltaTime = Math.min(.034, Math.max(0, (now - previousFrame) / 1000));
      previousFrame = now;
      previousRender = now;
      const target = navigationTargetRef.current ? 1 : 0;
      const seaResponse = target ? 1.65 : 2.1;
      const anchorResponse = target ? .52 : .72;
      seaEnergy += (target - seaEnergy) * (1 - Math.exp(-deltaTime / seaResponse));
      anchorProgress += (target - anchorProgress) * (1 - Math.exp(-deltaTime / anchorResponse));
      pendulumTime += deltaTime;
      if (!reduceMotion) simulationTime += deltaTime * (.025 + navigationStrength() * .975);
      drawFrame(simulationTime || .8, reduceMotion ? 0 : deltaTime, reduceMotion);
      animationFrame = requestAnimationFrame(render);
    };

    const stopAnimation = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };
    const startAnimation = () => {
      stopAnimation();
      particles = [];
      previousImpact = -1;
      lastSplashTime = -Infinity;
      shipImpact = 0;
      previousBowWater = null;
      const now = performance.now();
      previousFrame = now;
      previousRender = now;
      if (document.hidden || !isIntersecting) {
        drawFrame(simulationTime || .8, 0, true);
      } else {
        animationFrame = requestAnimationFrame(render);
      }
    };
    const resizeCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      pixelRatio = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      createGradients();
      startAnimation();
    };
    const handleVisibility = () => document.hidden ? stopAnimation() : startAnimation();
    const handleReducedMotion = (event) => {
      reduceMotion = event.matches;
      particles = [];
      startAnimation();
    };
    const handleShipLoad = () => {
      shipReady = true;
      startAnimation();
    };

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeCanvas);
    const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      isIntersecting = entry.isIntersecting;
      if (isIntersecting) startAnimation();
      else stopAnimation();
    }, { threshold: .01 });
    resizeObserver?.observe(canvas);
    intersectionObserver?.observe(canvas);
    if (!resizeObserver) window.addEventListener("resize", resizeCanvas);
    document.addEventListener("visibilitychange", handleVisibility);
    reducedMotionQuery.addEventListener?.("change", handleReducedMotion);
    shipImage.addEventListener("load", handleShipLoad);
    shipImage.src = "/imagens/navio-f200-v4.png";
    resizeCanvas();

    return () => {
      stopAnimation();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resizeCanvas);
      document.removeEventListener("visibilitychange", handleVisibility);
      reducedMotionQuery.removeEventListener?.("change", handleReducedMotion);
      shipImage.removeEventListener("load", handleShipLoad);
    };
  }, []);

  return <canvas ref={canvasRef} className="slogan-wave-canvas" />;
}

function getStored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function formatClock(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function parseTimeMinutes(value, isEndTime = false) {
  if (!value) return 0;
  const [hours, minutes] = value.split(":").map(Number);
  const total = (hours || 0) * 60 + (minutes || 0);
  if (isEndTime && (value.trim() === "24:00" || (value.trim() === "00:00" && total === 0))) {
    return 1440;
  }
  return total;
}

function getCurrentProgram(schedule, date = new Date()) {
  const fallback = { title: "Programação ao vivo", description: "Rádio Marinha" };
  if (!schedule || !schedule.length) return fallback;
  const dayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1;
  const programs = schedule[dayIndex] || [];
  const currentMinutes = date.getHours() * 60 + date.getMinutes();

  const scheduledProgram = programs.find(([time]) => {
    const [startText, endText] = time.split(/\s*[–-]\s*/);
    if (!endText) return false;
    const startMin = parseTimeMinutes(startText, false);
    const endMin = parseTimeMinutes(endText, true);
    return currentMinutes >= startMin && currentMinutes < endMin;
  });

  if (!scheduledProgram) return fallback;
  return {
    title: scheduledProgram[1] || fallback.title,
    description: scheduledProgram[2] || fallback.description
  };
}

function getUpcomingProgramsList(schedule, date = new Date(), limit = 6) {
  if (!schedule || !schedule.length) return [];
  const currentDayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1;
  const currentMinutes = date.getHours() * 60 + date.getMinutes();

  const upcoming = [];

  // 1. Programas restantes no dia de hoje
  const todayPrograms = schedule[currentDayIndex] || [];
  const currentProgramIndex = todayPrograms.findIndex(([time]) => {
    const [startText, endText] = time.split(/\s*[–-]\s*/);
    if (!endText) return false;
    const startMin = parseTimeMinutes(startText, false);
    const endMin = parseTimeMinutes(endText, true);
    return currentMinutes >= startMin && currentMinutes < endMin;
  });

  const startIndex = currentProgramIndex !== -1 ? currentProgramIndex + 1 : 0;
  for (let i = startIndex; i < todayPrograms.length; i += 1) {
    const [time, title, description] = todayPrograms[i];
    const [startTime] = time.split(/\s*[–-]\s*/);
    if (currentProgramIndex === -1 && parseTimeMinutes(startTime, false) <= currentMinutes) {
      continue;
    }
    upcoming.push({
      title,
      description,
      time: startTime,
      fullTime: time,
      isNextDay: false
    });
    if (upcoming.length >= limit) return upcoming;
  }

  // 2. Se acabaram TODOS os programas de hoje, exibir ESTRITAMENTE APENAS O PRÓXIMO programa do dia seguinte
  if (upcoming.length === 0) {
    const nextDayIndex = (currentDayIndex + 1) % 7;
    const nextDayPrograms = schedule[nextDayIndex] || [];
    if (nextDayPrograms.length > 0) {
      const [time, title, description] = nextDayPrograms[0];
      const [startTime] = time.split(/\s*[–-]\s*/);
      upcoming.push({
        title,
        description,
        time: startTime,
        fullTime: time,
        isNextDay: true
      });
    }
  }

  return upcoming;
}

function UpcomingProgramsTicker({ programs = [], onOpenSchedule }) {
  const [index, setIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (programs.length <= 1 || isHovered) return;
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % programs.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [programs.length, isHovered]);

  useEffect(() => {
    setIndex(0);
  }, [programs]);

  if (!programs.length) return null;

  const currentProgram = programs[index] || programs[0];

  return (
    <div
      className="program-roulette-container"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onOpenSchedule}
      title="Clique para ver a grade completa"
      role="button"
      tabIndex={0}
    >
      <div className="program-roulette-track-mask">
        <div 
          className="program-roulette-track"
          style={{ transform: `translateY(-${index * 30}px)` }}
        >
          {programs.map((prog, i) => (
            <div className="program-roulette-stage" key={i}>
              <span className="roulette-time-badge">
                {prog.isNextDay ? `Amanhã ${prog.time}` : `Às ${prog.time}`}
              </span>
              <span className="roulette-program-name">{prog.title}</span>
              <span className="roulette-divider">•</span>
              <span className="roulette-genre-desc">{prog.description}</span>
            </div>
          ))}
        </div>
      </div>

      {programs.length > 1 && (
        <div className="roulette-indicators" aria-hidden="true">
          {programs.map((_, i) => (
            <span
              key={i}
              className={`roulette-step-dot ${i === index ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setIndex(i);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RealisticHelmPlayButton({ playing, loading, onClick }) {
  const wheelRef = useRef(null);
  const angleRef = useRef(0);
  const velocityRef = useRef(0);

  useEffect(() => {
    let animationFrameId;
    let lastTime = performance.now();

    const animate = (currentTime) => {
      const deltaTime = Math.min(48, Math.max(0, currentTime - lastTime)) / 1000;
      lastTime = currentTime;

      const targetVelocity = playing ? 26 : 0; // 26 graus/s
      const friction = playing ? 3.0 : 1.6; // Aceleração suave e frenagem gradual
      velocityRef.current += (targetVelocity - velocityRef.current) * Math.min(1, friction * deltaTime);

      angleRef.current = (angleRef.current + velocityRef.current * deltaTime) % 360;

      if (wheelRef.current) {
        wheelRef.current.style.transform = `rotate(${angleRef.current.toFixed(2)}deg)`;
      }

      if (playing || velocityRef.current > 0.05) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [playing]);

  const angles = [0, 45, 90, 135, 180, 225, 270, 315];
  const ropeAngles = [22.5, 112.5, 202.5, 292.5]; // As 4 amarras de corda náutica
  const actionLabel = loading ? "Conectando à rádio" : playing ? "Pausar rádio" : "Ouvir rádio";

  return (
    <button
      className="realistic-helm-button"
      onClick={onClick}
      aria-label={actionLabel}
      type="button"
    >
      <div className="realistic-helm-aura" aria-hidden="true" />
      <svg
        className="realistic-helm-svg"
        viewBox="0 0 200 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          {/* Madeira Naval Autêntica e Homogênea (Cedro / Teca Realista) */}
          <linearGradient id="timaoCoverGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#7E5935" />
            <stop offset="30%" stopColor="#674729" />
            <stop offset="70%" stopColor="#54381F" />
            <stop offset="100%" stopColor="#3E2815" />
          </linearGradient>

          {/* Gradiente de Brilho e Relevo 3D da Madeira */}
          <linearGradient id="timaoWoodHighlight" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255, 255, 255, 0.40)" />
            <stop offset="25%" stopColor="rgba(255, 255, 255, 0.10)" />
            <stop offset="70%" stopColor="rgba(0, 0, 0, 0.25)" />
            <stop offset="100%" stopColor="rgba(0, 0, 0, 0.65)" />
          </linearGradient>

          {/* Gradiente das Cordas Náuticas de Sisal (4 Amarras Douradas) */}
          <linearGradient id="timaoRopeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7A5828" />
            <stop offset="25%" stopColor="#D4AD6A" />
            <stop offset="50%" stopColor="#F7E6B8" />
            <stop offset="75%" stopColor="#C4975A" />
            <stop offset="100%" stopColor="#68471D" />
          </linearGradient>

          {/* Cubo Central Convexo em Madeira Nobre Escurecida */}
          <radialGradient id="timaoHubGradient" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="rgba(255, 255, 255, 0.35)" />
            <stop offset="35%" stopColor="#543A22" />
            <stop offset="75%" stopColor="#382514" />
            <stop offset="100%" stopColor="#1E130A" />
          </radialGradient>

          {/* Sombra de Profundidade */}
          <filter id="timaoShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="5" stdDeviation="6" floodColor="#000000" floodOpacity="0.55" />
          </filter>

          {/* Gradiente do Símbolo de Vidro 3D em Cristal Diamante Límpido */}
          <linearGradient id="glass3dGradSymbol" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="45%" stopColor="rgba(255, 255, 255, 0.95)" />
            <stop offset="85%" stopColor="rgba(240, 248, 255, 0.85)" />
            <stop offset="100%" stopColor="rgba(220, 235, 250, 0.65)" />
          </linearGradient>

          {/* Sombra 3D do Símbolo */}
          <filter id="glass3dDropShadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodColor="#000000" floodOpacity="0.65" />
          </filter>

          {/* Definição de 1 Malagueta Torneada (Pega de Madeira Naval) */}
          <g id="timaoHandle">
            {/* Contorno orgânico da malagueta */}
            <path
              d="M 95.5 34 C 95.5 30, 96.8 25, 96.2 23 C 95 20, 94.2 14, 96 11 C 97.6 8.5, 102.4 8.5, 104 11 C 105.8 14, 105 20, 103.8 23 C 103.2 25, 104.5 30, 104.5 34 Z"
              fill="url(#timaoCoverGradient)"
            />
            {/* Brilho e rebaixo chanfrado */}
            <path
              d="M 95.5 34 C 95.5 30, 96.8 25, 96.2 23 C 95 20, 94.2 14, 96 11 C 97.6 8.5, 102.4 8.5, 104 11 C 105.8 14, 105 20, 103.8 23 C 103.2 25, 104.5 30, 104.5 34 Z"
              fill="url(#timaoWoodHighlight)"
              opacity="0.65"
            />
            {/* Anéis torneados de acabamento na madeira */}
            <circle cx="100" cy="11.5" r="3.2" fill="url(#timaoCoverGradient)" stroke="rgba(0,0,0,0.3)" strokeWidth="0.8" />
            <line x1="96.5" y1="23.5" x2="103.5" y2="23.5" stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
            <line x1="95.5" y1="33" x2="104.5" y2="33" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
          </g>

          {/* Definição de 1 Raio de Madeira (Spoke) */}
          <g id="timaoSpoke">
            <rect x="97.6" y="55" width="4.8" height="20" rx="1.5" fill="url(#timaoCoverGradient)" />
            <rect x="97.6" y="55" width="4.8" height="20" rx="1.5" fill="url(#timaoWoodHighlight)" opacity="0.6" />
          </g>

          {/* Definição de 1 Amarra de Corda Náutica (5 Voltas) */}
          <g id="timaoRopeWrap">
            <g transform="translate(0, 32.5)">
              <rect x="92" y="0" width="16" height="4.2" rx="2.1" fill="url(#timaoRopeGrad)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
              <rect x="92" y="4" width="16" height="4.2" rx="2.1" fill="url(#timaoRopeGrad)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
              <rect x="92" y="8" width="16" height="4.2" rx="2.1" fill="url(#timaoRopeGrad)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
              <rect x="92" y="12" width="16" height="4.2" rx="2.1" fill="url(#timaoRopeGrad)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
              <rect x="92" y="16" width="16" height="4.2" rx="2.1" fill="url(#timaoRopeGrad)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
              <rect x="92" y="20" width="16" height="4.2" rx="2.1" fill="url(#timaoRopeGrad)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
            </g>
          </g>
        </defs>

        {/* Timão Rotativo Completo (com inércia e aceleração suave) */}
        <g ref={wheelRef} className="realistic-helm-rotor" filter="url(#timaoShadow)">
          {/* 8 Raios de Madeira */}
          {angles.map((deg) => (
            <use key={`spoke-${deg}`} href="#timaoSpoke" transform={`rotate(${deg} 100 100)`} />
          ))}

          {/* Aro Espesso e Maciço de Madeira (com texturas de anéis) */}
          <circle cx="100" cy="100" r="55" stroke="url(#timaoCoverGradient)" strokeWidth="22" fill="none" />
          <circle cx="100" cy="100" r="55" stroke="url(#timaoWoodHighlight)" strokeWidth="22" opacity="0.6" fill="none" />

          {/* Detalhes de textura e chanfros do aro */}
          <circle cx="100" cy="100" r="44" stroke="rgba(0, 0, 0, 0.55)" strokeWidth="1.5" fill="none" />
          <circle cx="100" cy="100" r="45.5" stroke="rgba(255, 255, 255, 0.25)" strokeWidth="0.8" fill="none" />
          <circle cx="100" cy="100" r="66" stroke="rgba(0, 0, 0, 0.6)" strokeWidth="1.5" fill="none" />
          <circle cx="100" cy="100" r="64.5" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.8" fill="none" />
          <circle cx="100" cy="100" r="51" stroke="rgba(255, 255, 255, 0.15)" strokeWidth="0.8" strokeDasharray="10 5 16 6" fill="none" />
          <circle cx="100" cy="100" r="58" stroke="rgba(0, 0, 0, 0.3)" strokeWidth="0.8" strokeDasharray="14 6 8 8" fill="none" />

          {/* As 4 Amarras de Corda Náutica de Sisal no Aro */}
          {ropeAngles.map((deg) => (
            <use key={`rope-${deg}`} href="#timaoRopeWrap" transform={`rotate(${deg} 100 100)`} />
          ))}

          {/* As 8 Malaguetas Torneadas */}
          {angles.map((deg) => (
            <use key={`handle-${deg}`} href="#timaoHandle" transform={`rotate(${deg} 100 100)`} />
          ))}
        </g>

        {/* Cubo Central Fixo com Textura, Gradiente da Capa e Ícone 3D em Vidro Integrado */}
        <g className="realistic-helm-center">
          <circle cx="100" cy="100" r="29" fill="url(#timaoHubGradient)" stroke="rgba(0,0,0,0.60)" strokeWidth="2.8" />
          <circle cx="100" cy="100" r="27.2" stroke="rgba(255, 255, 255, 0.35)" strokeWidth="0.8" fill="none" />
          <circle cx="100" cy="100" r="23.5" stroke="rgba(0, 0, 0, 0.25)" strokeWidth="1" strokeDasharray="2 3" fill="none" />

          {/* Símbolos Centralizados Perfeitamente em (100, 100) em Tamanho Generoso */}
          {loading ? (
            <g className="helm-svg-spinner">
              <circle cx="100" cy="100" r="16" stroke="rgba(var(--cover-contrast-rgb, 245, 215, 150), 0.25)" strokeWidth="3" fill="none" />
              <circle cx="100" cy="100" r="16" stroke="rgb(var(--cover-contrast-rgb, 245, 215, 150))" strokeWidth="3" strokeDasharray="30 60" strokeLinecap="round" fill="none" />
            </g>
          ) : playing ? (
            <g className="glass-pause-3d-group" filter="url(#glass3dDropShadow)">
              {/* Barra Esquerda 3D (x: 88.5 .. 96.5, center 92.5) */}
              <rect x="88.5" y="85.5" width="8.0" height="29" rx="4.0" fill="url(#glass3dGradSymbol)" stroke="rgba(255,255,255,0.8)" strokeWidth="0.9" />
              <rect x="89.8" y="87.0" width="2.4" height="14" rx="1.2" fill="rgba(255,255,255,0.65)" />
              {/* Barra Direita 3D (x: 103.5 .. 111.5, center 107.5) */}
              {/* Centro exato das duas barras = (88.5 + 111.5) / 2 = 100.0 */}
              <rect x="103.5" y="85.5" width="8.0" height="29" rx="4.0" fill="url(#glass3dGradSymbol)" stroke="rgba(255,255,255,0.8)" strokeWidth="0.9" />
              <rect x="104.8" y="87.0" width="2.4" height="14" rx="1.2" fill="rgba(255,255,255,0.65)" />
            </g>
          ) : (
            <g className="glass-play-3d-group" filter="url(#glass3dDropShadow)">
              {/* Triângulo de Vidro 3D Ampliado e Perfeitamente Centralizado em (100, 100) */}
              {/* Base em x=90.0, Vértice em x=115.0, Centro Ótico exato em x=100.0 */}
              <path
                d="M 90.0 85.0 C 90.0 83.6, 91.5 82.8, 92.7 83.5 L 114.5 96.6 C 115.8 97.4, 115.8 99.4, 114.5 100.2 L 92.7 113.3 C 91.5 114.0, 90.0 113.2, 90.0 111.8 Z"
                fill="url(#glass3dGradSymbol)"
                stroke="rgba(255, 255, 255, 0.8)"
                strokeWidth="0.9"
              />
              {/* Faceta de Reflexo Especular Superior do Vidro 3D */}
              <path
                d="M 91.5 87.0 L 109.8 98.0 L 91.5 100.5 Z"
                fill="rgba(255, 255, 255, 0.6)"
              />
            </g>
          )}
        </g>
      </svg>
    </button>
  );
}

function extractPaletteFromImage(imgUrl, callback) {
  if (!imgUrl || imgUrl === FALLBACK_COVER) {
    callback(null);
    return;
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = imgUrl.startsWith("http") ? `/api/cover-proxy?url=${encodeURIComponent(imgUrl)}` : imgUrl;
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 40;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return callback(null);
      ctx.drawImage(img, 0, 0, 40, 40);
      const { data } = ctx.getImageData(0, 0, 40, 40);

      const colorBins = new Map();
      let totalR = 0, totalG = 0, totalB = 0, validPixels = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 120) continue;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const bri = (r * 299 + g * 587 + b * 114) / 1000;

        totalR += r;
        totalG += g;
        totalB += b;
        validPixels++;

        if (bri > 20 && bri < 240) {
          const qR = Math.round(r / 24) * 24;
          const qG = Math.round(g / 24) * 24;
          const qB = Math.round(b / 24) * 24;
          const key = `${qR},${qG},${qB}`;
          
          if (!colorBins.has(key)) {
            colorBins.set(key, { r: qR, g: qG, b: qB, count: 0, sat, bri });
          }
          colorBins.get(key).count++;
        }
      }

      if (colorBins.size === 0 && !validPixels) return callback(null);

      if (colorBins.size === 0) {
        const avgR = Math.round(totalR / validPixels);
        const avgG = Math.round(totalG / validPixels);
        const avgB = Math.round(totalB / validPixels);
        return callback({
          primary: `${avgR}, ${avgG}, ${avgB}`,
          secondary: `${Math.round(avgR * 0.7)}, ${Math.round(avgG * 0.7)}, ${Math.round(avgB * 0.7)}`
        });
      }

      const sortedBins = Array.from(colorBins.values()).sort((a, b) => {
        const scoreA = a.count * (a.sat > 0.15 ? 1 : 0.4);
        const scoreB = b.count * (b.sat > 0.15 ? 1 : 0.4);
        return scoreB - scoreA;
      });

      const primary = sortedBins[0];
      const secondary = sortedBins.find(c => Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b) > 70) || sortedBins[Math.floor(sortedBins.length * 0.5)] || primary;

      callback({
        primary: `${primary.r}, ${primary.g}, ${primary.b}`,
        secondary: `${secondary.r}, ${secondary.g}, ${secondary.b}`
      });
    } catch {
      callback(null);
    }
  };
  img.onerror = () => callback(null);
}

export default function App() {
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  const displayedTrackRef = useRef(initialTrack);
  const pendingTrackRef = useRef(null);
  const pendingTrackTimerRef = useRef(0);
  const playingRef = useRef(false);
  const streamRequestStartedAtRef = useRef(0);
  const streamWaitingStartedAtRef = useRef(0);
  const lastStreamMediaTimeRef = useRef(null);
  const streamMediaSourceRef = useRef("");
  const streamPositionZeroAtRef = useRef(null);
  const showsInitializedRef = useRef(false);
  const [track, setTrack] = useState(initialTrack);
  const [nextTrack, setNextTrack] = useState(null);
  const [history, setHistory] = useState([]);
  const [copiedKey, setCopiedKey] = useState(null);
  const [coverPalette, setCoverPalette] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [audioClockReady, setAudioClockReady] = useState(false);
  const [streamPositionZeroAt, setStreamPositionZeroAt] = useState(null);
  const [volume, setVolume] = useState(() => getStored("radio-volume", 0.85));
  const [lastVolume, setLastVolume] = useState(0.85);
  const [message, setMessage] = useState("");
  const [favorites, setFavorites] = useState(() => getStored("radio-favorites", []));
  const [panel, setPanel] = useState("lyrics");
  const [timerOpen, setTimerOpen] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [lyrics, setLyrics] = useState("");
  const [lyricsTrackKey, setLyricsTrackKey] = useState("");
  const [lyricsDuration, setLyricsDuration] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(true);
  const [artistInfo, setArtistInfo] = useState(null);
  const [artistLoading, setArtistLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [scheduleDay, setScheduleDay] = useState(() => Math.min(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1, 6));
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [currentProgram, setCurrentProgram] = useState(() => getCurrentProgram(DEFAULT_SCHEDULE));
  const upcomingPrograms = useMemo(() => getUpcomingProgramsList(schedule), [schedule, currentProgram]);

  // Estados de Notícias e Shows
  const [news, setNews] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsFilter, setNewsFilter] = useState("all");
  const [platforms, setPlatforms] = useState([]);
  const [festivals, setFestivals] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [selectedCity, setSelectedCity] = useState("Brasília");
  const [cityState, setCityState] = useState("DF");
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [citySearchInput, setCitySearchInput] = useState("");

  const loadNews = useCallback(async (force = false) => {
    setNewsLoading(true);
    try {
      const res = await fetch("/api/news");
      const data = await res.json();
      if (data && data.news) {
        setNews(data.news);
      }
    } catch {
      // mantém as anteriores
    } finally {
      setNewsLoading(false);
    }
  }, []);

  const loadEventsForCity = useCallback(async (city) => {
    setEventsLoading(true);
    try {
      const res = await fetch(`/api/events?city=${encodeURIComponent(city)}`);
      const data = await res.json();
      if (data) {
        setPlatforms(data.platforms || []);
        setFestivals(data.festivals || []);
        if (data.state) setCityState(data.state);
      }
    } catch {
      setPlatforms([]);
      setFestivals([]);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const loadLocationAndEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/location");
      const data = await res.json();
      if (data && data.city) {
        setUserLocation(data);
        setSelectedCity(data.city);
        if (data.state) setCityState(data.state);
        loadEventsForCity(data.city);
        return;
      }
    } catch {}
    loadEventsForCity("Brasília");
  }, [loadEventsForCity]);

  useEffect(() => {
    if (panel === "news" && news.length === 0) {
      loadNews();
    }
    if (panel === "shows" && !showsInitializedRef.current) {
      showsInitializedRef.current = true;
      loadLocationAndEvents();
    }
  }, [panel, news.length, loadNews, loadLocationAndEvents]);

  const filteredNews = useMemo(() => {
    if (newsFilter === "all") return news;
    return news.filter((item) => item.badge === newsFilter || item.source.includes(newsFilter));
  }, [news, newsFilter]);

  displayedTrackRef.current = track;
  playingRef.current = playing;
  const favoriteKey = `${track.artist}—${track.title}`;
  const stablePlaybackIdentity = track.playbackId || track.playedAt;
  const playbackKey = stablePlaybackIdentity
    ? `execucao-${stablePlaybackIdentity}`
    : `${favoriteKey}—${track.updatedAt || "atual"}`;
  const lyricsKey = stablePlaybackIdentity
    ? `execucao-${stablePlaybackIdentity}`
    : favoriteKey;
  const favorite = favorites.some((item) => item.key === favoriteKey);

  const effectiveCover = (track?.cover && track.cover !== FALLBACK_COVER)
    ? track.cover
    : (artistInfo?.image || FALLBACK_COVER);

  useEffect(() => {
    if (!effectiveCover || effectiveCover === FALLBACK_COVER) {
      setCoverPalette(null);
      return;
    }
    let isCurrent = true;
    extractPaletteFromImage(effectiveCover, (palette) => {
      if (isCurrent) setCoverPalette(palette);
    });
    return () => {
      isCurrent = false;
    };
  }, [effectiveCover]);

  function displayTrack(nextTrackItem) {
    clearTimeout(pendingTrackTimerRef.current);
    pendingTrackTimerRef.current = 0;
    pendingTrackRef.current = null;
    displayedTrackRef.current = nextTrackItem;
    setTrack(nextTrackItem);
  }

  function flushPendingTrack() {
    if (pendingTrackRef.current) displayTrack(pendingTrackRef.current);
  }

  function getTransitionDelayForTrack(trackItem) {
    const audio = audioRef.current;
    if (
      !playingRef.current
      || !audio
      || audio.paused
      || !Number.isFinite(streamPositionZeroAtRef.current)
    ) {
      return null;
    }
    return getTrackTransitionDelay({
      mediaTime: audio.currentTime,
      streamPositionZeroAt: streamPositionZeroAtRef.current,
      trackElapsed: trackItem.elapsed,
      trackSampledAt: trackItem.playbackSampledAt
    });
  }

  function displayTrackWhenAudible(nextTrackItem) {
    clearTimeout(pendingTrackTimerRef.current);
    pendingTrackTimerRef.current = 0;

    const displayedTrack = displayedTrackRef.current;
    const incomingIdentity = nextTrackItem.playbackId || nextTrackItem.playedAt;
    const displayedIdentity = displayedTrack.playbackId || displayedTrack.playedAt;
    const isNewPlayback = Boolean(
      incomingIdentity && displayedIdentity && incomingIdentity !== displayedIdentity
    );
    const transitionDelay = isNewPlayback ? getTransitionDelayForTrack(nextTrackItem) : null;

    if (
      isNewPlayback
      && playingRef.current
      && !Number.isFinite(streamPositionZeroAtRef.current)
      && performance.now() - streamRequestStartedAtRef.current < 15000
    ) {
      pendingTrackRef.current = nextTrackItem;
      pendingTrackTimerRef.current = window.setTimeout(() => {
        const pendingTrack = pendingTrackRef.current;
        if (pendingTrack) displayTrackWhenAudible(pendingTrack);
      }, 200);
      return;
    }

    if (isNewPlayback && Number.isFinite(transitionDelay) && transitionDelay > 0) {
      pendingTrackRef.current = nextTrackItem;
      pendingTrackTimerRef.current = window.setTimeout(() => {
        const pendingTrack = pendingTrackRef.current;
        if (pendingTrack) displayTrackWhenAudible(pendingTrack);
      }, transitionDelay * 1000);
      return;
    }
    displayTrack(nextTrackItem);
  }

  function toggleFavoriteItem(item) {
    const key = `${item.artist}—${item.title}`;
    const isFav = favorites.some((f) => f.key === key);
    const next = isFav
      ? favorites.filter((f) => f.key !== key)
      : [{ key, title: item.title, artist: item.artist, cover: item.cover || FALLBACK_COVER }, ...favorites].slice(0, 30);
    setFavorites(next);
    localStorage.setItem("radio-favorites", JSON.stringify(next));
  }

  async function copyTrackInfo(title, artist, key) {
    const text = `${artist} - ${title}`;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {}
  }

  useEffect(() => {
    let active = true;
    let requestInFlight = false;
    async function loadTrack() {
      if (requestInFlight) return;
      requestInFlight = true;
      const requestStartedAt = performance.now();
      try {
        const response = await fetch("/api/now-playing", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!active) return;
        const receivedAt = performance.now();
        const estimatedResponseTransit = Math.min(2.5, Math.max(0, receivedAt - requestStartedAt) / 2000);
        const incomingTrack = {
          title: data.title || "Programação ao vivo",
          artist: data.artist || "Rádio Marinha",
          album: data.album || "Rádio Marinha Online",
          cover: data.cover || FALLBACK_COVER,
          elapsed: (Number(data.elapsed) || 0) + estimatedResponseTransit,
          duration: Number(data.duration) || 0,
          durationReliable: Boolean(data.durationReliable),
          syncAllowed: Boolean(data.syncAllowed),
          playbackId: data.playbackId || null,
          playedAt: Number(data.playedAt) || null,
          playbackSampledAt: receivedAt,
          updatedAt: data.updatedAt || null
        };

        if (Array.isArray(data.history)) {
          setHistory(data.history);
        }
        if (data.nextTrack) {
          setNextTrack(data.nextTrack);
        } else {
          setNextTrack(null);
        }

        displayTrackWhenAudible(incomingTrack);
        setMessage("");
      } catch {
        if (active) setMessage("Os dados da programação estão temporariamente indisponíveis.");
      } finally {
        requestInFlight = false;
      }
    }
    loadTrack();
    const interval = setInterval(loadTrack, 3000);
    const refreshWhenVisible = () => {
      if (!document.hidden) void loadTrack();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("pageshow", refreshWhenVisible);
    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(pendingTrackTimerRef.current);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadSchedule = async () => {
      try {
        const response = await fetch(`/programacao.json?data=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const nextSchedule = DAY_KEYS.map((day) => {
          if (!Array.isArray(data?.dias?.[day])) throw new Error(`Dia inválido: ${day}`);
          return data.dias[day].map((item) => {
            if (!item?.inicio || !item?.fim || !item?.programa) throw new Error(`Programa inválido em ${day}`);
            return [`${item.inicio} – ${item.fim}`, item.programa, item.descricao || ""];
          });
        });
        if (active) setSchedule(nextSchedule);
      } catch (error) {
        console.error("Não foi possível carregar programacao.json; usando a grade padrão.", error);
      }
    };
    loadSchedule();
    const interval = setInterval(loadSchedule, 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const updateCurrentProgram = () => setCurrentProgram(getCurrentProgram(schedule));
    updateCurrentProgram();
    const interval = setInterval(updateCurrentProgram, 60000);
    return () => clearInterval(interval);
  }, [schedule]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    localStorage.setItem("radio-volume", JSON.stringify(volume));
  }, [volume]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: "Rádio Marinha",
      artwork: [{ src: new URL(effectiveCover || FALLBACK_COVER, window.location.href).href }]
    });
    navigator.mediaSession.setActionHandler("play", () => {
      if (!playing) void startRadio();
    });
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
  }, [effectiveCover, loading, playing, track.artist, track.title]);

  useEffect(() => {
    if (!track.artist || !track.title || track.artist === "Rádio Marinha") {
      setLyrics("");
      setLyricsTrackKey(lyricsKey);
      setLyricsDuration(0);
      setArtistInfo(null);
      setLyricsLoading(false);
      setArtistLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const lyricsParams = new URLSearchParams({
      artist: track.artist,
      title: track.title,
      syncAllowed: track.syncAllowed ? "1" : "0"
    });
    if (track.album && track.album !== "Rádio Marinha Online") {
      lyricsParams.set("album", track.album);
    }
    if (track.durationReliable && track.duration) {
      lyricsParams.set("duration", String(Math.round(track.duration)));
    }
    setLyricsLoading(true);
    setArtistLoading(true);
    setLyrics("");
    setLyricsTrackKey("");
    setLyricsDuration(0);
    setArtistInfo(null);

    fetch(`/api/lyrics?${lyricsParams}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : { lyrics: null, duration: 0 })
      .then((lyricsResult) => {
        if (!active) return;
        const receivedLyrics = String(lyricsResult.lyrics || "");
        setLyrics(lyricsResult.synced === false
          ? receivedLyrics.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "")
          : receivedLyrics);
        setLyricsDuration(Number(lyricsResult.duration) || 0);
      })
      .catch(() => {})
      .finally(() => {
        if (active) {
          setLyricsTrackKey(lyricsKey);
          setLyricsLoading(false);
        }
      });

    fetch(`/api/artist?name=${encodeURIComponent(track.artist)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((artistResult) => { if (active) setArtistInfo(artistResult); })
      .catch(() => {})
      .finally(() => { if (active) setArtistLoading(false); });

    return () => { active = false; controller.abort(); };
  }, [lyricsKey, track.album, track.artist, track.duration, track.durationReliable, track.playbackId, track.syncAllowed, track.title]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
  }, []);

  function establishStreamClockAnchor(audio, readyAt, requestStartedAt) {
    const mediaTime = Number(audio?.currentTime) || 0;
    const bufferedAhead = readBufferedAhead(audio, mediaTime);
    const startupLatency = estimateStreamStartupDelay(
      requestStartedAt,
      readyAt,
      bufferedAhead
    );
    const positionZeroAt = createStreamPositionZeroAt(readyAt, mediaTime, startupLatency);
    if (!Number.isFinite(positionZeroAt)) return false;

    streamPositionZeroAtRef.current = positionZeroAt;
    lastStreamMediaTimeRef.current = mediaTime;
    streamMediaSourceRef.current = audio?.currentSrc || audio?.src || "";
    setStreamPositionZeroAt(positionZeroAt);
    return true;
  }

  function handleAudioWaiting() {
    if (!streamWaitingStartedAtRef.current) {
      streamWaitingStartedAtRef.current = performance.now();
    }
    setLoading(true);
  }

  function handleAudioPlaying() {
    const now = performance.now();
    const audio = audioRef.current;
    const mediaTime = Number(audio?.currentTime) || 0;
    const mediaSource = audio?.currentSrc || audio?.src || "";
    const mediaRewound = lastStreamMediaTimeRef.current !== null
      && mediaTime < lastStreamMediaTimeRef.current - .35;
    const sourceChanged = Boolean(
      streamMediaSourceRef.current
      && mediaSource
      && streamMediaSourceRef.current !== mediaSource
    );

    if (!Number.isFinite(streamPositionZeroAtRef.current) || mediaRewound || sourceChanged) {
      const requestStartedAt = Number.isFinite(streamPositionZeroAtRef.current)
        ? (streamWaitingStartedAtRef.current || now)
        : (streamRequestStartedAtRef.current || streamWaitingStartedAtRef.current || now);
      establishStreamClockAnchor(audio, now, requestStartedAt);
    }

    lastStreamMediaTimeRef.current = mediaTime;
    streamMediaSourceRef.current = mediaSource;
    streamWaitingStartedAtRef.current = 0;
    setAudioClockReady(true);
    setLoading(false);
    if (pendingTrackRef.current) displayTrackWhenAudible(pendingTrackRef.current);
  }

  function handleAudioTimeUpdate() {
    const audio = audioRef.current;
    const mediaTime = Number(audio?.currentTime);
    if (!audio || !Number.isFinite(mediaTime)) return;
    const mediaSource = audio.currentSrc || audio.src || "";
    const mediaRewound = lastStreamMediaTimeRef.current !== null
      && mediaTime < lastStreamMediaTimeRef.current - .35;
    const sourceChanged = Boolean(
      streamMediaSourceRef.current
      && mediaSource
      && streamMediaSourceRef.current !== mediaSource
    );
    if (Number.isFinite(streamPositionZeroAtRef.current) && (mediaRewound || sourceChanged)) {
      const now = performance.now();
      establishStreamClockAnchor(audio, now, streamWaitingStartedAtRef.current || now);
      setAudioClockReady(true);
    }
    lastStreamMediaTimeRef.current = mediaTime;
    streamMediaSourceRef.current = mediaSource;
  }

  function handleAudioPause() {
    playingRef.current = false;
    setPlaying(false);
    setLoading(false);
    setAudioClockReady(false);
    streamRequestStartedAtRef.current = 0;
    streamWaitingStartedAtRef.current = 0;
    lastStreamMediaTimeRef.current = null;
    streamMediaSourceRef.current = "";
    streamPositionZeroAtRef.current = null;
    setStreamPositionZeroAt(null);
    flushPendingTrack();
  }

  async function startRadio() {
    if (!audioRef.current || loading) return;
    setMessage("");
    try {
      setLoading(true);
      setAudioClockReady(false);
      streamRequestStartedAtRef.current = performance.now();
      streamWaitingStartedAtRef.current = 0;
      lastStreamMediaTimeRef.current = null;
      streamMediaSourceRef.current = "";
      streamPositionZeroAtRef.current = null;
      setStreamPositionZeroAt(null);
      audioRef.current.src = `${STREAM_URL}?live=${Date.now()}`;
      await audioRef.current.play();
    } catch {
      setMessage("Não foi possível iniciar o áudio. Tente novamente.");
      setLoading(false);
    }
  }

  async function toggleRadio() {
    if (!audioRef.current || loading) return;
    if (playing) {
      audioRef.current.pause();
      return;
    }
    await startRadio();
  }

  function toggleMute() {
    if (volume > 0) {
      setLastVolume(volume);
      setVolume(0);
    } else {
      setVolume(lastVolume || 0.85);
    }
  }

  function toggleFavorite() {
    const next = favorite
      ? favorites.filter((item) => item.key !== favoriteKey)
      : [{ key: favoriteKey, ...track }, ...favorites].slice(0, 30);
    setFavorites(next);
    localStorage.setItem("radio-favorites", JSON.stringify(next));
  }

  async function shareTrack() {
    const text = `Ouvindo “${track.title}”, de ${track.artist}, na Rádio Marinha.`;
    try {
      if (navigator.share) await navigator.share({ title: "Rádio Marinha", text, url: location.href });
      else {
        await navigator.clipboard.writeText(`${text} ${location.href}`);
        setMessage("Link copiado para a área de transferência.");
      }
    } catch (error) {
      if (error.name !== "AbortError") setMessage("Não foi possível compartilhar agora.");
    }
  }

  function startTimer(minutes) {
    clearInterval(timerRef.current);
    let remaining = minutes * 60;
    setTimerSeconds(remaining);
    setTimerOpen(false);
    timerRef.current = setInterval(() => {
      remaining -= 1;
      setTimerSeconds(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current);
        audioRef.current?.pause();
        setMessage("A rádio foi desligada pelo temporizador.");
      }
    }, 1000);
  }

  function cancelTimer() {
    clearInterval(timerRef.current);
    setTimerSeconds(0);
    setTimerOpen(false);
  }

  function getContrastColor(rgb1, rgb2) {
    if (!rgb1) return "245, 215, 150";
    const [r1, g1, b1] = rgb1.split(",").map(Number);
    const [r2, g2, b2] = (rgb2 || rgb1).split(",").map(Number);

    const lum1 = (r1 * 299 + g1 * 587 + b1 * 114) / 1000;
    const lum2 = (r2 * 299 + g2 * 587 + b2 * 114) / 1000;

    // Escolhe a cor com maior luminância para garantir o maior contraste contra o cubo escuro
    const chosen = lum1 >= lum2 ? [r1, g1, b1, lum1] : [r2, g2, b2, lum2];
    let [r, g, b, lum] = chosen;

    // Se ambas forem escuras, projeta luminosidade para legibilidade cristalina
    if (lum < 140) {
      const factor = (180 - lum) / 255;
      r = Math.min(255, Math.round(r + (255 - r) * factor));
      g = Math.min(255, Math.round(g + (255 - g) * factor));
      b = Math.min(255, Math.round(b + (255 - b) * factor));
    }
    return `${r}, ${g}, ${b}`;
  }

  const dynamicCoverStyle = coverPalette ? {
    "--cover-rgb-1": coverPalette.primary,
    "--cover-rgb-2": coverPalette.secondary,
    "--cover-contrast-rgb": getContrastColor(coverPalette.primary, coverPalette.secondary),
  } : {
    "--cover-rgb-1": "196, 151, 90",
    "--cover-rgb-2": "42, 143, 180",
    "--cover-contrast-rgb": "245, 215, 150",
  };

  return (
    <main className={`app ${playing ? "is-playing" : ""} ${loading ? "is-loading" : ""}`} style={dynamicCoverStyle}>
      <div className="ambient" aria-hidden="true" />
      <section className="shell" aria-label="Player da Rádio Marinha">
        <header className="topbar">
          <div className="brand">
            <img className="brand-logo radio-brand-logo" src="/imagens/logo-radio-marinha.png" alt="Logo da Rádio Marinha" />
            <div className="brand-copy">
              <small className="sailing-slogan" aria-label="Navegando nas ondas do Rádio">
                <span className="slogan-wake" aria-hidden="true">
                  <SloganOceanWave active={playing || loading} />
                </span>
                <span className="slogan-words">Navegando nas ondas do Rádio</span>
              </small>
            </div>
          </div>
          <div className="live"><span className="live-dot" /> NO AR</div>
        </header>

        <div className="layout">
          <section className="hero">
            <div className="cover-wrap">
              <div className="now-indicator" aria-label={loading ? "Suspendendo" : playing ? "Navegando" : "Rádio fundeada"}>
                <span className="now-dot" aria-hidden="true" />
                <span className="mini-wave" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <i key={index} style={{ "--bar": index }} />)}</span>
                <span className="eyebrow">{loading ? "SUSPENDENDO" : playing ? "NAVEGANDO" : "RÁDIO FUNDEADA"}</span>
              </div>
              <CoverProgress
                cover={effectiveCover}
                duration={lyricsDuration || (track.durationReliable ? track.duration : 0)}
                elapsed={track.elapsed}
                playbackSampledAt={track.playbackSampledAt}
                title={track.title}
                trackKey={playbackKey}
                onError={useFallbackCover}
              />
            </div>
            <div className="track-copy">
              <h1>{track.title}</h1>
              <p className="artist">{track.artist}</p>
              <p className="album program-now">
                <span className="program-now-badge">PROGRAMA NO AR</span>
                <span className="program-now-copy">
                  <strong>{currentProgram.title}</strong>
                  <span className="program-now-separator" aria-hidden="true">—</span>
                  <span className="program-now-description">{currentProgram.description}</span>
                </span>
              </p>
            </div>

            <div className="main-controls">
              <RealisticHelmPlayButton
                playing={playing}
                loading={loading}
                onClick={toggleRadio}
              />
            </div>

            <div className="volume-control">
              <button onClick={toggleMute} aria-label={volume ? "Silenciar" : "Ativar som"}>{volume ? "◖))" : "◖×"}</button>
              <input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
              <output>{Math.round(volume * 100)}%</output>
            </div>

            {(nextTrack || upcomingPrograms.length > 0) && (
              <div className="up-next-card" role="region" aria-label="A seguir na programação">
                <div className="up-next-badge">
                  <ActionIcon name="next" />
                  <span>A SEGUIR</span>
                </div>
                {nextTrack ? (
                  <div className="up-next-content">
                    <img
                      className="up-next-cover"
                      src={nextTrack.cover || FALLBACK_COVER}
                      alt={`Capa de ${nextTrack.title}`}
                      onError={useFallbackCover}
                    />
                    <div className="up-next-info">
                      <strong>{nextTrack.title}</strong>
                      <small>{nextTrack.artist}</small>
                    </div>
                  </div>
                ) : (
                  <div className="up-next-content roulette-mode">
                    <UpcomingProgramsTicker programs={upcomingPrograms} onOpenSchedule={() => setModal("schedule")} />
                  </div>
                )}
              </div>
            )}

            <div className="quick-actions">
              <button className={favorite ? "active" : ""} onClick={toggleFavorite} aria-pressed={favorite}><span className="action-icon-wrap"><ActionIcon name="heart" /></span><span>Favoritar</span></button>
              <button onClick={shareTrack}><span className="action-icon-wrap"><ActionIcon name="share" /></span><span>Compartilhar</span></button>
              <button className={timerSeconds ? "active" : ""} onClick={() => setTimerOpen(!timerOpen)}><span className="action-icon-wrap"><ActionIcon name="timer" /></span><span>{timerSeconds ? formatClock(timerSeconds) : "Temporizador"}</span></button>
              <button onClick={() => setModal("schedule")}><span className="action-icon-wrap"><ActionIcon name="radio" /></span><span>Programação</span></button>
              <button onClick={() => setModal("contact")}><span className="action-icon-wrap"><ActionIcon name="mail" /></span><span>Fale conosco</span></button>
            </div>

            {timerOpen && <div className="timer-menu" role="dialog" aria-label="Temporizador">
              <strong>Desligar automaticamente</strong>
              <div>{TIMER_OPTIONS.map((minutes) => <button key={minutes} onClick={() => startTimer(minutes)}>{minutes} min</button>)}</div>
              {timerSeconds > 0 && <button className="cancel" onClick={cancelTimer}>Cancelar temporizador</button>}
            </div>}
            {message && <p className="message" role="status">{message}</p>}
          </section>

          <section className="player-panel content-panel">

            <nav className="tabs" aria-label="Conteúdo da rádio">
              <button className={panel === "lyrics" ? "active" : ""} onClick={() => setPanel("lyrics")}>Letra</button>
              <button className={panel === "artist" ? "active" : ""} onClick={() => setPanel("artist")}>Artista</button>
              <button className={panel === "recent" ? "active" : ""} onClick={() => setPanel("recent")}>Recentes</button>
              <button className={panel === "favorites" ? "active" : ""} onClick={() => setPanel("favorites")}>Favoritos</button>
              <button className={panel === "news" ? "active" : ""} onClick={() => setPanel("news")}>Notícias</button>
              <button className={panel === "shows" ? "active" : ""} onClick={() => setPanel("shows")}>Shows</button>
            </nav>

            <div className="tab-content" style={dynamicCoverStyle}>
              {panel === "radio" && <div className="welcome-content"><p className="section-kicker">CONTEÚDO DA FAIXA</p><h2>Conheça o que está tocando</h2><p>Abra a letra da música ou conheça a trajetória do artista enquanto acompanha a transmissão.</p><div className="content-shortcuts"><button onClick={() => setPanel("lyrics")}>Ver letra <span>→</span></button><button onClick={() => setPanel("artist")}>Sobre o artista <span>→</span></button></div></div>}
              {panel === "lyrics" && (
                <div className="lyrics-content">
                  <div className="content-heading">
                    <div>
                      <p className="section-kicker">LETRA</p>
                      <h2>{track.title}</h2>
                    </div>
                    <span>{track.artist}</span>
                  </div>
                  {lyricsLoading || lyricsTrackKey !== lyricsKey ? (
                    <div className="content-loading"><span className="spinner" /> Buscando letra…</div>
                  ) : lyrics ? (
                    <AutoScrollingLyrics
                      audioClockReady={audioClockReady}
                      audioPlaying={playing}
                      audioRef={audioRef}
                      duration={lyricsDuration || (track.durationReliable ? track.duration : 0)}
                      elapsed={track.elapsed}
                      lyrics={lyrics}
                      playbackSampledAt={track.playbackSampledAt}
                      streamPositionZeroAt={streamPositionZeroAt}
                      trackKey={playbackKey}
                      title={track.title}
                    />
                  ) : (
                    <div className="lyrics-fallback-view">
                      <div className="lyrics-fallback-notice">
                        <span>ℹ️ Letra não disponível no catálogo — Conheça a história do artista abaixo</span>
                      </div>
                      {artistLoading ? (
                        <div className="content-loading"><span className="spinner" /> Buscando informações do artista…</div>
                      ) : artistInfo?.biography ? (
                        <div className="lyrics-artist-card">
                          <div className="artist-heading">
                            {artistInfo.image && (
                              <img src={artistInfo.image} alt={artistInfo.name} onError={(e) => { e.target.style.display = 'none'; }} />
                            )}
                            <div>
                              <p className="section-kicker">SOBRE O ARTISTA</p>
                              <h2>{artistInfo.name || track.artist}</h2>
                              <span>{[artistInfo.genre, artistInfo.country].filter(Boolean).join(" • ")}</span>
                            </div>
                          </div>
                          <p className="biography">{artistInfo.biography}</p>
                        </div>
                      ) : (
                        <div className="empty-state">
                          <strong>Letra não disponível</strong>
                          <p>Não encontramos uma letra nem biografia correspondente para esta faixa.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {panel === "artist" && (
                <div className="artist-content">
                  {artistLoading ? (
                    <div className="content-loading"><span className="spinner" /> Buscando artista…</div>
                  ) : artistInfo?.biography ? (
                    <>
                      <div className="artist-heading">
                        {artistInfo.image && (
                          <img src={artistInfo.image} alt={artistInfo.name} onError={(e) => { e.target.style.display = 'none'; }} />
                        )}
                        <div>
                          <p className="section-kicker">SOBRE O ARTISTA</p>
                          <h2>{artistInfo.name || track.artist}</h2>
                          <span>{[artistInfo.genre, artistInfo.country].filter(Boolean).join(" • ")}</span>
                        </div>
                      </div>
                      <p className="biography">{artistInfo.biography}</p>
                    </>
                  ) : (
                    <div className="empty-state">
                      <strong>História não disponível</strong>
                      <p>A biografia de {track.artist} ainda não foi encontrada em nossa fonte.</p>
                    </div>
                  )}
                </div>
              )}
              {panel === "news" && (
                <div className="news-content">
                  <div className="content-heading news-heading">
                    <div>
                      <p className="section-kicker">MUNDO DA MÚSICA</p>
                      <h2>Últimas Notícias</h2>
                    </div>
                    <div className="news-toolbar-actions">
                      <button
                        className="news-refresh-btn"
                        onClick={() => loadNews(true)}
                        disabled={newsLoading}
                        title="Atualizar feed de notícias"
                        aria-label="Atualizar notícias"
                      >
                        <ActionIcon name="refresh" />
                        <span>Atualizar</span>
                      </button>
                    </div>
                  </div>

                  <div className="news-filter-chips" role="group" aria-label="Filtrar por portal">
                    <button className={newsFilter === "all" ? "active" : ""} onClick={() => setNewsFilter("all")}>Todas</button>
                    <button className={newsFilter === "Rolling Stone" ? "active" : ""} onClick={() => setNewsFilter("Rolling Stone")}>Rolling Stone</button>
                    <button className={newsFilter === "Billboard" ? "active" : ""} onClick={() => setNewsFilter("Billboard")}>Billboard(Internacional)</button>
                    <button className={newsFilter === "G1 Música" ? "active" : ""} onClick={() => setNewsFilter("G1 Música")}>G1</button>
                  </div>

                  {newsLoading && news.length === 0 ? (
                    <div className="content-loading"><span className="spinner" /> Carregando últimas notícias…</div>
                  ) : filteredNews.length > 0 ? (
                    <div className="news-grid">
                      {filteredNews.map((item) => (
                        <article className="news-card" key={item.id}>
                          <div className="news-thumb-wrap">
                            {item.image ? (
                              <img
                                src={item.image}
                                alt=""
                                className="news-thumb"
                                loading="lazy"
                                onError={(e) => {
                                  if (e.target) {
                                    e.target.style.display = 'none';
                                  }
                                }}
                              />
                            ) : (
                              <div className="news-thumb-fallback">
                                <ActionIcon name="news" />
                              </div>
                            )}
                            <span className="news-source-badge" style={{ backgroundColor: item.tagColor || 'var(--ocean-500)' }}>
                              {item.badge}
                            </span>
                          </div>
                          <div className="news-body">
                            <div className="news-meta">
                              <time className="news-time">{formatRelativeTime(item.pubDate)}</time>
                            </div>
                            <h3 className="news-title">
                              <a href={item.link} target="_blank" rel="noopener noreferrer">
                                {item.title}
                              </a>
                            </h3>
                            <p className="news-summary">
                              {item.summary ? item.summary.replace(/\]\]>|\]>/g, '').replace(/^[\s\]>]+/, '').trim() : ''}
                            </p>
                            <a href={item.link} target="_blank" rel="noopener noreferrer" className="news-read-more">
                              <span>Ler matéria completa</span>
                              <ActionIcon name="external" />
                            </a>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <strong>Nenhuma notícia encontrada</strong>
                      <p>Tente selecionar outro filtro de portal ou clique no botão Atualizar.</p>
                    </div>
                  )}
                </div>
              )}
              {panel === "shows" && (
                <div className="shows-content">
                  <div className="content-heading shows-heading">
                    <div>
                      <p className="section-kicker">NAVEGAÇÃO CULTURAL • GUIA OFICIAL DE INGRESSOS</p>
                      <h2>Shows & Festivais</h2>
                    </div>

                    <button
                      className="shows-city-selector-btn"
                      onClick={() => setCityPickerOpen(true)}
                      aria-label="Mudar cidade"
                      title="Clique para escolher outra cidade no mapa náutico"
                    >
                      <ActionIcon name="location" />
                      <span className="shows-city-name">{selectedCity} - {cityState}</span>
                      <ActionIcon name="chevronDown" />
                    </button>
                  </div>

                  <div className="shows-quick-cities-bar" role="group" aria-label="Cidades rápidas">
                    {[
                      { city: "Brasília", uf: "DF" },
                      { city: "Rio de Janeiro", uf: "RJ" },
                      { city: "São Paulo", uf: "SP" },
                      { city: "Salvador", uf: "BA" },
                      { city: "Belo Horizonte", uf: "MG" },
                      { city: "Recife", uf: "PE" },
                      { city: "Curitiba", uf: "PR" }
                    ].map((item) => (
                      <button
                        key={item.city}
                        className={`quick-city-chip ${selectedCity.toLowerCase() === item.city.toLowerCase() ? "active" : ""}`}
                        onClick={() => {
                          setSelectedCity(item.city);
                          setCityState(item.uf);
                          localStorage.setItem('radio_user_city', item.city);
                          localStorage.setItem('radio_user_state', item.uf);
                          loadEventsForCity(item.city);
                        }}
                      >
                        {item.city}
                      </button>
                    ))}
                    <button
                      className="quick-city-chip quick-city-more"
                      onClick={() => setCityPickerOpen(true)}
                    >
                      + Mais Cidades
                    </button>
                  </div>

                  {track.artist && track.artist !== "Rádio Marinha" && (
                    <div className="artist-tour-card">
                      <div className="artist-tour-inner">
                        <div className="artist-tour-media-wrap">
                          <div className="artist-tour-media">
                            <img
                              src={effectiveCover}
                              alt={track.artist}
                              className="artist-tour-thumb"
                              onError={(e) => {
                                if (e.target) e.target.src = FALLBACK_COVER;
                              }}
                            />
                          </div>
                          <div className="artist-tour-vinyl-disk" />
                        </div>
                        <div className="artist-tour-content">
                          <div className="artist-tour-live-pill">
                            <div className="equalizer-bars">
                              <span className="bar bar-1" />
                              <span className="bar bar-2" />
                              <span className="bar bar-3" />
                            </div>
                            <span>NO AR NA RÁDIO</span>
                          </div>
                          <h3 className="artist-tour-title">
                            Turnê de <b>{track.artist}</b>
                          </h3>
                          <p className="artist-tour-desc">
                            Pesquise ingressos e datas confirmadas nas bilheterias oficiais:
                          </p>
                          <div className="artist-tour-actions">
                            <a
                              href={`https://www.sympla.com.br/eventos?s=${encodeURIComponent(track.artist.split(/,| e | feat\.? | ft\.? | part\.? | com /i)[0].trim())}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="tour-btn tour-sympla"
                            >
                              <span className="tour-btn-icon">🎟️</span>
                              <span>Ingressos no Sympla</span>
                              <ActionIcon name="external" />
                            </a>
                            <a
                              href={`https://www.eventim.com.br/search/?searchterm=${encodeURIComponent(track.artist.split(/,| e | feat\.? | ft\.? | part\.? | com /i)[0].trim())}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="tour-btn tour-eventim"
                            >
                              <span className="tour-btn-icon">🎫</span>
                              <span>Ingressos na Eventim</span>
                              <ActionIcon name="external" />
                            </a>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="ticket-platforms-section">
                    <div className="section-title-wrap">
                      <div className="section-title-row">
                        <h3 className="ticket-section-title">Bilheterias Oficiais em {selectedCity}</h3>
                        <span className="section-verified-pill">✓ 100% Venda Oficial</span>
                      </div>
                      <p className="ticket-section-desc">Consulte a programação completa, datas confirmadas e venda oficial em tempo real:</p>
                    </div>

                    {eventsLoading ? (
                      <div className="content-loading"><span className="spinner" /> Carregando bilheterias de {selectedCity}…</div>
                    ) : (
                      <div className="ticket-platforms-grid">
                        {platforms.map((plat) => (
                          <a
                            href={plat.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ticket-platform-card"
                            key={plat.id}
                          >
                            <div className="plat-top-row">
                              <div className="plat-brand-badge" style={{ backgroundColor: plat.color }}>
                                {plat.name.slice(0, 2).toUpperCase()}
                              </div>
                              <div className="plat-info-col">
                                <span className="plat-name">{plat.name}</span>
                                <span className="plat-badge-pill">
                                  {plat.badge}
                                </span>
                              </div>
                            </div>
                            <p className="plat-desc">{plat.description}</p>
                            <div className="plat-cta">
                              <span>Acessar Programação</span>
                              <ActionIcon name="external" />
                            </div>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>

                  {festivals.length > 0 && (
                    <div className="major-festivals-section">
                      <div className="section-title-wrap">
                        <h3 className="ticket-section-title">Grandes Festivais no Brasil</h3>
                        <p className="ticket-section-desc">Sites oficiais e ingressos dos maiores eventos do país:</p>
                      </div>

                      <div className="festivals-grid">
                        {festivals.map((fest) => (
                          <a
                            href={fest.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="festival-card"
                            key={fest.id}
                          >
                            <div className="fest-img-wrap">
                              <img src={fest.image} alt={fest.name} loading="lazy" />
                              <span className="fest-badge">{fest.badge}</span>
                            </div>
                            <div className="fest-body">
                              <h4 className="fest-name">{fest.name}</h4>
                              <p className="fest-venue">📍 {fest.venue}</p>
                              <span className="fest-city-tag">{fest.city} - {fest.state}</span>
                              <div className="fest-link">
                                <span>Lineup & Ingressos</span>
                                <ActionIcon name="external" />
                              </div>
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {panel === "recent" && <div className="recent-content">
                <div className="content-heading">
                  <div>
                    <p className="section-kicker">HISTÓRICO NO AR</p>
                    <h2>Tocadas Recentemente</h2>
                  </div>
                  <span>Últimas faixas</span>
                </div>

                {history.length ? (
                  <div className="recent-timeline" role="feed" aria-label="Músicas tocadas recentemente">
                    {history.map((item, idx) => {
                      const itemKey = `${item.artist}—${item.title}`;
                      const isItemFav = favorites.some((f) => f.key === itemKey);
                      const isCopied = copiedKey === item.id;
                      return (
                        <article className="timeline-item" key={item.id || idx}>
                          <div className="timeline-spine" aria-hidden="true">
                            <span className="timeline-node" />
                            {idx < history.length - 1 && <span className="timeline-line" />}
                          </div>
                          <div className="timeline-card">
                            <img
                              className="timeline-cover"
                              src={item.cover || FALLBACK_COVER}
                              alt={`Capa de ${item.title}`}
                              onError={useFallbackCover}
                            />
                            <div className="timeline-meta">
                              <span className="timeline-time-badge">
                                <ActionIcon name="history" />
                                <time>{item.formattedTime || "Há pouco"}</time>
                              </span>
                              <strong className="timeline-title" title={item.title}>{item.title}</strong>
                              <small className="timeline-artist" title={item.artist}>{item.artist}</small>
                            </div>
                            <div className="timeline-actions">
                              <button
                                className={`timeline-action-btn ${isItemFav ? "active" : ""}`}
                                aria-label={isItemFav ? `Remover ${item.title} dos favoritos` : `Favoritar ${item.title}`}
                                title={isItemFav ? "Remover dos favoritos" : "Favoritar música"}
                                onClick={() => toggleFavoriteItem(item)}
                              >
                                <ActionIcon name="heart" />
                              </button>
                              <button
                                className={`timeline-action-btn ${isCopied ? "copied" : ""}`}
                                aria-label={`Copiar informações de ${item.title}`}
                                title={isCopied ? "Copiado!" : "Copiar artista e título"}
                                onClick={() => copyTrackInfo(item.title, item.artist, item.id)}
                              >
                                <ActionIcon name={isCopied ? "check" : "copy"} />
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">
                    <strong>Histórico em sincronização</strong>
                    <p>As faixas anteriores da transmissão aparecerão aqui conforme forem executadas.</p>
                  </div>
                )}
              </div>}
              {panel === "favorites" && <div><h2>Suas músicas favoritas</h2>{favorites.length ? <ul>{favorites.map((item) => <li key={item.key}><img src={item.cover || FALLBACK_COVER} alt="" onError={useFallbackCover} /><span><strong>{item.title}</strong><small>{item.artist}</small></span><button aria-label={`Remover ${item.title}`} onClick={() => { const next = favorites.filter((favoriteItem) => favoriteItem.key !== item.key); setFavorites(next); localStorage.setItem("radio-favorites", JSON.stringify(next)); }}>×</button></li>)}</ul> : <p>As músicas que você favoritar aparecerão aqui.</p>}</div>}
            </div>
          </section>
        </div>

        <footer><span>Rádio Marinha Online</span><span>{track.updatedAt ? `Atualizado às ${new Date(track.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Conectando à programação"}</span></footer>
      </section>

      {/* Modal de Escolha de Cidade para Shows */}
      {cityPickerOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCityPickerOpen(false); }}>
          <section className="modal-card city-picker-modal" role="dialog" aria-modal="true" aria-labelledby="city-modal-title">
            <header className="modal-header">
              <div className="modal-title">
                <span className="action-icon-wrap"><ActionIcon name="location" /></span>
                <div>
                  <small>AGENDA DE SHOWS</small>
                  <h2 id="city-modal-title">Escolha sua Cidade</h2>
                </div>
              </div>
              <button className="modal-close" onClick={() => setCityPickerOpen(false)} aria-label="Fechar modal">×</button>
            </header>

            <div className="city-picker-content">
              <div className="city-search-box">
                <input
                  type="text"
                  className="city-search-input"
                  placeholder="Pesquisar cidade ou capital..."
                  value={citySearchInput}
                  onChange={(e) => setCitySearchInput(e.target.value)}
                  autoFocus
                />
              </div>

              <p className="city-group-title">Capitais Principais</p>
              <div className="city-chips-grid">
                {BRAZILIAN_CAPITALS
                  .filter((c) => !citySearchInput || c.name.toLowerCase().includes(citySearchInput.toLowerCase()) || c.state.toLowerCase().includes(citySearchInput.toLowerCase()))
                  .map((cap) => (
                    <button
                      key={cap.name}
                      className={`city-chip ${selectedCity === cap.name ? "active" : ""}`}
                      onClick={() => {
                        setSelectedCity(cap.name);
                        loadEventsForCity(cap.name);
                        setCityPickerOpen(false);
                        setCitySearchInput("");
                      }}
                    >
                      <span className="city-chip-name">{cap.name}</span>
                      <span className="city-chip-uf">{cap.state}</span>
                    </button>
                  ))}
              </div>

              {citySearchInput.trim() && (
                <button
                  className="city-custom-search-btn"
                  onClick={() => {
                    const custom = citySearchInput.trim();
                    if (custom) {
                      setSelectedCity(custom);
                      loadEventsForCity(custom);
                      setCityPickerOpen(false);
                      setCitySearchInput("");
                    }
                  }}
                >
                  <span>Buscar shows em "<strong>{citySearchInput.trim()}</strong>"</span>
                  <ActionIcon name="next" />
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
        <section className={`modal-card ${modal === "schedule" ? "schedule-modal" : "contact-modal"}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <header className="modal-header">
            <div className="modal-title"><span className="action-icon-wrap"><ActionIcon name={modal === "schedule" ? "radio" : "mail"} /></span><div><small>RÁDIO MARINHA</small><h2 id="modal-title">{modal === "schedule" ? "Programação" : "Fale conosco"}</h2></div></div>
            <button className="modal-close" onClick={() => setModal(null)} aria-label="Fechar">×</button>
          </header>

          {modal === "schedule" ? <>
            <nav className="day-tabs" aria-label="Dias da programação">{DAYS.map((day, index) => <button key={day} className={scheduleDay === index ? "active" : ""} onClick={() => setScheduleDay(index)}>{day}</button>)}</nav>
            <div className="schedule-list">{schedule[scheduleDay].map(([time, title, description]) => <article className="schedule-item" key={`${time}-${title}`}><time>{time}</time><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
          </> : <div className="contact-content">
            <p>Envie pedidos de música e sugestões para a Rádio Marinha pelo e-mail ou WhatsApp.</p>
            <a className="contact-link" href="mailto:radiomarinha@marinha.mil.br"><span className="contact-symbol">@</span><span><small>E-MAIL</small><strong>radiomarinha@marinha.mil.br</strong></span><b>→</b></a>
            <a className="contact-link" href="https://wa.me/5561992979199?text=Ol%C3%A1%20R%C3%A1dio%20Marinha!%20Gostaria%20de%20fazer%20um%20pedido%20de%20m%C3%BAsica%20e%20uma%20sugest%C3%A3o." target="_blank" rel="noreferrer"><span className="contact-symbol">✆</span><span><small>WHATSAPP</small><strong>(61) 99297-9199</strong></span><b>→</b></a>
          </div>}
        </section>
      </div>}
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => {
          if (!streamRequestStartedAtRef.current) {
            streamRequestStartedAtRef.current = performance.now();
          }
          playingRef.current = true;
          setPlaying(true);
        }}
        onPause={handleAudioPause}
        onWaiting={handleAudioWaiting}
        onPlaying={handleAudioPlaying}
        onTimeUpdate={handleAudioTimeUpdate}
        onEnded={handleAudioPause}
        onError={() => {
          playingRef.current = false;
          setPlaying(false);
          setLoading(false);
          setAudioClockReady(false);
          streamRequestStartedAtRef.current = 0;
          streamWaitingStartedAtRef.current = 0;
          lastStreamMediaTimeRef.current = null;
          streamMediaSourceRef.current = "";
          streamPositionZeroAtRef.current = null;
          setStreamPositionZeroAt(null);
          setMessage("Não foi possível conectar à transmissão.");
          flushPendingTrack();
        }}
      />
    </main>
  );
}
