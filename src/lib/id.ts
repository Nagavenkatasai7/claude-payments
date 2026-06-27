export function newTransferId(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % 36]).join('');
}
