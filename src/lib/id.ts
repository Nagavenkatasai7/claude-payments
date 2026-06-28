export function newTransferId(): string {
  let id = '';
  while (id.length < 8) {
    const chunk = Math.random().toString(36).slice(2);
    if (chunk) id += chunk; // guard: Math.random()===0 → "0".slice(2)==="" (empty); skip it
  }
  return id.slice(0, 8);
}
