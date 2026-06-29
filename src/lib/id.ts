export function newTransferId(): string {
  let id = '';
  while (id.length < 8) {
    // Math.random() can legally return 0 per the ECMAScript spec.
    // (0).toString(36).slice(2) === "" — an empty chunk that would cause an
    // infinite loop since nothing is appended to id.  Skip empty chunks so the
    // loop always makes forward progress toward the 8-character target.
    const chunk = Math.random().toString(36).slice(2);
    if (chunk) id += chunk;
  }
  return id.slice(0, 8);
}
