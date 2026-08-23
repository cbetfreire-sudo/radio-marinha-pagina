export function selectStationElapsed(reportedElapsed, playedAt, sampledAtMs) {
  const hasReportedElapsed = reportedElapsed !== null
    && reportedElapsed !== undefined
    && String(reportedElapsed).trim() !== '';
  const reported = Number(reportedElapsed);
  if (hasReportedElapsed && Number.isFinite(reported) && reported >= 0) return reported;

  const startedAt = Number(playedAt);
  const sampledAt = Number(sampledAtMs);
  if (Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(sampledAt) && sampledAt > 0) {
    return Math.max(0, sampledAt / 1000 - startedAt);
  }
  return 0;
}

export function addRadioStatusCacheBuster(rawUrl, nonce = Date.now()) {
  const url = new URL(rawUrl);
  url.searchParams.set('_', String(nonce));
  return url.toString();
}
