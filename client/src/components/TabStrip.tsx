import type { TabView } from "../lib/connection";
import type { SessionGroup } from "../lib/protocol";
import { groupColor } from "../lib/groupColor";
import { AgentIcon } from "./AgentIcon";

// Chrome-mobile-style group/filter chips + the tab strip. The chips filter which tabs are shown:
// All, Unread (the phone's attention proxy), then one chip per group.
export function TabStrip({
  tabs,
  groups,
  filter,
  onFilter,
  onSelect,
  onNew,
  onClose,
}: {
  tabs: TabView[];
  groups: SessionGroup[];
  filter: string;
  onFilter: (f: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}) {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const unreadCount = tabs.filter((t) => t.unread && !t.active).length;

  const shown = tabs.filter((t) => {
    if (filter === "all") return true;
    if (filter === "unread") return t.unread || t.active;
    return t.groupId === filter; // a group id
  });

  const chip = (id: string, label: string, count?: number, color?: string) => (
    <button
      key={id}
      className={"fchip" + (filter === id ? " on" : "")}
      style={color ? ({ ["--chip"]: color } as any) : undefined}
      onPointerDown={(e) => {
        e.preventDefault();
        onFilter(id);
      }}
    >
      {color && <span className="fchip-dot" />}
      {label}
      {count ? <span className="fchip-count">{count}</span> : null}
    </button>
  );

  return (
    <div className="tabsWrap">
      {(groups.length > 0 || unreadCount > 0) && (
        <div className="filterbar">
          {chip("all", "All")}
          {chip("unread", "Unread", unreadCount)}
          {groups.map((g) => chip(g.id, g.name, tabs.filter((t) => t.groupId === g.id).length, groupColor(g.color)))}
        </div>
      )}
      <div className="tabstrip">
        {shown.map((t) => {
          const g = t.groupId ? groupById.get(t.groupId) : null;
          return (
            <div
              key={t.sessionId}
              className={"tab" + (t.active ? " active" : "") + (t.state === "exited" ? " exited" : "")}
              onPointerDown={(e) => {
                e.preventDefault();
                onSelect(t.sessionId);
              }}
            >
              {g && <span className="groupdot" style={{ background: groupColor(g.color) }} title={g.name} />}
              <AgentIcon profile={t.profile} size={16} />
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
          );
        })}
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
    </div>
  );
}
