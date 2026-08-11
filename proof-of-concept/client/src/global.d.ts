export {};

declare global {
  interface Window {
    edd: {
      pickFiles: () => Promise<string[]>;
      getPathForFile: (file: File) => string;
      openViewer: () => Promise<void>;
      closeViewer: () => Promise<void>;
      isViewerOpen: () => Promise<boolean>;
      selectInViewer: (guid: string | null) => void;
      onViewerStateChange: (cb: (open: boolean) => void) => () => void;
      onViewerSelection: (cb: (guid: string | null) => void) => () => void;
    };
  }
}
