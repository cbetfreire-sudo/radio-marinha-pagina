import test from "node:test";
import assert from "node:assert/strict";
import {
  createStreamPositionZeroAt,
  estimateStreamStartupDelay,
  findActiveLyricIndex,
  getTrackTransitionDelay,
  parseLyrics,
  projectAudibleTrackElapsed,
  projectBroadcastElapsed,
  reconcileBroadcastClock
} from "../src/lyricsSync.js";

test("interpreta timestamps LRC, offset e múltiplas linhas simultâneas", () => {
  const parsed = parseLyrics("[offset:+500]\n[00:10.00]Primeira\n[00:12.25][00:20.00]Refrão");

  assert.equal(parsed.synced, true);
  assert.deepEqual(parsed.rows.map(({ text, time }) => ({ text, time })), [
    { text: "Primeira", time: 10.5 },
    { text: "Refrão", time: 12.75 },
    { text: "Refrão", time: 20.5 }
  ]);
});

test("encontra a linha ativa por busca binária e escolhe a última linha simultânea", () => {
  const rows = [
    { time: 5 },
    { time: 10 },
    { time: 10 },
    { time: 18 }
  ];

  assert.equal(findActiveLyricIndex(rows, 4.99), -1);
  assert.equal(findActiveLyricIndex(rows, 10), 2);
  assert.equal(findActiveLyricIndex(rows, 17.99), 2);
  assert.equal(findActiveLyricIndex(rows, 18), 3);
});

test("projeta o tempo da transmissão sem depender do player de áudio", () => {
  const clock = { elapsed: 35, sampledAt: 1000, correction: 0 };
  assert.equal(projectBroadcastElapsed(clock, 7000), 41);
});

test("latência inicial usa metade do tempo start→playing como fallback", () => {
  assert.equal(estimateStreamStartupDelay(1000, 1750), .375);
  assert.equal(estimateStreamStartupDelay(1000, 13000), 6);
  assert.equal(estimateStreamStartupDelay(1000, 31000), 10);
  assert.equal(estimateStreamStartupDelay(1000, 13000, null, 4), 4);
});

test("buffer válido tem preferência sobre o fallback de inicialização", () => {
  assert.equal(estimateStreamStartupDelay(1000, 9000, 1.25), 1.25);
  assert.equal(estimateStreamStartupDelay(1000, 9000, 0), 0);
  assert.equal(estimateStreamStartupDelay(1000, 9000, 25), 25);
  assert.equal(estimateStreamStartupDelay(1000, 9000, 70), 45);
  assert.equal(estimateStreamStartupDelay(0, 9000, 2.5), 2.5);
});

test("estimativa de latência nunca é negativa, NaN ou maior que o limite", () => {
  const estimates = [
    estimateStreamStartupDelay(0, 1750),
    estimateStreamStartupDelay(2000, 1000),
    estimateStreamStartupDelay(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN),
    estimateStreamStartupDelay(1000, 5000, -3),
    estimateStreamStartupDelay(1000, 50000, Number.POSITIVE_INFINITY),
    estimateStreamStartupDelay(1000, 5000, 7, 10, 3)
  ];

  estimates.forEach((estimate) => {
    assert.equal(Number.isFinite(estimate), true);
    assert.ok(estimate >= 0);
    assert.ok(estimate <= 45);
  });
  assert.deepEqual(estimates, [0, 0, 0, 2, 10, 3]);
});

test("estimativa é pura e não acumula buffering posterior", () => {
  const startupFallback = estimateStreamStartupDelay(1000, 9000);
  const bufferedMeasurement = estimateStreamStartupDelay(1000, 9000, 1.5);
  const repeatedMeasurement = estimateStreamStartupDelay(1000, 9000, 1.5);

  assert.equal(startupFallback, 4);
  assert.equal(bufferedMeasurement, 1.5);
  assert.notEqual(bufferedMeasurement, startupFallback + 1.5);
  assert.equal(repeatedMeasurement, bufferedMeasurement);
});

test("relógio do player preserva uma única âncora do stream entre faixas", () => {
  const beforeBoundary = projectAudibleTrackElapsed({
    streamPositionZeroAt: 5000,
    mediaTime: 10,
    trackSampledAt: 20000,
    trackElapsed: 2
  });
  const afterBoundary = projectAudibleTrackElapsed({
    streamPositionZeroAt: 5000,
    mediaTime: 15,
    trackSampledAt: 20000,
    trackElapsed: 2
  });

  assert.equal(beforeBoundary, -3);
  assert.equal(afterBoundary, 2);
});

test("constrói a posição zero usando buffer e posição atual uma única vez", () => {
  assert.equal(createStreamPositionZeroAt(9000, 2, 1.5), 5500);
  assert.equal(createStreamPositionZeroAt(9000, -1, 1.5), null);
  assert.equal(createStreamPositionZeroAt(9000, 2, Number.NaN), null);
});

test("adia a troca visual até a nova faixa alcançar o conteúdo audível", () => {
  const clock = {
    streamPositionZeroAt: 5000,
    mediaTime: 10,
    trackSampledAt: 20000,
    trackElapsed: 2
  };

  assert.equal(getTrackTransitionDelay(clock), 3);
  assert.equal(getTrackTransitionDelay({ ...clock, mediaTime: 12.9 }), .12);
  assert.equal(getTrackTransitionDelay({ ...clock, mediaTime: 13 }), 0);
  assert.equal(getTrackTransitionDelay({ ...clock, streamPositionZeroAt: null }), null);
});

test("buffering congela o relógio audível sem acumular atraso artificial", () => {
  const clock = {
    streamPositionZeroAt: 8000,
    mediaTime: 12,
    trackSampledAt: 17000,
    trackElapsed: 4
  };

  assert.equal(projectAudibleTrackElapsed(clock), 7);
  assert.equal(projectAudibleTrackElapsed(clock), 7);
  assert.equal(projectAudibleTrackElapsed({ ...clock, streamPositionZeroAt: null }), null);
});

test("polls da mesma execução preservam uma única âncora monotônica", () => {
  const previous = { elapsed: 30, sampledAt: 1000, correction: 0, trackKey: "faixa-1" };
  const reconciled = reconcileBroadcastClock(previous, {
    elapsed: 32.4,
    sampledAt: 3000,
    trackKey: "faixa-1"
  }, 3000);

  assert.ok(Math.abs(projectBroadcastElapsed(reconciled, 3000) - 32) < .0001);
  assert.equal(reconciled.elapsed, 30);
  assert.equal(reconciled.sampledAt, 1000);
  assert.equal(reconciled.correction, 0);
});

test("uma leitura divergente da mesma faixa não sacode a linha ativa", () => {
  const previous = { elapsed: 30, sampledAt: 1000, correction: 0, trackKey: "faixa-1" };
  const reconciled = reconcileBroadcastClock(previous, {
    elapsed: 33,
    sampledAt: 3000,
    trackKey: "faixa-1"
  }, 3000);

  assert.equal(reconciled.correction, 0);
  assert.equal(projectBroadcastElapsed(reconciled, 3000), 32);
});

test("troca de faixa e desvios grandes fazem reposicionamento imediato", () => {
  const previous = { elapsed: 90, sampledAt: 1000, correction: 0, trackKey: "faixa-1" };
  const changed = reconcileBroadcastClock(previous, {
    elapsed: 2,
    sampledAt: 3000,
    trackKey: "faixa-2"
  }, 3000);

  assert.equal(changed.changedTrack, true);
  assert.equal(changed.correction, 0);
  assert.equal(projectBroadcastElapsed(changed, 3000), 2);
});
