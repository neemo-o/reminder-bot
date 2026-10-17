/**
 * Removes non-digit characters from a phone number or JID string.
 */
export function normalizePhone(input: string): string {
  if (!input) return '';
  // Remove suffix like @s.whatsapp.net or @g.us if present before stripping non-digits
  const cleanStr = input.split('@')[0];
  return cleanStr.replace(/\D/g, '');
}

/**
 * Checks whether a phone number / JID is allowed under TEST_PHONE_NUMBER filtering.
 * If testPhoneNumber is empty, all numbers are allowed.
 */
export function isPhoneAllowed(phoneOrJid: string, testPhoneNumber?: string): boolean {
  if (!testPhoneNumber || testPhoneNumber.trim() === '') {
    return true;
  }
  const input = normalizePhone(phoneOrJid);
  const test = normalizePhone(testPhoneNumber);
  if (!input || !test) return false;

  // Direct match (including full LID match if configured)
  if (input === test) return true;

  // Brazilian 9th digit mismatch handler (e.g. 557581520641 [12 digits] vs 5575981520641 [13 digits])
  if (input.startsWith('55') && test.startsWith('55')) {
    const inputWithout55 = input.slice(2);
    const testWithout55 = test.slice(2);
    const dddInput = inputWithout55.slice(0, 2);
    const dddTest = testWithout55.slice(0, 2);

    if (dddInput === dddTest) {
      const numInput = inputWithout55.slice(2);
      const numTest = testWithout55.slice(2);
      // Compare ignoring leading 9
      const cleanInput = numInput.length === 9 && numInput.startsWith('9') ? numInput.slice(1) : numInput;
      const cleanTest = numTest.length === 9 && numTest.startsWith('9') ? numTest.slice(1) : numTest;
      if (cleanInput === cleanTest) return true;
    }
  }

  return false;
}

/**
 * Converts a WhatsApp JID to a clean phone number.
 */
export function jidToPhone(jid: string): string {
  return normalizePhone(jid);
}

/**
 * Converts a clean phone number to a WhatsApp JID format.
 */
export function phoneToJid(phone: string): string {
  const clean = normalizePhone(phone);
  return `${clean}@s.whatsapp.net`;
}
