import type {ReactElement, ReactNode} from 'react';

// Build-time allowlisting is paired with browser-side checks: only the public
// Nession GitHub origin becomes a real external link; anything else stays
// plain text.
export function GitHubLink({
  text,
  url,
  className,
  children,
}: {
  text?: string;
  url: string;
  className?: string;
  children?: ReactNode;
}): ReactElement {
  let href: string | undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') href = parsed.href;
  } catch {
    // Inaccessible source deliberately remains plain text.
  }
  return (
    <a className={className} href={href} target={href ? '_blank' : undefined} rel={href ? 'noopener noreferrer' : undefined}>
      {children ?? text}
    </a>
  );
}

export function LocalLink({
  text,
  path,
  className,
  children,
}: {
  text?: string;
  path: string;
  className?: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <a className={className} href={'#' + path}>
      {children ?? text}
    </a>
  );
}

export function allowedKnowledgeExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'github.com' || parsed.hostname === 'gist.github.com') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function KnowledgeExternal({
  text,
  url,
  className,
}: {
  text: string;
  url: string;
  className?: string;
}): ReactElement {
  const allowed = allowedKnowledgeExternal(url);
  return (
    <a className={className} href={allowed ? url : undefined} target={allowed ? '_blank' : undefined} rel={allowed ? 'noopener noreferrer' : undefined}>
      {text}
    </a>
  );
}

const WORKFLOW_LINK =
  /^https:\/\/github\.com\/BestNathan\/nession\/(?:blob\/(?:[a-f0-9]{40}|main)\/\.github\/workflows\/[a-z0-9-]+\.yml|actions(?:\/workflows\/[a-z0-9-]+\.yml)?)$/;

export function WorkflowLink({text, href}: {text: string; href: string}): ReactElement {
  const allowed = WORKFLOW_LINK.test(href);
  return (
    <a className="workflow-link" href={allowed ? href : undefined} target={allowed ? '_blank' : undefined} rel={allowed ? 'noopener noreferrer' : undefined}>
      {text}
    </a>
  );
}
