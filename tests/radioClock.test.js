import test from "node:test";
import assert from "node:assert/strict";
import { addRadioStatusCacheBuster, selectStationElapsed } from "../radioClock.js";

test("prioriza o elapsed audível mesmo quando played_at diverge 5 segundos", () => {
  const sampledAt = 1_787_278_514_000;
  const playedAt = 1_787_278_386;

  assert.equal(selectStationElapsed(133, playedAt, sampledAt), 133);
});

test("usa played_at apenas quando a estação não envia elapsed válido", () => {
  const sampledAt = 1_787_278_514_000;
  const playedAt = 1_787_278_386;

  assert.equal(selectStationElapsed(undefined, playedAt, sampledAt), 128);
  assert.equal(selectStationElapsed(-1, playedAt, sampledAt), 128);
});

test("aceita elapsed zero no início de uma nova faixa", () => {
  assert.equal(selectStationElapsed(0, 123, 456000), 0);
});

test("não interpreta ausência de elapsed como zero", () => {
  assert.equal(selectStationElapsed(null, 123, 125000), 2);
  assert.equal(selectStationElapsed("", 123, 125000), 2);
});

test("cada consulta invalida o cache do endpoint sem perder parâmetros", () => {
  const first = new URL(addRadioStatusCacheBuster("https://radio.test/now?station=marinha", "a"));
  const second = new URL(addRadioStatusCacheBuster(first, "b"));

  assert.equal(first.searchParams.get("station"), "marinha");
  assert.equal(first.searchParams.get("_"), "a");
  assert.equal(second.searchParams.get("station"), "marinha");
  assert.equal(second.searchParams.get("_"), "b");
});
