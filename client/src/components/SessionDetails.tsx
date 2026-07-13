import { useState } from "react";
import type { SessionGroup } from "../lib/protocol";
import { groupColor } from "../lib/groupColor";

interface Detail {
  sessionId: string;
  title: string;
  cwd: string;
  profile: string;
  groupId: string | null;
  state: string;
  exitCode: number | null;
  host: string;
}

export function SessionDetails({
  detail,
  groups,
  onClose,
  onKill,
  onRename,
  onAssign,
  onCreateGroup,
}: {
  detail: Detail;
  groups: SessionGroup[];
  onClose: () => void;
  onKill: () => void;
  onRename: (title: string) => void;
  onAssign: (groupId: string | null) => void;
  onCreateGroup: (name: string) => void;
}) {
  const [title, setTitle] = useState(detail.title);
  const copy = (s: string) => {
    navigator.clipboard?.writeText(s).catch(() => {});
  };
  const row = (label: string, value: string, wrap = false) => (
    <div className="detail">
      <span className="detail-k">{label}</span>
      <code className={"detail-v" + (wrap ? " wrap" : "")} onClick={() => copy(value)}>
        {value || "—"}
      </code>
    </div>
  );

  return (
    <div className="sheet-backdrop" onPointerDown={onClose}>
      <div className="sheet" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>Session details</h3>

        <div className="detail">
          <span className="detail-k">Title</span>
          <div className="rename-row">
            <input
              className="rename-input"
              value={title}
              placeholder="tab name"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRename(title.trim());
              }}
            />
            <button className="mini-btn" onClick={() => onRename(title.trim())}>
              Save
            </button>
          </div>
        </div>

        <div className="detail">
          <span className="detail-k">Group</span>
          <div className="group-picker">
            <button className={"chip" + (!detail.groupId ? " on" : "")} onClick={() => onAssign(null)}>
              None
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                className={"chip" + (detail.groupId === g.id ? " on" : "")}
                style={{ ["--chip"]: groupColor(g.color) } as any}
                onClick={() => onAssign(g.id)}
              >
                {g.name}
              </button>
            ))}
            <button
              className="chip new"
              onClick={() => {
                const name = window.prompt("New group name");
                if (name && name.trim()) onCreateGroup(name.trim());
              }}
            >
              + New
            </button>
          </div>
        </div>

        {row("Profile", detail.profile)}
        {row("Working dir", detail.cwd, true)}
        {row("Host", detail.host, true)}
        {row("State", detail.state + (detail.exitCode != null ? ` (exit ${detail.exitCode})` : ""))}
        {row("Session ID", detail.sessionId, true)}
        <p className="hint">Tap any value to copy it.</p>
        <div className="detail-actions">
          <button className="danger-btn" onClick={onKill}>
            Kill session
          </button>
          <button className="cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
