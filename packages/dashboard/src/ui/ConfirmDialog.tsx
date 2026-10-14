import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';
import { button } from './styles.js';

/** A small modal question. Focus starts on Cancel, stays inside, and Escape cancels. */
export function ConfirmDialog({
  question,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Tab') {
      // Two buttons: Tab and Shift+Tab just swap between them.
      event.preventDefault();
      const other = document.activeElement === cancelRef.current ? confirmRef : cancelRef;
      other.current?.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-bg/80 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-question"
        onKeyDown={onKeyDown}
        className="flex max-w-sm flex-col gap-3 rounded-md border border-border bg-bg p-4"
      >
        <p id="confirm-question">{question}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={confirmRef}
            type="button"
            className={`${button} min-h-8 border-error text-error`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button ref={cancelRef} type="button" className={`${button} min-h-8`} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
