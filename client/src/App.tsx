import { useEffect, useReducer, useState } from "react";
import { Connection } from "./lib/connection";
import { Creds, loadCreds, clearCreds } from "./lib/storage";
import { installDeepLinkHandler, parsePairPayload } from "./lib/scan";
import { Pairing } from "./components/Pairing";
import { TabStrip } from "./components/TabStrip";
import { TerminalPane } from "./components/TerminalPane";
import { KeyBar } from "./components/KeyBar";
import { NewSessionSheet } from "./components/NewSessionSheet";
import { SessionDetails } from "./components/SessionDetails";

export function App() {
  const [creds, setCreds] = useState<Creds | null>(loadCreds());
  const [prefill, setPrefill] = useState<{ server: string; secret: string } | null>(null);

  useEffect(() => {
    let dispose = () => {};
    void installDeepLinkHandler((url) => {
      try {
        const { serverBase, secret } = parsePairPayload(url);
        if (!loadCreds()) setPrefill({ server: serverBase, secret });
      } catch {
        /* not a pairing link */
      }
    }).then((d) => {
      dispose = d;
    });
    return () => dispose();
  }, []);

  if (!creds) return <Pairing onPaired={setCreds} prefill={prefill} />;
  return (
    <Workspace
      creds={creds}
      onLogout={() => {
        clearCreds();
        setCreds(null);
      }}
    />
  );
}

function Workspace({ creds, onLogout }: { creds: Creds; onLogout: () => void }) {
  const [conn] = useState(() => new Connection(creds));
  const [, force] = useReducer((x) => x + 1, 0);
  const [sheet, setSheet] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    conn.start();
    const un = conn.subscribe(force);
    return () => {
      un();
      conn.destroy();
    };
  }, [conn]);

  const tabs = conn.getTabsView();
  const groups = conn.getGroups();

  useEffect(() => {
    if (conn.state === "ready" && tabs.length === 0) setSheet(true);
  }, [conn.state, tabs.length]);

  const stateLabel =
    conn.state === "ready"
      ? "connected"
      : conn.state === "connecting"
        ? "connecting…"
        : conn.state === "authenticating"
          ? "authenticating…"
          : "reconnecting…";

  return (
    <div className="app">
      <header className="topbar">
        <span className={"status " + conn.state} title={conn.lastError}>
          <span className="statusdot" />
          {stateLabel}
        </span>
        <div className="spacer" />
        <button className="iconbtn" onClick={() => conn.adjustFont(-1)} title="smaller text">
          A−
        </button>
        <button className="iconbtn" onClick={() => conn.adjustFont(1)} title="larger text">
          A+
        </button>
        <button
          className="iconbtn"
          disabled={!conn.activeId}
          onClick={() => {
            if (conn.activeId) setDetailsFor(conn.activeId);
          }}
          title="session details"
        >
          ⓘ
        </button>
        <button className="iconbtn" onClick={() => conn.refreshList()} title="refresh">
          ⟳
        </button>
        <button
          className="iconbtn"
          onClick={() => {
            if (confirm("Unpair this device? You'll need to pair again.")) onLogout();
          }}
          title="unpair"
        >
          ⏻
        </button>
      </header>

      <TabStrip
        tabs={tabs}
        groups={groups}
        filter={filter}
        onFilter={setFilter}
        onSelect={(id) => conn.setActive(id)}
        onNew={() => setSheet(true)}
        onClose={(id) => conn.closeTab(id)}
      />

      <div className="terminalStack">
        {tabs.map((t) => (
          <TerminalPane key={t.sessionId} conn={conn} sessionId={t.sessionId} active={t.active} />
        ))}
        {tabs.length === 0 && (
          <div className="empty">
            <div className="emptylogo">cordless</div>
            {conn.state === "ready" ? "No sessions yet — tap ＋ to start one." : stateLabel}
          </div>
        )}
      </div>

      <KeyBar conn={conn} ctrl={conn.ctrlLatch} alt={conn.altLatch} />

      {sheet && (
        <NewSessionSheet
          onClose={() => setSheet(false)}
          onCreate={async (profile, opts) => {
            setSheet(false);
            try {
              await conn.createSession(profile, opts);
            } catch (e) {
              console.error(e);
              alert("Failed to create session: " + (e as Error).message);
            }
          }}
        />
      )}

      {detailsFor &&
        conn.getSessionDetail(detailsFor) &&
        (() => {
          const d = conn.getSessionDetail(detailsFor)!;
          return (
            <SessionDetails
              detail={d}
              groups={groups}
              onClose={() => setDetailsFor(null)}
              onKill={() => {
                if (confirm("Kill this session?")) conn.killSession(detailsFor);
                setDetailsFor(null);
              }}
              onRename={(title) => {
                void conn.renameSession(detailsFor, title).catch((e) => alert("Rename failed: " + (e as Error).message));
              }}
              onAssign={(groupId) => {
                void conn.assignGroup(detailsFor, groupId).catch((e) => alert("Move failed: " + (e as Error).message));
              }}
              onCreateGroup={(name) => {
                void conn
                  .createGroup(name)
                  .then((g) => conn.assignGroup(detailsFor, g.id))
                  .catch((e) => alert("Create group failed: " + (e as Error).message));
              }}
            />
          );
        })()}
    </div>
  );
}
