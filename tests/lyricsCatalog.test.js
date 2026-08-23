import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artistPageTitleMatches,
  canonicalizeArtistName,
  isMusicalBiography,
  normalizeArtistFingerprint
} from '../trackMetadata.js';
import {
  scoreSyncedLyricsCandidate,
  selectBestSyncedLyrics
} from '../lyricsCatalog.js';

const synced = '[00:00.00]There comes a time\n[00:06.00]When we heed a certain call';

function candidate(overrides = {}) {
  return {
    id: 1,
    trackName: 'We Are the World',
    artistName: 'USA for Africa',
    albumName: 'We Are the World',
    duration: 427,
    syncedLyrics: synced,
    ...overrides
  };
}

test('canonicaliza as variantes da rádio para USA for Africa', () => {
  const aliases = [
    'U.S.A Africa',
    'U.S.A. Africa',
    'USA Africa',
    'u.s.a. for africa',
    'USA FOR AFRICA'
  ];

  aliases.forEach((alias) => {
    assert.equal(normalizeArtistFingerprint(alias), 'usa africa');
    assert.equal(canonicalizeArtistName(alias), 'USA for Africa');
  });
});

test('não transforma África nem South Africa no coletivo USA for Africa', () => {
  assert.equal(canonicalizeArtistName('África'), 'África');
  assert.equal(canonicalizeArtistName('South Africa'), 'South Africa');
  assert.notEqual(normalizeArtistFingerprint('África'), normalizeArtistFingerprint('U.S.A Africa'));
  assert.notEqual(normalizeArtistFingerprint('South Africa'), normalizeArtistFingerprint('U.S.A Africa'));
});

test('seleciona a letra oficial sincronizada de 427 s usando o alias recebido da rádio', () => {
  const official = candidate({ id: 3161797, artistName: 'U.S.A. for Africa' });
  const cover = candidate({
    id: 2,
    artistName: 'Munich Symphonic Sound Orchestra',
    duration: 425
  });
  const remix = candidate({ id: 3, trackName: 'We Are the World (Remix)', duration: 427 });

  assert.equal(
    selectBestSyncedLyrics([cover, remix, official], 'U.S.A Africa', 'We Are The World', 427),
    official
  );
  assert.ok(scoreSyncedLyricsCandidate(official, 'U.S.A Africa', 'We Are The World', 427) >= 120);
});

test('rejeita cover, karaokê e remix quando a transmissão toca a versão original', () => {
  const wrongVersions = [
    candidate({ id: 4, trackName: 'We Are the World (Cover)' }),
    candidate({ id: 5, trackName: 'We Are the World (Karaoke Version)' }),
    candidate({ id: 6, trackName: 'We Are the World (Tribute)' }),
    candidate({ id: 7, trackName: 'We Are the World (Instrumental)' }),
    candidate({ id: 8, trackName: 'We Are the World (Remix)' }),
    candidate({ id: 9, artistName: 'The Kelly Family' })
  ];

  wrongVersions.forEach((wrongVersion) => {
    assert.equal(
      selectBestSyncedLyrics([wrongVersion], 'U.S.A Africa', 'We Are The World', 427),
      null,
      `não deveria aceitar ${wrongVersion.artistName} — ${wrongVersion.trackName}`
    );
  });
});

test('aceita remix apenas quando o metadado de origem também informa remix', () => {
  const original = candidate({ id: 10 });
  const remix = candidate({ id: 11, trackName: 'We Are the World (Remix)' });

  assert.equal(
    selectBestSyncedLyrics([original, remix], 'USA for Africa', 'We Are the World (Remix)', 427),
    remix
  );
});

test('não confunde o coletivo USA for Africa com a página do continente África', () => {
  assert.equal(artistPageTitleMatches('USA for Africa', 'U.S.A Africa'), true);
  assert.equal(artistPageTitleMatches('África', 'U.S.A Africa'), false);
  assert.equal(artistPageTitleMatches('South Africa', 'U.S.A Africa'), false);

  assert.equal(isMusicalBiography({
    description: 'continente',
    extract: 'África é o terceiro continente mais extenso e possui uma população numerosa.'
  }), false);
  assert.equal(isMusicalBiography({
    description: 'supergrupo musical estadunidense',
    extract: 'USA for Africa foi um supergrupo de cantores que gravou a canção We Are the World.'
  }), true);
});

test('população não é interpretada como o gênero musical pop', () => {
  assert.equal(isMusicalBiography({
    description: 'continente',
    extract: 'Sua população representa uma parcela expressiva da população mundial.'
  }), false);
});
