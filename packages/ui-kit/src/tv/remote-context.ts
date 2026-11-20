import type { KeyInput } from '@elv/focus-core';
import { createContext } from 'react';

/** Minimal shape of a text-entry controller observed by {@link TvRemoteDispatcher}. */
export interface TextEntryActiveSource {
  isActive(): boolean;
  exit?(): boolean;
}

/** Event broadcast by {@link TvRemoteDispatcher} to every active subscriber. */
export interface TvRemoteEvent {
  readonly input: KeyInput;
  readonly requirePriorDown: boolean;
}

/** Centralized fan-out dispatcher decoupling root platform key listeners from `useTvKeySource` consumers (#277). */
export interface TvRemoteDispatcher {
  /** Subscribes to broadcasted remote key events; returns an idempotent unsubscribe function. */
  subscribe(listener: (event: TvRemoteEvent) => void): () => void;
  /** Broadcasts a remote key input to all active subscribers, isolating any thrown subscriber errors. */
  dispatch(input: KeyInput, requirePriorDown: boolean): void;
  /** Registers a text-entry source so root web listeners see active child text-entry boundaries. */
  registerTextEntry(controller: TextEntryActiveSource): () => void;
  /** Reports whether any registered text-entry source is currently active. */
  isTextEntryActive(): boolean;
  /** Returns the number of currently attached subscribers. */
  subscriberCount(): number;
}

/** Context holding the shared {@link TvRemoteDispatcher}, or `null` when no `TvRemoteProvider` is mounted. */
export const TvRemoteContext = createContext<TvRemoteDispatcher | null>(null);

const consumedTextEntryEvents = new WeakSet<TvRemoteEvent>();

/** Marks a broadcasted {@link TvRemoteEvent} as consumed by exiting text entry so sibling listeners do not also pop screens. */
export function markEventTextEntryConsumed(event: TvRemoteEvent): void {
  consumedTextEntryEvents.add(event);
}

/** Reports whether an earlier subscriber already consumed `event` by exiting an active text-entry session. */
export function isEventTextEntryConsumed(event: TvRemoteEvent): boolean {
  return consumedTextEntryEvents.has(event);
}
