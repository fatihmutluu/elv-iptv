import { store } from '../ports/storage';
import { format } from '../shared/format';
import type { Id } from '../types';
export const h: Id = format(store);
