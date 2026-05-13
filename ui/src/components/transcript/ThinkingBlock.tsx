interface Props {
  text: string;
  /**
   * Defaults to "thinking" (Anthropic raw chain-of-thought). Pass
   * "reasoning summary" for OpenAI's model-authored summary — same
   * styling, different label, since the artifacts are structurally
   * different (raw vs summarized).
   */
  label?: string;
}

export function ThinkingBlock({ text, label = "thinking" }: Props) {
  if (!text.trim()) return null;
  return (
    <div className="tr-thinking">
      <div className="tr-thinking-label">{label}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>
    </div>
  );
}
