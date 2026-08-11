import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AssembleWorkspace } from "@xbundle/assemble-ui";
import "@xbundle/assemble-ui/src/styles.css";

function pickFiles(): Promise<string[] | null> {
  return window.assemble!.pickFiles();
}

function pickBundleFile(): Promise<string | null> {
  return window.assemble!.pickBundleFile();
}

function pickFolder(): Promise<string | null> {
  return window.assemble!.pickFolder();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AssembleWorkspace
      onPickFiles={window.assemble ? pickFiles : undefined}
      onPickBundleFile={window.assemble ? pickBundleFile : undefined}
      onPickFolder={window.assemble ? pickFolder : undefined}
    />
  </StrictMode>,
);
