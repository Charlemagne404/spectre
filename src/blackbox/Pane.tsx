import type { ReactNode } from 'react';

export function Pane({ name, className, actions, children }: {
  name: string;
  className: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return <section className={'pane ' + className} aria-labelledby={className + '-title'}>
    <header className="pane-heading">
      <div className="pane-heading-name">
        <h2 id={className + '-title'}>{name}</h2>
      </div>
      {actions && <div className="pane-actions">{actions}</div>}
    </header>
    {children}
  </section>;
}
