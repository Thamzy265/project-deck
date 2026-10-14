import { z } from 'zod';

// The daemon's CSP forbids eval. Without this, zod probes `new Function` on first parse,
// which the browser reports as a CSP violation.
z.config({ jitless: true });
