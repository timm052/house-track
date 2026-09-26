// A sold house's price against its first price guide and against what we thought it was worth, in words: on its card
// in the list, the map's side panel and its own page.
import { Fragment } from "react";
import { soldAgainst } from "./format";

export default function SoldAgainst({ sold, firstLow, firstHigh, ours, className = "small" }: {
  sold: number; firstLow: number | null; firstHigh: number | null; ours: number | null; className?: string;
}) {
  const parts = soldAgainst(sold, firstLow, firstHigh, ours);
  if (!parts.length) return null;
  return (
    <div className={`sold-against ${className}`}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && " · "}
          {p.amount ? <><strong className={p.tone ? `tone-${p.tone}` : ""}>{p.amount}</strong> {p.rest}</>
            : i === 0 ? p.rest[0].toUpperCase() + p.rest.slice(1) : p.rest}
        </Fragment>
      ))}
    </div>
  );
}
