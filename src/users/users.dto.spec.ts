import { UpdateMeSchema } from './users.dto.js';
import { isReservedHandle } from './users.service.js';

describe('handle rules', () => {
  it('normalises and validates handles', () => {
    expect(UpdateMeSchema.parse({ handle: ' Loo_Ranger ' }).handle).toBe('loo_ranger');
    for (const bad of ['ab', 'a'.repeat(21), 'has space', 'émile', 'dash-y']) {
      expect(UpdateMeSchema.safeParse({ handle: bad }).success).toBe(false);
    }
  });
  it('blocks reserved handles', () => {
    expect(isReservedHandle('admin')).toBe(true);
    expect(isReservedHandle('ShitGoWhere')).toBe(true);
    expect(isReservedHandle('loo_ranger')).toBe(false);
  });
});
