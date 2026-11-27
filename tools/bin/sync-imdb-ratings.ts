import { runSyncImdbRatingsCli } from '../src/imdb-ratings-sync.ts';

const exitCode = await runSyncImdbRatingsCli(process.argv.slice(2));
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
