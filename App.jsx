import React, { useEffect, useRef, useState } from "react";
import "./styles.css";

const STREAM_URL =
  "https://stm0.inovativa.net/listen/radiomarinha/radio.mp3";
  
const API_URL = "http://localhost:3001/api/now-playing";

const FALLBACK_COVER =
  "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=900&q=85";

const defaultNowPlaying = {
  title: "Rádio Marinha",
  artist: "Programação ao vivo",
  album: "Rádio Marinha Online",
  cover: null,
  updatedAt: null
};

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function App() {
  const audioRef = useRef(null);

  const [nowPlaying, setNowPlaying] = useState(defaultNowPlaying);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [volume, setVolume] = useState(0.85);

  async function loadNowPlaying() {
  try {
    const response = await fetch(API_URL, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`API respondeu com HTTP ${response.status}`);
    }

    const data = await response.json();

    console.log("Dados recebidos da rádio:", data);

    setNowPlaying({
      title: data.title || "Programação ao vivo",
      artist: data.artist || "Rádio Marinha",
      album: data.album || "Rádio Marinha Online",
      cover: data.cover || null,
      updatedAt: data.updatedAt || null
    });

    setMessage("");
  } catch (error) {
    console.error("Erro ao carregar programação:", error);
    setMessage(
      "Não foi possível carregar os dados da programação. Verifique se o servidor está ativo na porta 3001."
    );
  }
}

  useEffect(() => {
    loadNowPlaying();

    const interval = setInterval(loadNowPlaying, 15000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  async function toggleRadio() {
    if (!audioRef.current) {
      return;
    }

    setMessage("");

    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }

    try {
      setLoading(true);

      await audioRef.current.play();

      setPlaying(true);
    } catch (error) {
      console.error("Erro ao iniciar o áudio:", error);
      setMessage(
        "O navegador bloqueou o áudio. Clique novamente no botão de reprodução."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app">
      <section className="radio-card">
        <header className="header">
          <div>
            <p className="overline">TRANSMISSÃO ONLINE</p>
            <h1>Rádio Marinha</h1>
          </div>

          <span className="live">
            <span className="live-dot" />
            AO VIVO
          </span>
        </header>

        <div className="radio-content">
          <div className="cover-area">
            <img
              className="cover"
              src={nowPlaying.cover || FALLBACK_COVER}
              alt={`Capa de ${nowPlaying.title}`}
            />
          </div>

          <div className="details">
            <p className="overline">TOCANDO AGORA</p>

            <h2>{nowPlaying.title}</h2>

            <p className="artist">{nowPlaying.artist}</p>

            <p className="album">{nowPlaying.album}</p>

            {nowPlaying.updatedAt && (
              <p className="updated">
                Atualizado às {formatTime(nowPlaying.updatedAt)}
              </p>
            )}

            <div className="controls">
              <button
                type="button"
                className="play-button"
                onClick={toggleRadio}
              >
                {loading ? "..." : playing ? "Ⅱ" : "▶"}
              </button>

              <label className="volume">
                <span>🔊</span>

                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(event) => {
                    setVolume(Number(event.target.value));
                  }}
                />
              </label>
            </div>

            {message && <p className="message">{message}</p>}

            <p className="stream-label">
              MP3 STREAM • RÁDIO MARINHA • 24 HORAS
            </p>
          </div>
        </div>

        <footer className="footer">
          Rádio Marinha Online
        </footer>
      </section>

      <audio
        ref={audioRef}
        src={STREAM_URL}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          setMessage("Não foi possível conectar ao stream de áudio.");
        }}
      />
    </main>
  );
}