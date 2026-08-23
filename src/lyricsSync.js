const LRC_TIMESTAMP = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;

export function parseLyrics(lyrics) {
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
      if (text) timedRows.push({
        id: `timed-${rowIndex}-${timeIndex}`,
        text,
        time: Math.max(0, time + offsetSeconds)
      });
    });
  });

  if (timedRows.length > 1) {
    timedRows.sort((first, second) => first.time - second.time);
    return { synced: true, rows: timedRows };
  }
  return { synced: false, rows: plainRows };
}

export function estimateLyricsDuration(rows) {
  const textRows = rows.filter((row) => !row.blank);
  const wordCount = textRows.reduce((total, row) => total + row.text.split(/\s+/).length, 0);
  const stanzaBreaks = rows.filter((row) => row.blank).length;
  const singingTime = wordCount / 1.25;
  const phrasingTime = textRows.length * .8 + stanzaBreaks * 3;
  return Math.max(180, Math.min(480, singingTime + phrasingTime + 40));
}

export function findActiveLyricIndex(rows, elapsed) {
  if (!rows.length || !Number.isFinite(elapsed)) return -1;
  let low = 0;
  let high = rows.length - 1;
  let match = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time <= elapsed) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

export function projectBroadcastElapsed(clock, now = performance.now()) {
  const elapsed = Math.max(0, Number(clock?.elapsed) || 0);
  const sampledAt = Number(clock?.sampledAt) || now;
  const correction = Number(clock?.correction) || 0;
  return Math.max(0, elapsed + Math.max(0, now - sampledAt) / 1000 + correction);
}

export function estimateStreamStartupDelay(
  requestStartedAt,
  playingAt,
  bufferedAhead = null,
  maximumFallbackSeconds = 10,
  maximumBufferedSeconds = 45
) {
  const maximumFallback = Number.isFinite(Number(maximumFallbackSeconds))
    ? Math.max(0, Number(maximumFallbackSeconds))
    : 10;
  const maximumBuffer = Number.isFinite(Number(maximumBufferedSeconds))
    ? Math.max(0, Number(maximumBufferedSeconds))
    : 45;
  const buffered = Number(bufferedAhead);
  if (bufferedAhead !== null && Number.isFinite(buffered) && buffered >= 0) {
    return Math.min(maximumBuffer, buffered);
  }

  const startedAt = Number(requestStartedAt);
  const readyAt = Number(playingAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(readyAt) || startedAt <= 0 || readyAt <= startedAt) {
    return 0;
  }
  return Math.min(maximumFallback, (readyAt - startedAt) / 2000);
}

export function createStreamPositionZeroAt(readyAt, mediaTime, startupDelay) {
  const ready = Number(readyAt);
  const position = Number(mediaTime);
  const delay = Number(startupDelay);
  if (
    !Number.isFinite(ready)
    || !Number.isFinite(position)
    || position < 0
    || !Number.isFinite(delay)
    || delay < 0
  ) {
    return null;
  }
  return ready - (position + delay) * 1000;
}

export function projectAudibleTrackElapsed({
  mediaTime,
  streamPositionZeroAt,
  trackElapsed,
  trackSampledAt
}) {
  if (
    streamPositionZeroAt === null
    || streamPositionZeroAt === undefined
    || trackSampledAt === null
    || trackSampledAt === undefined
  ) {
    return null;
  }
  const position = Number(mediaTime);
  const streamStart = Number(streamPositionZeroAt);
  const elapsed = Number(trackElapsed);
  const sampledAt = Number(trackSampledAt);
  if (
    !Number.isFinite(position)
    || position < 0
    || !Number.isFinite(streamStart)
    || !Number.isFinite(elapsed)
    || elapsed < 0
    || !Number.isFinite(sampledAt)
  ) {
    return null;
  }

  const songStartedAt = sampledAt - elapsed * 1000;
  return (streamStart + position * 1000 - songStartedAt) / 1000;
}

export function getTrackTransitionDelay(clock, minimumSeconds = .12, maximumSeconds = 3) {
  const audibleElapsed = projectAudibleTrackElapsed(clock);
  if (!Number.isFinite(audibleElapsed)) return null;
  if (audibleElapsed >= -.08) return 0;
  const minimum = Math.max(0, Number(minimumSeconds) || 0);
  const maximum = Math.max(minimum, Number(maximumSeconds) || 0);
  return Math.max(minimum, Math.min(maximum, -audibleElapsed));
}

export function reconcileBroadcastClock(previous, sample, now = performance.now()) {
  const nextElapsed = Math.max(0, Number(sample?.elapsed) || 0);
  const nextSampledAt = Number(sample?.sampledAt) || now;
  const changedTrack = !previous || previous.trackKey !== sample?.trackKey;
  const nextClock = {
    elapsed: nextElapsed,
    sampledAt: nextSampledAt,
    correction: 0,
    trackKey: sample?.trackKey ?? null
  };

  if (changedTrack) return { ...nextClock, changedTrack: true };
  return {
    elapsed: Math.max(0, Number(previous.elapsed) || 0),
    sampledAt: Number(previous.sampledAt) || nextSampledAt,
    correction: 0,
    trackKey: sample?.trackKey ?? null,
    changedTrack: false
  };
}
