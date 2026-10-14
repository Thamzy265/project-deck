import { useDeck } from '../../state/DeckProvider.js';
import { ActionButtons } from './ActionButtons.js';
import { AppNotice, AppPicker } from './AppPicker.js';
import { ResultChip } from './ResultChip.js';

export function Header({
  shortcuts,
  onShowInLogs,
}: {
  shortcuts: boolean;
  onShowInLogs: () => void;
}) {
  const { state } = useDeck();
  const project = state.info?.projectName ?? '';
  return (
    <header className="flex flex-col gap-2 border-b border-border p-2 md:flex-row md:flex-wrap md:items-start">
      <div className="flex min-w-0 items-center gap-2 md:flex-1">
        <span className="max-w-1/3 shrink-0 truncate font-medium" title={project}>
          {project}
        </span>
        <AppPicker />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButtons shortcuts={shortcuts} />
        <ResultChip onShowInLogs={onShowInLogs} />
      </div>
      <div className="basis-full">
        <AppNotice />
      </div>
    </header>
  );
}
