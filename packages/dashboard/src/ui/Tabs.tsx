import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
  panel: ReactNode;
}

/** WAI-ARIA tabs: arrow keys, Home and End move between tabs; panels stay mounted. */
export function Tabs<Id extends string>({
  tabs,
  selected,
  onSelect,
}: {
  tabs: TabDef<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
}) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    const tab = next === undefined ? undefined : tabs[next];
    if (tab === undefined) return;
    event.preventDefault();
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label="Views" className="flex gap-2 border-b border-border px-2">
        {tabs.map((tab, index) => {
          const active = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el === null) refs.current.delete(tab.id);
                else refs.current.set(tab.id, el);
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              className={`-mb-px min-h-8 border-b-2 px-2 hover:border-border ${
                active ? 'border-accent font-medium text-text' : 'border-transparent text-muted'
              }`}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={tab.id !== selected}
          className="flex min-h-0 flex-1 flex-col"
        >
          {tab.panel}
        </div>
      ))}
    </>
  );
}
