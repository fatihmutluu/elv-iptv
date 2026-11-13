import type { ExpoConfig } from 'expo/config';
import { buildAppConfig } from './config/build-app-config.ts';
import { version } from './package.json';

export default (): ExpoConfig => buildAppConfig(process.env, { version, now: new Date() });
