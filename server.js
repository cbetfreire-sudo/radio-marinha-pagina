import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;

const API_URL = 'https://stm0.inovativa.net/api/nowplaying/radiomarinha';
const FALLBACK_GIF = '/imagens/radio_gif.gif';

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

async function findHighResCover(artist, title) {
    try {
        const query = encodeURIComponent(`${artist} ${title}`);
        const res = await fetch(`https://itunes.apple.com/search?term=${query}&entity=song&limit=1`);
        const data = await res.json();
        if (data.results?.length > 0) {
            return data.results[0].artworkUrl100.replace('100x100', '600x600');
        }
    } catch (e) { console.error("[ITUNES ERROR]:", e.message); }
    return null;
}

async function fetchRadioStatus() {
    try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        const data = await response.json();
        const current = data.now_playing?.song;

        if (current && current.text !== nowPlaying.streamTitle) {
            let coverUrl = current.art;
            
            // Se a capa for a genérica ou não existir, tenta iTunes
            if (!coverUrl || coverUrl.includes('generic_song.jpg')) {
                const itunesCover = await findHighResCover(current.artist, current.title);
                // Se o iTunes também não achar, usa o seu GIF
                coverUrl = itunesCover || FALLBACK_GIF;
            }

            nowPlaying = {
                title: current.title || "Programação ao vivo",
                artist: current.artist || "Rádio Marinha",
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
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa"
    });
    app.use(vite.middlewares);

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
