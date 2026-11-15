import type { ProfileName } from './catalog.ts';

/** How the simulator answers a connection beyond the account limit. */
type LimitPolicy = 'status-509' | 'status-403' | 'text-notice';

/** A synthetic account defined in code; no real credentials exist here. */
export interface Account {
  username: string;
  password: string;
  profile: ProfileName;
  maxConnections: number;
  status: 'Active' | 'Expired';
  quirks: boolean;
  limitPolicy: LimitPolicy;
}

/** Every account the simulator knows. */
export const ACCOUNTS: readonly Account[] = [
  {
    username: 'demo',
    password: 'demo',
    profile: 'small',
    maxConnections: 1,
    status: 'Active',
    quirks: false,
    limitPolicy: 'status-509',
  },
  {
    username: 'large',
    password: 'large',
    profile: 'large',
    maxConnections: 2,
    status: 'Active',
    quirks: false,
    limitPolicy: 'status-403',
  },
  {
    username: 'compat',
    password: 'compat',
    profile: 'compat',
    maxConnections: 1,
    status: 'Active',
    quirks: false,
    limitPolicy: 'text-notice',
  },
  {
    username: 'huge',
    password: 'huge',
    profile: 'huge',
    maxConnections: 2,
    status: 'Active',
    quirks: false,
    limitPolicy: 'status-509',
  },
  {
    username: 'corpus',
    password: 'corpus',
    profile: 'corpus',
    maxConnections: 1,
    status: 'Active',
    quirks: false,
    limitPolicy: 'status-509',
  },
  {
    username: 'expired',
    password: 'expired',
    profile: 'small',
    maxConnections: 1,
    status: 'Expired',
    quirks: false,
    limitPolicy: 'status-509',
  },
  {
    username: 'quirks',
    password: 'quirks',
    profile: 'small',
    maxConnections: 1,
    status: 'Active',
    quirks: true,
    limitPolicy: 'status-509',
  },
];

/** Looks up an account by exact credentials; `undefined` for missing or wrong ones. */
export function findAccount(username: string | null, password: string | null): Account | undefined {
  if (username === null || password === null) return undefined;
  return ACCOUNTS.find((a) => a.username === username && a.password === password);
}
