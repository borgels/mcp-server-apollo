import { describe, expect, it } from 'vitest';
import { selectFields } from '../src/apollo/fields.js';

const organization = {
  id: '5e66b6381e05b4008c8331b8',
  name: 'Apollo.io',
  primary_domain: 'apollo.io',
  website_url: 'http://www.apollo.io',
  primary_phone: { number: '+1 202-374-1312', source: 'Scraped' },
  founded_year: 2015,
  employment_history: [
    { organization_name: 'Apollo', title: 'CEO' },
    { organization_name: 'BrainGenie', title: 'CEO' },
  ],
};

describe('selectFields', () => {
  it('returns the value unchanged when no fields are given', () => {
    expect(selectFields(organization, [])).toBe(organization);
    expect(selectFields(organization, ['  ', ''])).toBe(organization);
  });

  it('keeps only the requested top-level fields', () => {
    expect(selectFields(organization, ['name', 'primary_domain'])).toEqual({
      name: 'Apollo.io',
      primary_domain: 'apollo.io',
    });
  });

  it('descends into nested objects via dot paths', () => {
    expect(selectFields(organization, ['name', 'primary_phone.number'])).toEqual({
      name: 'Apollo.io',
      primary_phone: { number: '+1 202-374-1312' },
    });
  });

  it('keeps a whole subtree when the path names the object itself', () => {
    expect(selectFields(organization, ['primary_phone'])).toEqual({
      primary_phone: { number: '+1 202-374-1312', source: 'Scraped' },
    });
  });

  it('maps array elements through the remaining path', () => {
    expect(selectFields(organization, ['employment_history.title'])).toEqual({
      employment_history: [{ title: 'CEO' }, { title: 'CEO' }],
    });
  });

  it('silently skips unknown fields', () => {
    expect(selectFields(organization, ['name', 'naics_codes', 'primary_phone.missing'])).toEqual({
      name: 'Apollo.io',
      primary_phone: {},
    });
  });

  it('projects every element of a top-level array', () => {
    const list = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    expect(selectFields(list, ['a'])).toEqual([{ a: 1 }, { a: 3 }]);
  });
});
