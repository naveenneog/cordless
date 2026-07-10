import type { Connection } from "../lib/connection";

const SEQ: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\t",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Left: "\x1b[D",
  Right: "\x1b[C",
  Home: "\x1b[H",
  End: "\x1b[F",
  PgUp: "\x1b[5~",
  PgDn: "\x1b[6~",
};

const SYMBOLS = "| / \\ ~ ` - _ = + { } [ ] ( ) < > : ; & * # $ ! ?".split(" ");

function Key({
  label,
  onPress,
  active,
  wide,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      className={"key" + (active ? " active" : "") + (wide ? " wide" : "")}
      // pointerdown + preventDefault keeps the soft keyboard open (no focus steal)
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
    >
      {label}
    </button>
  );
}

export function KeyBar({ conn, ctrl, alt }: { conn: Connection; ctrl: boolean; alt: boolean }) {
  return (
    <div className="keybar">
      <div className="keyrow">
        <Key label="Esc" onPress={() => conn.pressSpecial(SEQ.Esc)} />
        <Key label="Tab" onPress={() => conn.pressSpecial(SEQ.Tab)} />
        <Key label="Ctrl" active={ctrl} onPress={() => conn.toggleCtrl()} />
        <Key label="Alt" active={alt} onPress={() => conn.toggleAlt()} />
        <Key label="↑" onPress={() => conn.pressSpecial(SEQ.Up)} />
        <Key label="↓" onPress={() => conn.pressSpecial(SEQ.Down)} />
        <Key label="←" onPress={() => conn.pressSpecial(SEQ.Left)} />
        <Key label="→" onPress={() => conn.pressSpecial(SEQ.Right)} />
        <Key label="^C" onPress={() => conn.pressSpecial("\x03")} />
        <Key label="^D" onPress={() => conn.pressSpecial("\x04")} />
      </div>
      <div className="keyrow scroll">
        {SYMBOLS.map((s) => (
          <Key key={s} label={s} onPress={() => conn.sendText(s)} />
        ))}
        <Key label="PgUp" onPress={() => conn.pressSpecial(SEQ.PgUp)} />
        <Key label="PgDn" onPress={() => conn.pressSpecial(SEQ.PgDn)} />
        <Key
          label="paste"
          wide
          onPress={async () => {
            try {
              const t = await navigator.clipboard.readText();
              if (t) conn.sendText(t);
            } catch {
              /* clipboard denied */
            }
          }}
        />
      </div>
    </div>
  );
}
