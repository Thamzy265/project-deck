import process from 'node:process';
// Preloaded with `node --import`: prints how many 'error' listeners stdout and stderr
// have when the process exits, so a test can see whether the stdio guard was released.
process.on('exit', () => {
  process.stderr.write(
    `LISTENERS out=${process.stdout.listenerCount('error')} err=${process.stderr.listenerCount('error')}\n`,
  );
});
