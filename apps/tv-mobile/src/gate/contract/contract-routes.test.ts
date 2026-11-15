import { describe, expect, it } from 'vitest';
import { parseContractGateUrl } from './contract-routes';

describe('parseContractGateUrl', () => {
  it('returns undefined for null or non-contract URLs', () => {
    expect(parseContractGateUrl(null)).toBeUndefined();
    expect(parseContractGateUrl('elviptv://gate/player?host=127.0.0.1:7878')).toBeUndefined();
    expect(parseContractGateUrl('https://example.com/gate/contract')).toBeUndefined();
  });

  it('uses defaults when query parameters are omitted', () => {
    expect(parseContractGateUrl('elviptv://gate/contract')).toEqual({
      host: '127.0.0.1:7878',
      account: 'demo',
    });
  });

  it('accepts only development hosts and valid accounts', () => {
    expect(
      parseContractGateUrl('elviptv://gate/contract?host=10.0.2.2:7878&account=compat'),
    ).toEqual({
      host: '10.0.2.2:7878',
      account: 'compat',
    });
    expect(
      parseContractGateUrl('elviptv://gate/contract?host=localhost:9000&account=test_1'),
    ).toEqual({
      host: 'localhost:9000',
      account: 'test_1',
    });
    expect(
      parseContractGateUrl('elviptv://gate/contract?host=evil.example:7878&account=bad/acct'),
    ).toEqual({
      host: '127.0.0.1:7878',
      account: 'demo',
    });
    expect(parseContractGateUrl('elviptv://gate/contract?host=127.0.0.1:70000')).toEqual({
      host: '127.0.0.1:7878',
      account: 'demo',
    });
  });
});
