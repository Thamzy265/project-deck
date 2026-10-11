import { describe, expect, it } from 'vitest';
import { connectorUris } from './uri-options.js';

describe('connectorUris', () => {
  it('reads comma-separated addresses from the environment', () => {
    expect(
      connectorUris(
        { dtdUris: [], vmServiceUris: [] },
        {
          DECK_DTD_URIS: 'ws://127.0.0.1:1/a=, ws://127.0.0.1:2/b=',
          DECK_VM_SERVICE_URIS: 'http://127.0.0.1:3/c=/',
        },
      ),
    ).toEqual({
      dtdUris: ['ws://127.0.0.1:1/a=', 'ws://127.0.0.1:2/b='],
      vmServiceUris: ['http://127.0.0.1:3/c=/'],
    });
  });

  it('adds command-line addresses and ignores empty entries', () => {
    expect(
      connectorUris(
        { dtdUris: ['ws://127.0.0.1:9/flag='], vmServiceUris: [] },
        { DECK_DTD_URIS: ' ,ws://127.0.0.1:1/a=,,', DECK_VM_SERVICE_URIS: '' },
      ),
    ).toEqual({ dtdUris: ['ws://127.0.0.1:9/flag=', 'ws://127.0.0.1:1/a='], vmServiceUris: [] });
  });

  it('works with neither set', () => {
    expect(connectorUris({ dtdUris: [], vmServiceUris: [] }, {})).toEqual({
      dtdUris: [],
      vmServiceUris: [],
    });
  });
});
