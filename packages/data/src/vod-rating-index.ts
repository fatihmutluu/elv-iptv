import { foldText } from './fold';

/** Standardized VOD/series metadata enrichment payload returned by local index or optional fetcher (`#215`). */
export interface VodEnrichmentPayload {
  readonly rating?: number | null;
  readonly ratingSource?: string | null;
  readonly releaseYear?: number | null;
  readonly genres?: readonly string[];
  readonly synopsis?: string | null;
  readonly certification?: string | null;
}

/** Normalized query passed to {@link lookupLocalVodIndex} and optional {@link VodEnrichmentFetcher}. */
export interface VodEnrichmentQuery {
  readonly cleanTitle: string;
  readonly foldedTitle: string;
  readonly releaseYear: number | null;
  readonly kind: 'movie' | 'series';
}

/** Optional pluggable key-free metadata adapter seam (never called when enrichment is disabled). */
export type VodEnrichmentFetcher = (
  query: VodEnrichmentQuery,
) => Promise<VodEnrichmentPayload | null>;

interface LocalVodIndexEntry {
  readonly title: string;
  readonly kind: 'movie' | 'series';
  readonly releaseYear: number;
  readonly rating: number;
  readonly genres: readonly string[];
  readonly synopsis: string;
  readonly certification: string;
}

const LOCAL_INDEX_ENTRIES: readonly LocalVodIndexEntry[] = [
  {
    title: 'Metropolis',
    kind: 'movie',
    releaseYear: 1927,
    rating: 8.3,
    genres: ['Sci-Fi', 'Drama'],
    synopsis:
      'In a futuristic city sharply divided between the working class and the city planners, the son of the city mastermind falls in love with a prophet predicting the coming of a savior.',
    certification: 'Not Rated',
  },
  {
    title: 'Nosferatu',
    kind: 'movie',
    releaseYear: 1922,
    rating: 7.9,
    genres: ['Horror', 'Fantasy'],
    synopsis:
      'Vampire Count Orlok expresses interest in a new residence and real estate agent Hutter travels to the Carpathian Mountains to close the deal.',
    certification: 'Not Rated',
  },
  {
    title: 'Night of the Living Dead',
    kind: 'movie',
    releaseYear: 1968,
    rating: 7.8,
    genres: ['Horror', 'Thriller'],
    synopsis:
      'A ragtag group of Pennsylvanians barricade themselves in an old farmhouse to remain safe from a horde of flesh-eating ghouls.',
    certification: 'Not Rated',
  },
  {
    title: 'Charade',
    kind: 'movie',
    releaseYear: 1963,
    rating: 7.9,
    genres: ['Comedy', 'Mystery', 'Romance'],
    synopsis:
      'Romance and suspense ensue in Paris as a woman is pursued by several men who want a fortune her murdered husband had stolen.',
    certification: 'Not Rated',
  },
  {
    title: 'His Girl Friday',
    kind: 'movie',
    releaseYear: 1940,
    rating: 7.8,
    genres: ['Comedy', 'Drama', 'Romance'],
    synopsis:
      'A newspaper editor uses every trick in the book to keep his ace reporter ex-wife from remarrying.',
    certification: 'Passed',
  },
  {
    title: 'The General',
    kind: 'movie',
    releaseYear: 1926,
    rating: 8.1,
    genres: ['Action', 'Adventure', 'Comedy'],
    synopsis:
      'After being rejected by the Confederate military, Johnny realizes he must single-handedly recapture his beloved locomotive after it is seized by Union spies.',
    certification: 'Passed',
  },
  {
    title: 'M',
    kind: 'movie',
    releaseYear: 1931,
    rating: 8.3,
    genres: ['Crime', 'Mystery', 'Thriller'],
    synopsis:
      'When the police in a German city are unable to catch a child-murderer, other criminals join in the manhunt.',
    certification: 'Passed',
  },
  {
    title: 'The Cabinet of Dr. Caligari',
    kind: 'movie',
    releaseYear: 1920,
    rating: 8.0,
    genres: ['Horror', 'Mystery', 'Thriller'],
    synopsis:
      'Hypnotist Dr. Caligari uses a somnambulist to commit murders in a small German town.',
    certification: 'Not Rated',
  },
  {
    title: 'Solaris',
    kind: 'movie',
    releaseYear: 1972,
    rating: 8.0,
    genres: ['Drama', 'Mystery', 'Sci-Fi'],
    synopsis:
      'A psychologist is sent to a station orbiting a distant planet in order to discover what has caused the crew to go insane.',
    certification: 'PG',
  },
  {
    title: 'Stalker',
    kind: 'movie',
    releaseYear: 1979,
    rating: 8.1,
    genres: ['Drama', 'Sci-Fi'],
    synopsis:
      'A guide leads two men through an area known as the Zone to find a room that grants wishes.',
    certification: 'Not Rated',
  },
  {
    title: '2001: A Space Odyssey',
    kind: 'movie',
    releaseYear: 1968,
    rating: 8.3,
    genres: ['Adventure', 'Sci-Fi'],
    synopsis:
      'After uncovering a mysterious artifact buried beneath the Lunar surface, a spacecraft is sent to Jupiter to find its origins.',
    certification: 'G',
  },
  {
    title: 'Blade Runner',
    kind: 'movie',
    releaseYear: 1982,
    rating: 8.1,
    genres: ['Action', 'Drama', 'Sci-Fi'],
    synopsis:
      'A blade runner must pursue and terminate four replicants who stole a ship in space and have returned to Earth to find their creator.',
    certification: 'R',
  },
  {
    title: 'The Godfather',
    kind: 'movie',
    releaseYear: 1972,
    rating: 9.2,
    genres: ['Crime', 'Drama'],
    synopsis:
      'The aging patriarch of an organized crime dynasty transfers control of his clandestine empire to his reluctant youngest son.',
    certification: 'R',
  },
  {
    title: 'The Godfather Part II',
    kind: 'movie',
    releaseYear: 1974,
    rating: 9.0,
    genres: ['Crime', 'Drama'],
    synopsis:
      'The early life and career of Vito Corleone is portrayed while his son Michael expands and tightens his grip on the family crime syndicate.',
    certification: 'R',
  },
  {
    title: 'Citizen Kane',
    kind: 'movie',
    releaseYear: 1941,
    rating: 8.3,
    genres: ['Drama', 'Mystery'],
    synopsis:
      'Following the death of publishing tycoon Charles Foster Kane, reporters scramble to uncover the meaning of his final utterance: Rosebud.',
    certification: 'PG',
  },
  {
    title: 'Casablanca',
    kind: 'movie',
    releaseYear: 1942,
    rating: 8.5,
    genres: ['Drama', 'Romance', 'War'],
    synopsis:
      'A cynical expatriate American cafe owner struggles to decide whether or not to help his former lover and her fugitive husband escape the Nazis.',
    certification: 'PG',
  },
  {
    title: 'Seven Samurai',
    kind: 'movie',
    releaseYear: 1954,
    rating: 8.6,
    genres: ['Action', 'Drama'],
    synopsis:
      'Farmers from a village exploited by bandits hire a veteran samurai for protection, who gathers six other samurai to join him.',
    certification: 'Not Rated',
  },
  {
    title: '12 Angry Men',
    kind: 'movie',
    releaseYear: 1957,
    rating: 9.0,
    genres: ['Crime', 'Drama'],
    synopsis:
      'The jury in a New York City murder trial is frustrated by a single member whose skeptical caution forces them to more carefully consider the evidence.',
    certification: 'Approved',
  },
  {
    title: 'Rear Window',
    kind: 'movie',
    releaseYear: 1954,
    rating: 8.5,
    genres: ['Mystery', 'Thriller'],
    synopsis:
      'A wheelchair-bound photographer spies on his neighbors from his apartment window and becomes convinced one of them has committed murder.',
    certification: 'PG',
  },
  {
    title: 'Vertigo',
    kind: 'movie',
    releaseYear: 1958,
    rating: 8.3,
    genres: ['Mystery', 'Romance', 'Thriller'],
    synopsis:
      'A former San Francisco police detective juggles wrestling with his personal demons and becoming obsessed with the hauntingly beautiful woman he has been hired to trail.',
    certification: 'PG',
  },
  {
    title: 'Psycho',
    kind: 'movie',
    releaseYear: 1960,
    rating: 8.5,
    genres: ['Horror', 'Mystery', 'Thriller'],
    synopsis:
      'A Phoenix secretary embezzles forty thousand dollars from her employer, goes on the run, and checks into a remote motel run by a young man under the domination of his mother.',
    certification: 'R',
  },
  {
    title: 'The Third Man',
    kind: 'movie',
    releaseYear: 1949,
    rating: 8.1,
    genres: ['Film-Noir', 'Mystery', 'Thriller'],
    synopsis:
      'Pulp novelist Holly Martins travels to shadowy, postwar Vienna, only to find himself investigating the mysterious death of an old friend.',
    certification: 'Approved',
  },
  {
    title: 'Rashomon',
    kind: 'movie',
    releaseYear: 1950,
    rating: 8.2,
    genres: ['Crime', 'Drama', 'Mystery'],
    synopsis: 'The murder of a samurai is described in four contradictory ways by four witnesses.',
    certification: 'Not Rated',
  },
  {
    title: 'Bicycle Thieves',
    kind: 'movie',
    releaseYear: 1948,
    rating: 8.3,
    genres: ['Drama'],
    synopsis:
      'In post-war Italy, a working-class man searches through Rome with his young son for his stolen bicycle, upon which his livelihood depends.',
    certification: 'Not Rated',
  },
  {
    title: 'The Seventh Seal',
    kind: 'movie',
    releaseYear: 1957,
    rating: 8.1,
    genres: ['Drama', 'Fantasy'],
    synopsis:
      'A knight returning to Sweden after the Crusades seeks answers about life, death, and the existence of God as he plays chess against the Grim Reaper.',
    certification: 'Not Rated',
  },
  {
    title: 'Modern Times',
    kind: 'movie',
    releaseYear: 1936,
    rating: 8.5,
    genres: ['Comedy', 'Drama', 'Romance'],
    synopsis:
      'The Tramp struggles to live in modern industrial society with the help of a young homeless woman.',
    certification: 'G',
  },
  {
    title: 'City Lights',
    kind: 'movie',
    releaseYear: 1931,
    rating: 8.5,
    genres: ['Comedy', 'Drama', 'Romance'],
    synopsis:
      'With the aid of a wealthy erratic tippler, a dewy-eyed tramp who has fallen in love with a sightless flower girl accumulates money to help her medically.',
    certification: 'G',
  },
  {
    title: "It's a Wonderful Life",
    kind: 'movie',
    releaseYear: 1946,
    rating: 8.6,
    genres: ['Drama', 'Family', 'Fantasy'],
    synopsis:
      'An angel is sent from Heaven to help a desperately frustrated businessman by showing him what life would have been like if he had never existed.',
    certification: 'PG',
  },
  {
    title: 'House on Haunted Hill',
    kind: 'movie',
    releaseYear: 1959,
    rating: 6.8,
    genres: ['Horror', 'Mystery'],
    synopsis:
      'A millionaire offers ten thousand dollars to five people who agree to be locked in a large, spooky, rented house overnight with him and his wife.',
    certification: 'Not Rated',
  },
  {
    title: 'Carnival of Souls',
    kind: 'movie',
    releaseYear: 1962,
    rating: 7.1,
    genres: ['Horror', 'Mystery'],
    synopsis:
      'After a traumatic accident, a woman becomes drawn to a mysterious abandoned carnival pavilion.',
    certification: 'PG',
  },
  {
    title: 'Big Buck Bunny',
    kind: 'movie',
    releaseYear: 2008,
    rating: 6.4,
    genres: ['Animation', 'Comedy', 'Short'],
    synopsis: 'A giant gentle rabbit deals with three bullying rodents in a sunlit forest.',
    certification: 'G',
  },
  {
    title: 'Sintel',
    kind: 'movie',
    releaseYear: 2010,
    rating: 7.4,
    genres: ['Animation', 'Action', 'Fantasy'],
    synopsis:
      'A lonely young woman searches across harsh lands for a baby dragon she once rescued.',
    certification: 'PG',
  },
  {
    title: 'Tears of Steel',
    kind: 'movie',
    releaseYear: 2012,
    rating: 5.7,
    genres: ['Sci-Fi', 'Short'],
    synopsis:
      'In an apocalyptic Amsterdam, a group of warriors and scientists gather to stage a crucial event from the past.',
    certification: 'PG',
  },
  {
    title: 'The Twilight Zone',
    kind: 'series',
    releaseYear: 1959,
    rating: 9.0,
    genres: ['Drama', 'Fantasy', 'Sci-Fi'],
    synopsis:
      'Ordinary people find themselves in extraordinarily astounding situations, which they each try to solve in a remarkable manner.',
    certification: 'TV-PG',
  },
  {
    title: 'Planet Earth',
    kind: 'series',
    releaseYear: 2006,
    rating: 9.4,
    genres: ['Documentary'],
    synopsis:
      'A sweeping portrait of Earth wilderness habitats and the wildlife that inhabits them.',
    certification: 'TV-G',
  },
  {
    title: 'Cosmos',
    kind: 'series',
    releaseYear: 1980,
    rating: 9.3,
    genres: ['Documentary', 'History'],
    synopsis:
      'Astronomer Carl Sagan leads viewers on an engaging guided tour of the various elements and cosmological theories of the universe.',
    certification: 'TV-PG',
  },
  {
    title: 'Sherlock',
    kind: 'series',
    releaseYear: 2010,
    rating: 9.1,
    genres: ['Crime', 'Drama', 'Mystery'],
    synopsis:
      'The quirky spin on Arthur Conan Doyle iconic sleuth pitches him as a high-functioning sociopath in modern-day London.',
    certification: 'TV-14',
  },
];

const INDEX_BY_FOLD: ReadonlyMap<string, readonly LocalVodIndexEntry[]> = (() => {
  const map = new Map<string, LocalVodIndexEntry[]>();
  for (const entry of LOCAL_INDEX_ENTRIES) {
    const key = foldText(entry.title);
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }
  return map;
})();

/**
 * Looks up a normalized VOD/series query in the bundled key-free offline rating & metadata index.
 * Matches by folded title (and `kind`), preferring exact or `+/- 1` year alignment when a release
 * year is known.
 */
export function lookupLocalVodIndex(query: VodEnrichmentQuery): VodEnrichmentPayload | null {
  if (query.foldedTitle === '') return null;
  const candidates = INDEX_BY_FOLD.get(query.foldedTitle);
  if (candidates === undefined || candidates.length === 0) return null;

  const sameKind = candidates.filter((c) => c.kind === query.kind);
  const pool = sameKind.length > 0 ? sameKind : candidates;

  let match: LocalVodIndexEntry | undefined;
  const targetYear = query.releaseYear;
  if (targetYear !== null) {
    match =
      pool.find((c) => c.releaseYear === targetYear) ??
      pool.find((c) => Math.abs(c.releaseYear - targetYear) <= 1);
  } else {
    match = pool[0];
  }
  if (match === undefined) return null;

  return {
    rating: match.rating,
    ratingSource: 'local-index',
    releaseYear: match.releaseYear,
    genres: match.genres,
    synopsis: match.synopsis,
    certification: match.certification,
  };
}
