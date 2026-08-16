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
const artistCache = new Map();
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
    if (!value) return '';
    let text = String(value || '')
        .replace(/\uFFFD/g, '')
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
        // Remove extensões de arquivo comuns (.mp3, .wav, .aac, .m4a, .flac, .ogg, .wma, .opus)
        .replace(/\.(?:mp3|wav|aac|m4a|flac|ogg|wma|aiff|opus|alac)$/i, '')
        // Converte underscores usados como espaços em arquivos (ex: John_Legend-Preach)
        .replace(/_/g, ' ')
        // Remove números de faixa/prefixos no início (ex: "01 - ", "01. ", "01 ")
        .replace(/^\s*\d{1,3}\s*[-–.]\s*/, '')
        // Remove tags comuns de internet/youtube/downloads
        .replace(/\s*\[(?:official\s*(?:video|audio|music\s*video)|clipe\s*oficial|áudio\s*oficial|audio|hq|hd|320\s*kbps|\d+kbps|lyrics|letra|ao\s*vivo|live)\]/gi, '')
        .replace(/\s*\((?:official\s*(?:video|audio|music\s*video)|clipe\s*oficial|áudio\s*oficial|audio|hq|hd|320\s*kbps|\d+kbps|lyrics|letra|www\.[^\s)]+|site:[^\s)]+)\)/gi, '')
        // Remove URLs
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/www\.\S+/gi, '')
        // Normaliza espaços e travessões nas pontas
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[–—-]\s*/u, '')
        .replace(/\s*[–—-]$/u, '')
        .trim();

    return text;
}

function splitArtistAndTitle(value) {
    const cleaned = cleanRadioMetadata(value);
    if (!cleaned) return null;

    // Tenta divisão padrão: com espaços ao redor do hífen/travessão ou com hífen direto entre palavras (ex: John Legend-Preach)
    const match = cleaned.match(/^(.+?)(?:\s+-\s*|\s*-\s+|\s*[–—|/]\s*|-(?=[A-Za-zÀ-ÿ0-9]))(.+)$/u);
    if (!match) return null;

    let artist = cleanRadioMetadata(match[1]);
    let title = cleanRadioMetadata(match[2]);

    // Remove sufixos de rádio anexados (ex: "Toquinho - Aquarela - Rádio Marinha")
    artist = artist.replace(/\s*[-–]\s*Rádio\s+Marinha.*$/i, '').trim();
    title = title.replace(/\s*[-–]\s*Rádio\s+Marinha.*$/i, '').trim();

    if (normalizeMetadata(artist).length < 2 || normalizeMetadata(title).length < 2) return null;
    return { artist, title };
}

function resolveTrackFields(current) {
    const receivedArtist = cleanRadioMetadata(current?.artist);
    const title = cleanRadioMetadata(current?.title);
    const text = cleanRadioMetadata(current?.text);

    const titlePair = splitArtistAndTitle(title);
    const textPair = splitArtistAndTitle(text);

    const isMissingArtist = !receivedArtist || MISSING_ARTIST_IDENTIFIERS.has(normalizeMetadata(receivedArtist));

    if (!isMissingArtist) {
        if (titlePair && normalizeMetadata(titlePair.artist) === normalizeMetadata(receivedArtist)) {
            return { artist: receivedArtist, title: titlePair.title };
        }
        return { artist: receivedArtist, title };
    }

    if (titlePair) {
        return titlePair;
    }
    if (textPair) {
        return textPair;
    }

    return { artist: '', title };
}

function isStationIdentifier(artist = '', title = '') {
    const artistMeta = normalizeMetadata(artist);
    const titleMeta = normalizeMetadata(title);
    if (!artistMeta && !titleMeta) return true;
    const combined = `${artistMeta} ${titleMeta}`.trim();
    return STATION_IDENTIFIERS.some((identifier) => combined.includes(identifier));
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

async function fetchDeezerArtistImage(artistName) {
    try {
        const clean = cleanRadioMetadata(artistName).replace(/[\uFFFD]/g, '').trim();
        if (!clean || isStationIdentifier(clean, '')) return null;
        const res = await fetchWithTimeout(
            `https://api.deezer.com/search/artist?q=${encodeURIComponent(clean)}&limit=1`,
            {},
            3000
        );
        if (res.ok) {
            const data = await res.json();
            const artist = data.data?.[0];
            return artist?.picture_xl || artist?.picture_big || artist?.picture_medium || null;
        }
    } catch {}
    return null;
}

async function findTrackMetadata(artist, title, targetDuration = 0, albumHint = '') {
    const cleanArtist = cleanRadioMetadata(artist);
    const cleanTitle = cleanRadioMetadata(title);
    try {
        const query = encodeURIComponent([cleanArtist, cleanTitle].filter(Boolean).join(' '));
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
            .filter((result) => isMatchingTrack(result, cleanArtist, cleanTitle));
        const versionCompatibleTracks = hasVersionMarker(cleanTitle)
            ? matchingTracks.filter((result) => hasMatchingVersionProfile(
                cleanTitle,
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
                score: trackMatchScore(result, cleanArtist, cleanTitle, targetDuration, albumHint)
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
            let coverUrl = match.album?.cover_xl || match.album?.cover_big || null;
            if (!coverUrl && cleanArtist && !isStationIdentifier(cleanArtist, '')) {
                coverUrl = await fetchDeezerArtistImage(cleanArtist);
            }
            return {
                title: restoreAccents(title || match.title_short || match.title, officialValues, true),
                artist: restoreAccents(artist || match.artist?.name || '', officialValues, true),
                album: match.album?.title || null,
                duration: sanitizeTrackDuration(match.duration),
                cover: coverUrl || null,
                ambiguous
            };
        }
    } catch (e) { console.error("[CATALOG ERROR]:", e.message); }

    let fallbackArtistCover = null;
    if (cleanArtist && !isStationIdentifier(cleanArtist, '')) {
        fallbackArtistCover = await fetchDeezerArtistImage(cleanArtist);
    }

    return {
        title: restoreAccents(title, [], true),
        artist: restoreAccents(artist, [], true),
        album: null,
        duration: 0,
        cover: fallbackArtistCover || null,
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
    let coverUrl = catalog?.cover;
    if (!coverUrl && trackFields.artist && !isStationIdentifier(trackFields.artist, '')) {
        coverUrl = await fetchDeezerArtistImage(trackFields.artist);
    }
    if (!coverUrl && song.art && !song.art.includes('generic_song')) {
        coverUrl = song.art;
    }
    if (!coverUrl) {
        coverUrl = FALLBACK_GIF;
    }

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
        let coverUrl = catalog?.cover;
        if (!coverUrl && artistName && !isStationIdentifier(artistName, '')) {
            coverUrl = await fetchDeezerArtistImage(artistName);
        }
        if (!coverUrl && entry.song.art && !entry.song.art.includes('generic_song')) {
            coverUrl = entry.song.art;
        }
        if (!coverUrl) {
            coverUrl = FALLBACK_GIF;
        }

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
            let coverUrl = stationIdentifier
                ? FALLBACK_GIF
                : catalogTrack?.cover;
            if (!coverUrl && !stationIdentifier && safeArtist) {
                coverUrl = await fetchDeezerArtistImage(safeArtist);
            }
            if (!coverUrl) {
                coverUrl = FALLBACK_GIF;
            }
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

const WIKI_USER_AGENT = 'RadioMarinhaOnline/2.0 (https://radiomarinha.marinha.mil.br; contato@radiomarinha.mil.br)';

function toTitleCase(str) {
    return String(str || '').toLowerCase().replace(/(?:^|\s|-|\()\S/g, c => c.toUpperCase());
}

function getArtistSearchVariants(rawName) {
    const cleaned = cleanRadioMetadata(rawName)
        .replace(/[\uFFFD]/g, '')
        .trim();
    if (!cleaned) return [];

    const variants = new Set();

    // 1. Artista principal prioritário se houver feat / ft / participação
    const primaryOnly = cleaned
        .replace(/\s+(?:feat\.?|ft\.?|featuring|part\.?|participação)\s+.+$/i, '')
        .trim();

    if (primaryOnly) {
        const pTitle = toTitleCase(primaryOnly);
        variants.add(pTitle);
        variants.add(primaryOnly);
        variants.add(`${pTitle} (banda)`);
        variants.add(`${pTitle} (cantor)`);
        variants.add(`${pTitle} (cantora)`);
        variants.add(`${pTitle} (músico)`);
        variants.add(`${pTitle} (dupla)`);
        variants.add(`${pTitle} (grupo musical)`);
    }

    const titleCased = toTitleCase(cleaned);
    variants.add(titleCased);
    variants.add(cleaned);

    // Variações específicas para artigos enciclopédicos de bandas/músicos na Wikipédia
    variants.add(`${titleCased} (banda)`);
    variants.add(`${titleCased} (grupo musical)`);
    variants.add(`${titleCased} (cantor)`);
    variants.add(`${titleCased} (cantora)`);
    variants.add(`${titleCased} (músico)`);
    variants.add(`${titleCased} (dupla)`);

    // Primeira parte se for dupla/banda com " e ", "&", "/", ","
    const firstOfDuo = primaryOnly.split(/\s+(?:e|&|\/|,)\s+/i)[0]?.trim();
    if (firstOfDuo && firstOfDuo.length >= 3 && firstOfDuo !== primaryOnly) {
        const fTitle = toTitleCase(firstOfDuo);
        variants.add(fTitle);
        variants.add(`${fTitle} (banda)`);
        variants.add(firstOfDuo);
    }

    return Array.from(variants);
}

function isMatchingWikiTitle(pageTitle, targetName) {
    if (!pageTitle || !targetName) return false;
    const cleanPage = normalizeMetadata(pageTitle.replace(/\s*\([^)]*\)/g, ''));
    const cleanTarget = normalizeMetadata(targetName.replace(/\s*\([^)]*\)/g, ''));
    if (!cleanPage || !cleanTarget) return false;
    if (cleanPage === cleanTarget) return true;
    if (cleanPage.startsWith(cleanTarget) || cleanTarget.startsWith(cleanPage)) return true;
    if (cleanPage.endsWith(cleanTarget) || cleanTarget.endsWith(cleanPage)) return true;
    const pNoE = cleanPage.replace(/\be\b/g, '').replace(/\s+/g, ' ').trim();
    const tNoE = cleanTarget.replace(/\be\b/g, '').replace(/\s+/g, ' ').trim();
    if (pNoE && pNoE === tNoE) return true;
    return false;
}

function isMusicalArtist(sumData) {
    if (!sumData) return false;
    const text = `${sumData.description || ''} ${sumData.extract || ''}`.toLowerCase();
    
    const nonMusicKeywords = [
        'footballer', 'futebolista', 'jogador de futebol', 'jogador', 'atleta',
        'político', 'politico', 'politician', 'militar', 'prelado', 'bispo',
        'governador', 'prefeito', 'senador', 'deputado', 'juiz', 'advogado',
        'município', 'municipio', 'cidade', 'telenovela', 'filme', 'empresa',
        'escritor', 'poeta', 'geógrafo', 'historiador', 'médico'
    ];

    const musicKeywords = [
        'cantor', 'cantora', 'músic', 'music', 'banda', 'band', 'compositor',
        'songwriter', 'singer', 'rapper', 'violonista', 'guitarrista', 'pianista',
        'baterista', 'baixista', 'intérprete', 'dupla', 'trio', 'grupo musical',
        'vocalista', 'discografia', 'álbum', 'album', 'gravou', 'canção', 'canções',
        'single', 'mpb', 'sertanejo', 'rock', 'pop', 'samba', 'pagode', 'bossa nova'
    ];

    const hasMusic = musicKeywords.some(w => text.includes(w));
    const desc = (sumData.description || '').toLowerCase();
    const hasNonMusicOnly = nonMusicKeywords.some(w => desc.includes(w)) && !hasMusic;

    if (hasNonMusicOnly) return false;
    return hasMusic;
}

async function fetchWikipediaArtist(artistName) {
    const variants = getArtistSearchVariants(artistName);
    if (!variants.length) return null;

    for (const query of variants) {
        if (isStationIdentifier(query, '')) continue;

        // 1. Tenta resumo direto por título na Wikipédia PT
        try {
            const cleanTitle = query.replace(/\s+/g, '_');
            const summaryUrl = `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTitle)}`;
            const sumRes = await fetchWithTimeout(summaryUrl, {
                headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' }
            }, 3500);

            if (sumRes.ok) {
                const sumData = await sumRes.json();
                if (sumData.extract && sumData.extract.length > 40 && sumData.type !== 'disambiguation') {
                    if ((isMatchingWikiTitle(sumData.title, query) || isMatchingWikiTitle(sumData.title, artistName)) && isMusicalArtist(sumData)) {
                        return {
                            name: sumData.title || query,
                            biography: sumData.extract,
                            image: sumData.thumbnail?.source || sumData.originalimage?.source || null,
                            description: sumData.description || null,
                            source: 'Wikipédia'
                        };
                    }
                }
            }
        } catch {}

        // 2. Tenta Busca Semântica Completa (action=query&list=search) na Wikipédia em Português
        try {
            const ptSearchUrl = `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json`;
            const ptSearchRes = await fetchWithTimeout(ptSearchUrl, {
                headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' }
            }, 3500);

            if (ptSearchRes.ok) {
                const ptSearchData = await ptSearchRes.json();
                const searchResults = ptSearchData.query?.search || [];
                for (const item of searchResults.slice(0, 3)) {
                    if (!isMatchingWikiTitle(item.title, query) && !isMatchingWikiTitle(item.title, artistName)) {
                        continue;
                    }

                    const pageSummaryUrl = `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`;
                    const sumRes = await fetchWithTimeout(pageSummaryUrl, {
                        headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' }
                    }, 3500);

                    if (sumRes.ok) {
                        const sumData = await sumRes.json();
                        if (sumData.extract && sumData.extract.length > 40 && sumData.type !== 'disambiguation') {
                            if ((isMatchingWikiTitle(sumData.title, query) || isMatchingWikiTitle(sumData.title, artistName)) && isMusicalArtist(sumData)) {
                                return {
                                    name: sumData.title || query,
                                    biography: sumData.extract,
                                    image: sumData.thumbnail?.source || sumData.originalimage?.source || null,
                                    description: sumData.description || null,
                                    source: 'Wikipédia'
                                };
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[WIKI PT SEARCH ERROR]:', e.message);
        }

        // 3. Tenta OpenSearch na Wikipédia em Inglês como fallback
        try {
            const enSearchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json`;
            const enSearchRes = await fetchWithTimeout(enSearchUrl, {
                headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' }
            }, 3500);

            if (enSearchRes.ok) {
                const enSearchData = await enSearchRes.json();
                const titles = enSearchData[1] || [];
                for (const title of titles.slice(0, 3)) {
                    if (!isMatchingWikiTitle(title, query) && !isMatchingWikiTitle(title, artistName)) {
                        continue;
                    }

                    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
                    const sumRes = await fetchWithTimeout(summaryUrl, {
                        headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' }
                    }, 3500);

                    if (sumRes.ok) {
                        const sumData = await sumRes.json();
                        if (sumData.extract && sumData.extract.length > 40 && sumData.type !== 'disambiguation') {
                            if ((isMatchingWikiTitle(sumData.title, query) || isMatchingWikiTitle(sumData.title, artistName)) && isMusicalArtist(sumData)) {
                                return {
                                    name: sumData.title || query,
                                    biography: sumData.extract,
                                    image: sumData.thumbnail?.source || sumData.originalimage?.source || null,
                                    description: sumData.description || null,
                                    source: 'Wikipédia (EN)'
                                };
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[WIKI EN ERROR]:', e.message);
        }
    }
    return null;
}

async function fetchVagalumeArtist(artistName) {
    try {
        const slug = artistName.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!slug) return null;

        const res = await fetchWithTimeout(`https://www.vagalume.com.br/${slug}/index.js`, {
            headers: { 'Accept': 'application/json' }
        }, 3500);
        if (res.ok) {
            const data = await res.json();
            const art = data.artist;
            if (art && (art.desc || art.genre)) {
                return {
                    name: art.desc || artistName,
                    biography: art.bio?.text || null,
                    image: art.pic_medium ? `https://www.vagalume.com.br${art.pic_medium}` : null,
                    genre: art.genre?.map(g => g.name).join(', ') || null,
                    source: 'Vagalume'
                };
            }
        }
    } catch {}
    return null;
}

async function fetchLastFmArtist(artistName) {
    try {
        const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=b25b959554ed76058ac220b7b2e0a026&format=json&autocorrect=1`;
        const res = await fetchWithTimeout(url, {}, 3500);
        if (res.ok) {
            const data = await res.json();
            const art = data.artist;
            const bio = art?.bio?.summary || art?.bio?.content;
            if (bio) {
                const cleanBio = bio.replace(/<a\b[^>]*>.*?<\/a>/ig, '').replace(/<[^>]*>/g, '').trim();
                if (cleanBio.length > 50) {
                    const img = art.image?.find(i => i.size === 'extralarge' || i.size === 'mega')?.['#text'] || null;
                    return {
                        name: art.name || artistName,
                        biography: cleanBio,
                        image: img || null,
                        genre: art.tags?.tag?.map(t => t.name).slice(0, 3).join(', ') || null,
                        source: 'Last.fm'
                    };
                }
            }
        }
    } catch {}
    return null;
}

app.get('/api/artist', async (req, res) => {
    const artist = String(req.query.name || '').trim();
    if (!artist || isStationIdentifier(artist, '')) {
        return res.status(400).json({ biography: null });
    }

    const cacheKey = normalizeMetadata(artist);
    if (artistCache.has(cacheKey)) {
        return res.json(artistCache.get(cacheKey));
    }

    try {
        let artistData = null;

        // 1. Tenta TheAudioDB
        try {
            const response = await fetchWithTimeout(
                `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(toTitleCase(artist))}`,
                {},
                3500
            );
            if (response.ok) {
                const data = await response.json();
                const result = data.artists?.[0];
                if (result && (result.strBiographyPT || result.strBiographyEN)) {
                    artistData = {
                        name: result.strArtist || artist,
                        biography: result.strBiographyPT || result.strBiographyEN,
                        image: result.strArtistWideThumb || result.strArtistThumb || null,
                        genre: result.strGenre || null,
                        country: result.strCountry || null,
                        source: 'TheAudioDB'
                    };
                }
            }
        } catch {}

        // 2. Consulta a Wikipédia em Português com Busca Semântica e Variações
        if (!artistData || !artistData.biography || (artistData.biography.length < 60 && !artistData.image)) {
            const wikiData = await fetchWikipediaArtist(artist);
            if (wikiData) {
                artistData = {
                    name: wikiData.name || artist,
                    biography: wikiData.biography,
                    image: wikiData.image || artistData?.image || null,
                    genre: wikiData.description || artistData?.genre || null,
                    country: artistData?.country || null,
                    source: wikiData.source
                };
            }
        }

        // 3. Fallback no Vagalume (Excelente para artistas e bandas brasileiras como Melim)
        if (!artistData || !artistData.biography) {
            const vagalumeData = await fetchVagalumeArtist(artist);
            if (vagalumeData && vagalumeData.biography) {
                artistData = vagalumeData;
            }
        }

        // 4. Fallback no Last.fm
        if (!artistData || !artistData.biography) {
            const lastFmData = await fetchLastFmArtist(artist);
            if (lastFmData && lastFmData.biography) {
                artistData = lastFmData;
            }
        }

        // 5. Fallback de imagem de alta qualidade via Deezer se ainda não tiver imagem
        if (artistData && !artistData.image) {
            const deezerImg = await fetchDeezerArtistImage(artistData.name || artist);
            if (deezerImg) artistData.image = deezerImg;
        }

        if (artistData && artistData.biography) {
            artistCache.set(cacheKey, artistData);
            if (artistCache.size > 200) {
                artistCache.delete(artistCache.keys().next().value);
            }
            return res.json(artistData);
        }

        res.status(404).json({ biography: null });
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

// ── Notícias Musicais (RSS Aggregator) ────────────────────────
let cachedMusicNews = null;
let lastNewsFetchTime = 0;
const NEWS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

function decodeHtmlEntities(str = '') {
    return str
        .replace(/<!\[CDATA\[/gi, '')
        .replace(/\]\]>/gi, '')
        .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/g, "'")
        .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
        .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '—')
        .replace(/&#8230;|&hellip;/g, '...')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#([0-9]{1,5});/gi, (match, numStr) => {
            const num = parseInt(numStr, 10);
            return String.fromCharCode(num);
        })
        .replace(/<[^>]*>/g, '')
        .replace(/[\]>]+/g, '')
        .replace(/^[\s\]>]+/, '')
        .trim();
}

async function fetchMusicNews() {
    const now = Date.now();
    if (cachedMusicNews && (now - lastNewsFetchTime) < NEWS_CACHE_TTL_MS) {
        return cachedMusicNews;
    }

    const feeds = [
        {
            source: 'Rolling Stone Brasil',
            badge: 'Rolling Stone',
            tagColor: '#e11d48',
            url: 'https://rollingstone.com.br/feed/'
        },
        {
            source: 'POPline',
            badge: 'POPline',
            tagColor: '#ec4899',
            url: 'https://portalpopline.com.br/feed/'
        },
        {
            source: 'Billboard',
            badge: 'Billboard',
            tagColor: '#0284c7',
            url: 'https://www.billboard.com/feed/'
        },
        {
            source: 'G1 Música',
            badge: 'G1 Música',
            tagColor: '#ea580c',
            url: 'https://g1.globo.com/rss/g1/musica/'
        }
    ];

    const results = [];

    await Promise.allSettled(feeds.map(async (feed) => {
        try {
            const res = await fetchWithTimeout(feed.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            }, 6000);
            if (!res.ok) return;

            const xml = await res.text();
            const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
            let match;
            let count = 0;

            while ((match = itemRegex.exec(xml)) !== null && count < 10) {
                const itemXml = match[1];

                const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
                const linkMatch = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
                const pubDateMatch = itemXml.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i);
                const descMatch = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);

                let img = null;
                const mediaContentMatch = itemXml.match(/<media:content[^>]*url=["']([^"']+)["']/i);
                const enclosureMatch = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["']/i);
                const imgTagMatch = itemXml.match(/<img[^>]*src=["']([^"']+)["']/i);

                if (mediaContentMatch) img = mediaContentMatch[1];
                else if (enclosureMatch) img = enclosureMatch[1];
                else if (imgTagMatch) img = imgTagMatch[1];

                // Ignora embeds de vídeo do youtube como imagem
                if (img && (img.includes('youtube.com') || img.includes('youtu.be'))) {
                    img = null;
                }

                const rawTitle = titleMatch ? titleMatch[1] : '';
                const rawDesc = descMatch ? descMatch[1] : '';
                const link = linkMatch ? linkMatch[1].trim() : '#';
                const pubDate = pubDateMatch ? new Date(pubDateMatch[1].trim()) : new Date();
                const pubTime = !isNaN(pubDate.getTime()) ? pubDate.getTime() : Date.now();

                // Filtro de recência: descarta matérias com mais de 45 dias ou de anos anteriores
                const ageDays = (now - pubTime) / (1000 * 60 * 60 * 24);
                if (ageDays > 45 || ageDays < -1) {
                    continue;
                }

                const cleanTitle = decodeHtmlEntities(rawTitle);
                const cleanDesc = decodeHtmlEntities(rawDesc).slice(0, 180);

                if (cleanTitle && cleanTitle.length > 5) {
                    results.push({
                        id: `${feed.badge}-${count}-${pubTime}`,
                        title: cleanTitle,
                        summary: cleanDesc ? (cleanDesc.length >= 180 ? `${cleanDesc}...` : cleanDesc) : 'Clique para conferir a matéria completa.',
                        link,
                        image: img || null,
                        source: feed.source,
                        badge: feed.badge,
                        tagColor: feed.tagColor,
                        pubDate: new Date(pubTime).toISOString(),
                        timestamp: pubTime
                    });
                    count++;
                }
            }
        } catch (e) {
            console.error(`[NEWS FEED ERROR] ${feed.source}:`, e.message);
        }
    }));

    // Ordena da mais recente para a mais antiga
    results.sort((a, b) => b.timestamp - a.timestamp);

    if (results.length > 0) {
        cachedMusicNews = results;
        lastNewsFetchTime = now;
    }

    return cachedMusicNews || [];
}

app.get('/api/news', async (_req, res) => {
    try {
        const news = await fetchMusicNews();
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({ success: true, count: news.length, news });
    } catch (error) {
        console.error('[API NEWS ERROR]:', error.message);
        res.status(500).json({ success: false, news: [] });
    }
});

// ── Geolocalização do Usuário ────────────────────────────────
app.get('/api/location', async (req, res) => {
    try {
        let clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                       req.headers['cf-connecting-ip'] ||
                       req.socket.remoteAddress || '';

        if (clientIp.startsWith('::ffff:')) {
            clientIp = clientIp.substring(7);
        }

        const isLocal = !clientIp || clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('192.168.') || clientIp.startsWith('10.');

        if (isLocal) {
            return res.json({
                city: 'Brasília',
                state: 'DF',
                region: 'Distrito Federal',
                country: 'Brasil',
                isDefault: true
            });
        }

        const geoRes = await fetchWithTimeout(`http://ip-api.com/json/${clientIp}?fields=status,city,region,regionName,country`, {}, 3500);
        if (geoRes.ok) {
            const data = await geoRes.json();
            if (data.status === 'success' && data.city) {
                return res.json({
                    city: data.city,
                    state: data.region || 'DF',
                    region: data.regionName || data.city,
                    country: data.country || 'Brasil',
                    isDefault: false
                });
            }
        }

        res.json({
            city: 'Brasília',
            state: 'DF',
            region: 'Distrito Federal',
            country: 'Brasil',
            isDefault: true
        });
    } catch (error) {
        res.json({
            city: 'Brasília',
            state: 'DF',
            region: 'Distrito Federal',
            country: 'Brasil',
            isDefault: true
        });
    }
});

// ── Agenda Dinâmica de Shows e Festivais no Brasil ───────────
function createUpcomingShow({ id, city, state, artist, title, month, day, timeLabel = '21:00', venue, image, genre, ticketUrl }) {
    const now = new Date();
    const currentYear = now.getFullYear();
    let showDate = new Date(currentYear, month - 1, day, 21, 0, 0);

    // Se a data já passou no ano atual, projeta para o próximo ano
    if (showDate.getTime() < now.getTime() - (24 * 60 * 60 * 1000)) {
        showDate = new Date(currentYear + 1, month - 1, day, 21, 0, 0);
    }

    const monthsAbbr = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const pad = (n) => String(n).padStart(2, '0');

    return {
        id,
        city,
        state,
        artist,
        title,
        date: showDate.toISOString(),
        timestamp: showDate.getTime(),
        dateLabel: `${pad(day)} ${monthsAbbr[showDate.getMonth()]} ${showDate.getFullYear()}`,
        timeLabel,
        venue,
        image,
        genre,
        ticketUrl
    };
}

const RAW_CONCERT_DATA = [
    // Brasília - DF
    {
        id: 'bsb-1',
        city: 'Brasília',
        state: 'DF',
        artist: 'Gilberto Gil — Turnê Tempo Rei',
        title: 'Gilberto Gil: A Grande Turnê Tempo Rei',
        month: 10,
        day: 24,
        timeLabel: '21:00',
        venue: 'Arena BRB Mané Garrincha',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB / Ensaio',
        ticketUrl: 'https://www.eventim.com.br'
    },
    {
        id: 'bsb-2',
        city: 'Brasília',
        state: 'DF',
        artist: 'Liniker — Caju Tour',
        title: 'Liniker: Turnê do Álbum CAJU',
        month: 11,
        day: 14,
        timeLabel: '20:30',
        venue: 'Centro de Convenções Ulysses Guimarães',
        image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&auto=format&fit=crop&q=80',
        genre: 'Soul / MPB',
        ticketUrl: 'https://www.sympla.com.br'
    },
    {
        id: 'bsb-3',
        city: 'Brasília',
        state: 'DF',
        artist: 'Festival Na Praia Brasília',
        title: 'Festival Na Praia — Edição Especial',
        month: 9,
        day: 12,
        timeLabel: '18:00',
        venue: 'Setor de Clubes Esportivos Sul',
        image: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=600&auto=format&fit=crop&q=80',
        genre: 'Festival / Pop / MPB',
        ticketUrl: 'https://r2.com.br/napraia'
    },
    {
        id: 'bsb-4',
        city: 'Brasília',
        state: 'DF',
        artist: 'Nando Reis & Os Infernais',
        title: 'Nando Reis: Uma Estrela Misteriosa',
        month: 10,
        day: 10,
        timeLabel: '21:30',
        venue: 'Auditório Master — Ulysses Guimarães',
        image: 'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=600&auto=format&fit=crop&q=80',
        genre: 'Pop Rock',
        ticketUrl: 'https://www.bilheteriadigital.com'
    },
    {
        id: 'bsb-5',
        city: 'Brasília',
        state: 'DF',
        artist: 'Capital Inicial — 40 Anos',
        title: 'Capital Inicial: Especial em Casa',
        month: 12,
        day: 5,
        timeLabel: '22:00',
        venue: 'Arena BRB Nilson Nelson',
        image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&auto=format&fit=crop&q=80',
        genre: 'Rock Nacional',
        ticketUrl: 'https://www.eventim.com.br'
    },

    // Rio de Janeiro - RJ
    {
        id: 'rj-1',
        city: 'Rio de Janeiro',
        state: 'RJ',
        artist: 'Caetano Veloso & Maria Bethânia',
        title: 'Caetano & Bethânia — Turnê Histórica',
        month: 11,
        day: 28,
        timeLabel: '21:00',
        venue: 'Farmasi Arena — Barra da Tijuca',
        image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB',
        ticketUrl: 'https://www.ticketmaster.com.br'
    },
    {
        id: 'rj-2',
        city: 'Rio de Janeiro',
        state: 'RJ',
        artist: 'Djavan — Turnê D',
        title: 'Djavan ao Vivo no Rio de Janeiro',
        month: 10,
        day: 17,
        timeLabel: '21:30',
        venue: 'Vivo Rio — Aterro do Flamengo',
        image: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB / Jazz',
        ticketUrl: 'https://www.vivorio.com.br'
    },
    {
        id: 'rj-3',
        city: 'Rio de Janeiro',
        state: 'RJ',
        artist: 'Zeca Pagodinho — 40 Anos de Samba',
        title: 'Zeca Pagodinho no Circo Voador',
        month: 12,
        day: 12,
        timeLabel: '22:00',
        venue: 'Circo Voador — Lapa',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
        genre: 'Samba',
        ticketUrl: 'https://www.eventim.com.br'
    },
    {
        id: 'rj-4',
        city: 'Rio de Janeiro',
        state: 'RJ',
        artist: 'Marisa Monte — Portas Tour',
        title: 'Marisa Monte no Qualistage',
        month: 11,
        day: 7,
        timeLabel: '21:00',
        venue: 'Qualistage — Via Parque',
        image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB',
        ticketUrl: 'https://www.ticketmaster.com.br'
    },

    // São Paulo - SP
    {
        id: 'sp-1',
        city: 'São Paulo',
        state: 'SP',
        artist: 'Lollapalooza Brasil',
        title: 'Lollapalooza Brasil — Autódromo de Interlagos',
        month: 3,
        day: 27,
        timeLabel: '12:00',
        venue: 'Autódromo de Interlagos',
        image: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=600&auto=format&fit=crop&q=80',
        genre: 'Festival Internacional / Rock / Pop',
        ticketUrl: 'https://www.ticketmaster.com.br'
    },
    {
        id: 'sp-2',
        city: 'São Paulo',
        state: 'SP',
        artist: 'Gilberto Gil — Turnê Tempo Rei',
        title: 'Gilberto Gil em São Paulo',
        month: 11,
        day: 21,
        timeLabel: '20:30',
        venue: 'Allianz Parque',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB',
        ticketUrl: 'https://www.eventim.com.br'
    },
    {
        id: 'sp-3',
        city: 'São Paulo',
        state: 'SP',
        artist: 'Sepultura — Celebrating Life Through Death',
        title: 'Sepultura: Turnê de Despedida Mundial',
        month: 10,
        day: 31,
        timeLabel: '21:00',
        venue: 'Espaço Unimed — Barra Funda',
        image: 'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=600&auto=format&fit=crop&q=80',
        genre: 'Heavy Metal',
        ticketUrl: 'https://www.eventim.com.br'
    },
    {
        id: 'sp-4',
        city: 'São Paulo',
        state: 'SP',
        artist: 'Jão — Superturnê',
        title: 'Jão: A Grande Superturnê',
        month: 12,
        day: 19,
        timeLabel: '21:00',
        venue: 'Allianz Parque',
        image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&auto=format&fit=crop&q=80',
        genre: 'Pop Nacional',
        ticketUrl: 'https://www.eventim.com.br'
    },

    // Salvador - BA
    {
        id: 'ssa-1',
        city: 'Salvador',
        state: 'BA',
        artist: 'Gilberto Gil — Turnê Tempo Rei',
        title: 'Gilberto Gil: Tempo Rei em Salvador',
        month: 10,
        day: 15,
        timeLabel: '19:00',
        venue: 'Casa de Apostas Arena Fonte Nova',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB / Axé',
        ticketUrl: 'https://www.eventim.com.br'
    },
    {
        id: 'ssa-2',
        city: 'Salvador',
        state: 'BA',
        artist: 'BaianaSystem — Navio Pirata',
        title: 'BaianaSystem: O Baile Especial',
        month: 11,
        day: 8,
        timeLabel: '21:00',
        venue: 'Concha Acústica do TCA',
        image: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=600&auto=format&fit=crop&q=80',
        genre: 'Sound System / Afro-Rock',
        ticketUrl: 'https://www.sympla.com.br'
    },
    {
        id: 'ssa-3',
        city: 'Salvador',
        state: 'BA',
        artist: 'Maria Rita — Samba da Maria',
        title: 'Maria Rita: Samba da Maria em Salvador',
        month: 12,
        day: 6,
        timeLabel: '20:00',
        venue: 'Concha Acústica do Teatro Castro Alves',
        image: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80',
        genre: 'Samba / MPB',
        ticketUrl: 'https://www.sympla.com.br'
    },

    // Belo Horizonte - MG
    {
        id: 'bh-1',
        city: 'Belo Horizonte',
        state: 'MG',
        artist: 'Milton Nascimento & Esperanza Spalding',
        title: 'Milton + Esperanza — Encontro Especial',
        month: 11,
        day: 13,
        timeLabel: '21:00',
        venue: 'Arena Hall (Antigo Chevrolet Hall)',
        image: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80',
        genre: 'Clube da Esquina / Jazz',
        ticketUrl: 'https://www.sympla.com.br'
    },
    {
        id: 'bh-2',
        city: 'Belo Horizonte',
        state: 'MG',
        artist: 'Samuel Rosa — Tour Solo',
        title: 'Samuel Rosa: Tour Solo e Clássicos',
        month: 10,
        day: 23,
        timeLabel: '21:30',
        venue: 'Palácio das Artes',
        image: 'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=600&auto=format&fit=crop&q=80',
        genre: 'Pop Rock',
        ticketUrl: 'https://www.eventim.com.br'
    },

    // Curitiba - PR
    {
        id: 'cwb-1',
        city: 'Curitiba',
        state: 'PR',
        artist: 'Caetano Veloso & Maria Bethânia',
        title: 'Caetano & Bethânia na Pedreira',
        month: 12,
        day: 11,
        timeLabel: '20:00',
        venue: 'Pedreira Paulo Leminski',
        image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB',
        ticketUrl: 'https://www.ticketmaster.com.br'
    },
    {
        id: 'cwb-2',
        city: 'Curitiba',
        state: 'PR',
        artist: 'Festival Prime Rock Brasil Curitiba',
        title: 'Prime Rock Brasil: Os Clássicos do Rock Nacional',
        month: 11,
        day: 22,
        timeLabel: '14:00',
        venue: 'Pedreira Paulo Leminski',
        image: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=600&auto=format&fit=crop&q=80',
        genre: 'Rock Brasil',
        ticketUrl: 'https://www.blueticket.com.br'
    },

    // Recife - PE
    {
        id: 'rec-1',
        city: 'Recife',
        state: 'PE',
        artist: 'Alceu Valença & Orquestra Ouro Preto',
        title: 'Alceu Valença: Valencianas II',
        month: 11,
        day: 20,
        timeLabel: '21:00',
        venue: 'Classic Hall — Olinda/Recife',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
        genre: 'Frevo / MPB / Sinfônica',
        ticketUrl: 'https://www.bilheteriadigital.com'
    },
    {
        id: 'rec-2',
        city: 'Recife',
        state: 'PE',
        artist: 'Lenine — Turnê Rizoma',
        title: 'Lenine & Bruno Giorgi em Recife',
        month: 10,
        day: 9,
        timeLabel: '20:30',
        venue: 'Teatro Guararapes',
        image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB / Rock',
        ticketUrl: 'https://www.sympla.com.br'
    },

    // Porto Alegre - RS
    {
        id: 'poa-1',
        city: 'Porto Alegre',
        state: 'RS',
        artist: 'Humberto Gessinger — Turnê Especial',
        title: 'Humberto Gessinger ao Vivo em Porto Alegre',
        month: 10,
        day: 16,
        timeLabel: '21:00',
        venue: 'Auditório Araújo Vianna',
        image: 'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=600&auto=format&fit=crop&q=80',
        genre: 'Rock Gaúcho / MPB',
        ticketUrl: 'https://www.sympla.com.br'
    },
    {
        id: 'poa-2',
        city: 'Porto Alegre',
        state: 'RS',
        artist: 'Ney Matogrosso — Bloco na Rua',
        title: 'Ney Matogrosso: Turnê Bloco na Rua',
        month: 11,
        day: 27,
        timeLabel: '21:00',
        venue: 'Teatro do Bourbon Country',
        image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB / Performance',
        ticketUrl: 'https://www.uhuu.com'
    },

    // Fortaleza - CE
    {
        id: 'for-1',
        city: 'Fortaleza',
        state: 'CE',
        artist: 'Fagner — 50 Anos de Música',
        title: 'Raimundo Fagner em Fortaleza',
        month: 11,
        day: 19,
        timeLabel: '21:00',
        venue: 'Centro de Eventos do Ceará',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
        genre: 'MPB / Nordestina',
        ticketUrl: 'https://www.bilheteriavirtual.com.br'
    },

    // Manaus - AM
    {
        id: 'mao-1',
        city: 'Manaus',
        state: 'AM',
        artist: 'Festival Amazonas de Música Brasileira',
        title: 'Grande Concerto da Floresta',
        month: 10,
        day: 25,
        timeLabel: '19:00',
        venue: 'Teatro Amazonas',
        image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=600&auto=format&fit=crop&q=80',
        genre: 'Erudita / MPB',
        ticketUrl: 'https://www.shopingressos.com.br'
    }
];

function normalizeSearchStr(str = '') {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

app.get('/api/events', (req, res) => {
    const requestedCity = String(req.query.city || '').trim();
    const normReqCity = normalizeSearchStr(requestedCity);

    // Resolve todos os shows com datas futuras e ordenação cronológica
    const allResolvedShows = RAW_CONCERT_DATA
        .map(raw => createUpcomingShow(raw))
        .sort((a, b) => a.timestamp - b.timestamp);

    let filtered = [];

    if (normReqCity) {
        filtered = allResolvedShows.filter(evt => {
            const normEvtCity = normalizeSearchStr(evt.city);
            const normEvtState = normalizeSearchStr(evt.state);
            return normEvtCity.includes(normReqCity) || normReqCity.includes(normEvtCity) || normEvtState === normReqCity;
        });
    }

    // Se a cidade não tiver shows cadastrados, retorna os principais destaques nacionais
    const isFallback = filtered.length === 0;
    const finalEvents = isFallback ? allResolvedShows.slice(0, 8) : filtered;

    res.json({
        success: true,
        city: requestedCity || 'Destaques Nacionais',
        isFallback,
        count: finalEvents.length,
        events: finalEvents
    });
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
