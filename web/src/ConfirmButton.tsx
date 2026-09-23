import { useState, type ReactNode } from "react";

/** A destructive action asked about in place: the first click shows the question and a second button.
 *  (Browser confirm() dialogs are suppressed in some browsers and embedded views, where the action then
 *  silently never happens.) */
export default function ConfirmButton({ label, question, yes, onConfirm, className = "link danger-link", title }: {
  label: ReactNode; question: ReactNode; yes: string; onConfirm: () => void; className?: string; title?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className={className} title={title} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAsking(true); }}>{label}</button>;
  return (
    <span className="confirm-ask" role="alertdialog" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <span className="small">{question}</span>
      <button className="danger small-btn" autoFocus onClick={() => { setAsking(false); onConfirm(); }}>{yes}</button>
      <button className="small-btn" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}
