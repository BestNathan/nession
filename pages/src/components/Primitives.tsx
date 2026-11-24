import type {ReactElement, ReactNode} from 'react';
import {GitHubLink} from './Links.tsx';

export function Section({
  kicker,
  title,
  hint,
  children,
}: {
  kicker: string;
  title: string;
  hint: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <section className="section">
      <div className="section-title">
        <div>
          <div className="eyebrow">{kicker}</div>
          <h2>{title}</h2>
        </div>
        <div className="hint">{hint}</div>
      </div>
      {children}
    </section>
  );
}

export function Grid({
  cols,
  children,
}: {
  cols: 'two' | 'three' | 'four';
  children: ReactNode;
}): ReactElement {
  return <div className={'grid ' + cols}>{children}</div>;
}

export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note: ReactNode;
}): ReactElement {
  return (
    <article className="metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </article>
  );
}

export function PageHead({
  kicker,
  title,
  description,
}: {
  kicker: string;
  title: string;
  description: string;
}): ReactElement {
  return (
    <div className="page-head">
      <div className="eyebrow">{kicker}</div>
      <h1>{title}</h1>
      <p className="lede">{description}</p>
    </div>
  );
}

export function Empty({title, text}: {title: string; text: string}): ReactElement {
  return (
    <article className="panel">
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

export function List({children}: {children: ReactNode}): ReactElement {
  return <div className="list">{children}</div>;
}

export function Hint({children}: {children: ReactNode}): ReactElement {
  return <p className="hint">{children}</p>;
}

export function Callout({children}: {children: ReactNode}): ReactElement {
  return <div className="callout">{children}</div>;
}

export function Entry({
  title,
  subtitle,
  value,
  url,
  stamp,
  pane,
}: {
  title: string;
  subtitle: ReactNode;
  value: ReactNode;
  url?: string | null;
  stamp?: ReactNode;
  pane?: ReactNode;
}): ReactElement {
  const label = url ? (
    <GitHubLink className="entry-title" url={url}>
      <strong>{title}</strong>
    </GitHubLink>
  ) : (
    <span className="entry-title unlinked">{title}</span>
  );
  return (
    <article className="entry">
      <div className="entry-main">
        {label}
        <small>{subtitle}</small>
        {pane}
      </div>
      <div className="entry-right">
        <strong>{value}</strong>
        <span>{stamp || ''}</span>
      </div>
    </article>
  );
}

export function Loading({text}: {text: string}): ReactElement {
  return <p className="loading">{text}</p>;
}

export function Failure({text}: {text: string}): ReactElement {
  return <p className="failure">{text}</p>;
}
