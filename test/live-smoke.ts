/**
 * Live smoke test against the real Apollo API. Requires APOLLO_API_KEY in the
 * environment (a master key for people search / usage stats). Run manually:
 *
 *   APOLLO_API_KEY=... npm run smoke:live
 *
 * Keeps credit usage minimal: one 3-result company search page (1 credit) and
 * two free calls.
 */
import { ApolloClient } from '../src/apollo/client.js';
import { searchCompanies } from '../src/apollo/companies.js';
import { searchPeople } from '../src/apollo/people.js';
import { getUsageStats } from '../src/apollo/usage.js';

async function main(): Promise<void> {
  if (!process.env.APOLLO_API_KEY) {
    console.error('Set APOLLO_API_KEY to run the live smoke test.');
    process.exit(1);
  }

  const client = new ApolloClient();

  console.log('--- usage stats (free, master key required) ---');
  const usage = await getUsageStats(client);
  console.log(`endpoints reported: ${usage.endpoints.length}`);
  console.log(JSON.stringify(usage.endpoints.slice(0, 3), null, 2));
  console.log('rate limit headers:', usage.rateLimitHeaders);

  console.log('--- people search (free, master key required) ---');
  const people = await searchPeople(client, {
    personTitles: ['chief executive officer'],
    qOrganizationDomainsList: ['apollo.io'],
    perPage: 3,
  });
  console.log(`total_entries: ${String(people.total_entries)}, returned: ${people.people.length}`);

  console.log('--- company search (1 credit) ---');
  const companies = await searchCompanies(client, {
    qOrganizationKeywordTags: ['plumbing'],
    organizationLocations: ['Ballerup, Denmark'],
    perPage: 3,
  });
  console.log('pagination:', JSON.stringify(companies.pagination));
  console.log(`organizations: ${companies.organizations.length}, accounts: ${companies.accounts.length}`);
  console.log(JSON.stringify(companies.organizations, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
