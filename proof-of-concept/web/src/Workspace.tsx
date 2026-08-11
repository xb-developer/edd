import { useState } from "react";
import type { Matter } from "./types";
import { MatterList } from "./components/MatterList";
import { DocumentRegister } from "./components/DocumentRegister";

export function Workspace() {
  const [matter, setMatter] = useState<Matter | null>(null);

  if (!matter) {
    return <MatterList onOpen={setMatter} />;
  }

  return <DocumentRegister matter={matter} onSwitchMatter={() => setMatter(null)} />;
}
