import { normalizeArtistFingerprint } from './trackMetadata.js';

function normalizeMetadata(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|featuring|ft)\b.*$/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  return normalizeMetadata(value)
    .replace(/\b(ao vivo|acustico|live|remasterizado|remastered)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVersionMetadata(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const VERSION_MARKERS = [
  /\b(?:ao vivo|live)\b/,
  /\b(?:acustico|acoustic)\b/,
  /\b(?:remix|mix)\b/,
  /\b(?:remasterizado|remastered|remaster)\b/,
  /\b(?:cover|karaoke|tribute|tributo|instrumental)\b/
];

function hasMatchingVersionProfile(source, candidate) {
  const sourceText = normalizeVersionMetadata(source);
  const candidateText = normalizeVersionMetadata(candidate);
  return VERSION_MARKERS.every(
    (marker) => marker.test(sourceText) === marker.test(candidateText)
  );
}

function sanitizeDuration(value) {
  const duration = Math.max(0, Number(value) || 0);
  return duration >= 30 && duration <= 1800 ? duration : 0;
}

export function scoreSyncedLyricsCandidate(candidate, artist, title, duration = 0, album = '') {
  if (!candidate?.syncedLyrics) return Number.NEGATIVE_INFINITY;
  const sourceArtist = normalizeArtistFingerprint(artist);
  const sourceTitle = normalizeTitle(title);
  const candidateArtist = normalizeArtistFingerprint(candidate.artistName);
  const candidateTitle = normalizeTitle(candidate.trackName);
  let score = 0;

  if (candidateTitle === sourceTitle) score += 90;
  else if (candidateTitle.includes(sourceTitle) || sourceTitle.includes(candidateTitle)) score += 35;
  else return Number.NEGATIVE_INFINITY;

  if (candidateArtist === sourceArtist) score += 80;
  else if (candidateArtist.includes(sourceArtist) || sourceArtist.includes(candidateArtist)) score += 30;
  else return Number.NEGATIVE_INFINITY;

  if (!hasMatchingVersionProfile(title, candidate.trackName)) {
    return Number.NEGATIVE_INFINITY;
  }
  score += 35;

  const requestedDuration = sanitizeDuration(duration);
  const candidateDuration = sanitizeDuration(candidate.duration);
  if (requestedDuration && candidateDuration) {
    const difference = Math.abs(requestedDuration - candidateDuration);
    if (difference <= 3) score += 90;
    else if (difference <= 8) score += 45;
    else if (difference <= 15) score -= 35;
    else score -= 140;
  }

  const sourceAlbum = normalizeMetadata(album);
  const candidateAlbum = normalizeMetadata(candidate.albumName);
  if (sourceAlbum && candidateAlbum) score += sourceAlbum === candidateAlbum ? 35 : -8;
  return score;
}

export function selectBestSyncedLyrics(candidates, artist, title, duration = 0, album = '') {
  const best = (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreSyncedLyricsCandidate(candidate, artist, title, duration, album)
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((first, second) => second.score - first.score || first.index - second.index)[0];
  return best && best.score >= 120 ? best.candidate : null;
}
