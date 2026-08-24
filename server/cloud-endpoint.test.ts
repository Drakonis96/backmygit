import { describe, expect, it } from 'vitest';
import { privateOrReservedIp, validateCloudEndpoint } from './cloud-endpoint.js';

describe('cloud endpoint SSRF protection', () => {
  it('rejects private, reserved, and IPv4-mapped addresses', () => {
    for (const address of [
      '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1',
      '198.51.100.2', '::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:a00:1',
    ]) expect(privateOrReservedIp(address), address).toBe(true);
    expect(privateOrReservedIp('8.8.8.8')).toBe(false);
    expect(privateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects mapped literals before a cloud operation can use them', async () => {
    await expect(validateCloudEndpoint('https://[::ffff:10.0.0.1]')).rejects.toThrow('Private cloud endpoints');
  });
});
