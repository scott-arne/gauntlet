interface Props {
  turn: number;
  content: string;
}

export function SystemReminderPanel({ turn, content }: Props) {
  return (
    <div className="tr-system-reminder">
      <div className="tr-system-reminder-label">system reminder · turn {turn}</div>
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{content}</p>
    </div>
  );
}
