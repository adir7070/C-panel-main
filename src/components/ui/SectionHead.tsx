import type { ReactNode } from "react";

interface Props {
  eyebrow?: string;
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}

export function SectionHead({ eyebrow, title, meta, action }: Props) {
  return (
    <div className="section-head">
      <div>
        {eyebrow && <p className="t-eyebrow" style={{ marginBottom: 6 }}>{eyebrow}</p>}
        <h2 className="t-section">{title}</h2>
        {meta && <p className="t-meta" style={{ marginTop: 4 }}>{meta}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
