import { useState } from "react";
import { PROFILES } from "../lib/protocol";

export function NewSessionSheet({
  onCreate,
  onClose,
}: {
  onCreate: (profile: string, opts: { cwd?: string; title?: string }) => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");

  return (
    <div className="sheet-backdrop" onPointerDown={onClose}>
      <div className="sheet" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>New session</h3>
        <div className="profiles">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              className="profile"
              onClick={() => onCreate(p.id, { cwd: cwd.trim() || undefined, title: title.trim() || undefined })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label>Working directory (optional)</label>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <label>Title (optional)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="frontend"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
