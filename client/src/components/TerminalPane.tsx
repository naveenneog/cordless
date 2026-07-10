import { useEffect, useRef } from "react";
import type { Connection } from "../lib/connection";

export function TerminalPane({
  conn,
  sessionId,
  active,
}: {
  conn: Connection;
  sessionId: string;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) conn.mountPane(sessionId, ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (active) conn.refit(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return <div ref={ref} className={"terminalPane" + (active ? " active" : " inactive")} />;
}
