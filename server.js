import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_HOSTS = ['radio-marinha-pagina.onrender.com'];
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DIST_DIR = path.join(__dirname, 'dist');

const API_URL = 'https://stm0.inovativa.net/api/nowplaying/radiomarinha';
const FALLBACK_GIF = '/imagens/radio_gif.gif';
const STATION_IDENTIFIERS = ['radio marinha', 'programacao ao vivo'];
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
    updatedAt: null
};

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

function isStationIdentifier(artist, title) {
    const metadata = `${normalizeMetadata(artist)} ${normalizeMetadata(title)}`;
    return STATION_IDENTIFIERS.some((identifier) => metadata.includes(identifier));
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
    return Boolean(resultArtist && resultTitle)
        && resultTitle === sourceTitle
        && sourceArtist.includes(resultArtist);
}

async function findTrackMetadata(artist, title) {
    try {
        const query = encodeURIComponent(`${artist} ${title}`);
        const [deezerResponse, itunesResponse] = await Promise.allSettled([
            fetch(`https://api.deezer.com/search?q=${query}&limit=10`).then((response) => response.json()),
            fetch(`https://itunes.apple.com/search?term=${query}&entity=song&limit=10&country=BR`).then((response) => response.json())
        ]);
        const deezerTracks = deezerResponse.status === 'fulfilled' ? deezerResponse.value.data || [] : [];
        const itunesTracks = itunesResponse.status === 'fulfilled'
            ? (itunesResponse.value.results || []).map((result) => ({
                title: result.trackName,
                title_short: result.trackName,
                artist: { name: result.artistName },
                album: {
                    title: result.collectionName,
                    cover_xl: result.artworkUrl100?.replace('100x100', '600x600')
                }
            }))
            : [];
        const match = [...deezerTracks, ...itunesTracks]
            .find((result) => isMatchingTrack(result, artist, title));
        if (match) {
            const officialValues = [match.title, match.title_short, match.artist?.name, match.album?.title];
            return {
                title: restoreAccents(title, officialValues, true),
                artist: restoreAccents(artist, officialValues, true),
                cover: match.album?.cover_xl || match.album?.cover_big || null
            };
        }
    } catch (e) { console.error("[CATALOG ERROR]:", e.message); }
    return {
        title: restoreAccents(title, [], true),
        artist: restoreAccents(artist, [], true),
        cover: null
    };
}

async function fetchRadioStatus() {
    try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        const data = await response.json();
        const current = data.now_playing?.song;

        if (current && current.text !== nowPlaying.streamTitle) {
            const stationIdentifier = isStationIdentifier(current.artist, current.title);
            const catalogTrack = stationIdentifier
                ? null
                : await findTrackMetadata(current.artist, current.title);
            // A URL de arte da transmissão também pode devolver a capa genérica sem
            // indicar isso no endereço. Só exibimos capas confirmadas pelo catálogo;
            // quando não há correspondência, usamos a animação da rádio.
            const coverUrl = stationIdentifier
                ? FALLBACK_GIF
                : catalogTrack?.cover || FALLBACK_GIF;

            nowPlaying = {
                title: capitalizeTitle(catalogTrack?.title || current.title || "Programação ao vivo"),
                artist: catalogTrack?.artist || current.artist || "Rádio Marinha",
                album: current.album || "Rádio Marinha Online",
                cover: coverUrl || FALLBACK_GIF,
                streamTitle: current.text,
                updatedAt: new Date().toISOString()
            };
            console.log(`[RADIO] Tocando: ${current.text}`);
        }
    } catch (e) { console.error("[API ERROR]"); }
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
    res.json(nowPlaying);
});

app.get('/api/lyrics', async (req, res) => {
    const artist = String(req.query.artist || '').trim();
    const title = String(req.query.title || '').trim();

    if (!artist || !title) {
        return res.status(400).json({ lyrics: null });
    }

    try {
        const params = new URLSearchParams({ artist_name: artist, track_name: title });
        const syncedResponse = await fetch(`https://lrclib.net/api/get?${params}`);

        if (syncedResponse.ok) {
            const data = await syncedResponse.json();
            const lyrics = data.syncedLyrics || data.plainLyrics;
            if (lyrics) return res.json({ lyrics, synced: Boolean(data.syncedLyrics) });
        }

        const fallbackResponse = await fetch(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
        );
        if (fallbackResponse.ok) {
            const data = await fallbackResponse.json();
            if (data.lyrics) return res.json({ lyrics: data.lyrics, synced: false });
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
        const response = await fetch(
            `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artist)}`
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
