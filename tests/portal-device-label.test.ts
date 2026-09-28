import { describe, it, expect } from 'vitest';
import { deviceLabel, isDeviceLabel, DEVICE_LABELS } from '@/lib/portal-device-label';

// M2-2 Task 2.2: the Devices page shows a label drawn from a CLOSED set of
// browser × OS words. The raw user agent (and the IP) is never stored or echoed.

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
};

describe('deviceLabel (closed set; no raw UA stored)', () => {
  it.each([
    [UA.chromeMac, 'Chrome on macOS'],
    [UA.safariIphone, 'Safari on iPhone'],
    [UA.edgeWindows, 'Edge on Windows'],
    [UA.firefoxLinux, 'Firefox on Linux'],
    [UA.samsungAndroid, 'Samsung Internet on Android'],
    [UA.chromeAndroid, 'Chrome on Android'],
    [UA.safariIpad, 'Safari on iPad'],
    [UA.safariMac, 'Safari on macOS'],
    [UA.chromeIos, 'Chrome on iPhone'],
    [UA.firefoxWindows, 'Firefox on Windows'],
  ])('%s → %s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  it('null, empty and unrecognised agents are "Unknown device"', () => {
    expect(deviceLabel(null)).toBe('Unknown device');
    expect(deviceLabel('')).toBe('Unknown device');
    expect(deviceLabel('curl/8.4.0')).toBe('Unknown device');
  });

  it('a known browser on an unknown OS, and an unknown browser on a known OS, stay in the set', () => {
    expect(deviceLabel('Firefox/129.0')).toBe('Firefox');
    expect(deviceLabel('SomeBot/1.0 (Windows NT 10.0)')).toBe('Browser on Windows');
  });

  it('a hostile UA never leaks into the label', () => {
    const out = deviceLabel('<script>Chrome</script> Mac OS X');
    expect(out).toBe('Chrome on macOS');
    expect(out).toMatch(/^[A-Za-z ]+$/);
  });

  it('every output is a member of the closed set and matches the safe charset', () => {
    const samples = [...Object.values(UA), null, '', 'x'.repeat(5000), '\u0000‮ evil', 'Edg/1 CriOS/1 FxiOS/1'];
    for (const s of samples) {
      const out = deviceLabel(s);
      expect(DEVICE_LABELS).toContain(out);
      expect(isDeviceLabel(out)).toBe(true);
      expect(out).toMatch(/^[A-Za-z ]+$/);
    }
  });

  it('isDeviceLabel rejects anything outside the set', () => {
    expect(isDeviceLabel('Chrome on macOS')).toBe(true);
    expect(isDeviceLabel('Unknown device')).toBe(true);
    expect(isDeviceLabel('d')).toBe(false);
    expect(isDeviceLabel(UA.chromeMac)).toBe(false);
    expect(isDeviceLabel('chrome on macos')).toBe(false);
    expect(DEVICE_LABELS.every((l) => /^[A-Za-z ]+$/.test(l))).toBe(true);
  });
});
