/** The player area in CSS pixels of the app window's content, and whether video should show there. */
export interface PlayerArea {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** How mpv's picture reaches the screen: a child window kept on the player area, or mpv's own window. */
export type PresenterKind = 'child-window' | 'own-window';
