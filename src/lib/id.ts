export function newTransferId(): string {
  let id = '';
  while (id.length < 8) {
    const r = Math.random();
    // (0).toString(36) === '0'; '0'.slice(2) === '' — appending empty string never
    // advances id.length, causing an infinite loop.  Skip r=0 and retry.
    if (r > 0) id += r.toString(36).slice(2);
  }
  return id.slice(0, 8);
}
