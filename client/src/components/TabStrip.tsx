import type { TabView } from "../lib/connection";

export function TabStrip({
  tabs,
  onSelect,
  onNew,
  onClose,
}: {
  tabs: TabView[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="tabstrip">
      {tabs.map((t) => (
        <div
          key={t.sessionId}
          className={"tab" + (t.active ? " active" : "") + (t.state === "exited" ? " exited" : "")}
          onPointerDown={(e) => {
            e.preventDefault();
            onSelect(t.sessionId);
          }}
        >
          <span className={"dot " + t.state} />
          <span className="tabtitle">{t.title}</span>
          {t.unread && !t.active && <span className="unread" />}
          <span
            className="tabclose"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose(t.sessionId);
            }}
          >
            ×
          </span>
        </div>
      ))}
      <button
        className="tabnew"
        onPointerDown={(e) => {
          e.preventDefault();
          onNew();
        }}
        title="new session"
      >
        ＋
      </button>
    </div>
  );
}
