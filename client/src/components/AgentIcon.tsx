import { agentMeta } from "../lib/protocol";

// A colored rounded badge with the agent's glyph — used instead of the profile name in the tabs and
// the new-session picker (shell, Claude Code, Codex, GitHub Copilot, or a generic badge for custom
// profiles).
export function AgentIcon({ profile, size = 18 }: { profile: string; size?: number }) {
  const m = agentMeta(profile);
  return (
    <span
      className="agenticon"
      style={{ background: m.color, width: size, height: size, fontSize: Math.round(size * 0.52) }}
      title={m.label}
      aria-label={m.label}
      role="img"
    >
      {m.glyph}
    </span>
  );
}
