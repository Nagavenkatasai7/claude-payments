export function newTransferId(): string {
  let id = '';
  while (id.length < 8) {
    // (0).toString(36) = "0"; "0".slice(2) = "" — the empty string is falsy, so
    // without the fallback the loop would spin forever when Math.random() returns 0.
    // '0' is a valid base-36 char, so the fallback always makes forward progress.
    const chunk = Math.random().toString(36).slice(2);
    id += chunk || '0';
  }
  return id.slice(0, 8);
}
