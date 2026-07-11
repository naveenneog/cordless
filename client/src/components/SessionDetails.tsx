interface Detail {
  sessionId: string;
  title: string;
  cwd: string;
  profile: string;
  state: string;
  exitCode: number | null;
  host: string;
}

export function SessionDetails({
  detail,
  onClose,
  onKill,
}: {
  detail: Detail;
  onClose: () => void;
  onKill: () => void;
}) {
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
        {row("Title", detail.title, true)}
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
