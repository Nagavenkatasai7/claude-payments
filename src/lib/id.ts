export function newTransferId(): string {
  let id = '';
  while (id.length < 8) {
    id += Math.random().toString(36).slice(2);
  }
  return id.slice(0, 8);
}
