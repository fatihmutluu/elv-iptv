/** Platform port for opening external trailer URLs such as YouTube deep links on TV (`#512`). */
export interface TrailerExternalPort {
  /** Opens an external trailer URL via the host platform. Resolves `true` if handed off cleanly. */
  openExternalUrl(url: string): Promise<boolean>;
}
