import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

const STREAM_URL = "https://stm0.inovativa.net/listen/radiomarinha/radio.mp3";
const FALLBACK_COVER = "/imagens/radio_gif.gif";
const TIMER_OPTIONS = [15, 30, 45, 60, 90];
const DAYS = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"];
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
    mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>
  };
  return <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const LRC_TIMESTAMP = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;

function parseLyrics(lyrics) {
  const lyricLines = String(lyrics || "").split("\n");
  const offsetLine = lyricLines.find((line) => /^\[offset:[+-]?\d+\]/i.test(line.trim()));
  const offsetMatch = offsetLine?.trim().match(/^\[offset:([+-]?\d+)\]/i);
  const offsetSeconds = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  const plainRows = [];
  const timedRows = [];

  lyricLines.forEach((rawLine, rowIndex) => {
    if (/^\[(?:ar|al|ti|by|offset|length|re):/i.test(rawLine.trim())) return;
    const timestamps = [...rawLine.matchAll(LRC_TIMESTAMP)].map((match) => (
      Number(match[1]) * 60 + Number(match[2])
    ));
    const text = rawLine.replace(LRC_TIMESTAMP, "").trim();
    plainRows.push({ id: `plain-${rowIndex}`, text, blank: !text });
    timestamps.forEach((time, timeIndex) => {
      if (text) timedRows.push({ id: `timed-${rowIndex}-${timeIndex}`, text, time: Math.max(0, time + offsetSeconds) });
    });
  });

  if (timedRows.length > 1) {
    timedRows.sort((first, second) => first.time - second.time);
    return { synced: true, rows: timedRows };
  }
  return { synced: false, rows: plainRows };
}

function estimateLyricsDuration(rows) {
  const textRows = rows.filter((row) => !row.blank);
  const wordCount = textRows.reduce((total, row) => total + row.text.split(/\s+/).length, 0);
  const stanzaBreaks = rows.filter((row) => row.blank).length;
  const singingTime = wordCount / 1.25;
  const phrasingTime = textRows.length * .8 + stanzaBreaks * 3;
  return Math.max(180, Math.min(480, singingTime + phrasingTime + 40));
}

function AutoScrollingLyrics({ active, audioRef, duration, elapsed, latency, lyrics, playbackSampledAt, trackKey, title }) {
  const parsedLyrics = useMemo(() => parseLyrics(lyrics), [lyrics]);
  const scrollRef = useRef(null);
  const animationFrameRef = useRef(0);
  const activeLineRef = useRef(-1);
  const lineRefs = useRef([]);
  const pointerStartRef = useRef(null);
  const playbackRef = useRef({
    anchorElapsed: null,
    anchorMediaTime: null,
    elapsed: 0,
    sampledAt: performance.now(),
    trackKey: null
  });
  const latencyRef = useRef(0);
  const [activeLine, setActiveLine] = useState(-1);
  const [manualPause, setManualPause] = useState(false);
  const [timingAdjustment, setTimingAdjustment] = useState(0);
  const [followEnabled, setFollowEnabled] = useState(() => {
    const storedPreference = getStored("radio-lyrics-follow", null);
    if (typeof storedPreference === "boolean") return storedPreference;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    latencyRef.current = Math.max(0, Number(latency) || 0);
  }, [latency]);

  useEffect(() => {
    const previousPlayback = playbackRef.current;
    const changedTrack = previousPlayback.trackKey !== trackKey;
    playbackRef.current = {
      ...previousPlayback,
      anchorElapsed: changedTrack ? null : previousPlayback.anchorElapsed,
      anchorMediaTime: changedTrack ? null : previousPlayback.anchorMediaTime,
      elapsed: Math.max(0, Number(elapsed) || 0),
      sampledAt: Number(playbackSampledAt) || performance.now(),
      trackKey
    };
  }, [elapsed, playbackSampledAt, trackKey]);

  useEffect(() => {
    cancelAnimationFrame(animationFrameRef.current);
    activeLineRef.current = -1;
    setActiveLine(-1);
    setManualPause(false);
    setTimingAdjustment(0);
    lineRefs.current = [];
    const animationFrame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [lyrics, trackKey]);

  const following = active && followEnabled && !manualPause;

  useEffect(() => {
    cancelAnimationFrame(animationFrameRef.current);
    if (!following || !parsedLyrics.rows.length) return;

    let previousFrame = performance.now();
    const updateScroll = (now) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const delta = Math.min(64, Math.max(0, now - previousFrame));
      previousFrame = now;
      const playback = playbackRef.current;
      const serverElapsed = playback.elapsed + (now - playback.sampledAt) / 1000;
      const mediaTime = audioRef.current?.currentTime;
      const hasMediaClock = Number.isFinite(mediaTime) && mediaTime >= 0;
      if (hasMediaClock && (
        playback.anchorMediaTime === null
        || mediaTime < playback.anchorMediaTime - .75
      )) {
        playback.anchorMediaTime = mediaTime;
        playback.anchorElapsed = Math.max(0, serverElapsed - latencyRef.current);
      }
      const audibleElapsed = hasMediaClock && playback.anchorMediaTime !== null
        ? playback.anchorElapsed + Math.max(0, mediaTime - playback.anchorMediaTime)
        : serverElapsed - latencyRef.current;
      const currentElapsed = Math.max(0, audibleElapsed + timingAdjustment);
      const maximumScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      let targetScroll = scroller.scrollTop;

      if (parsedLyrics.synced) {
        let currentIndex = -1;
        for (let index = parsedLyrics.rows.length - 1; index >= 0; index -= 1) {
          if (currentElapsed >= parsedLyrics.rows[index].time) {
            currentIndex = index;
            break;
          }
        }
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

      targetScroll = Math.max(0, Math.min(maximumScroll, targetScroll));
      const easingDuration = parsedLyrics.synced ? 520 : 900;
      const easing = 1 - Math.exp(-delta / easingDuration);
      scroller.scrollTop += (targetScroll - scroller.scrollTop) * easing;
      animationFrameRef.current = requestAnimationFrame(updateScroll);
    };

    animationFrameRef.current = requestAnimationFrame(updateScroll);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [audioRef, duration, following, parsedLyrics, timingAdjustment, trackKey]);

  const pauseForInteraction = () => {
    if (followEnabled && !manualPause) setManualPause(true);
  };

  const toggleFollowing = () => {
    if (manualPause) {
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
    ? "Retomar rolagem"
    : followEnabled && active
      ? "Pausar rolagem"
      : followEnabled
        ? "Automático ativado"
        : "Acompanhar letra";
  const controlClass = following ? "active" : followEnabled && !manualPause ? "ready" : "";
  const controlSymbol = following ? "Ⅱ" : followEnabled && !manualPause ? "✓" : "▶";

  return (
    <div className="lyrics-view">
      <div className="lyrics-toolbar">
        <span className="lyrics-sync-status" role="status" aria-live="polite">
          <i aria-hidden="true" />
          {manualPause ? "Rolagem pausada" : parsedLyrics.synced ? "Sincronizada" : "Acompanhamento aproximado"}
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
              aria-label="Atrasar a letra em 5 segundos"
              title="Atrasar a letra em 5 segundos"
              onClick={() => adjustTiming(-5)}
            >
              −5 s
            </button>
            <button
              type="button"
              aria-label="Adiantar a letra em 5 segundos"
              title="Adiantar a letra em 5 segundos"
              onClick={() => adjustTiming(5)}
            >
              +5 s
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
      <div
        ref={scrollRef}
        className="lyrics-scroll"
        tabIndex="0"
        aria-label={`Letra de ${title}`}
        onWheel={pauseForInteraction}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) pauseForInteraction();
        }}
        onPointerDown={(event) => {
          pointerStartRef.current = { x: event.clientX, y: event.clientY };
          if (event.pointerType !== "mouse") pauseForInteraction();
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
        {parsedLyrics.rows.map((row, index) => row.blank
          ? <span className="lyric-break" key={row.id} aria-hidden="true" />
          : (
            <p
              ref={(element) => { lineRefs.current[index] = element; }}
              className={`lyric-line ${parsedLyrics.synced && index === activeLine ? "is-current" : ""}`}
              aria-current={parsedLyrics.synced && index === activeLine ? "true" : undefined}
              key={row.id}
            >
              {row.text}
            </p>
          ))}
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
    const minimumFrameTime = coarsePointer ? 1000 / 30 : 0;
    const waterlineRatio = .37;

    const smoothstep = (value) => value * value * (3 - 2 * value);
    const navigationStrength = () => smoothstep(seaEnergy);
    const waveAmplitude = () => .1 + navigationStrength() * .9;
    const waveScale = () => Math.max(.78, Math.min(1.45, height / 30));
    const obstacleX = () => width * .47;
    const vesselWidth = () => Math.max(100, Math.min(120, width * .52));
    const surfaceY = (x, time) => {
      const scale = waveScale();
      const baseline = height * waterlineRatio;
      const amplitude = waveAmplitude();
      const directWave = baseline
        - Math.sin(x * .036 - time * 1.76) * 3.15 * scale * amplitude
        - Math.sin(x * .079 - time * 2.62 + .85) * 1.05 * scale * amplitude
        - Math.sin(x * .018 - time * .82 + 2.1) * .65 * scale * amplitude;
      const distanceToObstacle = obstacleX() - x;
      if (distanceToObstacle <= 0) return directWave;
      const reflectionFalloff = Math.exp(-distanceToObstacle / Math.max(46, width * .25));
      const reflectedWave = Math.sin((obstacleX() * 2 - x) * .043 - time * 1.34 + .4) * .58 * scale * reflectionFalloff * amplitude;
      return directWave - reflectedWave;
    };
    const surfaceX = (x, time) => {
      if (x <= 0 || x >= width) return x;
      const scale = waveScale();
      const amplitude = waveAmplitude();
      return x
        + Math.cos(x * .036 - time * 1.76) * .52 * scale * amplitude
        + Math.cos(x * .079 - time * 2.62 + .85) * .16 * scale * amplitude;
    };
    const deepY = (x, time) => {
      const scale = waveScale();
      const amplitude = waveAmplitude();
      return height * .48
        - Math.sin(x * .028 - time * .88 + 1.45) * 2.15 * scale * amplitude
        - Math.sin(x * .057 - time * 1.18) * .6 * scale * amplitude;
    };

    const createGradients = () => {
      const deepFill = context.createLinearGradient(0, height * .35, 0, height * .55);
      deepFill.addColorStop(0, "rgba(20, 126, 167, .18)");
      deepFill.addColorStop(1, "rgba(4, 50, 78, 0)");
      const waterFill = context.createLinearGradient(0, height * waterlineRatio, 0, height * .55);
      waterFill.addColorStop(0, "rgba(48, 192, 224, .38)");
      waterFill.addColorStop(.5, "rgba(12, 112, 157, .25)");
      waterFill.addColorStop(1, "rgba(4, 49, 76, .03)");
      const surfaceStroke = context.createLinearGradient(0, 0, width, 0);
      surfaceStroke.addColorStop(0, "#117ca9");
      surfaceStroke.addColorStop(.48, "#55d1ed");
      surfaceStroke.addColorStop(1, "#1786b3");
      gradients = { deepFill, waterFill, surfaceStroke };
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
      const threshold = height * waterlineRatio - 2.15 * scale * waveAmplitude();
      let drawing = false;
      context.beginPath();
      for (let x = 0; x <= width + 2; x += 1.5) {
        const y = surfaceY(x, time);
        const nextY = surfaceY(x + 1.5, time);
        const isCrest = y < threshold && Math.abs(nextY - y) < .8 * scale;
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
      const aspectRatio = shipImage.naturalWidth / shipImage.naturalHeight || 3.69;
      const renderedHeight = renderedWidth / aspectRatio;
      const isStaticFrame = deltaTime <= 0;

      const surgeTarget = (
        Math.sin(time * .54 + .65) * .85
        + Math.sin(time * .23 + 2.25) * .35
      ) * scale * navigationStrength();
      [shipSurge, shipSurgeVelocity] = updateSpring(shipSurge, shipSurgeVelocity, surgeTarget, .32, .95, deltaTime);

      const x = obstacleX() + shipSurge;
      const waterSamples = [[.08, .1], [.27, .22], [.5, .36], [.73, .22], [.92, .1]];
      const sampledHeave = waterSamples.reduce(
        (sum, [position, weight]) => sum + surfaceY(x + renderedWidth * position, time) * weight,
        0
      ) - .2 * scale;
      const heaveBaseline = height * waterlineRatio - .2 * scale;
      const heaveTarget = Math.max(
        heaveBaseline - 2.8 * scale * waveAmplitude(),
        Math.min(heaveBaseline + 2.8 * scale * waveAmplitude(), sampledHeave)
      );
      [shipHeave, shipHeaveVelocity] = updateSpring(shipHeave, shipHeaveVelocity, heaveTarget, .95, .82, deltaTime);

      const bowWaterY = (
        surfaceY(x + renderedWidth * .07, time)
        + surfaceY(x + renderedWidth * .17, time)
      ) * .5;
      const sternWaterY = (
        surfaceY(x + renderedWidth * .83, time)
        + surfaceY(x + renderedWidth * .93, time)
      ) * .5;

      const pitchTarget = Math.max(
        -.048,
        Math.min(.048, Math.atan2(sternWaterY - bowWaterY, renderedWidth * .76) * .82)
      );
      [shipPitch, shipPitchVelocity] = updateSpring(shipPitch, shipPitchVelocity, pitchTarget, .78, .86, deltaTime);

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
      context.save();
      context.translate(shipCenterX, shipHeave);
      context.rotate(shipPitch);

      // Sombra estreita sob o casco para integrar o recorte ao mar.
      context.beginPath();
      context.ellipse(0, 1.9, renderedWidth * .43, 1.25 * scale, 0, 0, Math.PI * 2);
      context.fillStyle = "rgba(1, 20, 33, .3)";
      context.fill();

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.shadowColor = "rgba(0, 8, 16, .42)";
      context.shadowBlur = 2.2 * scale;
      context.shadowOffsetY = 1.1 * scale;
      context.drawImage(shipImage, -renderedWidth * .5, -renderedHeight * .88, renderedWidth, renderedHeight);

      // A âncora pertence ao navio: fundeada na proa quando a rádio está
      // parada e recolhida suavemente antes de o navio voltar a navegar.
      const anchorTravel = smoothstep(anchorProgress);
      const anchorOpacity = .8 + (1 - anchorTravel) * .2;
      if (anchorOpacity > .01) {
        const detailScale = Math.max(.82, Math.min(1.18, width / 190));
        const bowX = -renderedWidth * .39;
        const hawseY = -renderedHeight * .16;
        const deployedChainLength = Math.max(28, Math.min(45, height * .48));
        const chainLength = (deployedChainLength * (1 - anchorTravel) + 1.5 * anchorTravel) * detailScale;
        const anchorSize = (8 * (1 - anchorTravel) + 2.35 * anchorTravel) * detailScale;
        const deployedAmount = 1 - anchorTravel;
        const pendulumOffset = (
          Math.sin(pendulumTime * .78)
          + Math.sin(pendulumTime * 1.31 + .9) * .28
        ) * 1.7 * detailScale * (.04 + deployedAmount * .96);
        const stowedOffsetX = anchorTravel * 2.2 * detailScale;
        const chainEndX = bowX - .4 * scale + pendulumOffset + stowedOffsetX;
        const pendulumAngle = pendulumOffset / Math.max(18, chainLength) * .72;
        context.save();
        context.globalAlpha = anchorOpacity;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.shadowColor = "rgba(0, 7, 13, .62)";
        context.shadowBlur = 1.8 * scale;

        // Corrente de aço, com uma base escura para continuar legível sobre a água.
        context.globalAlpha = anchorOpacity * (.06 + deployedAmount * .94);
        context.setLineDash([1.25 * scale, 1.15 * scale]);
        context.beginPath();
        context.moveTo(bowX, hawseY);
        context.quadraticCurveTo(
          bowX + pendulumOffset * .28,
          hawseY + chainLength * .46,
          chainEndX,
          hawseY + chainLength
        );
        context.strokeStyle = "#46535c";
        context.lineWidth = Math.max(1.35, 1.32 * scale);
        context.stroke();
        context.strokeStyle = "#dce4e9";
        context.lineWidth = Math.max(.68, .62 * scale);
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
      drawWaveLayer(surfaceY, elapsed, gradients.waterFill, gradients.surfaceStroke, Math.max(1.15, waveScale() * 1.55), surfaceX);
      drawCrestFoam(elapsed);

      const impactPoint = drawShip(elapsed, isStatic ? 0 : deltaTime);
      const impactStrength = impactPoint.impactStrength;
      if (navigationStrength() > .45 && shipReady && !isStatic && impactStrength > .42 && previousImpact <= .42 && elapsed - lastSplashTime > 1.35) {
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
      simulationTime += deltaTime * (.025 + navigationStrength() * .975);
      drawFrame(simulationTime, deltaTime);
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
      pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      createGradients();
      startAnimation();
    };
    const handleVisibility = () => document.hidden ? stopAnimation() : startAnimation();
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
    shipImage.addEventListener("load", handleShipLoad);
    shipImage.src = "/imagens/navio-f200-v2.png";
    resizeCanvas();

    return () => {
      stopAnimation();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resizeCanvas);
      document.removeEventListener("visibilitychange", handleVisibility);
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

function getCurrentProgram(date = new Date()) {
  const dayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1;
  const programs = WEEKEND_PROGRAMS[dayIndex] || WEEKDAY_PROGRAMS;
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };

  const scheduledProgram = programs.find(([time]) => {
    const [startText, endText] = time.split(/\s*[–-]\s*/);
    if (!endText) return false;
    return currentMinutes >= toMinutes(startText) && currentMinutes < toMinutes(endText);
  });

  return scheduledProgram?.[1] || "Programação ao vivo";
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
  const streamWaitingMediaTimeRef = useRef(0);
  const streamHasStartedRef = useRef(false);
  const streamLatencyRef = useRef(0);
  const streamTransportOverheadRef = useRef(0);
  const streamLatencyMeasuredAtRef = useRef(0);
  const [track, setTrack] = useState(initialTrack);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamLatency, setStreamLatency] = useState(0);
  const [volume, setVolume] = useState(() => getStored("radio-volume", 0.85));
  const [lastVolume, setLastVolume] = useState(0.85);
  const [message, setMessage] = useState("");
  const [favorites, setFavorites] = useState(() => getStored("radio-favorites", []));
  const [panel, setPanel] = useState("lyrics");
  const [timerOpen, setTimerOpen] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [lyrics, setLyrics] = useState("");
  const [lyricsDuration, setLyricsDuration] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(true);
  const [artistInfo, setArtistInfo] = useState(null);
  const [artistLoading, setArtistLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [scheduleDay, setScheduleDay] = useState(() => Math.min(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1, 6));
  const [currentProgram, setCurrentProgram] = useState(() => getCurrentProgram());

  displayedTrackRef.current = track;
  playingRef.current = playing;
  const favoriteKey = `${track.artist}—${track.title}`;
  const playbackKey = `${favoriteKey}—${track.playbackId || track.playedAt || track.updatedAt || "atual"}`;
  const favorite = favorites.some((item) => item.key === favoriteKey);

  function displayTrack(nextTrack) {
    clearTimeout(pendingTrackTimerRef.current);
    pendingTrackTimerRef.current = 0;
    pendingTrackRef.current = null;
    displayedTrackRef.current = nextTrack;
    setTrack(nextTrack);
  }

  function flushPendingTrack() {
    if (pendingTrackRef.current) displayTrack(pendingTrackRef.current);
  }

  useEffect(() => {
    let active = true;
    let requestInFlight = false;
    async function loadTrack() {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch("/api/now-playing", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!active) return;
        const receivedAt = performance.now();
        const incomingTrack = {
          title: data.title || "Programação ao vivo",
          artist: data.artist || "Rádio Marinha",
          album: data.album || "Rádio Marinha Online",
          cover: data.cover || FALLBACK_COVER,
          elapsed: Number(data.elapsed) || 0,
          duration: Number(data.duration) || 0,
          durationReliable: Boolean(data.durationReliable),
          syncAllowed: Boolean(data.syncAllowed),
          playbackId: data.playbackId || null,
          playedAt: Number(data.playedAt) || null,
          playbackSampledAt: receivedAt,
          updatedAt: data.updatedAt || null
        };
        const displayedTrack = displayedTrackRef.current;
        const incomingIdentity = incomingTrack.playbackId || incomingTrack.playedAt;
        const displayedIdentity = displayedTrack.playbackId || displayedTrack.playedAt;
        const isNewPlayback = Boolean(
          incomingIdentity && displayedIdentity && incomingIdentity !== displayedIdentity
        );
        const remainingTransportDelay = streamLatencyRef.current - incomingTrack.elapsed;

        if (playingRef.current && isNewPlayback && remainingTransportDelay > .15) {
          clearTimeout(pendingTrackTimerRef.current);
          pendingTrackRef.current = incomingTrack;
          pendingTrackTimerRef.current = window.setTimeout(
            () => displayTrack(incomingTrack),
            remainingTransportDelay * 1000
          );
        } else {
          displayTrack(incomingTrack);
        }
        setMessage("");
      } catch {
        if (active) setMessage("Os dados da programação estão temporariamente indisponíveis.");
      } finally {
        requestInFlight = false;
      }
    }
    loadTrack();
    const interval = setInterval(loadTrack, 5000);
    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(pendingTrackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const updateCurrentProgram = () => setCurrentProgram(getCurrentProgram());
    updateCurrentProgram();
    const interval = setInterval(updateCurrentProgram, 60000);
    return () => clearInterval(interval);
  }, []);

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
      artwork: [{ src: new URL(track.cover || FALLBACK_COVER, window.location.href).href }]
    });
    navigator.mediaSession.setActionHandler("play", () => {
      if (!playing) void startRadio();
    });
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
  }, [loading, playing, track]);

  useEffect(() => {
    if (!track.artist || !track.title || track.artist === "Rádio Marinha") {
      setLyrics("");
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
      .finally(() => { if (active) setLyricsLoading(false); });

    fetch(`/api/artist?name=${encodeURIComponent(track.artist)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((artistResult) => { if (active) setArtistInfo(artistResult); })
      .catch(() => {})
      .finally(() => { if (active) setArtistLoading(false); });

    return () => { active = false; controller.abort(); };
  }, [track.album, track.artist, track.duration, track.durationReliable, track.playbackId, track.syncAllowed, track.title]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
  }, []);

  function getBufferedLatency() {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.currentTime) || !audio.buffered.length) return null;
    try {
      for (let index = 0; index < audio.buffered.length; index += 1) {
        const rangeStart = audio.buffered.start(index);
        const rangeEnd = audio.buffered.end(index);
        if (audio.currentTime >= rangeStart - .05 && audio.currentTime <= rangeEnd + .05) {
          const bufferedAhead = rangeEnd - audio.currentTime;
          return Number.isFinite(bufferedAhead) && bufferedAhead >= 0 && bufferedAhead <= 45
            ? bufferedAhead
            : null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function commitStreamLatency(value, immediate = false) {
    if (!Number.isFinite(value)) return;
    const measured = Math.max(0, Math.min(45, value));
    const current = streamLatencyRef.current;
    const next = immediate
      ? measured
      : measured > current
        ? current * .65 + measured * .35
        : current * .92 + measured * .08;
    if (Math.abs(next - current) < .02) return;
    streamLatencyRef.current = next;
    setStreamLatency(next);
  }

  function measureStreamLatency(force = false) {
    const now = performance.now();
    if (!force && now - streamLatencyMeasuredAtRef.current < 1000) return;
    streamLatencyMeasuredAtRef.current = now;
    const bufferedAhead = getBufferedLatency();
    if (bufferedAhead !== null) {
      commitStreamLatency(bufferedAhead + streamTransportOverheadRef.current);
    }
  }

  function handleAudioWaiting() {
    if (streamHasStartedRef.current && !streamWaitingStartedAtRef.current) {
      streamWaitingStartedAtRef.current = performance.now();
      streamWaitingMediaTimeRef.current = Number(audioRef.current?.currentTime) || 0;
    }
    setLoading(true);
  }

  function handleAudioPlaying() {
    const now = performance.now();
    const bufferedAhead = getBufferedLatency();
    const waitingDuration = streamWaitingStartedAtRef.current
      ? Math.max(0, (now - streamWaitingStartedAtRef.current) / 1000)
      : 0;
    const mediaTime = Number(audioRef.current?.currentTime) || 0;
    const mediaAdvancedWhileWaiting = Math.max(0, mediaTime - streamWaitingMediaTimeRef.current);
    const stalledFor = Math.max(0, waitingDuration - mediaAdvancedWhileWaiting);

    if (!streamHasStartedRef.current) {
      const startupLatency = streamRequestStartedAtRef.current
        ? Math.max(0, (now - streamRequestStartedAtRef.current) / 1000)
        : 0;
      streamTransportOverheadRef.current = 0;
      commitStreamLatency(
        bufferedAhead === null ? Math.min(startupLatency, 3) : bufferedAhead,
        true
      );
      streamHasStartedRef.current = true;
    } else {
      if (stalledFor) {
        streamTransportOverheadRef.current = Math.min(
          45,
          streamTransportOverheadRef.current + stalledFor
        );
      }
      if (bufferedAhead !== null) {
        commitStreamLatency(
          bufferedAhead + streamTransportOverheadRef.current,
          stalledFor > 0
        );
      } else if (stalledFor) {
        commitStreamLatency(streamLatencyRef.current + stalledFor, true);
      }
    }

    streamWaitingStartedAtRef.current = 0;
    streamWaitingMediaTimeRef.current = 0;
    setLoading(false);
  }

  function handleAudioPause() {
    playingRef.current = false;
    setPlaying(false);
    setLoading(false);
    streamWaitingStartedAtRef.current = 0;
    streamWaitingMediaTimeRef.current = 0;
    flushPendingTrack();
  }

  async function startRadio() {
    if (!audioRef.current || loading) return;
    setMessage("");
    try {
      setLoading(true);
      streamRequestStartedAtRef.current = performance.now();
      streamWaitingStartedAtRef.current = 0;
      streamWaitingMediaTimeRef.current = 0;
      streamHasStartedRef.current = false;
      streamLatencyMeasuredAtRef.current = 0;
      streamLatencyRef.current = 0;
      streamTransportOverheadRef.current = 0;
      setStreamLatency(0);
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

  return (
    <main className={`app ${playing ? "is-playing" : ""} ${loading ? "is-loading" : ""}`}>
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
              <img className="cover" src={track.cover || FALLBACK_COVER} alt={`Capa de ${track.title}`} onError={useFallbackCover} />
            </div>
            <div className="track-copy">
              <h1>{track.title}</h1>
              <p className="artist">{track.artist}</p>
              <p className="album program-now"><span>PROGRAMA NO AR</span>{currentProgram}</p>
            </div>

            <div className="main-controls">
              <button className="play" onClick={toggleRadio} aria-label={playing ? "Pausar rádio" : "Ouvir rádio"}>
                {loading ? <span className="spinner" /> : (
                  <span className={`play-symbol ${playing ? "pause-state" : "play-state"}`} aria-hidden="true">
                    {playing && <><i /><i /></>}
                  </span>
                )}
              </button>
            </div>

            <div className="volume-control">
              <button onClick={toggleMute} aria-label={volume ? "Silenciar" : "Ativar som"}>{volume ? "◖))" : "◖×"}</button>
              <input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
              <output>{Math.round(volume * 100)}%</output>
            </div>

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
              <button className={panel === "favorites" ? "active" : ""} onClick={() => setPanel("favorites")}>Favoritos</button>
            </nav>

            <div className="tab-content">
              {panel === "radio" && <div className="welcome-content"><p className="section-kicker">CONTEÚDO DA FAIXA</p><h2>Conheça o que está tocando</h2><p>Abra a letra da música ou conheça a trajetória do artista enquanto acompanha a transmissão.</p><div className="content-shortcuts"><button onClick={() => setPanel("lyrics")}>Ver letra <span>→</span></button><button onClick={() => setPanel("artist")}>Sobre o artista <span>→</span></button></div></div>}
              {panel === "lyrics" && <div className="lyrics-content"><div className="content-heading"><div><p className="section-kicker">LETRA</p><h2>{track.title}</h2></div><span>{track.artist}</span></div>{lyricsLoading ? <div className="content-loading"><span className="spinner" /> Buscando letra…</div> : lyrics ? <AutoScrollingLyrics active={playing && !loading} audioRef={audioRef} duration={lyricsDuration || (track.durationReliable ? track.duration : 0)} elapsed={track.elapsed} latency={streamLatency} lyrics={lyrics} playbackSampledAt={track.playbackSampledAt} trackKey={playbackKey} title={track.title} /> : <div className="empty-state"><strong>Letra não disponível</strong><p>Não encontramos uma letra confiável para esta faixa.</p></div>}</div>}
              {panel === "artist" && <div className="artist-content">{artistLoading ? <div className="content-loading"><span className="spinner" /> Buscando artista…</div> : artistInfo?.biography ? <><div className="artist-heading">{artistInfo.image && <img src={artistInfo.image} alt={artistInfo.name} />}<div><p className="section-kicker">SOBRE O ARTISTA</p><h2>{artistInfo.name || track.artist}</h2><span>{[artistInfo.genre, artistInfo.country].filter(Boolean).join(" • ")}</span></div></div><p className="biography">{artistInfo.biography}</p></> : <div className="empty-state"><strong>História não disponível</strong><p>A biografia de {track.artist} ainda não foi encontrada em nossa fonte.</p></div>}</div>}
              {panel === "favorites" && <div><h2>Suas músicas favoritas</h2>{favorites.length ? <ul>{favorites.map((item) => <li key={item.key}><img src={item.cover || FALLBACK_COVER} alt="" onError={useFallbackCover} /><span><strong>{item.title}</strong><small>{item.artist}</small></span><button aria-label={`Remover ${item.title}`} onClick={() => { const next = favorites.filter((favoriteItem) => favoriteItem.key !== item.key); setFavorites(next); localStorage.setItem("radio-favorites", JSON.stringify(next)); }}>×</button></li>)}</ul> : <p>As músicas que você favoritar aparecerão aqui.</p>}</div>}
            </div>
          </section>
        </div>

        <footer><span>Rádio Marinha Online</span><span>{track.updatedAt ? `Atualizado às ${new Date(track.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Conectando à programação"}</span></footer>
      </section>

      {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
        <section className={`modal-card ${modal === "schedule" ? "schedule-modal" : "contact-modal"}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <header className="modal-header">
            <div className="modal-title"><span className="action-icon-wrap"><ActionIcon name={modal === "schedule" ? "radio" : "mail"} /></span><div><small>RÁDIO MARINHA</small><h2 id="modal-title">{modal === "schedule" ? "Programação" : "Fale conosco"}</h2></div></div>
            <button className="modal-close" onClick={() => setModal(null)} aria-label="Fechar">×</button>
          </header>

          {modal === "schedule" ? <>
            <nav className="day-tabs" aria-label="Dias da programação">{DAYS.map((day, index) => <button key={day} className={scheduleDay === index ? "active" : ""} onClick={() => setScheduleDay(index)}>{day}</button>)}</nav>
            <div className="schedule-list">{(WEEKEND_PROGRAMS[scheduleDay] || WEEKDAY_PROGRAMS).map(([time, title, description]) => <article className="schedule-item" key={`${time}-${title}`}><time>{time}</time><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
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
          playingRef.current = true;
          setPlaying(true);
        }}
        onPause={handleAudioPause}
        onWaiting={handleAudioWaiting}
        onPlaying={handleAudioPlaying}
        onProgress={() => measureStreamLatency()}
        onTimeUpdate={() => measureStreamLatency()}
        onEnded={handleAudioPause}
        onError={() => {
          playingRef.current = false;
          setPlaying(false);
          setLoading(false);
          setMessage("Não foi possível conectar à transmissão.");
          flushPendingTrack();
        }}
      />
    </main>
  );
}
