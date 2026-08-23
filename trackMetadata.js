function normalizeWords(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function baseArtistFingerprint(value) {
  const words = normalizeWords(value);
  const collapsed = [];

  for (let index = 0; index < words.length; index += 1) {
    if (words[index].length !== 1) {
      collapsed.push(words[index]);
      continue;
    }
    let initials = words[index];
    while (index + 1 < words.length && words[index + 1].length === 1) {
      initials += words[index + 1];
      index += 1;
    }
    collapsed.push(initials);
  }

  return collapsed.join(' ').trim();
}

const CANONICAL_ARTISTS = new Map([
  ['usa africa', 'USA for Africa'],
  ['usa for africa', 'USA for Africa']
]);

export function normalizeArtistFingerprint(value) {
  const fingerprint = baseArtistFingerprint(value);
  return CANONICAL_ARTISTS.has(fingerprint) ? 'usa africa' : fingerprint;
}

export function canonicalizeArtistName(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return CANONICAL_ARTISTS.get(baseArtistFingerprint(cleaned)) || cleaned;
}

function normalizeComparable(value) {
  return String(value || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshteinDistance(first, second) {
  if (!first.length) return second.length;
  if (!second.length) return first.length;
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex];
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current[secondIndex] = Math.min(
        current[secondIndex - 1] + 1,
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[second.length];
}

export function artistPageTitleMatches(pageTitle, targetName) {
  const page = normalizeComparable(pageTitle);
  const target = normalizeComparable(canonicalizeArtistName(targetName));
  if (!page || !target) return false;
  if (page === target) return true;

  const withoutLeadingArticle = (value) => value.replace(/^(?:the|a|an|o|os|as)\s+/, '');
  const pageWithoutArticle = withoutLeadingArticle(page);
  const targetWithoutArticle = withoutLeadingArticle(target);
  if (pageWithoutArticle === targetWithoutArticle) return true;

  const longestLength = Math.max(pageWithoutArticle.length, targetWithoutArticle.length);
  return longestLength >= 7
    && levenshteinDistance(pageWithoutArticle, targetWithoutArticle) <= 2;
}

function containsWholePhrase(text, phrase) {
  const normalizedText = String(text || '').normalize('NFC').toLowerCase();
  const escaped = String(phrase || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu')
    .test(normalizedText);
}

const MUSIC_DESCRIPTORS = [
  'cantor', 'cantora', 'cantores', 'cantoras',
  'músico', 'música', 'músicos', 'músicas', 'musico', 'musica', 'musicos', 'musicas',
  'musician', 'musicians', 'music group', 'musical group',
  'banda', 'band', 'bands', 'compositor', 'compositora', 'songwriter',
  'singer', 'rapper', 'violonista', 'guitarrista', 'pianista', 'baterista',
  'baixista', 'intérprete', 'interprete', 'dupla', 'trio', 'grupo musical',
  'vocalista', 'discografia', 'álbum', 'album', 'gravou', 'canção', 'cancao',
  'canções', 'cancoes', 'single', 'mpb', 'sertanejo', 'rock', 'pop', 'samba',
  'pagode', 'bossa nova'
];

const NON_MUSIC_DESCRIPTORS = [
  'continente', 'continent', 'país', 'pais', 'country', 'município', 'municipio',
  'cidade', 'city', 'footballer', 'futebolista', 'jogador de futebol', 'atleta',
  'político', 'politico', 'politician', 'militar', 'prelado', 'bispo', 'governador',
  'prefeito', 'senador', 'deputado', 'juiz', 'advogado', 'telenovela', 'filme',
  'empresa', 'escritor', 'poeta', 'geógrafo', 'geografo', 'historiador', 'médico', 'medico'
];

export function isMusicalBiography(summaryData) {
  if (!summaryData) return false;
  const description = String(summaryData.description || '').toLowerCase();
  const combined = `${description} ${summaryData.extract || ''}`.toLowerCase();
  const hasMusicDescriptor = MUSIC_DESCRIPTORS.some((keyword) => (
    containsWholePhrase(combined, keyword)
  ));
  const hasNonMusicDescription = NON_MUSIC_DESCRIPTORS.some((keyword) => (
    containsWholePhrase(description, keyword)
  ));
  return hasMusicDescriptor && !hasNonMusicDescription;
}
