import { createHash } from 'node:crypto';

const TRANSLATABLE_LANGUAGES = new Set(['en', 'es']);
const MAX_LINES = 180;
const MAX_ID_LENGTH = 160;
const MAX_LINE_LENGTH = 500;
const MAX_TOTAL_LENGTH = 5000;
const TRANSLATION_BATCH_SIZE = 100;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class TranslationServiceError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'TranslationServiceError';
        this.code = code;
        this.status = status;
    }
}

function decodeTranslationEntities(value) {
    return String(value || '')
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function validateLines(lines) {
    if (!Array.isArray(lines) || !lines.length) {
        throw new TranslationServiceError('invalid_lines', 400, 'Envie ao menos uma linha para tradução.');
    }
    if (lines.length > MAX_LINES) {
        throw new TranslationServiceError('lyrics_too_large', 413, 'A letra possui linhas demais para tradução.');
    }

    let totalLength = 0;
    const ids = new Set();
    const normalized = lines.map((line, index) => {
        if (typeof line?.id !== 'string' || typeof line?.text !== 'string') {
            throw new TranslationServiceError('invalid_line', 400, `Linha inválida na posição ${index}.`);
        }
        const id = line.id.trim().normalize('NFC');
        const text = line.text.trim().normalize('NFC');
        if (!id || !text) {
            throw new TranslationServiceError('invalid_line', 400, `Linha inválida na posição ${index}.`);
        }
        if (Array.from(id).length > MAX_ID_LENGTH || /[\r\n\0]/.test(id)) {
            throw new TranslationServiceError('invalid_line_id', 400, `ID inválido na posição ${index}.`);
        }
        if (/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
            throw new TranslationServiceError('invalid_line', 400, `Texto inválido na posição ${index}.`);
        }
        if (ids.has(id)) {
            throw new TranslationServiceError('duplicate_line_id', 400, `ID repetido na posição ${index}.`);
        }
        ids.add(id);
        const textLength = Array.from(text).length;
        if (textLength > MAX_LINE_LENGTH) {
            throw new TranslationServiceError('line_too_large', 413, `Linha ${index + 1} excede o limite.`);
        }
        totalLength += textLength;
        return { id, text };
    });

    if (totalLength > MAX_TOTAL_LENGTH) {
        throw new TranslationServiceError('lyrics_too_large', 413, 'A letra excede o limite de tradução.');
    }
    return normalized;
}

function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

export function createLyricsTranslator({ apiKey, fetchImpl = fetch, cacheLimit = 200, timeoutMs = 9000 } = {}) {
    const cache = new Map();
    const pending = new Map();

    const requestGoogle = async (path, body) => {
        if (!apiKey) {
            throw new TranslationServiceError(
                'translation_not_configured',
                503,
                'A tradução ainda não foi configurada no servidor.'
            );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const endpoint = `https://translation.googleapis.com/language/translate/v2${path ? `/${path}` : ''}`;
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                const upstreamReason = JSON.stringify(payload?.error || '').toLowerCase();
                const quotaExceeded = response.status === 429 || (
                    response.status === 403
                    && /(dailylimitexceeded|userratelimitexceeded|quota[_ ]?exceeded|rate limit|daily limit)/.test(upstreamReason)
                );
                const credentialsRejected = response.status === 401 || (response.status === 403 && !quotaExceeded);
                const status = quotaExceeded ? 429 : credentialsRejected ? 503 : 502;
                const code = quotaExceeded
                    ? 'translation_quota_exceeded'
                    : credentialsRejected
                        ? 'translation_credentials_rejected'
                        : 'translation_provider_error';
                throw new TranslationServiceError(code, status, `Serviço de tradução respondeu HTTP ${response.status}.`);
            }
            if (!payload) {
                throw new TranslationServiceError('translation_provider_error', 502, 'O serviço retornou uma resposta inválida.');
            }
            return payload;
        } catch (error) {
            if (error instanceof TranslationServiceError) throw error;
            if (error?.name === 'AbortError') {
                throw new TranslationServiceError('translation_timeout', 504, 'O serviço de tradução demorou para responder.');
            }
            throw new TranslationServiceError('translation_provider_error', 502, 'Não foi possível acessar o serviço de tradução.');
        } finally {
            clearTimeout(timeout);
        }
    };

    const translate = async (inputLines) => {
        const lines = validateLines(inputLines);
        const cacheKey = createHash('sha256')
            .update(JSON.stringify(lines.map(({ text }) => text)))
            .digest('hex');

        const materialize = (value, cached) => ({
            available: value.available,
            sourceLanguage: value.sourceLanguage,
            targetLanguage: value.targetLanguage,
            translations: value.available
                ? lines.map((line, index) => ({ id: line.id, text: value.translatedTexts[index] }))
                : [],
            cached
        });

        if (cache.has(cacheKey)) {
            const cachedEntry = cache.get(cacheKey);
            cache.delete(cacheKey);
            if (cachedEntry.expiresAt > Date.now()) {
                cache.set(cacheKey, cachedEntry);
                return materialize(cachedEntry.value, true);
            }
        }
        if (pending.has(cacheKey)) {
            return materialize(await pending.get(cacheKey), true);
        }

        const operation = (async () => {
            const languageSample = Array.from(lines.map(({ text }) => text).join(' ')).slice(0, 5000).join('');
            const detection = await requestGoogle('detect', { q: languageSample });
            const detectedLanguage = String(
                detection?.data?.detections?.[0]?.[0]?.language || ''
            ).toLowerCase().split('-')[0];
            if (!detectedLanguage) {
                throw new TranslationServiceError(
                    'translation_detection_error',
                    502,
                    'O serviço não conseguiu identificar o idioma da letra.'
                );
            }

            if (!TRANSLATABLE_LANGUAGES.has(detectedLanguage)) {
                const unavailableResult = {
                    available: false,
                    sourceLanguage: detectedLanguage || null,
                    targetLanguage: 'pt-BR',
                    translatedTexts: []
                };
                cache.set(cacheKey, { value: unavailableResult, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS });
                while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
                return unavailableResult;
            }

            const uniqueTexts = [...new Set(lines.map(({ text }) => text))];
            const batches = chunk(uniqueTexts, TRANSLATION_BATCH_SIZE);
            const translatedBatches = await Promise.all(batches.map(async (batch) => {
                const result = await requestGoogle('', {
                    q: batch,
                    source: detectedLanguage,
                    target: 'pt-BR',
                    format: 'text'
                });
                const translations = result?.data?.translations;
                if (!Array.isArray(translations) || translations.length !== batch.length) {
                    throw new TranslationServiceError(
                        'translation_alignment_error',
                        502,
                        'A tradução não preservou o alinhamento das linhas.'
                    );
                }
                return batch.map((sourceText, index) => {
                    const translatedText = translations[index]?.translatedText;
                    if (typeof translatedText !== 'string' || !translatedText.trim()) {
                        throw new TranslationServiceError(
                            'translation_alignment_error',
                            502,
                            'O serviço retornou uma linha traduzida inválida.'
                        );
                    }
                    return [sourceText, decodeTranslationEntities(translatedText)];
                });
            }));

            const translationsBySource = new Map(translatedBatches.flat());
            const result = {
                available: true,
                sourceLanguage: detectedLanguage,
                targetLanguage: 'pt-BR',
                translatedTexts: lines.map(({ text }) => translationsBySource.get(text) || text)
            };
            cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
            while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
            return result;
        })();

        pending.set(cacheKey, operation);
        try {
            return materialize(await operation, false);
        } finally {
            pending.delete(cacheKey);
        }
    };

    return { translate };
}
