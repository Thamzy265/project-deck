import type { DbDevice } from '@project-deck/core';
import { useState } from 'react';
import { visibleText } from '../../db/cells.js';
import { button, field } from '../styles.js';
import { VisibleText } from './VisibleText.js';

/**
 * More than one device or simulator could hold the app's database (`choose-device`):
 * the user picks one; FlutterDeck never guesses.
 */
export function DevicePicker({
  source,
  message,
  devices,
  onChoose,
  busy,
  error,
}: {
  source: string;
  message: string;
  devices: DbDevice[];
  onChoose: (source: string, device: string) => void;
  busy: boolean;
  error: string | undefined;
}) {
  const [device, setDevice] = useState(devices[0]?.id ?? '');
  const id = `device-${source.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="m-2 flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h2 id={`${id}-title`} className="font-medium">
        <VisibleText text={message} />
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id}>Device</label>
        <select
          id={id}
          className={`${field} min-w-0 flex-1`}
          value={device}
          onChange={(e) => setDevice(e.target.value)}
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {visibleText(d.name === d.id ? d.id : `${d.name} (${d.id})`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={button}
          aria-disabled={busy || device === '' ? true : undefined}
          onClick={() => {
            if (!busy && device !== '') onChoose(source, device);
          }}
        >
          {busy ? 'Finding databases…' : 'Use this device'}
        </button>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </section>
  );
}
