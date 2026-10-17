/**
 * Review R1: saving must never wipe saved queries the page hasn't read, and two tabs
 * must not overwrite each other.
 */
import { EditorView } from '@codemirror/view';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DbApiError } from '../../api/db-client.js';
import { fakeDbClient, fakeDbData } from '../../testing/db-fake.js';
import { fakeDaemon, renderDashboard } from '../../testing/harness.js';

async function sqlView(db = fakeDbClient()) {
  const t = renderDashboard(fakeDaemon(), undefined, undefined, { tab: 'database', db });
  await t.connect();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'SQL' }));
  let content: HTMLElement | null | undefined;
  await waitFor(
    () => {
      // The editor replaces the loading text once its code has loaded.
      const host = screen.getByText('SQL', { selector: '#sql-label' }).nextElementSibling;
      content = host?.shadowRoot?.querySelector<HTMLElement>('.cm-content');
      expect(content).toBeTruthy();
    },
    { timeout: 10_000 },
  );
  return { ...t, user, content: content as HTMLElement };
}

/** Types into the editor and presses Ctrl+S, as CodeMirror reads them. */
async function typeAndSave(content: HTMLElement, sql: string) {
  await act(async () => {
    const view = EditorView.findFromDOM(content);
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } });
    await Promise.resolve();
  });
  await act(async () => {
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

describe('saved queries are saved only from what was read (review R1)', { timeout: 20_000 }, () => {
  it('a failed load shows the error, not an empty list, and Ctrl+S saves nothing', async () => {
    const db = fakeDbClient(fakeDbData({ saved: [{ name: 'keep me', sql: 'SELECT 1' }] }));
    db.savedQueries.mockRejectedValue(new DbApiError('internal', "Couldn't read saved queries."));
    const t = await sqlView(db);
    await typeAndSave(t.content, 'SELECT 2');
    expect(await screen.findByText("Couldn't save queries")).toBeInTheDocument();
    expect(db.saveQueries).not.toHaveBeenCalled();
    await t.user.click(screen.getByRole('button', { name: 'More database options' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't read saved queries.");
    expect(screen.queryByText(/No saved queries/)).toBeNull();
  });

  it('Ctrl+S while the list is still loading saves nothing', async () => {
    const db = fakeDbClient();
    db.savedQueries.mockReturnValue(new Promise(() => undefined));
    const t = await sqlView(db);
    await typeAndSave(t.content, 'SELECT 2');
    expect(db.saveQueries).not.toHaveBeenCalled();
  });

  it('a save refused as stale reads the list again and keeps both tabs’ queries', async () => {
    const data = fakeDbData({ saved: [{ name: 'mine', sql: 'SELECT 1' }] });
    const db = fakeDbClient(data);
    const t = await sqlView(db);
    await waitFor(() => expect(db.savedQueries).toHaveBeenCalled());
    // Another tab saves meanwhile.
    data.saved = [...data.saved, { name: 'theirs', sql: 'SELECT 3' }];
    data.revision = 'f'.repeat(64);
    db.saveQueries.mockRejectedValueOnce(new DbApiError('conflict', 'The saved queries changed.'));
    await typeAndSave(t.content, 'SELECT 2');
    await waitFor(() =>
      expect(db.saveQueries).toHaveBeenLastCalledWith(
        [
          { name: 'mine', sql: 'SELECT 1' },
          { name: 'theirs', sql: 'SELECT 3' },
          { name: 'SELECT 2', sql: 'SELECT 2' },
        ],
        'f'.repeat(64),
      ),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });
});
