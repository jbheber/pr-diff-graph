import type { Core } from 'cytoscape';

declare global {
  interface Window {
    /** Set by tests before the client starts: Cytoscape runs headless. */
    __PDG_TEST__?: boolean;
    /** For tests and debugging from the devtools console. */
    __prDiffGraph?: { cy: Core; openNode(path: string): boolean };
  }
}
