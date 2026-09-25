// Mask a high-sensitivity value (e.g. a government-ID number) to its last 4
// characters for read-only display. Defensive against undefined/short input.
// App-level field encryption of PII is OUT OF SCOPE for the prototype (the
// Upstash layer provides at-rest encryption); this masking is the minimum
// dashboard exposure control.
export function maskLast4(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v.length <= 4 ? v : v.slice(-4);
}

// Partner-demo R6a: a phone number shown to SOMEONE ELSE (the sender's number
// in the recipient's "money delivered" notice) is only ever `••••<last 4
// digits>`. The mask is U+2022 bullets, NOT '*': WhatsApp reads `*…*` as bold
// markup (so are _ ~ `), and the output carries none of those characters and no
// whitespace, so it renders literally in a template variable. It is the
// same "••••" the dashboard already uses for masked IDs. Formatting characters
// in the input are ignored; a value with 4 or fewer digits is fully masked, so
// the output never carries more than 4 digits.
const PHONE_MASK = '\u2022\u2022\u2022\u2022'; // ••••

export function maskPhoneLast4(phone: string | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length > 4 ? `${PHONE_MASK}${digits.slice(-4)}` : PHONE_MASK;
}
