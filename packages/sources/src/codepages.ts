// Pure single-byte codepage tables and heuristic decoder for legacy Xtream EPG text (#329).

const ARABIC_TIMEZONES = new Set([
  'africa/algiers',
  'africa/cairo',
  'africa/casablanca',
  'africa/djibouti',
  'africa/juba',
  'africa/khartoum',
  'africa/mogadishu',
  'africa/nouakchott',
  'africa/tripoli',
  'africa/tunis',
  'asia/aden',
  'asia/amman',
  'asia/baghdad',
  'asia/bahrain',
  'asia/beirut',
  'asia/damascus',
  'asia/dubai',
  'asia/gaza',
  'asia/hebron',
  'asia/kabul',
  'asia/karachi',
  'asia/kuwait',
  'asia/muscat',
  'asia/qatar',
  'asia/riyadh',
  'asia/tehran',
  'indian/comoro',
]);

const TURKISH_TIMEZONES = new Set(['europe/istanbul', 'asia/istanbul', 'turkey']);

/** WHATWG Windows-1256 mapping for bytes 0x80–0xFF. */
const WIN1256_HIGH: readonly number[] = [
  0x20ac, 0x067e, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0679, 0x2039,
  0x0152, 0x0686, 0x0698, 0x0688, 0x06af, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x06a9, 0x2122, 0x0691, 0x203a, 0x0153, 0x200c, 0x200d, 0x06ba, 0x00a0, 0x060c, 0x00a2, 0x00a3,
  0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x06be, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x061b, 0x00bb,
  0x00bc, 0x00bd, 0x00be, 0x061f, 0x06c1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627,
  0x0628, 0x0629, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f, 0x0630, 0x0631, 0x0632, 0x0633,
  0x0634, 0x0635, 0x0636, 0x00d7, 0x0637, 0x0638, 0x0639, 0x063a, 0x0640, 0x0641, 0x0642, 0x0643,
  0x00e0, 0x0644, 0x00e2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb,
  0x0649, 0x064a, 0x00ee, 0x00ef, 0x064b, 0x064c, 0x064d, 0x064e, 0x00f4, 0x064f, 0x0650, 0x00f7,
  0x0651, 0x00f9, 0x0652, 0x00fb, 0x00fc, 0x200e, 0x200f, 0x06d2,
];

/** WHATWG ISO-8859-6 mapping for bytes 0x80–0xFF (C1 controls and undefined positions map to U+FFFD). */
const ISO8859_6_HIGH: readonly number[] = [
  0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd,
  0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd,
  0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0x00a0, 0xfffd, 0xfffd, 0xfffd,
  0x00a4, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0x060c, 0x00ad, 0xfffd, 0xfffd,
  0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0x061b,
  0xfffd, 0xfffd, 0xfffd, 0x061f, 0xfffd, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627,
  0x0628, 0x0629, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f, 0x0630, 0x0631, 0x0632, 0x0633,
  0x0634, 0x0635, 0x0636, 0x0637, 0x0638, 0x0639, 0x063a, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd,
  0x0640, 0x0641, 0x0642, 0x0643, 0x0644, 0x0645, 0x0646, 0x0647, 0x0648, 0x0649, 0x064a, 0x064b,
  0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651, 0x0652, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd,
  0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd,
];

/** WHATWG Windows-1252 C1 block (0x80–0x9F); unmapped positions are U+FFFD. */
const WIN1252_C1: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

const WIN1252_HIGH: readonly number[] = Array.from({ length: 128 }, (_, i) =>
  i < 32 ? (WIN1252_C1[i] as number) : 0x80 + i,
);

const WIN1254_OVERRIDES = new Map<number, number>([
  [0x8e, 0xfffd],
  [0x9e, 0xfffd],
  [0xd0, 0x011e],
  [0xdd, 0x0130],
  [0xde, 0x015e],
  [0xf0, 0x011f],
  [0xfd, 0x0131],
  [0xfe, 0x015f],
]);

const WIN1254_HIGH: readonly number[] = WIN1252_HIGH.map(
  (cp, i) => WIN1254_OVERRIDES.get(0x80 + i) ?? cp,
);

/** WHATWG Windows-1251 mapping for bytes 0x80–0xFF (0x98 is unmapped and maps to U+FFFD). */
const WIN1251_HIGH: readonly number[] = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039,
  0x040a, 0x040c, 0x040b, 0x040f, 0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0xfffd, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408,
  0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb,
  0x0458, 0x0405, 0x0455, 0x0457, 0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417,
  0x0418, 0x0419, 0x041a, 0x041b, 0x041c, 0x041d, 0x041e, 0x041f, 0x0420, 0x0421, 0x0422, 0x0423,
  0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429, 0x042a, 0x042b, 0x042c, 0x042d, 0x042e, 0x042f,
  0x0430, 0x0431, 0x0432, 0x0433, 0x0434, 0x0435, 0x0436, 0x0437, 0x0438, 0x0439, 0x043a, 0x043b,
  0x043c, 0x043d, 0x043e, 0x043f, 0x0440, 0x0441, 0x0442, 0x0443, 0x0444, 0x0445, 0x0446, 0x0447,
  0x0448, 0x0449, 0x044a, 0x044b, 0x044c, 0x044d, 0x044e, 0x044f,
];

/** Single-byte legacy codepages supported by XMLTV prolog decoding (`#429`). */
export type SingleByteCodepage =
  | 'windows-1252'
  | 'windows-1254'
  | 'windows-1251'
  | 'windows-1256'
  | 'iso-8859-6';

/** Resolved XMLTV character encoding (`utf-8` or a supported single-byte codepage). */
export type XmlEncoding = 'utf-8' | SingleByteCodepage;

const CODEPAGE_TABLES: Readonly<Record<SingleByteCodepage, readonly number[]>> = {
  'windows-1252': WIN1252_HIGH,
  'windows-1254': WIN1254_HIGH,
  'windows-1251': WIN1251_HIGH,
  'windows-1256': WIN1256_HIGH,
  'iso-8859-6': ISO8859_6_HIGH,
};

/**
 * Decodes `bytes[start, end)` using a WHATWG single-byte codepage table. Non-throwing: unmapped
 * byte positions decode to `U+FFFD`.
 */
export function decodeCodepageSlice(
  bytes: Uint8Array,
  start: number,
  end: number,
  codepage: SingleByteCodepage,
): string {
  const high = CODEPAGE_TABLES[codepage];
  const limit = Math.min(end, bytes.length);
  const units: number[] = [];
  let out = '';
  for (let i = Math.max(start, 0); i < limit; i++) {
    const b = bytes[i] as number;
    units.push(b < 0x80 ? b : (high[b - 0x80] ?? 0xfffd));
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

function decodeWithTable(bytes: Uint8Array, high: readonly number[]): string | undefined {
  const units: number[] = [];
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    const cp = b < 0x80 ? b : (high[b - 0x80] as number);
    if (cp === 0xfffd) return undefined;
    units.push(cp);
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

function isArabicLetter(cp: number): boolean {
  return (
    (cp >= 0x0621 && cp <= 0x063a) ||
    (cp >= 0x0641 && cp <= 0x064a) ||
    (cp >= 0x0679 && cp <= 0x06d2)
  );
}

function isArabicMark(cp: number): boolean {
  return (cp >= 0x064b && cp <= 0x0652) || (cp >= 0x200c && cp <= 0x200f);
}

function isLatinNonAsciiLetter(cp: number): boolean {
  return (cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7) || (cp >= 0x0100 && cp <= 0x017f);
}

const NORMAL_PUNCT = new Set([
  0x21, 0x22, 0x26, 0x27, 0x28, 0x29, 0x2c, 0x2d, 0x2e, 0x2f, 0x3a, 0x3b, 0x3f, 0xa1, 0xa3, 0xab,
  0xb0, 0xb7, 0xbb, 0xbf, 0x060c, 0x061b, 0x061f, 0x0640, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2026, 0x20ac,
]);

function isPlausibleText(decoded: string, isArabic: boolean): boolean {
  let nonWs = 0;
  let asciiLetters = 0;
  let nonAsciiLetters = 0;
  let digits = 0;
  let weird = 0;
  let hasSpace = false;

  for (let i = 0; i < decoded.length; i++) {
    const cp = decoded.charCodeAt(i);
    if (cp <= 0x20 || cp === 0xa0) {
      if (cp === 0x20) hasSpace = true;
      continue;
    }
    nonWs++;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      asciiLetters++;
    } else if (isArabicLetter(cp) || isLatinNonAsciiLetter(cp)) {
      nonAsciiLetters++;
    } else if (cp >= 0x30 && cp <= 0x39) {
      digits++;
    } else if (!NORMAL_PUNCT.has(cp) && !isArabicMark(cp)) {
      weird++;
    }
  }

  const letters = asciiLetters + nonAsciiLetters;
  if (nonWs === 0 || letters === 0) return false;
  if (isArabic) {
    if (nonWs >= 2 && letters < 2 && letters < nonWs) return false;
    if (weird > 0 && weird * 4 >= nonWs) return false;
    if (nonWs >= 4 && (letters + digits) / nonWs < 0.65) return false;
    return true;
  }
  if (nonWs <= 3 && letters < nonWs) return false;
  if (weird > 0 && ((!hasSpace && nonWs <= 12) || weird * 5 >= nonWs)) return false;
  if (nonWs >= 4 && (letters + digits) / nonWs < 0.7) return false;
  if (!hasSpace && nonWs >= 4 && nonAsciiLetters > asciiLetters && letters < nonWs) return false;
  if (!hasSpace && letters < nonWs && letters / nonWs < 0.7) return false;
  return true;
}

function scoreArabic(decoded: string): number {
  let score = 0;
  let arabicCount = 0;
  let latinAccented = 0;
  for (let i = 0; i < decoded.length; i++) {
    const cp = decoded.charCodeAt(i);
    if (isArabicLetter(cp)) {
      arabicCount++;
      score += 3;
      if (i + 1 < decoded.length) {
        const next = decoded.charCodeAt(i + 1);
        if ((cp === 0x0627 && next === 0x0644) || (cp === 0x0644 && next === 0x0627)) {
          score += 4;
        }
      }
    } else if (cp === 0x060c || cp === 0x061b || cp === 0x061f || cp === 0x0640) {
      score += 1;
    } else if (cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7) {
      latinAccented++;
    }
  }
  if (arabicCount > 0 && latinAccented > 0) {
    score -= latinAccented * 4;
  }
  return score;
}

function isArabicCandidateByte(b: number): boolean {
  if (b >= 0xc1 && b <= 0xf2) return true;
  return b === 0x81 || b === 0x8d || b === 0x8e || b === 0x90 || b === 0x98 || b === 0xc0;
}

function isTurkishSpecificByte(b: number): boolean {
  return b === 0xd0 || b === 0xdd || b === 0xde || b === 0xf0 || b === 0xfd || b === 0xfe;
}

/**
 * Decodes invalid-UTF-8 single-byte EPG text using `windows-1256`, `iso-8859-6`, `windows-1254`,
 * or `windows-1252` selected via byte-range distribution and optional IANA `timezoneHint`.
 * Returns `undefined` when control bytes, UTF-16 BOM markers, unmapped bytes, or non-text noise appear.
 */
export function decodeLegacyCodepage(bytes: Uint8Array, timezoneHint?: string): string | undefined {
  if (bytes.length === 0) return undefined;
  if (
    bytes.length === 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    return undefined;
  }

  let asciiLetters = 0;
  let arabicBytes = 0;
  let currentArabicRun = 0;
  let maxArabicRun = 0;
  let turkishSpecific = 0;

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
      return undefined;
    }
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
      asciiLetters++;
      currentArabicRun = 0;
      continue;
    }
    if (isArabicCandidateByte(b)) {
      arabicBytes++;
      currentArabicRun++;
      if (currentArabicRun > maxArabicRun) maxArabicRun = currentArabicRun;
    } else {
      currentArabicRun = 0;
    }
    if (isTurkishSpecificByte(b)) turkishSpecific++;
  }

  const tz = timezoneHint?.trim().toLowerCase() ?? '';
  const tzArabic = tz.length > 0 && ARABIC_TIMEZONES.has(tz);
  const tzTurkish = tz.length > 0 && TURKISH_TIMEZONES.has(tz);

  const looksArabic =
    maxArabicRun >= 3 ||
    (maxArabicRun >= 2 && (asciiLetters === 0 || tzArabic)) ||
    (tzArabic && arabicBytes > 0 && arabicBytes >= asciiLetters);

  if (looksArabic) {
    const win = decodeWithTable(bytes, WIN1256_HIGH);
    const iso = decodeWithTable(bytes, ISO8859_6_HIGH);
    let chosen: string | undefined;
    if (win !== undefined && iso !== undefined) {
      chosen = scoreArabic(iso) > scoreArabic(win) ? iso : win;
    } else {
      chosen = win ?? iso;
    }
    if (chosen !== undefined && isPlausibleText(chosen, true)) return chosen;
    return undefined;
  }

  const order = tzTurkish || turkishSpecific > 0 ? [WIN1254_HIGH, WIN1252_HIGH] : [WIN1252_HIGH];
  for (const table of order) {
    const decoded = decodeWithTable(bytes, table);
    if (decoded !== undefined && isPlausibleText(decoded, false)) return decoded;
  }
  return undefined;
}
