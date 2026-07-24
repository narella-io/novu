// narella: live AWS region list for the dashboard's region combobox.
// Source is AWS's public ip-ranges.json (no SDK, no IAM) — refreshed at most
// once a day, with a baked-in fallback so the form never renders empty.

const FALLBACK_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3',
  'ap-southeast-4', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'il-central-1', 'me-central-1', 'me-south-1', 'sa-east-1',
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
];

const REFRESH_MS = 24 * 60 * 60 * 1000;

let cachedRegions: string[] = FALLBACK_REGIONS;
let lastFetchedAt = 0;

export async function getAwsRegions(): Promise<string[]> {
  if (Date.now() - lastFetchedAt < REFRESH_MS) {
    return cachedRegions;
  }

  try {
    const response = await fetch('https://ip-ranges.amazonaws.com/ip-ranges.json');
    if (response.ok) {
      const body = (await response.json()) as { prefixes?: Array<{ region?: string }> };
      const regions = [
        ...new Set(
          (body.prefixes || [])
            .map((prefix) => prefix.region)
            .filter((region): region is string => Boolean(region) && region !== 'GLOBAL')
        ),
      ].sort();
      if (regions.length > 0) {
        cachedRegions = regions;
      }
    }
    lastFetchedAt = Date.now();
  } catch {
    // Keep whatever we have; retry after the refresh window.
    lastFetchedAt = Date.now();
  }

  return cachedRegions;
}
