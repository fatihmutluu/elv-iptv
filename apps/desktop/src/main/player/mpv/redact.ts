const URL_PATTERN = /https?:\/\/[^\s'"<>]+/g;
const XTREAM_PASSWORD = /\/(live|movie|series)\/([^/]+)\/[^/]+(?=\/)/;

/**
 * Removes secrets from any URL inside `text`: user-info, query and fragment are dropped and the
 * password segment of an Xtream path (`/live|movie|series/<user>/<password>/...`) becomes `***`.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (url) => {
    const withoutTail = url.replace(/[?#].*$/s, '');
    const withoutUser = withoutTail.replace(/^(https?:\/\/)[^/@]*@/, '$1');
    return withoutUser.replace(XTREAM_PASSWORD, '/$1/$2/***');
  });
}
