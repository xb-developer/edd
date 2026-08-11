import { useEffect, useState } from "react";
import { api } from "./api";
import type { MatterInfo } from "./types";
import { MatterPicker } from "./components/MatterPicker";
import Register from "./Register";

export default function App() {
  const [activeMatter, setActiveMatter] = useState<MatterInfo | null | undefined>(undefined);

  useEffect(() => {
    api
      .listMatters()
      .then(({ active }) => setActiveMatter(active))
      .catch(() => setActiveMatter(null));
  }, []);

  if (activeMatter === undefined) {
    return (
      <div className="matter-screen">
        <div className="empty-note">Loading…</div>
      </div>
    );
  }

  if (!activeMatter) {
    return <MatterPicker onOpened={setActiveMatter} />;
  }

  return <Register key={activeMatter.id} matterName={activeMatter.name} onSwitchMatter={() => setActiveMatter(null)} />;
}
