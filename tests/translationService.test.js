import test from "node:test";
import assert from "node:assert/strict";
import {
  createLyricsTranslator,
  TranslationServiceError
} from "../translationService.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function requestBody(options) {
  return JSON.parse(options.body);
}

test("retorna erro controlado quando a chave de tradução não está configurada", async () => {
  let fetchCalls = 0;
  const translator = createLyricsTranslator({
    apiKey: "",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch não deveria ser chamado sem chave");
    }
  });

  await assert.rejects(
    translator.translate([{ id: "line-1", text: "Hello" }]),
    (error) => {
      assert.ok(error instanceof TranslationServiceError);
      assert.equal(error.code, "translation_not_configured");
      assert.equal(error.status, 503);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test("traduz inglês com deduplicação, alinhamento por posição e cache do servidor", async () => {
  const calls = [];
  const translatedBySource = new Map([
    ["Hello", "Olá"],
    ["Sing the chorus", "Cante o refrão"],
    ["Goodbye", "Adeus"]
  ]);
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      const body = requestBody(options);
      calls.push({ url, body });
      if (url.endsWith("/detect")) {
        return jsonResponse({ data: { detections: [[{ language: "en-US" }]] } });
      }
      return jsonResponse({
        data: {
          translations: body.q.map((source) => ({
            translatedText: translatedBySource.get(source)
          }))
        }
      });
    }
  });
  const lines = [
    { id: "line-1", text: "Hello" },
    { id: "line-2", text: "Sing the chorus" },
    { id: "line-3", text: "Sing the chorus" },
    { id: "line-4", text: "Goodbye" }
  ];

  const first = await translator.translate(lines);
  assert.deepEqual(first, {
    available: true,
    sourceLanguage: "en",
    targetLanguage: "pt-BR",
    translations: [
      { id: "line-1", text: "Olá" },
      { id: "line-2", text: "Cante o refrão" },
      { id: "line-3", text: "Cante o refrão" },
      { id: "line-4", text: "Adeus" }
    ],
    cached: false
  });

  const translationCalls = calls.filter(({ url }) => !url.endsWith("/detect"));
  assert.equal(translationCalls.length, 1);
  assert.deepEqual(translationCalls[0].body, {
    q: ["Hello", "Sing the chorus", "Goodbye"],
    source: "en",
    target: "pt-BR",
    format: "text"
  });

  const cached = await translator.translate(lines.map((line, index) => ({
    ...line,
    id: `cached-${index + 1}`
  })));
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.translations, [
    { id: "cached-1", text: "Olá" },
    { id: "cached-2", text: "Cante o refrão" },
    { id: "cached-3", text: "Cante o refrão" },
    { id: "cached-4", text: "Adeus" }
  ]);
  assert.equal(calls.length, 2, "o cache deve evitar nova detecção e nova tradução");
});

test("detecta espanhol e envia o idioma normalizado ao provedor", async () => {
  const calls = [];
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      const body = requestBody(options);
      calls.push({ url, body });
      if (url.endsWith("/detect")) {
        return jsonResponse({ data: { detections: [[{ language: "es-MX" }]] } });
      }
      return jsonResponse({
        data: {
          translations: body.q.map((text) => ({ translatedText: `PT:${text}` }))
        }
      });
    }
  });

  const result = await translator.translate([
    { id: "verse-1", text: "Hola, marinero" },
    { id: "verse-2", text: "Adiós" }
  ]);

  assert.equal(result.available, true);
  assert.equal(result.sourceLanguage, "es");
  assert.deepEqual(result.translations, [
    { id: "verse-1", text: "PT:Hola, marinero" },
    { id: "verse-2", text: "PT:Adiós" }
  ]);
  assert.equal(calls[1].body.source, "es");
  assert.equal(calls[1].body.target, "pt-BR");
});

test("não traduz português e reutiliza a detecção armazenada em cache", async () => {
  let detectionCalls = 0;
  let translationCalls = 0;
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      if (url.endsWith("/detect")) {
        detectionCalls += 1;
        return jsonResponse({ data: { detections: [[{ language: "pt-BR" }]] } });
      }
      translationCalls += 1;
      throw new Error("letra em português não deve ser enviada para tradução");
    }
  });
  const lines = [
    { id: "pt-1", text: "O mar serenou" },
    { id: "pt-2", text: "Quando ela pisou na areia" }
  ];

  const first = await translator.translate(lines);
  assert.deepEqual(first, {
    available: false,
    sourceLanguage: "pt",
    targetLanguage: "pt-BR",
    translations: [],
    cached: false
  });

  const second = await translator.translate(lines);
  assert.equal(second.available, false);
  assert.equal(second.sourceLanguage, "pt");
  assert.equal(second.cached, true);
  assert.deepEqual(second.translations, []);
  assert.equal(detectionCalls, 1);
  assert.equal(translationCalls, 0);
});

test("rejeita resposta de detecção malformada sem armazená-la em cache", async () => {
  let fetchCalls = 0;
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ data: { detections: [] } });
    }
  });
  const lines = [{ id: "line-1", text: "Unknown language" }];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      translator.translate(lines),
      (error) => {
        assert.ok(error instanceof TranslationServiceError);
        assert.equal(error.code, "translation_detection_error");
        assert.equal(error.status, 502);
        return true;
      }
    );
  }
  assert.equal(fetchCalls, 2, "respostas inválidas não devem contaminar o cache");
});

test("converte o erro 403 de cota do Google em limite temporário", async () => {
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async () => jsonResponse({
      error: {
        errors: [{ reason: "dailyLimitExceeded" }],
        message: "Daily Limit Exceeded"
      }
    }, 403)
  });

  await assert.rejects(
    translator.translate([{ id: "line-1", text: "Hello" }]),
    (error) => {
      assert.ok(error instanceof TranslationServiceError);
      assert.equal(error.code, "translation_quota_exceeded");
      assert.equal(error.status, 429);
      return true;
    }
  );
});

test("rejeita tipos inesperados antes de consultar o provedor", async () => {
  let fetchCalls = 0;
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    }
  });

  await assert.rejects(
    translator.translate([{ id: "line-1", text: 123 }]),
    (error) => error instanceof TranslationServiceError && error.code === "invalid_line"
  );
  assert.equal(fetchCalls, 0);
});

test("divide mais de 100 textos em lotes e preserva a ordem mesmo com respostas invertidas", async () => {
  const lines = Array.from({ length: 135 }, (_, index) => ({
    id: `line-${String(index).padStart(3, "0")}`,
    text: `English line ${String(index).padStart(3, "0")}`
  }));
  const translationBodies = [];
  const translator = createLyricsTranslator({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      const body = requestBody(options);
      if (url.endsWith("/detect")) {
        return jsonResponse({ data: { detections: [[{ language: "en" }]] } });
      }

      translationBodies.push(body);
      if (body.q.length === 100) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return jsonResponse({
        data: {
          translations: body.q.map((text) => ({ translatedText: `Traduzida: ${text}` }))
        }
      });
    }
  });

  const result = await translator.translate(lines);

  assert.equal(result.available, true);
  assert.equal(result.cached, false);
  assert.deepEqual(translationBodies.map(({ q }) => q.length), [100, 35]);
  assert.deepEqual(
    result.translations,
    lines.map(({ id, text }) => ({ id, text: `Traduzida: ${text}` }))
  );
});
