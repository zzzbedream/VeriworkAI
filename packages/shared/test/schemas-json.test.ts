import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonicalJson } from '../src/canonical-json';
import { jsonString, toJsonValue } from '../src/json';
import {
  AddressSchema,
  BlockNumberStringSchema,
  boundedJson,
  Bytes32Schema,
  EcdsaSignatureSchema,
  HexSchema,
  jsonByteLength,
  LanguageCodeSchema,
  SignedWeiStringSchema,
  WalletSignatureSchema,
  WeiStringSchema,
} from '../src/schemas';

describe('primitive schemas', () => {
  it('AddressSchema lowercases and enforces checksums on mixed case', () => {
    expect(AddressSchema.parse(' 0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A ')).toBe(
      '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a',
    );
    expect(AddressSchema.parse('0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a')).toBe(
      '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a',
    );
    expect(AddressSchema.safeParse('0xb2F17f55e1378BFbeAC04c7302d2e52a1a83E00A').success).toBe(
      false,
    );
    expect(AddressSchema.safeParse('0x1234').success).toBe(false);
  });

  it('hex, bytes32 and signatures', () => {
    expect(HexSchema.parse('0xABCD')).toBe('0xabcd');
    expect(HexSchema.safeParse('0xabc').success).toBe(false);
    expect(Bytes32Schema.parse('0x' + 'AB'.repeat(32))).toBe('0x' + 'ab'.repeat(32));
    expect(Bytes32Schema.safeParse('0x' + 'ab'.repeat(31)).success).toBe(false);
    expect(EcdsaSignatureSchema.safeParse('0x' + '11'.repeat(65)).success).toBe(true);
    expect(EcdsaSignatureSchema.safeParse('0x' + '11'.repeat(64)).success).toBe(false);
    expect(WalletSignatureSchema.safeParse('0x' + '11'.repeat(65)).success).toBe(true);
    expect(WalletSignatureSchema.safeParse('0x' + '11'.repeat(300)).success).toBe(true);
    expect(WalletSignatureSchema.safeParse('0x' + '11'.repeat(10)).success).toBe(false);
    expect(WalletSignatureSchema.safeParse('0x' + '11'.repeat(10_001)).success).toBe(false);
  });

  it('wei, signed wei and block number strings', () => {
    expect(WeiStringSchema.safeParse('0').success).toBe(true);
    expect(WeiStringSchema.safeParse((2n ** 256n - 1n).toString()).success).toBe(true);
    expect(WeiStringSchema.safeParse((2n ** 256n).toString()).success).toBe(false);
    expect(WeiStringSchema.safeParse('-1').success).toBe(false);
    expect(WeiStringSchema.safeParse('007').success).toBe(false);
    expect(SignedWeiStringSchema.safeParse('-15').success).toBe(true);
    expect(SignedWeiStringSchema.safeParse('-0').success).toBe(false);
    expect(BlockNumberStringSchema.safeParse('82845950').success).toBe(true);
    expect(BlockNumberStringSchema.safeParse((2n ** 64n).toString()).success).toBe(false);
  });

  it('language codes (BCP-47 subset)', () => {
    for (const ok of ['en', 'es', 'pt-BR', 'fil'])
      expect(LanguageCodeSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['EN', 'en_US', 'english', 'e'])
      expect(LanguageCodeSchema.safeParse(bad).success).toBe(false);
  });

  it('bounded JSON', () => {
    const schema = boundedJson(20);
    expect(schema.safeParse({ a: 'short' }).success).toBe(true);
    expect(schema.safeParse({ a: 'this is far too long for twenty bytes' }).success).toBe(false);
    expect(jsonByteLength({ a: 'ñ' })).toBe(10);
  });
});

describe('canonical JSON (agent signatures and resultsHash)', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: true, x: null }], c: 'é' }, u: undefined })).toBe(
      '{"a":{"c":"é","d":[3,{"x":null,"y":true}]},"b":1}',
    );
    expect(canonicalJson([1, 'two', false])).toBe('[1,"two",false]');
    expect(canonicalJson(Object.create(null) as object)).toBe('{}');
  });

  it('hashes are key-order independent', () => {
    expect(hashCanonicalJson({ a: 1, b: 2 })).toBe(hashCanonicalJson({ b: 2, a: 1 }));
    expect(hashCanonicalJson({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects values JSON cannot represent exactly', () => {
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/Circular/);
  });

  it('allows repeated (non-cyclic) references', () => {
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});

describe('toJsonValue (decoded on-chain data)', () => {
  it('converts bigints and lowercases addresses', () => {
    expect(
      toJsonValue({
        account: '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A',
        amount: 150n * 10n ** 18n,
        list: [1n, 'x', true, null],
        skip: undefined,
        nested: { hash: '0x' + 'AB'.repeat(32) },
      }),
    ).toEqual({
      account: '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a',
      amount: '150000000000000000000',
      list: ['1', 'x', true, null],
      nested: { hash: '0x' + 'AB'.repeat(32) },
    });
    expect(toJsonValue(5)).toBe(5);
  });

  it('rejects non-JSON values', () => {
    expect(() => toJsonValue(Number.NaN)).toThrow(TypeError);
    expect(() => toJsonValue(Symbol('x'))).toThrow(TypeError);
    expect(() => toJsonValue(new Map())).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => toJsonValue(cyclic)).toThrow(/deeply/);
  });

  it('reads string members', () => {
    const value = toJsonValue({ campaignId: '0xabc', amount: 1n, n: 3 });
    expect(jsonString(value, 'campaignId')).toBe('0xabc');
    expect(jsonString(value, 'amount')).toBe('1');
    expect(jsonString(value, 'n')).toBeUndefined();
    expect(jsonString(value, 'missing')).toBeUndefined();
    expect(jsonString(['a'], '0')).toBeUndefined();
    expect(jsonString(null, 'a')).toBeUndefined();
    expect(jsonString(undefined, 'a')).toBeUndefined();
    expect(jsonString('text', 'a')).toBeUndefined();
  });
});
