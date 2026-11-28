import type { AddSourceInput, LinkSourceInput, LocalM3uSourceInput } from '@elv/data';
import { elvError, err, ok, type Result } from '@elv/domain';
import { hasControlChar } from '../shared/catalog-ipc-guards.ts';
import { sanitizeStalkerSourceInput } from './catalog-worker-wave-f5b-ops.ts';

const NON_HOST_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\/\/)(?!\d+(?:[/?#]|$))/;

/** Strips ASCII control characters from user-provided display text before persisting. */
export function sanitizeDisplayText(text: string): string {
  if (!hasControlChar(text)) return text;
  let out = '';
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += text[i];
      lastSpace = code === 0x20;
    }
  }
  return out.trim();
}

function isHttpUrl(raw: string): boolean {
  if (raw === '' || hasControlChar(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isValidXtreamServer(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '' || hasControlChar(trimmed)) return false;
  if (!trimmed.startsWith('[') && NON_HOST_SCHEME_RE.test(trimmed)) return false;
  const normalized = (trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|panel_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
  return isHttpUrl(normalized);
}

function sanitizeGuideUrl(guideUrl: string | undefined): Result<string | undefined> {
  if (guideUrl === undefined) return ok(undefined);
  const trimmed = guideUrl.trim();
  if (trimmed === '') return ok(undefined);
  if (!isHttpUrl(trimmed)) return err(elvError('source-format', 'invalid-source'));
  return ok(trimmed);
}

/** Validates and normalizes an `addSource` payload inside the catalog utility process. */
export function sanitizeAddSourceInput(input: AddSourceInput): Result<AddSourceInput> {
  const guide = sanitizeGuideUrl(input.guideUrl);
  if (!guide.ok) return guide;
  if (input.kind === 'm3u') {
    const playlistUrl = input.playlistUrl.trim();
    if (!isHttpUrl(playlistUrl)) return err(elvError('source-format', 'invalid-source'));
    const { guideUrl: _prevGuide, ...rest } = input;
    return ok({
      ...rest,
      playlistUrl,
      ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
    });
  }
  if (input.kind === 'stalker') return sanitizeStalkerSourceInput(input, guide.value);
  const server = input.server.trim();
  if (!isValidXtreamServer(server)) return err(elvError('source-format', 'invalid-source'));
  let backupServers: string[] | undefined;
  if (input.backupServers !== undefined) {
    backupServers = [];
    for (const rawBackup of input.backupServers) {
      const trimmedBackup = rawBackup.trim();
      if (!isValidXtreamServer(trimmedBackup)) {
        return err(elvError('source-format', 'invalid-source'));
      }
      backupServers.push(trimmedBackup);
    }
  }
  const { guideUrl: _prevGuide, backupServers: _prevBackups, ...rest } = input;
  return ok({
    ...rest,
    server,
    ...(backupServers === undefined ? {} : { backupServers }),
    ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
  });
}

/** Validates and normalizes an `addSourceFromLink` payload inside the catalog utility process. */
export function sanitizeLinkSourceInput(input: LinkSourceInput): Result<LinkSourceInput> {
  const url = input.url.trim();
  if (!isHttpUrl(url)) return err(elvError('source-format', 'invalid-source'));
  const guide = sanitizeGuideUrl(input.guideUrl);
  if (!guide.ok) return guide;
  const { guideUrl: _prevGuide, ...rest } = input;
  return ok({
    ...rest,
    url,
    ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
  });
}

/** Validates and normalizes an `addLocalM3uSource` payload inside the catalog utility process. */
export function sanitizeLocalM3uInput(input: LocalM3uSourceInput): Result<LocalM3uSourceInput> {
  const guide = sanitizeGuideUrl(input.guideUrl);
  if (!guide.ok) return guide;
  const { guideUrl: _prevGuide, ...rest } = input;
  return ok({
    ...rest,
    ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
  });
}
