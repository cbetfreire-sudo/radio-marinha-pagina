import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_HOSTS = ['radio-marinha-pagina.onrender.com', 'localhost', '127.0.0.1', '.onrender.com'];
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DIST_DIR = path.join(__dirname, 'dist');

const API_URL = 'https://stm0.inovativa.net/api/nowplaying/radiomarinha';
const FALLBACK_GIF = '/imagens/radio_gif.gif';
const LRCLIB_USER_AGENT = 'RadioMarinha/2.0 (radiomarinha.marinha.mil.br)';
const STATION_IDENTIFIERS = ['radio marinha', 'programacao ao vivo'];
const MISSING_ARTIST_IDENTIFIERS = new Set([
    '', 'radio marinha', 'programacao ao vivo', 'unknown artist', 'artista desconhecido'
]);
const PORTUGUESE_SPELLING = new Map([
    ['acustico', 'acústico'], ['alem', 'além'], ['amanha', 'amanhã'],
    ['aviao', 'avião'], ['caca', 'cacá'], ['cancao', 'canção'], ['coracao', 'coração'],
    ['entao', 'então'], ['estacao', 'estação'], ['facil', 'fácil'], ['fe', 'fé'],
    ['girao', 'girão'], ['historia', 'história'], ['irmao', 'irmão'], ['mae', 'mãe'],
    ['maeana', 'mãeana'], ['magalhaes', 'magalhães'], ['nao', 'não'], ['ninguem', 'ninguém'],
    ['paixao', 'paixão'], ['radio', 'rádio'], ['relicario', 'relicário'],
    ['sinonimos', 'sinônimos'], ['so', 'só'], ['taxi', 'táxi'], ['voce', 'você'],
    ['violao', 'violão'], ['ze', 'zé']
]);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagens', express.static(path.join(__dirname, 'imagens')));

let nowPlaying = {
    title: "Rádio Marinha",
    artist: "Programação ao vivo",
    album: "Rádio Marinha Online",
    cover: FALLBACK_GIF,
    streamTitle: "",
    elapsed: 0,
    duration: 0,
    durationReliable: false,
    syncAllowed: false,
    playbackId: null,
    playedAt: null,
    sampledAt: Date.now(),
    updatedAt: null
};
let playingNext = null;
let songHistory = [];
const catalogCache = new Map();
let radioStatusFetchInFlight = false;
const observedTrackDurations = new Map();

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

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

function capitalizeTitle(value) {
    return String(value || '').replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase('pt-BR'));
}

function cleanRadioMetadata(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[–—-]\s*/u, '')
        .trim();
}

function splitArtistAndTitle(value) {
    const cleaned = cleanRadioMetadata(value);
    const match = cleaned.match(/^(.+?)(?:\s+-\s*|\s*-\s+|\s*[–—]\s*)(.+)$/u);
    if (!match) return null;

    const artist = cleanRadioMetadata(match[1]);
    const title = cleanRadioMetadata(match[2]);
    if (normalizeMetadata(artist).length < 2 || normalizeMetadata(title).length < 2) return null;
    return { artist, title };
}

function resolveTrackFields(current) {
    const receivedArtist = cleanRadioMetadata(current?.artist);
    const artist = MISSING_ARTIST_IDENTIFIERS.has(normalizeMetadata(receivedArtist)) ? '' : receivedArtist;
    const title = cleanRadioMetadata(current?.title);

    if (artist) {
        const titlePair = splitArtistAndTitle(title);
        if (titlePair && normalizeMetadata(titlePair.artist) === normalizeMetadata(artist)) {
            return { artist, title: titlePair.title };
        }
        return { artist, title };
    }

    const combinedMetadata = [title, current?.text]
        .map(splitArtistAndTitle)
        .find(Boolean);
    return combinedMetadata || { artist: '', title };
}

function isStationIdentifier(artist, title) {
    const titleMetadata = normalizeMetadata(title);
    if (!titleMetadata || titleMetadata.length < 3) return true;
    return STATION_IDENTIFIERS.some((identifier) => titleMetadata.includes(identifier));
}

function getLevenshteinDistance(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const matrix = Array(a.length + 1).fill().map(() => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        }
    }
    return matrix[a.length][b.length];
}

function restoreAccents(value, officialValues, usePortugueseSpelling = false) {
    const accentsByWord = new Map();

    officialValues.forEach((officialValue) => {
        String(officialValue || '').match(/[\p{L}\p{N}]+/gu)?.forEach((word) => {
            const normalizedWord = normalizeMetadata(word);
            if (normalizedWord && normalizedWord !== word.toLowerCase()) {
                accentsByWord.set(normalizedWord, word);
            }
        });
    });

    return String(value || '').replace(/[\p{L}\p{N}]+/gu, (word) => {
        const normalizedWord = normalizeMetadata(word);
        const officialWord = accentsByWord.get(normalizedWord)
            || (usePortugueseSpelling ? PORTUGUESE_SPELLING.get(normalizedWord) : null);
        if (!officialWord) return word;
        if (word === word.toUpperCase()) return officialWord.toUpperCase();
        if (word[0] === word[0].toUpperCase()) return officialWord[0].toUpperCase() + officialWord.slice(1);
        return officialWord.toLowerCase();
    });
}

function isMatchingTrack(result, artist, title) {
    const sourceArtist = normalizeMetadata(artist);
    const sourceTitle = normalizeTitle(title);
    const resultArtist = normalizeMetadata(result.artist?.name);
    const resultTitle = normalizeTitle(result.title_short || result.title);
    if (!resultTitle) return false;
    let titleMatches = resultTitle === sourceTitle
        || resultTitle.includes(sourceTitle)
        || sourceTitle.includes(resultTitle);
    
    if (!titleMatches && sourceTitle.length > 4 && resultTitle.length > 4) {
        const distance = getLevenshteinDistance(sourceTitle, resultTitle);
        if (distance <= 2 && Math.max(sourceTitle.length, resultTitle.length) >= 7) {
            titleMatches = true;
        }
    }
    if (!titleMatches) return false;

    if (!sourceArtist) return true;
    let artistMatches = Boolean(resultArtist) && (sourceArtist.includes(resultArtist) || resultArtist.includes(sourceArtist));
    if (!artistMatches && sourceArtist.length > 4 && resultArtist.length > 4) {
        const distance = getLevenshteinDistance(sourceArtist, resultArtist);
        if (distance <= 2 && Math.max(sourceArtist.length, resultArtist.length) >= 6) {
            artistMatches = true;
        }
    }
    return Boolean(artistMatches);
}

function normalizeVersionMetadata(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const TRACK_VERSION_MARKERS = [
    /\b(?:ao vivo|live)\b/,
    /\b(?:acustico|acoustic)\b/,
    /\b(?:remix|mix)\b/,
    /\b(?:remasterizado|remastered|remaster)\b/
];

function hasVersionMarker(value) {
    const normalized = normalizeVersionMetadata(value);
    return TRACK_VERSION_MARKERS.some((marker) => marker.test(normalized));
}

function hasMatchingVersionProfile(source, candidate) {
    const sourceText = normalizeVersionMetadata(source);
    const candidateText = normalizeVersionMetadata(candidate);
    return TRACK_VERSION_MARKERS.every(
        (marker) => marker.test(sourceText) === marker.test(candidateText)
    );
}

function getTrackIdentity(artist, title) {
    return `${normalizeMetadata(artist)}|${normalizeVersionMetadata(title)}`;
}

function sanitizeTrackDuration(value) {
    const duration = Math.max(0, Number(value) || 0);
    return duration >= 30 && duration <= 1800 ? duration : 0;
}

function rememberObservedDurations(history = []) {
    history.forEach((entry) => {
        const fields = resolveTrackFields(entry?.song);
        const duration = sanitizeTrackDuration(entry?.duration);
        if (!fields.artist || !fields.title || !duration) return;
        if (isStationIdentifier(fields.artist, fields.title)) return;
        const key = getTrackIdentity(fields.artist, fields.title);
        const previous = observedTrackDurations.get(key);
        const ambiguous = Boolean(
            previous?.ambiguous
            || (previous?.duration && Math.abs(previous.duration - duration) > 8)
        );
        observedTrackDurations.delete(key);
        observedTrackDurations.set(key, { ambiguous, duration });
    });

    while (observedTrackDurations.size > 200) {
        observedTrackDurations.delete(observedTrackDurations.keys().next().value);
    }
}

function trackMatchScore(result, artist, title, targetDuration = 0, albumHint = '') {
    if (!isMatchingTrack(result, artist, title)) return Number.NEGATIVE_INFINITY;
    const sourceText = normalizeVersionMetadata(title);
    const resultText = normalizeVersionMetadata([result.title, result.title_version].filter(Boolean).join(' '));
    let score = 100;

    TRACK_VERSION_MARKERS.forEach((marker) => {
        score += marker.test(sourceText) === marker.test(resultText) ? 18 : -45;
    });
    if (sourceText === resultText) score += 30;
    if (!sourceText.match(/\b(?:ao vivo|live|acustico|acoustic|remix|mix|remasterizado|remastered|remaster)\b/)
        && !result.title_version) score += 8;
    const resultDuration = Math.max(0, Number(result.duration) || 0);
    if (targetDuration && resultDuration) {
        const difference = Math.abs(resultDuration - targetDuration);
        if (difference <= 3) score += 90;
        else if (difference <= 8) score += 55;
        else score -= Math.min(120, difference * 2);
    }
    const sourceAlbum = normalizeMetadata(albumHint);
    const resultAlbum = normalizeMetadata(result.album?.title);
    if (sourceAlbum && resultAlbum) {
        if (sourceAlbum === resultAlbum) score += 45;
        else if (sourceAlbum.includes(resultAlbum) || resultAlbum.includes(sourceAlbum)) score += 20;
        else score -= 12;
    }
    return score;
}

async function findTrackMetadata(artist, title, targetDuration = 0, albumHint = '') {
    try {
        const query = encodeURIComponent([artist, title].filter(Boolean).join(' '));
        const [deezerResponse, itunesResponse] = await Promise.allSettled([
            fetchWithTimeout(`https://api.deezer.com/search?q=${query}&limit=10`, {}, 4000)
                .then((response) => response.json()),
            fetchWithTimeout(`https://itunes.apple.com/search?term=${query}&entity=song&limit=10&country=BR`, {}, 4000)
                .then((response) => response.json())
        ]);
        const deezerTracks = deezerResponse.status === 'fulfilled' ? deezerResponse.value.data || [] : [];
        const itunesTracks = itunesResponse.status === 'fulfilled'
            ? (itunesResponse.value.results || []).map((result) => ({
                title: result.trackName,
                title_short: result.trackName,
                title_version: '',
                duration: Number(result.trackTimeMillis) ? Math.round(Number(result.trackTimeMillis) / 1000) : 0,
                artist: { name: result.artistName },
                album: {
                    title: result.collectionName,
                    cover_xl: result.artworkUrl100?.replace('100x100', '600x600')
                }
            }))
            : [];
        const matchingTracks = [...deezerTracks, ...itunesTracks]
            .filter((result) => isMatchingTrack(result, artist, title));
        const versionCompatibleTracks = hasVersionMarker(title)
            ? matchingTracks.filter((result) => hasMatchingVersionProfile(
                title,
                [result.title, result.title_version].filter(Boolean).join(' ')
            ))
            : matchingTracks;
        const albumMatches = normalizeMetadata(albumHint)
            ? versionCompatibleTracks.filter((result) => (
                normalizeMetadata(result.album?.title) === normalizeMetadata(albumHint)
            ))
            : [];
        const candidatePool = albumMatches.length ? albumMatches : versionCompatibleTracks;
        const match = candidatePool
            .map((result, index) => ({
                result,
                index,
                score: trackMatchScore(result, artist, title, targetDuration, albumHint)
            }))
            .filter(({ score }) => Number.isFinite(score))
            .sort((first, second) => second.score - first.score || first.index - second.index)[0]?.result;
        if (match) {
            const officialValues = [match.title, match.title_short, match.artist?.name, match.album?.title];
            const candidateDurations = candidatePool
                .map((result) => Math.max(0, Number(result.duration) || 0))
                .filter(Boolean);
            const durationSpread = candidateDurations.length > 1
                ? Math.max(...candidateDurations) - Math.min(...candidateDurations)
                : 0;
            const ambiguous = !targetDuration && durationSpread > 10;
            return {
                title: restoreAccents(title || match.title_short || match.title, officialValues, true),
                artist: restoreAccents(artist || match.artist?.name || '', officialValues, true),
                album: match.album?.title || null,
                duration: sanitizeTrackDuration(match.duration),
                cover: match.album?.cover_xl || match.album?.cover_big || null,
                ambiguous
            };
        }
    } catch (e) { console.error("[CATALOG ERROR]:", e.message); }
    return {
        title: restoreAccents(title, [], true),
        artist: restoreAccents(artist, [], true),
        album: null,
        duration: 0,
        cover: null,
        ambiguous: true
    };
}

async function getCachedTrackMetadata(artist, title, targetDuration = 0, albumHint = '') {
    let cleanArtist = cleanRadioMetadata(artist);
    const cleanTitle = cleanRadioMetadata(title);
    if (!cleanTitle) return null;

    if (STATION_IDENTIFIERS.some(id => normalizeMetadata(cleanArtist).includes(id))) {
        cleanArtist = '';
    }
    const cacheKey = getTrackIdentity(cleanArtist, cleanTitle);
    if (catalogCache.has(cacheKey)) {
        return catalogCache.get(cacheKey);
    }
    const meta = await findTrackMetadata(cleanArtist, cleanTitle, targetDuration, albumHint);
    catalogCache.set(cacheKey, meta);
    if (catalogCache.size > 250) {
        catalogCache.delete(catalogCache.keys().next().value);
    }
    return meta;
}

async function processPlayingNext(nextData) {
    if (!nextData || !nextData.song) return null;
    const song = nextData.song;
    const trackFields = resolveTrackFields(song);
    if (!trackFields.title || isStationIdentifier(trackFields.artist, trackFields.title)) {
        return null;
    }
    const duration = sanitizeTrackDuration(nextData.duration);
    const catalog = await getCachedTrackMetadata(trackFields.artist, trackFields.title, duration, song.album);
    const coverUrl = catalog?.cover
        || (song.art && !song.art.includes('generic_song') ? song.art : FALLBACK_GIF);

    return {
        title: capitalizeTitle(catalog?.title || trackFields.title),
        artist: catalog?.artist || trackFields.artist,
        album: song.album || catalog?.album || null,
        cover: coverUrl,
        duration: duration || catalog?.duration || 0,
        playlist: nextData.playlist || null,
        cuedAt: nextData.cued_at || null,
        playedAt: Number(nextData.played_at) || null
    };
}

async function processSongHistory(rawHistory = []) {
    if (!Array.isArray(rawHistory)) return [];
    const validHistory = [];
    for (const entry of rawHistory) {
        if (!entry?.song) continue;
        const trackFields = resolveTrackFields(entry.song);
        if (!trackFields.title || isStationIdentifier(trackFields.artist, trackFields.title)) {
            continue;
        }
        const playedAt = Number(entry.played_at) || null;
        const date = playedAt ? new Date(playedAt * 1000) : new Date();
        const formattedTime = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const artistName = trackFields.artist || "Rádio Marinha";
        const catalog = await getCachedTrackMetadata(artistName, trackFields.title, entry.duration, entry.song.album);
        const coverUrl = catalog?.cover
            || (entry.song.art && !entry.song.art.includes('generic_song') ? entry.song.art : FALLBACK_GIF);

        validHistory.push({
            id: entry.sh_id || `hist-${playedAt}-${trackFields.title}`,
            title: capitalizeTitle(catalog?.title || trackFields.title),
            artist: catalog?.artist || artistName,
            album: entry.song.album || catalog?.album || null,
            cover: coverUrl,
            duration: sanitizeTrackDuration(entry.duration) || catalog?.duration || 0,
            playedAt,
            formattedTime
        });
        if (validHistory.length >= 10) break;
    }
    return validHistory;
}

async function fetchRadioStatus() {
    if (radioStatusFetchInFlight) return;
    radioStatusFetchInFlight = true;
    let refreshAgain = false;
    try {
        const response = await fetchWithTimeout(API_URL, { cache: 'no-store' }, 4000);
        const data = await response.json();
        rememberObservedDurations(data.song_history);

        // Processa histórico e próxima música
        const [historyResult, nextResult] = await Promise.allSettled([
            processSongHistory(data.song_history),
            processPlayingNext(data.playing_next)
        ]);
        if (historyResult.status === 'fulfilled' && historyResult.value.length) {
            const newItems = historyResult.value;
            const merged = [...newItems];
            for (const existing of songHistory) {
                const exists = merged.some(m => 
                    (m.id && existing.id && m.id === existing.id) ||
                    (m.title.toLowerCase() === existing.title.toLowerCase() && m.artist.toLowerCase() === existing.artist.toLowerCase())
                );
                if (!exists) {
                    merged.push(existing);
                }
            }
            merged.sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0));
            songHistory = merged.slice(0, 10);
        }
        // Se a transmissão for ao vivo (streamer/estúdio), o AutoDJ fica congelado na Inovativa
        // e o playing_next não corresponde à próxima faixa real do estúdio.
        if (data.live?.is_live || !nextResult.value) {
            playingNext = null;
        } else if (nextResult.status === 'fulfilled') {
            playingNext = nextResult.value;
        }

        const playback = data.now_playing || {};
        const current = playback.song;
        const sampledAt = Date.now();
        const playbackId = playback.sh_id || null;
        const playedAt = Number(playback.played_at) || null;
        const reportedElapsed = Math.max(0, Number(playback.elapsed) || 0);
        const clockElapsed = playedAt ? Math.max(0, sampledAt / 1000 - playedAt) : reportedElapsed;
        const clockLooksAligned = Math.abs(clockElapsed - reportedElapsed) <= 5;
        const samePlayback = playbackId
            ? playbackId === nowPlaying.playbackId
            : Boolean(playedAt && playedAt === nowPlaying.playedAt);
        const previousElapsed = samePlayback
            ? nowPlaying.elapsed + Math.max(0, (sampledAt - nowPlaying.sampledAt) / 1000)
            : 0;
        const playbackState = {
            elapsed: Math.max(
                reportedElapsed,
                clockLooksAligned ? clockElapsed : 0,
                previousElapsed
            ),
            duration: sanitizeTrackDuration(playback.duration),
            playbackId,
            playedAt,
            sampledAt
        };

        if (current && (current.text !== nowPlaying.streamTitle || (playedAt && playedAt !== nowPlaying.playedAt))) {
            const trackFields = resolveTrackFields(current);
            const stationIdentifier = isStationIdentifier(trackFields.artist, trackFields.title);
            const observedTrack = observedTrackDurations.get(
                getTrackIdentity(trackFields.artist, trackFields.title)
            );
            const observedDuration = observedTrack && !observedTrack.ambiguous
                ? observedTrack.duration
                : 0;
            const sourceDuration = playbackState.duration || observedDuration;
            const catalogTrack = stationIdentifier
                ? null
                : await getCachedTrackMetadata(
                    trackFields.artist,
                    trackFields.title,
                    sourceDuration,
                    current.album
                );
            if (!stationIdentifier) {
                try {
                    const verificationResponse = await fetchWithTimeout(
                        API_URL,
                        { cache: 'no-store' },
                        2500
                    );
                    const verificationData = await verificationResponse.json();
                    const latestPlayback = verificationData.now_playing || {};
                    const capturedIdentity = playback.sh_id || playedAt || current.text;
                    const latestIdentity = latestPlayback.sh_id
                        || Number(latestPlayback.played_at)
                        || latestPlayback.song?.text;
                    if (capturedIdentity && latestIdentity && capturedIdentity !== latestIdentity) {
                        refreshAgain = true;
                        return;
                    }
                } catch {
                    // A consulta principal continua válida; a próxima rodada fará nova conferência.
                }
            }
            // A URL de arte da transmissão também pode devolver a capa genérica sem
            // indicar isso no endereço. Só exibimos capas confirmadas pelo catálogo;
            // quando não há correspondência, usamos a animação da rádio.
            const coverUrl = stationIdentifier
                ? FALLBACK_GIF
                : catalogTrack?.cover || FALLBACK_GIF;
            const durationReliable = Boolean(
                sourceDuration || (catalogTrack?.duration && !catalogTrack.ambiguous)
            );
            const resolvedDuration = sourceDuration
                || (durationReliable ? catalogTrack?.duration : 0)
                || 0;

            const safeTitle = trackFields.title === "RADIO MARINHA" ? "Rádio Marinha" : trackFields.title;
            const safeArtist = trackFields.artist === "RADIO MARINHA" ? "Rádio Marinha" : trackFields.artist;
            nowPlaying = {
                title: capitalizeTitle(catalogTrack?.title || safeTitle || "Programação ao vivo"),
                artist: catalogTrack?.artist || safeArtist || "Rádio Marinha",
                album: current.album || catalogTrack?.album || "Rádio Marinha Online",
                cover: coverUrl || FALLBACK_GIF,
                streamTitle: current.text,
                ...playbackState,
                duration: resolvedDuration,
                durationReliable,
                syncAllowed: durationReliable && !stationIdentifier,
                updatedAt: new Date().toISOString()
            };
            console.log(`[RADIO] Tocando: ${current.text}`);
        } else if (current) {
            nowPlaying = {
                ...nowPlaying,
                ...playbackState,
                duration: playbackState.duration || nowPlaying.duration,
                durationReliable: Boolean(playbackState.duration || nowPlaying.durationReliable),
                syncAllowed: Boolean(playbackState.duration || nowPlaying.syncAllowed)
                    && !isStationIdentifier(nowPlaying.artist, nowPlaying.title)
            };
        }
    } catch (e) {
        console.error("[API ERROR]", e.message);
    } finally {
        radioStatusFetchInFlight = false;
        if (refreshAgain) setTimeout(fetchRadioStatus, 0);
    }
}

app.get('/api/proxy-cover', async (req, res) => {
    try {
        const response = await fetch(req.query.url);
        const buffer = await response.arrayBuffer();
        res.setHeader('Content-Type', response.headers.get('Content-Type') || 'image/jpeg');
        res.send(Buffer.from(buffer));
    } catch (e) { res.status(500).send("Erro proxy"); }
});

app.get('/api/now-playing', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sampledAt = Date.now();
    const sampleAge = Math.max(0, (sampledAt - nowPlaying.sampledAt) / 1000);
    res.json({
        ...nowPlaying,
        elapsed: nowPlaying.elapsed + sampleAge,
        sampledAt,
        nextTrack: playingNext,
        history: songHistory
    });
});

app.get('/api/history', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({ history: songHistory });
});

app.get('/api/next-track', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({ nextTrack: playingNext });
});

app.get('/api/lyrics', async (req, res) => {
    const artist = String(req.query.artist || '').trim();
    const title = String(req.query.title || '').trim();
    const album = String(req.query.album || '').trim();
    const requestedDuration = sanitizeTrackDuration(req.query.duration);

    if (!artist || !title) {
        return res.status(400).json({ lyrics: null });
    }

    try {
        let lyricsData = null;

        // 1. Tenta endpoint direto /api/get com e sem album
        const queryVariants = [];
        if (requestedDuration || album) queryVariants.push({ duration: requestedDuration, album });
        if (requestedDuration) queryVariants.push({ duration: requestedDuration, album: '' });
        queryVariants.push({ duration: 0, album: '' });

        for (const variant of queryVariants) {
            const params = new URLSearchParams({ artist_name: artist, track_name: title });
            if (variant.album) params.set('album_name', variant.album);
            if (variant.duration) params.set('duration', String(Math.round(variant.duration)));
            try {
                const lyricsResponse = await fetchWithTimeout(`https://lrclib.net/api/get?${params}`, {
                    headers: { 'User-Agent': LRCLIB_USER_AGENT }
                }, 4000);
                if (lyricsResponse.ok) {
                    const candidate = await lyricsResponse.json();
                    if (candidate && (candidate.syncedLyrics || candidate.plainLyrics)) {
                        lyricsData = candidate;
                        if (candidate.syncedLyrics) break; // achou sincronizada direta
                    }
                }
            } catch {}
        }

        // 2. Se não achou sincronizada pelo get, faz busca inteligente no LRCLIB (/api/search)
        if (!lyricsData || !lyricsData.syncedLyrics) {
            try {
                const searchParams = new URLSearchParams({ track_name: title, artist_name: artist });
                let searchRes = await fetchWithTimeout(`https://lrclib.net/api/search?${searchParams}`, {
                    headers: { 'User-Agent': LRCLIB_USER_AGENT }
                }, 5000);
                if (searchRes.ok) {
                    const list = await searchRes.json();
                    if (Array.isArray(list) && list.length > 0) {
                        const syncedMatch = list.find(item => item.syncedLyrics && item.trackName && item.artistName);
                        if (syncedMatch) {
                            lyricsData = syncedMatch;
                        } else if (!lyricsData && list[0]) {
                            lyricsData = list[0];
                        }
                    }
                }
            } catch {}
        }

        // 3. Segunda tentativa de busca por query livre se ainda não tiver sincronizada
        if (!lyricsData || !lyricsData.syncedLyrics) {
            try {
                const searchRes = await fetchWithTimeout(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`, {
                    headers: { 'User-Agent': LRCLIB_USER_AGENT }
                }, 5000);
                if (searchRes.ok) {
                    const list = await searchRes.json();
                    if (Array.isArray(list) && list.length > 0) {
                        const syncedMatch = list.find(item => item.syncedLyrics);
                        if (syncedMatch) {
                            lyricsData = syncedMatch;
                        }
                    }
                }
            } catch {}
        }

        if (lyricsData) {
            const hasLrcTimestamps = Boolean(lyricsData.syncedLyrics && /\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/.test(lyricsData.syncedLyrics));
            const trustedSyncedLyrics = hasLrcTimestamps ? lyricsData.syncedLyrics : null;
            const plainFromSynced = String(lyricsData.syncedLyrics || '')
                .replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, '')
                .replace(/[ \t]+$/gm, '');
            const lyrics = trustedSyncedLyrics || lyricsData.plainLyrics || plainFromSynced;
            const duration = Math.max(0, Number(lyricsData.duration) || requestedDuration || 0);

            if (lyrics) {
                return res.json({
                    lyrics,
                    synced: Boolean(trustedSyncedLyrics),
                    duration
                });
            }
        }

        // 4. Fallback lyrics.ovh para letras estáticas
        const fallbackResponse = await fetchWithTimeout(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
            {},
            5000
        );
        if (fallbackResponse.ok) {
            const data = await fallbackResponse.json();
            if (data.lyrics) return res.json({
                lyrics: data.lyrics,
                synced: false,
                duration: requestedDuration
            });
        }

        res.status(404).json({ lyrics: null });
    } catch (error) {
        console.error('[LYRICS ERROR]:', error.message);
        res.status(502).json({ lyrics: null });
    }
});

app.get('/api/artist', async (req, res) => {
    const artist = String(req.query.name || '').trim();
    if (!artist) return res.status(400).json({ biography: null });

    try {
        const response = await fetchWithTimeout(
            `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artist)}`,
            {},
            5000
        );
        const data = await response.json();
        const result = data.artists?.[0];

        if (!result) return res.status(404).json({ biography: null });

        res.json({
            name: result.strArtist || artist,
            biography: result.strBiographyPT || result.strBiographyEN || null,
            image: result.strArtistWideThumb || result.strArtistThumb || null,
            genre: result.strGenre || null,
            country: result.strCountry || null
        });
    } catch (error) {
        console.error('[ARTIST ERROR]:', error.message);
        res.status(502).json({ biography: null });
    }
});

app.get('/api/cover-proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl || !rawUrl.startsWith('http')) {
        return res.status(400).end();
    }
    try {
        const upstream = await fetchWithTimeout(rawUrl, {}, 6000);
        if (!upstream.ok) return res.status(404).end();
        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.send(buffer);
    } catch {
        res.status(502).end();
    }
});

async function startServer() {
    if (IS_PRODUCTION) {
        app.use(express.static(DIST_DIR));
        app.get('*', (_req, res) => {
            res.sendFile(path.join(DIST_DIR, 'index.html'));
        });
    } else {
        const { createServer: createViteServer } = await import("vite");
        const vite = await createViteServer({
            server: {
                middlewareMode: true,
                allowedHosts: ALLOWED_HOSTS
            },
            appType: "spa"
        });
        app.use(vite.middlewares);

        app.use('*', async (req, res, next) => {
            if (req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/imagens')) {
                return next();
            }
            try {
                const url = req.originalUrl;
                let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
                template = await vite.transformIndexHtml(url, template);
                res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
            } catch (e) {
                vite.ssrFixStacktrace(e);
                next(e);
            }
        });
    }

    app.listen(PORT, () => {
        console.log(`[SUCESSO] Site e API em http://localhost:` + PORT);
        setInterval(fetchRadioStatus, 5000);
        fetchRadioStatus();
    });
}

startServer().catch((error) => {
    console.error("[ERRO] Não foi possível iniciar o servidor:", error);
    process.exitCode = 1;
});
