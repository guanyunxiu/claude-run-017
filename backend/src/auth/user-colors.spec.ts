import { colorForUser } from './user-colors';

describe('colorForUser', () => {
  it('returns a hex color', () => {
    expect(colorForUser('alice@example.com')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('is deterministic', () => {
    expect(colorForUser('a@x.com')).toBe(colorForUser('a@x.com'));
  });

  it('spreads different users across the palette', () => {
    const colors = new Set(
      ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'].map(colorForUser),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
