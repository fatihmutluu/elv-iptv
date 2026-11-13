import type { SecretStore } from '@elv/domain';
import { placeholderNames } from './m3u-templating';
import { secretKey } from './sources';
import { resolveTemplate, type UrlVars } from './templates';

/** Reads the `urlvars` secret of a source; a missing or unreadable value yields an empty object. */
export async function readUrlVars(
  deps: { secrets: SecretStore },
  sourceId: string,
): Promise<UrlVars> {
  const raw = await deps.secrets.get(secretKey(sourceId, 'urlvars')).catch(() => undefined);
  try {
    const parsed: unknown = raw === undefined ? {} : JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as UrlVars) : {};
  } catch {
    return {};
  }
}

/** Rebuilds the stored templates of one source in memory. */
export interface StreamResolver {
  /**
   * The URL behind a stored template (an M3U entry URL, logo or referer, a guide placeholder); `undefined` when a
   * placeholder has no value, so a half-resolved URL never reaches a player. Never log or store the result.
   */
  resolve(template: string): string | undefined;
}

/**
 * Reads the `urlvars` secret of a source once and returns a resolver over it, so a screen of logos or a channel
 * switch does not hit the platform secret store per item. Create a new one after an import (values may change).
 */
export async function createStreamResolver(
  sourceId: string,
  deps: { secrets: SecretStore },
): Promise<StreamResolver> {
  const vars = await readUrlVars(deps, sourceId);
  return {
    resolve(template) {
      const missing = placeholderNames(template).some(
        (name) => name !== '(' && !Object.hasOwn(vars, name),
      );
      return missing ? undefined : resolveTemplate(template, vars);
    },
  };
}
